"use strict";

const PROTOCOL = "jx-auto-selection-file-v1";
const PARTS = Object.freeze({ upper: [4, 17], lower: [5, 6, 8], dress: [7], clothes: [4, 5, 6, 7, 8, 17], head: [1, 2, 3, 11], shoes: [9, 10] });
const PART_LABELS = Object.freeze({ upper: "上衣", lower: "下装", dress: "连衣裙", clothes: "整套服装", head: "头部（含头发）", shoes: "鞋" });

function classifyReference(labels) {
  const counts = new Uint32Array(18);
  for (const value of labels) {
    if (value > 17) throw new Error("本地识别结果类别无效");
    counts[value]++;
  }
  const ranked = [["head", PARTS.head], ["upper", PARTS.upper], ["lower", PARTS.lower], ["dress", [7]], ["shoes", PARTS.shoes]]
    .map(([part, classes]) => ({ part, pixels: classes.reduce((sum, value) => sum + counts[value], 0) }))
    .sort((a, b) => b.pixels - a.pixels);
  const [first, second] = ranked;
  // Full-body model photos provide context without voting on the product category.
  const face = counts[11] >= labels.length * 0.001;
  const lowerBody = counts[5] + counts[6] + counts[9] + counts[10] + counts[12] + counts[13];
  if (face && lowerBody >= labels.length * 0.01) return null;
  return first.pixels >= labels.length * 0.03 && first.pixels >= second.pixels * 2 ? first.part : null;
}

function resolveReferencePart(parts) {
  const known = [...new Set(parts.filter(Boolean))];
  if (known.includes("head")) return "head";
  if (known.length > 1) throw new Error("参考图包含不同类别，请保留同一类参考图，或手动选择要修的部位");
  if (known.length !== 1) throw new Error("未识别到明确的单品类别，请添加白底单品图或清晰的头部参考图，也可以手动选择部位");
  return known[0];
}

function resolveGarmentAssignments(referenceParts, firstImageIndex = 2) {
  if (!Array.isArray(referenceParts) || referenceParts.length < 1 || !Number.isInteger(firstImageIndex) || firstImageIndex < 2) {
    throw new Error("至少需要一张服装参考图");
  }
  const supported = new Set(["upper", "lower", "dress", "shoes"]);
  const assignments = [];
  for (let index = 0; index < referenceParts.length; index += 1) {
    const part = referenceParts[index];
    if (!supported.has(part)) {
      throw new Error(`图${firstImageIndex + index}未能明确识别为上衣、下装、连衣裙或鞋，请换用单品图`);
    }
    let assignment = assignments.find((item) => item.part === part);
    if (!assignment) {
      assignment = { part, referenceIndexes: [] };
      assignments.push(assignment);
    }
    assignment.referenceIndexes.push(firstImageIndex + index);
  }
  return assignments;
}

function garmentReplacementPrompt(assignments) {
  if (!Array.isArray(assignments) || !assignments.length) throw new Error("没有可用于换装的服装参考图");
  const imageNames = ["一", "二", "三", "四", "五", "六", "七"];
  const referenceName = (index) => `图${imageNames[index - 1] || index}`;
  const mapping = assignments.map((assignment) => {
    const garment = { upper: "上衣", lower: "裤子", dress: "连衣裙", shoes: "鞋子" }[assignment.part];
    const sources = (assignment.referenceIndexes || []).map(referenceName).join("、");
    if (!garment || !sources) throw new Error("服装参考图对应关系无效");
    return `将图一的${garment}替换为${sources}的${garment}，保持${sources}的颜色和细节一致性。`;
  });
  return mapping.join("\n");
}

