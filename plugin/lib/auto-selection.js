"use strict";

const PROTOCOL = "jx-auto-selection-file-v1";
const PARTS = Object.freeze({ upper: [4, 17], lower: [5, 6], clothes: [4, 5, 6, 7, 8, 17], head: [1, 2, 3, 11], shoes: [9, 10] });
const PART_LABELS = Object.freeze({ upper: "上衣", lower: "下装", clothes: "整套服装", head: "头部（含头发）", shoes: "鞋" });

function classifyReference(labels) {
  const counts = new Uint32Array(18);
  for (const value of labels) {
    if (value > 17) throw new Error("本地识别结果类别无效");
    counts[value]++;
  }
  const ranked = [["head", PARTS.head], ["upper", PARTS.upper], ["lower", PARTS.lower], ["shoes", PARTS.shoes], ["clothes", [7]]]
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
  if (known.length > 1) throw new Error("参考图包含不同类别，请保留同一类参考图，或手动选择要修的部位");
  if (known.length !== 1) throw new Error("未识别到明确的单品类别，请添加白底单品图，或手动选择部位");
  return known[0];
}

function selectionPlan(labels, mapWidth, mapHeight, width, height, part) {
  if (!Object.prototype.hasOwnProperty.call(PARTS, part)) throw new Error("请选择有效的识别区域");
  if (![mapWidth, mapHeight, width, height].every(Number.isInteger) ||
      Math.min(mapWidth, mapHeight, width, height) < 1 ||
      mapWidth > 1024 || mapHeight > 1024 || labels.length !== mapWidth * mapHeight) throw new Error("识别结果尺寸无效");
  const wanted = PARTS[part];
  let left = mapWidth, top = mapHeight, right = 0, bottom = 0, count = 0;
  for (let y = 0; y < mapHeight; y++) for (let x = 0; x < mapWidth; x++) {
    const value = labels[y * mapWidth + x];
    if (value > 17) throw new Error("本地识别结果类别无效");
    if (!wanted.includes(value)) continue;
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
      if (wanted.includes(label) && (part === "head" || !protection[row * mapWidth + col])) {
        bytes[py * cropWidth + px] = 255;
      }
    }
  }
  return { bounds, target, ratio, part, mask: { bytes, width: cropWidth, height: cropHeight, bounds } };
}

function defaultRepairPrompt(part) {
  const region = PART_LABELS[part];
  if (!region) throw new Error("未知识别区域");
  if (part === "shoes") return "参照后续参考图修复图一中可见的鞋，准确还原鞋型、颜色、材质、鞋底和鞋面细节。保留图一的脚部姿势、腿部、服装、光线、背景和构图。仅返回与图一构图及宽高比一致的完整修复图，不要拼图或添加文字。";
  return part === "head"
    ? "以图一为待修复的原图，参照后续模特参考图修复完整头部及头发，准确还原模特身份、五官、发型和发色，保留图一的头部角度、表情、姿势、光线和背景。不要改变服装及画面构图。仅返回与图一构图及宽高比一致的完整修复图，不要拼图或添加文字。"
    : "以图一为待修复的原图，严格参照后续服装参考图修复" + region + "的款式、颜色、面料、纹理、领口、袖口、纽扣、印花和结构。保留图一的人物姿势、身体比例、脸、头发、皮肤、其他衣物、背景和光线，不要照搬参考图中的姿势或人物。仅返回与图一构图及宽高比一致的完整修复图，不要拼图或添加文字。";
}

function createLocalSelectionClient({ folder, textFormat, launch, decodeBase64, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  async function parse(image) {
    const id = "jx-segment-" + Date.now() + "-" + Math.random().toString(16).slice(2).padEnd(8, "0");
    const job = await folder.createFolder(id);
    const options = { format: textFormat };
    let response;
    try {
      const request = await job.createFile("request.json");
      await request.write(JSON.stringify({ protocol: PROTOCOL, image }), options);
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
    if (response.width !== 512 || response.height !== 512 || typeof response.labels !== "string" || response.labels.length !== 349528) throw new Error("识别结果数据不完整");
    const labels = new Uint8Array(decodeBase64(response.labels));
    return { ...response, labels };
  }
  return {
    async classify(image) { return classifyReference((await parse(image)).labels); },
    async detect(image, width, height, part) {
      const parsed = await parse(image);
      return { ...selectionPlan(parsed.labels, parsed.width, parsed.height, width, height, part), inferenceMs: parsed.inferenceMs };
    }
  };
}

module.exports = { PROTOCOL, PARTS, PART_LABELS, classifyReference, resolveReferencePart, selectionPlan, defaultRepairPrompt, createLocalSelectionClient };