function selectionPlan(labels, mapWidth, mapHeight, width, height, part) {
  const selectedParts = Array.isArray(part) ? [...new Set(part)] : [part];
  if (!selectedParts.length || selectedParts.some((value) => !Object.prototype.hasOwnProperty.call(PARTS, value))) {
    throw new Error("请选择有效的识别区域");
  }
  if (![mapWidth, mapHeight, width, height].every(Number.isInteger) ||
      Math.min(mapWidth, mapHeight, width, height) < 1 ||
      mapWidth > 1024 || mapHeight > 1024 || labels.length !== mapWidth * mapHeight) throw new Error("识别结果尺寸无效");
  const wanted = new Set(selectedParts.flatMap((value) => PARTS[value]));
  let left = mapWidth, top = mapHeight, right = 0, bottom = 0, count = 0;
  for (let y = 0; y < mapHeight; y++) for (let x = 0; x < mapWidth; x++) {
    const value = labels[y * mapWidth + x];
    if (value > 17) throw new Error("本地识别结果类别无效");
    if (!wanted.has(value)) continue;
    count++;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
  }
  if (count < Math.max(8, mapWidth * mapHeight * 0.0003)) throw new Error("没有识别到该区域，请更换类别或手动框选");
  const target = { left: Math.floor(left * width / mapWidth), top: Math.floor(top * height / mapHeight),
    right: Math.ceil(right * width / mapWidth), bottom: Math.ceil(bottom * height / mapHeight) };
  const targetWidth = target.right - target.left, targetHeight = target.bottom - target.top;
  const margin = Math.max(8, Math.round(Math.max(targetWidth, targetHeight) * 0.06)) + 8;
  const candidates = [[1, 1], [3, 4], [4, 3]].flatMap(([rw, rh]) => {
    const required = Math.ceil(Math.max(targetWidth / rw, targetHeight / rh));
    const available = Math.floor(Math.min(width / rw, height / rh));
    if (required > available) return [];
    const scale = Math.min(available, Math.ceil(Math.max((targetWidth + 2 * margin) / rw, (targetHeight + 2 * margin) / rh)));
    return [{ width: rw * scale, height: rh * scale, ratio: `${rw}:${rh}` }];
  });
  candidates.sort((a, b) => a.width * a.height - b.width * b.height);
  if (!candidates.length) throw new Error("完整区域放不进画布内的 3:4、1:1 或 4:3 选区，请先扩展画布或手动框选");
  const { width: cropWidth, height: cropHeight, ratio } = candidates[0];
  if (cropWidth * cropHeight > 12 * 1024 * 1024) throw new Error("自动修图区域过大，请先缩小文档后重试");
  const x = Math.max(0, Math.min(width - cropWidth, Math.round((target.left + target.right - cropWidth) / 2)));
  const y = Math.max(0, Math.min(height - cropHeight, Math.round((target.top + target.bottom - cropHeight) / 2)));
  const bounds = { left: x, top: y, right: x + cropWidth, bottom: y + cropHeight, width: cropWidth, height: cropHeight };
  if (bounds.left > target.left || bounds.top > target.top || bounds.right < target.right || bounds.bottom < target.bottom) throw new Error("无法完整框住该区域，请手动框选");
  // Expand protection by two parsing pixels. Hair and face always win over clothes.
  const protection = new Uint8Array(mapWidth * mapHeight);
  if (part !== "head") for (let py = 0; py < mapHeight; py++) for (let px = 0; px < mapWidth; px++) {
    if (![1, 2, 3, 11].includes(labels[py * mapWidth + px])) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (px + dx >= 0 && px + dx < mapWidth && py + dy >= 0 && py + dy < mapHeight) protection[(py + dy) * mapWidth + px + dx] = 1;
    }
  }
  const bytes = new Uint8Array(cropWidth * cropHeight);
  for (let py = 0; py < cropHeight; py++) {
    const row = Math.min(mapHeight - 1, Math.floor((y + py + 0.5) * mapHeight / height));
    for (let px = 0; px < cropWidth; px++) {
      const col = Math.min(mapWidth - 1, Math.floor((x + px + 0.5) * mapWidth / width));
      const label = labels[row * mapWidth + col];
      if (wanted.has(label) && (selectedParts.includes("head") || !protection[row * mapWidth + col])) {
        bytes[py * cropWidth + px] = 255;
      }
    }
  }
  return { bounds, target, ratio, part: selectedParts.length === 1 ? selectedParts[0] : selectedParts,
    parts: selectedParts, mask: { bytes, width: cropWidth, height: cropHeight, bounds } };
}

function garmentSelectionPlans(labels, mapWidth, mapHeight, width, height) {
  const plans = [];
  for (const part of ["upper", "lower", "dress"]) {
    try {
      plans.push(selectionPlan(labels, mapWidth, mapHeight, width, height, part));
    } catch (error) {
      if (!/没有识别到该区域/.test(String(error && error.message || error))) throw error;
    }
  }
  if (!plans.length) throw new Error("没有识别到上衣、下装或连衣裙，请更换图片后重试");
  return plans;
}

function featherMaskInward(source, width, height) {
  if (!source || source.length !== width * height || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("服装蒙版尺寸无效");
  }
  const kernel = [1, 4, 10, 20, 31, 40, 44, 40, 31, 20, 10, 4, 1];
  const horizontal = new Uint8Array(source.length);
  const softened = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      for (let offset = -6; offset <= 6; offset += 1) {
        const sampleX = Math.max(0, Math.min(width - 1, x + offset));
        total += source[row + sampleX] * kernel[offset + 6];
      }
      horizontal[row + x] = Math.round(total / 256);
    }
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      for (let offset = -6; offset <= 6; offset += 1) {
        const sampleY = Math.max(0, Math.min(height - 1, y + offset));
        total += horizontal[sampleY * width + x] * kernel[offset + 6];
      }
      softened[row + x] = source[row + x] ? Math.min(source[row + x], Math.round(total / 256)) : 0;
    }
  }
  return softened;
}

function featherMaskPercent(source, width, height, percent = 0.05) {
  if (!source || source.length !== width * height || !Number.isInteger(width) || !Number.isInteger(height) ||
      !Number.isFinite(percent) || percent < 0 || percent > 1) {
    throw new Error("服装蒙版尺寸或羽化比例无效");
  }
  const radius = Math.max(1, Math.round(Math.min(width, height) * percent));
  const horizontal = new Uint8Array(source.length);
  const output = new Uint8Array(source.length);
  const diameter = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx >= 0 && dx < width) sum += source[row + dx];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = Math.round(sum / diameter);
      const leaving = x - radius;
      const entering = x + radius + 1;
      if (leaving >= 0) sum -= source[row + leaving];
      if (entering < width) sum += source[row + entering];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      if (dy >= 0 && dy < height) sum += horizontal[dy * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      const index = y * width + x;
      output[index] = source[index] ? Math.round(sum / diameter) : 0;
      const leaving = y - radius;
      const entering = y + radius + 1;
      if (leaving >= 0) sum -= horizontal[leaving * width + x];
      if (entering < height) sum += horizontal[entering * width + x];
    }
  }
  return { bytes: output, radius, percent };
}

function decontaminateGarmentEdge(rgba, mask, width, height, radius = 5) {
  if (!rgba || rgba.length !== width * height * 4 || !mask || mask.length !== width * height) {
    throw new Error("服装边缘颜色数据无效");
  }
  const radiusSquared = radius * radius;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x;
    if (mask[index] === 0 || mask[index] === 255) continue;
    let nearest = -1;
    let nearestDistance = radiusSquared + 1;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const sampleY = y + dy;
      if (sampleY < 0 || sampleY >= height) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const distance = dx * dx + dy * dy;
        if (distance >= nearestDistance) continue;
        const sampleX = x + dx;
        if (sampleX < 0 || sampleX >= width) continue;
        const sampleIndex = sampleY * width + sampleX;
        if (mask[sampleIndex] !== 255) continue;
        nearest = sampleIndex;
        nearestDistance = distance;
      }
    }
    if (nearest < 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      rgba[index * 4 + channel] = rgba[nearest * 4 + channel];
    }
  }
  return rgba;
}

function refineGarmentMatte(pixels, components, binaryMask, alphaMask, width, height, radius = 6) {
  if (!pixels || ![3, 4].includes(components) || pixels.length < width * height * components ||
      !binaryMask || binaryMask.length !== width * height || !alphaMask || alphaMask.length !== width * height) {
    throw new Error("服装边缘抠图数据无效");
  }
  const interior = new Uint8Array(binaryMask.length);
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const index = y * width + x;
    if (binaryMask[index] !== 255) continue;
    let solid = true;
    for (let dy = -1; dy <= 1 && solid; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (binaryMask[(y + dy) * width + x + dx] !== 255) { solid = false; break; }
    }
    if (solid) interior[index] = 1;
  }

  const radiusSquared = radius * radius;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x;
    if (binaryMask[index] !== 255 || alphaMask[index] === 0 || alphaMask[index] === 255) continue;
    let foreground = -1, background = -1;
    let foregroundDistance = radiusSquared + 1, backgroundDistance = radiusSquared + 1;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const sampleY = y + dy;
      if (sampleY < 0 || sampleY >= height) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const distance = dx * dx + dy * dy;
        if (distance > radiusSquared) continue;
        const sampleX = x + dx;
        if (sampleX < 0 || sampleX >= width) continue;
        const sampleIndex = sampleY * width + sampleX;
        if (interior[sampleIndex] && distance < foregroundDistance) {
          foreground = sampleIndex;
          foregroundDistance = distance;
        }
        if (binaryMask[sampleIndex] === 0 && distance < backgroundDistance) {
          background = sampleIndex;
          backgroundDistance = distance;
        }
      }
    }
    if (foreground < 0 || background < 0) continue;

    const pixelOffset = index * components;
    const foregroundOffset = foreground * components;
    const backgroundOffset = background * components;
    let dot = 0, lengthSquared = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const direction = pixels[foregroundOffset + channel] - pixels[backgroundOffset + channel];
      dot += (pixels[pixelOffset + channel] - pixels[backgroundOffset + channel]) * direction;
      lengthSquared += direction * direction;
    }
    if (lengthSquared < 900) continue;
    const estimate = dot / lengthSquared;
    if (estimate < -0.1 || estimate > 1.1) continue;
    const opacity = Math.max(0, Math.min(1, estimate));
    let residualSquared = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const expected = pixels[backgroundOffset + channel] + opacity *
        (pixels[foregroundOffset + channel] - pixels[backgroundOffset + channel]);
      const residual = pixels[pixelOffset + channel] - expected;
      residualSquared += residual * residual;
    }
    if (residualSquared > 60 * 60 * 3) continue;
    alphaMask[index] = Math.min(alphaMask[index], Math.round(opacity * 255));
  }
  return alphaMask;
}

// Local edit templates use the supplied references for identity or product details
// and keep the original crop as the authority for pose, perspective and lighting.
const REPAIR_DETAILS = Object.freeze({
  head: "仅修复图一的完整头部（含头发）。以头部参考图为准，还原同一模特的脸型、五官比例、发际线、发型和发色；保留图一的头部角度、视线、表情和颈部连接。保留自然毛孔、细碎发丝和肤色层次，发缘与背景自然过渡，避免磨皮、塑料感和硬边。保持身体、服装和配饰不变。",
  upper: "仅替换图一的上衣。以单品参考图为准，还原版型、领口、肩线、袖长、袖口、下摆、门襟、面料纹理及可辨认的纽扣、图案和标志。让衣料顺着图一的肩、手臂和姿势自然垂坠与起褶，保留头发和手在衣服前方的遮挡，保持下装和鞋不变。",
  lower: "仅替换图一的下装。以单品参考图为准，还原腰头、裤裆或裙身、腿型或裙摆、长度、口袋、接缝、裤脚及可辨认的纹理和图案。按图一的腰线、腿部姿势和视角还原贴合与褶皱，保持原有上衣和下装的遮挡顺序、双腿轮廓和鞋的位置。",
  shoes: "仅修复图一中可见的鞋。以单品参考图为准，还原鞋头、鞋面、材质、颜色、鞋带或扣件、鞋底厚度和可见纹路。匹配图一每只脚的朝向、位置和透视，保留原有裤脚遮挡和接地阴影，保持腿部和服装不变。",
  clothes: "仅替换图一中参考图对应的服装。还原整体廓形、领口、袖口、腰线、下摆、面料及可辨认的图案和标志。保留图一的身体比例、姿势以及各层衣物和头发、手的遮挡关系，使衣料自然贴合与垂坠。"
});

function defaultRepairPrompt(part) {
  if (!Object.prototype.hasOwnProperty.call(REPAIR_DETAILS, part)) throw new Error("未知识别区域");
  return [
    "图一是待修的裁切原图，后续图片只提供对应部位的参考。",
    REPAIR_DETAILS[part],
    "保持图一的构图、透视、光线、背景和选区内其他内容，画面四边与原图对齐，便于原位回贴。仅输出一张完整修复图，保持图一的宽高比。只还原参考图中可辨认的商品细节，不新增文字、标志或装饰。"
  ].join("\n");
}

function createLocalSelectionClient({ folder, textFormat, launch, decodeBase64, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  async function parse(image, mode) {
    const id = "jx-segment-" + Date.now() + "-" + Math.random().toString(16).slice(2).padEnd(8, "0");
    const job = await folder.createFolder(id);
    const options = { format: textFormat };
    let response;
    try {
      const request = await job.createFile("request.json");
      await request.write(JSON.stringify({ protocol: PROTOCOL, image, mode }), options);
      // UXP creates the physical file on the first write.
      const ready = await job.createFile("ready");
      await ready.write(PROTOCOL, options);
      await launch();
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const output = (await job.getEntries()).find((entry) => entry.name === "response.json");
        if (output) {
          const text = await output.read(options);
          if (text.length > 500000) throw new Error("本地识别响应过大");
          response = JSON.parse(text);
          break;
        }
        await wait(250);
      }
    } finally {
      try {
        for (const entry of await job.getEntries()) {
          try { await entry.delete(); } catch (_) {}
        }
      } catch (_) {}
      try { await job.delete(); } catch (_) {}
    }
    if (!response) throw new Error("本地识别超时，请确认已允许启动识别程序后再试");
    if (response.protocol !== PROTOCOL) throw new Error("本地识别程序版本不匹配");
    if (response.error === "model_missing") throw new Error("未找到本地自动框选模型。请按插件说明配置自用模型，或手动框选");
    if (response.error) throw new Error("本地模型未能识别这张图，请重试或手动框选");
    if (mode === "reference" && Object.prototype.hasOwnProperty.call(response, "referencePart")) {
      const part = response.referencePart;
      if (part !== null && !Object.prototype.hasOwnProperty.call(PARTS, part)) throw new Error("本地参考图识别结果类别无效");
      return response;
    }
    if (response.width !== 512 || response.height !== 512 || typeof response.labels !== "string" || response.labels.length !== 349528) throw new Error("识别结果数据不完整");
    const labels = new Uint8Array(decodeBase64(response.labels));
    return { ...response, labels };
  }
  return {
    async classify(image) {
      const parsed = await parse(image, "reference");
      return parsed.labels ? classifyReference(parsed.labels) : parsed.referencePart;
    },
    async detect(image, width, height, part) {
      const parsed = await parse(image);
      return { ...selectionPlan(parsed.labels, parsed.width, parsed.height, width, height, part), inferenceMs: parsed.inferenceMs };
    },
    async detectGarments(image, width, height) {
      const parsed = await parse(image);
      return garmentSelectionPlans(parsed.labels, parsed.width, parsed.height, width, height)
        .map((plan) => ({ ...plan, inferenceMs: parsed.inferenceMs }));
    }
  };
}

module.exports = { PROTOCOL, PARTS, PART_LABELS, classifyReference, resolveReferencePart, resolveGarmentAssignments, garmentReplacementPrompt, selectionPlan, garmentSelectionPlans, featherMaskInward, featherMaskPercent, decontaminateGarmentEdge, refineGarmentMatte, defaultRepairPrompt, createLocalSelectionClient };
