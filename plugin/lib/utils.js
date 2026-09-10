"use strict";

const { RATIO_SIZES, RATIO_ORDER } = require("./constants.js");

function asFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBounds(bounds) {
  if (!bounds) return null;
  const left = asFiniteNumber(bounds.left, NaN);
  const top = asFiniteNumber(bounds.top, NaN);
  const right = asFiniteNumber(bounds.right, NaN);
  const bottom = asFiniteNumber(bounds.bottom, NaN);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { left, top, right, bottom };
}

function clampBounds(bounds, documentWidth, documentHeight) {
  const normalized = normalizeBounds(bounds);
  if (!normalized) return null;
  const width = Math.max(0, Math.floor(asFiniteNumber(documentWidth, 0)));
  const height = Math.max(0, Math.floor(asFiniteNumber(documentHeight, 0)));
  const clamped = {
    left: Math.max(0, Math.floor(normalized.left)),
    top: Math.max(0, Math.floor(normalized.top)),
    right: Math.min(width, Math.ceil(normalized.right)),
    bottom: Math.min(height, Math.ceil(normalized.bottom))
  };
  if (clamped.right <= clamped.left || clamped.bottom <= clamped.top) return null;
  clamped.width = clamped.right - clamped.left;
  clamped.height = clamped.bottom - clamped.top;
  return clamped;
}

function computeTopLeftAlignmentOffset(currentBounds, targetBounds) {
  const current = normalizeBounds(currentBounds);
  const target = normalizeBounds(targetBounds);
  if (!current || !target) return { x: 0, y: 0 };
  return {
    x: target.left - current.left,
    y: target.top - current.top
  };
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeRgbColor(color) {
  return {
    r: Math.max(0, Math.min(255, Math.round(Number(color && color.r) || 0))),
    g: Math.max(0, Math.min(255, Math.round(Number(color && color.g) || 0))),
    b: Math.max(0, Math.min(255, Math.round(Number(color && color.b) || 0)))
  };
}

function rgbToHsl(red, green, blue) {
  const r = clampUnit(Number(red) / 255);
  const g = clampUnit(Number(green) / 255);
  const b = clampUnit(Number(blue) / 255);
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  let hue = 0;
  let saturation = 0;

  if (delta > 1e-7) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (maximum === r) hue = ((g - b) / delta) % 6;
    else if (maximum === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }

  return { h: clampUnit(hue), s: clampUnit(saturation), l: clampUnit(lightness) };
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((Number(hue) || 0) % 1 + 1) % 1;
  const s = clampUnit(saturation);
  const l = clampUnit(lightness);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = h * 6;
  const intermediate = chroma * (1 - Math.abs(section % 2 - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (section < 1) [r, g, b] = [chroma, intermediate, 0];
  else if (section < 2) [r, g, b] = [intermediate, chroma, 0];
  else if (section < 3) [r, g, b] = [0, chroma, intermediate];
  else if (section < 4) [r, g, b] = [0, intermediate, chroma];
  else if (section < 5) [r, g, b] = [intermediate, 0, chroma];
  else [r, g, b] = [chroma, 0, intermediate];

  const offset = l - chroma / 2;
  return {
    r: Math.round(clampUnit(r + offset) * 255),
    g: Math.round(clampUnit(g + offset) * 255),
    b: Math.round(clampUnit(b + offset) * 255)
  };
}

function recolorSelectedPixels(pixelBytes, selectionBytes, width, height, components, sourceColor, targetColor, tolerance) {
  const w = Math.max(0, Math.round(Number(width)));
  const h = Math.max(0, Math.round(Number(height)));
  const channelCount = Math.round(Number(components));
  const pixels = pixelBytes instanceof Uint8Array ? pixelBytes : new Uint8Array(pixelBytes || 0);
  const selection = selectionBytes instanceof Uint8Array ? selectionBytes : new Uint8Array(selectionBytes || 0);
  const pixelCount = w * h;
  if (!(w > 0) || !(h > 0) || ![3, 4].includes(channelCount)) {
    throw new Error("无效的换色像素尺寸");
  }
  if (pixels.length < pixelCount * channelCount || selection.length < pixelCount) {
    throw new Error("换色像素或选区蒙版不完整");
  }

  const source = normalizeRgbColor(sourceColor);
  const target = normalizeRgbColor(targetColor);
  const sourceHsl = rgbToHsl(source.r, source.g, source.b);
  const targetHsl = rgbToHsl(target.r, target.g, target.b);
  const range = Math.max(0.2, Math.min(1, Number(tolerance) || 0.55));
  const output = new Uint8Array(pixelCount * 4);
  let matchedPixels = 0;
  let strengthTotal = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const mask = selection[index] / 255;
    if (mask <= 0) continue;
    const inputOffset = index * channelCount;
    const pixelHsl = rgbToHsl(
      pixels[inputOffset],
      pixels[inputOffset + 1],
      pixels[inputOffset + 2]
    );
    let distance;
    if (sourceHsl.s < 0.08) {
      const saturationDifference = Math.abs(pixelHsl.s - sourceHsl.s) / (0.2 + range * 0.3);
      const lightnessDifference = Math.abs(pixelHsl.l - sourceHsl.l) / (0.32 + range * 0.45);
      distance = Math.sqrt(saturationDifference * saturationDifference * 0.52 + lightnessDifference * lightnessDifference * 0.48);
    } else {
      const rawHueDistance = Math.abs(pixelHsl.h - sourceHsl.h);
      const hueDistance = Math.min(rawHueDistance, 1 - rawHueDistance);
      const hueReliability = Math.min(1, pixelHsl.s / 0.14);
      const hueDifference = hueDistance / (0.045 + range * 0.14) * hueReliability;
      const saturationDifference = Math.abs(pixelHsl.s - sourceHsl.s) / (0.24 + range * 0.48);
      const lightnessDifference = Math.abs(pixelHsl.l - sourceHsl.l) / (0.36 + range * 0.55);
      distance = Math.sqrt(
        hueDifference * hueDifference * 0.58 +
        saturationDifference * saturationDifference * 0.22 +
        lightnessDifference * lightnessDifference * 0.2
      );
    }

    let similarity = clampUnit(1 - distance);
    similarity = similarity * similarity * (3 - 2 * similarity);
    if (similarity <= 0.01) continue;

    const recoloredSaturation = clampUnit(targetHsl.s + (pixelHsl.s - sourceHsl.s) * 0.35);
    const recoloredLightness = clampUnit(pixelHsl.l + (targetHsl.l - sourceHsl.l) * 0.72);
    const recolored = hslToRgb(targetHsl.h, recoloredSaturation, recoloredLightness);
    const inputAlpha = channelCount === 4 ? pixels[inputOffset + 3] / 255 : 1;
    const outputAlpha = clampUnit(mask * inputAlpha * similarity);
    const outputOffset = index * 4;
    output[outputOffset] = recolored.r;
    output[outputOffset + 1] = recolored.g;
    output[outputOffset + 2] = recolored.b;
    output[outputOffset + 3] = Math.round(outputAlpha * 255);
    if (outputAlpha > 0.035) matchedPixels += 1;
    strengthTotal += outputAlpha;
  }

  return {
    pixels: output,
    matchedPixels,
    strengthTotal,
    source,
    target
  };
}

function srgbChannelToLinear(value) {
  const channel = clampUnit(Number(value) / 255);
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function linearChannelToSrgb(value) {
  const channel = Number(value) || 0;
  const encoded = channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * Math.pow(Math.max(0, channel), 1 / 2.4) - 0.055;
  return Math.round(clampUnit(encoded) * 255);
}

function rgbToOklab(red, green, blue) {
  const r = srgbChannelToLinear(red);
  const g = srgbChannelToLinear(green);
  const b = srgbChannelToLinear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  };
}

function oklabToRgb(lightness, greenRed, blueYellow) {
  const lRoot = lightness + 0.3963377774 * greenRed + 0.2158037573 * blueYellow;
  const mRoot = lightness - 0.1055613458 * greenRed - 0.0638541728 * blueYellow;
  const sRoot = lightness - 0.0894841775 * greenRed - 1.291485548 * blueYellow;
  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;
  return {
    r: linearChannelToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearChannelToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearChannelToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  };
}

function quantile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  const position = clampUnit(fraction) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const mix = position - lower;
  return sortedValues[lower] * (1 - mix) + sortedValues[upper] * mix;
}

function summarizeColorChannel(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  return {
    p01: quantile(sorted, 0.01),
    p05: quantile(sorted, 0.05),
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99)
  };
}

function analyzeColorRegion(pixelBytes, selectionBytes, width, height, components, maximumSamples) {
  const w = Math.max(0, Math.round(Number(width)));
  const h = Math.max(0, Math.round(Number(height)));
  const channelCount = Math.round(Number(components));
  const pixels = pixelBytes instanceof Uint8Array ? pixelBytes : new Uint8Array(pixelBytes || 0);
  const selection = selectionBytes instanceof Uint8Array ? selectionBytes : new Uint8Array(selectionBytes || 0);
  const pixelCount = w * h;
  if (!(w > 0) || !(h > 0) || ![3, 4].includes(channelCount)) throw new Error("无效的颜色样板尺寸");
  if (pixels.length < pixelCount * channelCount || selection.length < pixelCount) {
    throw new Error("颜色样板像素或选区蒙版不完整");
  }

  const limit = Math.max(1000, Math.min(120000, Math.round(Number(maximumSamples)) || 80000));
  const stride = Math.max(1, Math.floor(pixelCount / limit));
  const lightness = [];
  const greenRed = [];
  const blueYellow = [];
  let selectedPixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const inputOffset = index * channelCount;
    const inputAlpha = channelCount === 4 ? pixels[inputOffset + 3] / 255 : 1;
    const weight = selection[index] / 255 * inputAlpha;
    if (weight <= 0.08) continue;
    selectedPixels += 1;
    if (index % stride !== 0 || weight < 0.35) continue;
    const lab = rgbToOklab(pixels[inputOffset], pixels[inputOffset + 1], pixels[inputOffset + 2]);
    lightness.push(lab.l);
    greenRed.push(lab.a);
    blueYellow.push(lab.b);
  }
  if (lightness.length < 16) throw new Error("选区中的有效衣服像素太少");
  const lightnessStats = summarizeColorChannel(lightness);
  const surfaceLightness = [];
  const surfaceGreenRed = [];
  const surfaceBlueYellow = [];
  for (let index = 0; index < lightness.length; index += 1) {
    if (lightness[index] < lightnessStats.p25 || lightness[index] > lightnessStats.p90) continue;
    surfaceLightness.push(lightness[index]);
    surfaceGreenRed.push(greenRed[index]);
    surfaceBlueYellow.push(blueYellow[index]);
  }
  const surfaceAvailable = surfaceLightness.length >= 12;
  const surface = surfaceAvailable ? {
    l: summarizeColorChannel(surfaceLightness).p50,
    a: summarizeColorChannel(surfaceGreenRed).p50,
    b: summarizeColorChannel(surfaceBlueYellow).p50,
    samples: surfaceLightness.length
  } : null;
  const fabricDistances = [];
  const fabricCenterA = surface ? surface.a : summarizeColorChannel(greenRed).p50;
  const fabricCenterB = surface ? surface.b : summarizeColorChannel(blueYellow).p50;
  for (let index = 0; index < lightness.length; index += 1) {
    const deltaA = greenRed[index] - fabricCenterA;
    const deltaB = blueYellow[index] - fabricCenterB;
    fabricDistances.push(Math.sqrt(deltaA * deltaA + deltaB * deltaB));
  }
  const sortedFabricDistances = fabricDistances.slice().sort((left, right) => left - right);
  const fabricDistanceLimit = Math.max(
    0.012,
    Math.min(0.045, quantile(sortedFabricDistances, 0.72) * 1.5)
  );
  const fabricSamples = [];
  for (let index = 0; index < lightness.length; index += 1) {
    if (fabricDistances[index] > fabricDistanceLimit) continue;
    fabricSamples.push({ l: lightness[index], a: greenRed[index], b: blueYellow[index] });
  }
  const usableFabricSamples = fabricSamples.length >= 16
    ? fabricSamples
    : lightness.map((value, index) => ({ l: value, a: greenRed[index], b: blueYellow[index] }));
  usableFabricSamples.sort((left, right) => left.l - right.l);
  const fabricLightness = usableFabricSamples.map((sample) => sample.l);
  const toneCurve = [0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95].map((position) => {
    const centerIndex = Math.round(position * (usableFabricSamples.length - 1));
    const halfWindow = Math.max(3, Math.round(usableFabricSamples.length * 0.055));
    const start = Math.max(0, centerIndex - halfWindow);
    const end = Math.min(usableFabricSamples.length, centerIndex + halfWindow + 1);
    const window = usableFabricSamples.slice(start, end);
    const windowLightness = window.map((sample) => sample.l);
    const windowGreenRed = window.map((sample) => sample.a);
    const windowBlueYellow = window.map((sample) => sample.b);
    return {
      position,
      l: summarizeColorChannel(windowLightness).p50,
      a: summarizeColorChannel(windowGreenRed).p50,
      b: summarizeColorChannel(windowBlueYellow).p50
    };
  });
  const stats = {
    l: lightnessStats,
    a: summarizeColorChannel(greenRed),
    b: summarizeColorChannel(blueYellow),
    surface,
    fabricL: summarizeColorChannel(fabricLightness),
    toneCurve,
    fabricSamples: usableFabricSamples.length,
    samples: lightness.length,
    selectedPixels
  };
  const previewLightness = stats.surface ? stats.surface.l : stats.l.p50;
  const previewGreenRed = stats.surface ? stats.surface.a : stats.a.p50;
  const previewBlueYellow = stats.surface ? stats.surface.b : stats.b.p50;
  stats.previewColor = oklabToRgb(previewLightness, previewGreenRed, previewBlueYellow);
  return stats;
}

const COLOR_QUANTILE_KEYS = Object.freeze(["p01", "p05", "p10", "p25", "p50", "p75", "p90", "p95", "p99"]);
const COLOR_QUANTILE_POSITIONS = Object.freeze([0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]);

function mapColorChannelByQuantiles(value, targetChannel, sourceChannel) {
  const firstKey = COLOR_QUANTILE_KEYS[0];
  const lastKey = COLOR_QUANTILE_KEYS[COLOR_QUANTILE_KEYS.length - 1];
  if (Math.abs(targetChannel[lastKey] - targetChannel[firstKey]) < 1e-7) {
    return sourceChannel.p50;
  }
  if (value <= targetChannel[firstKey]) return sourceChannel[firstKey];
  if (value >= targetChannel[lastKey]) return sourceChannel[lastKey];
  for (let index = 1; index < COLOR_QUANTILE_KEYS.length; index += 1) {
    const lowerKey = COLOR_QUANTILE_KEYS[index - 1];
    const upperKey = COLOR_QUANTILE_KEYS[index];
    const lower = targetChannel[lowerKey];
    const upper = targetChannel[upperKey];
    if (value > upper) continue;
    const span = upper - lower;
    const mix = Math.abs(span) < 1e-8 ? 0.5 : clampUnit((value - lower) / span);
    return sourceChannel[lowerKey] * (1 - mix) + sourceChannel[upperKey] * mix;
  }
  return sourceChannel[lastKey];
}

function colorValuePercentile(value, channel) {
  const firstKey = COLOR_QUANTILE_KEYS[0];
  const lastKey = COLOR_QUANTILE_KEYS[COLOR_QUANTILE_KEYS.length - 1];
  if (Math.abs(channel[lastKey] - channel[firstKey]) < 1e-7) return 0.5;
  if (value <= channel[firstKey]) return COLOR_QUANTILE_POSITIONS[0];
  if (value >= channel[lastKey]) return COLOR_QUANTILE_POSITIONS[COLOR_QUANTILE_POSITIONS.length - 1];
  for (let index = 1; index < COLOR_QUANTILE_KEYS.length; index += 1) {
    const lowerKey = COLOR_QUANTILE_KEYS[index - 1];
    const upperKey = COLOR_QUANTILE_KEYS[index];
    if (value > channel[upperKey]) continue;
    const span = channel[upperKey] - channel[lowerKey];
    const mix = Math.abs(span) < 1e-8 ? 0.5 : clampUnit((value - channel[lowerKey]) / span);
    return COLOR_QUANTILE_POSITIONS[index - 1] * (1 - mix) + COLOR_QUANTILE_POSITIONS[index] * mix;
  }
  return 0.5;
}

function sampleFabricTone(toneCurve, position, fallback) {
  if (!Array.isArray(toneCurve) || !toneCurve.length) return fallback;
  if (position <= toneCurve[0].position) return toneCurve[0];
  const last = toneCurve[toneCurve.length - 1];
  if (position >= last.position) return last;
  for (let index = 1; index < toneCurve.length; index += 1) {
    const lower = toneCurve[index - 1];
    const upper = toneCurve[index];
    if (position > upper.position) continue;
    const span = upper.position - lower.position;
    const mix = span <= 0 ? 0.5 : clampUnit((position - lower.position) / span);
    return {
      position,
      l: lower.l * (1 - mix) + upper.l * mix,
      a: lower.a * (1 - mix) + upper.a * mix,
      b: lower.b * (1 - mix) + upper.b * mix
    };
  }
  return fallback;
}

function transferColorRegion(pixelBytes, selectionBytes, width, height, components, sourceStats, targetStats) {
  const w = Math.max(0, Math.round(Number(width)));
  const h = Math.max(0, Math.round(Number(height)));
  const channelCount = Math.round(Number(components));
  const pixels = pixelBytes instanceof Uint8Array ? pixelBytes : new Uint8Array(pixelBytes || 0);
  const selection = selectionBytes instanceof Uint8Array ? selectionBytes : new Uint8Array(selectionBytes || 0);
  const pixelCount = w * h;
  if (!(w > 0) || !(h > 0) || ![3, 4].includes(channelCount)) throw new Error("无效的颜色匹配尺寸");
  if (pixels.length < pixelCount * channelCount || selection.length < pixelCount) {
    throw new Error("颜色匹配像素或选区蒙版不完整");
  }
  if (!sourceStats || !targetStats || !sourceStats.l || !targetStats.l) {
    throw new Error("颜色样板数据不完整");
  }

  const sourceLightness = sourceStats.fabricL || sourceStats.l;
  const targetLightness = targetStats.fabricL || targetStats.l;
  const sourceGreenRedCenter = sourceStats.surface ? sourceStats.surface.a : sourceStats.a.p50;
  const sourceBlueYellowCenter = sourceStats.surface ? sourceStats.surface.b : sourceStats.b.p50;
  const targetGreenRedCenter = targetStats.surface ? targetStats.surface.a : targetStats.a.p50;
  const targetBlueYellowCenter = targetStats.surface ? targetStats.surface.b : targetStats.b.p50;
  const clampChannel = (value, channel, padding) => Math.max(
    channel.p01 - padding,
    Math.min(channel.p99 + padding, value)
  );
  const smoothRange = (value, start, end) => {
    if (value <= start) return 0;
    if (value >= end || end <= start) return 1;
    const amount = clampUnit((value - start) / (end - start));
    return amount * amount * (3 - 2 * amount);
  };
  const output = new Uint8Array(pixelCount * 4);
  let affectedPixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const mask = selection[index] / 255;
    if (mask <= 0) continue;
    const inputOffset = index * channelCount;
    const inputAlpha = channelCount === 4 ? pixels[inputOffset + 3] / 255 : 1;
    if (inputAlpha <= 0) continue;
    const lab = rgbToOklab(pixels[inputOffset], pixels[inputOffset + 1], pixels[inputOffset + 2]);
    const tonePosition = colorValuePercentile(lab.l, targetLightness);
    const sourceTone = sampleFabricTone(sourceStats.toneCurve, tonePosition, {
      l: sourceLightness.p50,
      a: sourceGreenRedCenter,
      b: sourceBlueYellowCenter
    });
    const targetTone = sampleFabricTone(targetStats.toneCurve, tonePosition, {
      l: targetLightness.p50,
      a: targetGreenRedCenter,
      b: targetBlueYellowCenter
    });
    const matchedLightness = mapColorChannelByQuantiles(lab.l, targetLightness, sourceLightness);
    const matchedGreenRed = clampChannel(
      sourceTone.a + (lab.a - targetTone.a) * 0.1,
      sourceStats.a,
      0.008
    );
    const matchedBlueYellow = clampChannel(
      sourceTone.b + (lab.b - targetTone.b) * 0.1,
      sourceStats.b,
      0.008
    );
    const matched = oklabToRgb(matchedLightness, matchedGreenRed, matchedBlueYellow);
    let detailStrength = 1;
    if (targetLightness.p50 > 0.52) {
      detailStrength *= smoothRange(lab.l, 0.12, 0.3);
    }
    detailStrength *= smoothRange(lab.l, targetLightness.p01, targetLightness.p05);
    const outputOffset = index * 4;
    output[outputOffset] = matched.r;
    output[outputOffset + 1] = matched.g;
    output[outputOffset + 2] = matched.b;
    output[outputOffset + 3] = Math.round(clampUnit(mask * inputAlpha * detailStrength) * 255);
    if (output[outputOffset + 3] > 8) affectedPixels += 1;
  }
  return { pixels: output, affectedPixels };
}

function nominalRatio(label) {
  const parts = String(label).split(":");
  if (parts.length !== 2) return NaN;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!(width > 0) || !(height > 0)) return NaN;
  return width / height;
}

function findClosestRatio(width, height) {
  const actual = Number(width) / Number(height);
  if (!(actual > 0) || !Number.isFinite(actual)) return "1:1";
  let best = RATIO_ORDER[0];
  let bestDistance = Infinity;
  for (const label of RATIO_ORDER) {
    const distance = Math.abs(Math.log(actual / nominalRatio(label)));
    if (distance < bestDistance) {
      best = label;
      bestDistance = distance;
    }
  }
  return best;
}

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size));
  if (!match) throw new Error("无效的输出尺寸");
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    value: String(size)
  };
}

function resolveOutputSize(aspectRatio, resolution, sourceWidth, sourceHeight) {
  const level = ["1K", "2K", "4K"].includes(resolution) ? resolution : "2K";
  const ratio = aspectRatio === "auto"
    ? findClosestRatio(sourceWidth, sourceHeight)
    : String(aspectRatio);
  if (!RATIO_SIZES[ratio]) throw new Error("不支持的画面比例");
  const parsed = parseSize(RATIO_SIZES[ratio][level]);
  return {
    ratio,
    resolution: level,
    size: parsed.value,
    width: parsed.width,
    height: parsed.height,
    automatic: aspectRatio === "auto"
  };
}

function computeCoverCrop(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sw = Math.max(1, Math.round(Number(sourceWidth)));
  const sh = Math.max(1, Math.round(Number(sourceHeight)));
  const tw = Math.max(1, Math.round(Number(targetWidth)));
  const th = Math.max(1, Math.round(Number(targetHeight)));
  const sourceRatio = sw / sh;
  const targetRatio = tw / th;

  if (Math.abs(sourceRatio - targetRatio) < 1e-9) {
    return { left: 0, top: 0, right: sw, bottom: sh, width: sw, height: sh };
  }

  if (sourceRatio > targetRatio) {
    const cropWidth = Math.max(1, Math.min(sw, Math.round(sh * targetRatio)));
    const left = Math.floor((sw - cropWidth) / 2);
    return { left, top: 0, right: left + cropWidth, bottom: sh, width: cropWidth, height: sh };
  }

  const cropHeight = Math.max(1, Math.min(sh, Math.round(sw / targetRatio)));
  const top = Math.floor((sh - cropHeight) / 2);
  return { left: 0, top, right: sw, bottom: top + cropHeight, width: sw, height: cropHeight };
}

function normalizePricingModelName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizePricingTierName(value) {
  return String(value || "").toUpperCase().replace(/[^0-9A-Z]+/g, "");
}

function pricingNumber(value) {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct >= 0) return Math.round(direct * 10000) / 10000;
  const match = String(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 10000) / 10000 : null;
}

function pricingEntryPrice(entry) {
  if (typeof entry === "number" || typeof entry === "string") return pricingNumber(entry);
  if (!entry || typeof entry !== "object") return null;
  for (const key of ["price", "api_price", "apiPrice", "unit_price", "unitPrice", "amount", "value"]) {
    const price = pricingNumber(entry[key]);
    if (price !== null) return price;
  }
  return null;
}

function pricingEntryEnabled(entry, price) {
  if (price === null) return false;
  if (!entry || typeof entry !== "object") return true;
  let raw;
  let found = false;
  for (const key of ["enable", "enabled", "is_enabled", "isEnabled", "available", "status"]) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) {
      raw = entry[key];
      found = true;
      break;
    }
  }
  if (!found || raw === null || raw === undefined || raw === "") return true;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  const normalized = String(raw).trim().toLowerCase();
  if (["0", "false", "off", "disabled", "disable", "inactive", "unavailable", "停用", "不可用"].includes(normalized)) {
    return false;
  }
  return true;
}

function pricingEntryForSize(priceMap, size) {
  const wanted = normalizePricingTierName(size);
  if (Array.isArray(priceMap)) {
    return priceMap.find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      return [entry.size, entry.resolution, entry.level, entry.tier, entry.name, entry.key]
        .some((value) => normalizePricingTierName(value) === wanted);
    }) || null;
  }
  if (!priceMap || typeof priceMap !== "object") return null;
  const key = Object.keys(priceMap).find((item) => normalizePricingTierName(item) === wanted);
  return key ? priceMap[key] : null;
}

function priceMapHasSizes(priceMap, sizes) {
  return sizes.some((size) => pricingEntryPrice(pricingEntryForSize(priceMap, size)) !== null);
}

function pricingMapsForRecord(record, sizes) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  const output = [];
  if (priceMapHasSizes(record, sizes)) output.push({ priceMap: record, priceKey: "" });
  for (const key of ["api_price", "apiPrice", "prices", "pricing", "price_table", "priceTable"]) {
    const container = record[key];
    if (!container || typeof container !== "object") continue;
    if (priceMapHasSizes(container, sizes)) {
      output.push({ priceMap: container, priceKey: "" });
      continue;
    }
    if (!Array.isArray(container)) {
      for (const [nestedKey, nestedValue] of Object.entries(container)) {
        if (nestedValue && typeof nestedValue === "object" && priceMapHasSizes(nestedValue, sizes)) {
          output.push({ priceMap: nestedValue, priceKey: nestedKey });
        }
      }
    }
  }
  return output;
}

function pricingRecordNames(record, sourceKey, priceKey) {
  const names = [];
  if (record && typeof record === "object") {
    for (const key of [
      "model_name", "modelName", "model", "model_id", "modelId", "id",
      "name", "display_name", "displayName", "title", "code", "slug"
    ]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) names.push(value.trim());
    }
  }
  const genericKeys = new Set(["data", "result", "models", "items", "list", "records", "pricing", "prices"]);
  for (const value of [priceKey, sourceKey]) {
    const text = String(value || "").trim();
    if (text && !genericKeys.has(text.toLowerCase()) && !/^\d+$/.test(text)) names.push(text);
  }
  return Array.from(new Set(names));
}

function collectPricingCandidates(payload, sizes) {
  const queue = [{ value: payload, sourceKey: "", depth: 0 }];
  const seen = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  const candidates = [];
  let visited = 0;
  while (queue.length && visited < 600) {
    const current = queue.shift();
    const value = current.value;
    if (!value || typeof value !== "object") continue;
    if (seen && seen.has(value)) continue;
    if (seen) seen.add(value);
    visited += 1;
    if (!Array.isArray(value)) {
      for (const pricingMap of pricingMapsForRecord(value, sizes)) {
        candidates.push({
          record: value,
          priceMap: pricingMap.priceMap,
          names: pricingRecordNames(value, current.sourceKey, pricingMap.priceKey)
        });
      }
    }
    if (current.depth >= 5) continue;
    if (Array.isArray(value)) {
      value.slice(0, 200).forEach((item, index) => {
        queue.push({ value: item, sourceKey: String(index), depth: current.depth + 1 });
      });
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (["api_price", "apiPrice", "prices", "pricing", "price_table", "priceTable"].includes(key)) continue;
        if (child && typeof child === "object") {
          queue.push({ value: child, sourceKey: key, depth: current.depth + 1 });
        }
      }
    }
  }
  return candidates;
}

function pricingCandidateScore(candidate, configuredModel) {
  const wanted = normalizePricingModelName(configuredModel);
  const aliases = wanted === "gptimage2"
    ? new Set(["gptimage2", "gpimage2", "image2", "iamge2"])
    : new Set([wanted]);
  let best = -1;
  for (const name of candidate.names || []) {
    const normalized = normalizePricingModelName(name);
    if (!normalized) continue;
    if (normalized === wanted) best = Math.max(best, 100);
    else if (aliases.has(normalized)) best = Math.max(best, 90);
    else if (wanted && (normalized.endsWith(wanted) || normalized.startsWith(wanted))) best = Math.max(best, 75);
  }
  return best;
}

function extractPricingSnapshot(payload, configuredModel, requestedSizes) {
  const sizes = Array.isArray(requestedSizes) && requestedSizes.length
    ? requestedSizes.map(String)
    : ["1K", "2K", "4K"];
  const candidates = collectPricingCandidates(payload, sizes);
  if (!candidates.length) return null;
  const ranked = candidates
    .map((candidate) => ({ candidate, score: pricingCandidateScore(candidate, configuredModel) }))
    .sort((left, right) => right.score - left.score);
  let selected = ranked[0];
  if (!selected || selected.score < 0) {
    const unnamed = candidates.filter((candidate) => !(candidate.names && candidate.names.length));
    if (candidates.length !== 1 || unnamed.length !== 1) return null;
    selected = { candidate: unnamed[0], score: 0 };
  }

  const prices = {};
  const enabled = {};
  const updateTimes = [];
  for (const size of sizes) {
    const entry = pricingEntryForSize(selected.candidate.priceMap, size);
    const price = pricingEntryPrice(entry);
    prices[size] = price;
    enabled[size] = pricingEntryEnabled(entry, price);
    if (entry && typeof entry === "object") {
      for (const key of ["updated_at", "updatedAt", "update_time", "updateTime"]) {
        if (entry[key]) updateTimes.push(String(entry[key]));
      }
    }
  }
  const record = selected.candidate.record;
  if (record && typeof record === "object") {
    for (const key of ["updated_at", "updatedAt", "update_time", "updateTime"]) {
      if (record[key]) updateTimes.push(String(record[key]));
    }
  }
  return {
    prices,
    enabled,
    serviceUpdatedAt: updateTimes.sort().pop() || "",
    matchedModel: selected.candidate.names[0] || String(configuredModel || "")
  };
}

function normalizeBase64(input) {
  const source = String(input || "")
    .replace(/^data:[^,]*;base64,/i, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  if (!source || source.length % 4 === 1) throw new Error("返回的 Base64 图片无效");
  return source;
}

function estimateBase64Bytes(input) {
  const source = normalizeBase64(input);
  return Math.floor(source.length * 6 / 8);
}

function base64ToArrayBuffer(input, maxBytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const source = normalizeBase64(input);
  const outputLength = Math.floor(source.length * 6 / 8);
  if (maxBytes && outputLength > maxBytes) throw new Error("返回图片超过插件的安全上限");

  const output = new Uint8Array(outputLength);
  let accumulator = 0;
  let bitCount = 0;
  let outputIndex = 0;

  for (let index = 0; index < source.length; index += 1) {
    const value = alphabet.indexOf(source[index]);
    if (value < 0) throw new Error("返回的 Base64 图片包含无效字符");
    accumulator = (accumulator << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      output[outputIndex] = (accumulator >> bitCount) & 0xff;
      outputIndex += 1;
      accumulator &= bitCount ? (1 << bitCount) - 1 : 0;
    }
  }
  return output.buffer;
}

function arrayBufferToBase64(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(exactArrayBuffer(value));
  const chunks = [];
  const chunkSize = 3 * 4096;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const end = Math.min(bytes.length, start + chunkSize);
    let output = "";
    for (let index = start; index < end; index += 3) {
      const first = bytes[index];
      const hasSecond = index + 1 < end;
      const hasThird = index + 2 < end;
      const second = hasSecond ? bytes[index + 1] : 0;
      const third = hasThird ? bytes[index + 2] : 0;
      const combined = (first << 16) | (second << 8) | third;
      output += alphabet[(combined >> 18) & 0x3f];
      output += alphabet[(combined >> 12) & 0x3f];
      output += hasSecond ? alphabet[(combined >> 6) & 0x3f] : "=";
      output += hasThird ? alphabet[combined & 0x3f] : "=";
    }
    chunks.push(output);
  }
  return chunks.join("");
}

function startsWithBytes(bytes, signature) {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32BE(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  ) >>> 0;
}

function jpegDimensions(bytes) {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += length;
  }
  throw new Error("JPEG 图片头无效或缺少尺寸信息");
}

function webpDimensions(bytes) {
  if (bytes.length < 25) throw new Error("WebP 图片头不完整");
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === "VP8X") {
    if (bytes.length < 30) throw new Error("WebP VP8X 图片头不完整");
    if (bytes[20] & 0x02) throw new Error("不支持动画 WebP 结果");
    return {
      width: readUint24LE(bytes, 24) + 1,
      height: readUint24LE(bytes, 27) + 1
    };
  }
  if (chunk === "VP8 ") {
    if (
      bytes.length < 30 || bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 || bytes[25] !== 0x2a
    ) {
      throw new Error("WebP VP8 图片头无效");
    }
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff
    };
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) throw new Error("WebP VP8L 图片头无效");
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)
    };
  }
  throw new Error("不支持该 WebP 编码格式");
}

function ensureImageDimensions(type, dimensions) {
  const width = Number(dimensions && dimensions.width);
  const height = Number(dimensions && dimensions.height);
  if (!(width > 0) || !(height > 0) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new Error(`${type} 图片尺寸无效`);
  }
  return { width, height };
}

function detectImageType(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (
      bytes.length < 24 || bytes[12] !== 0x49 || bytes[13] !== 0x48 ||
      bytes[14] !== 0x44 || bytes[15] !== 0x52
    ) {
      throw new Error("PNG 图片头无效或缺少 IHDR");
    }
    const dimensions = ensureImageDimensions("PNG", {
      width: readUint32BE(bytes, 16),
      height: readUint32BE(bytes, 20)
    });
    return { mime: "image/png", extension: "png", width: dimensions.width, height: dimensions.height };
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    const dimensions = ensureImageDimensions("JPEG", jpegDimensions(bytes));
    return { mime: "image/jpeg", extension: "jpg", width: dimensions.width, height: dimensions.height };
  }
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const dimensions = ensureImageDimensions("WebP", webpDimensions(bytes));
    return { mime: "image/webp", extension: "webp", width: dimensions.width, height: dimensions.height };
  }
  throw new Error("接口返回的不是可识别的 PNG、JPEG 或静态 WebP 图片");
}

function responseContainers(payload) {
  if (!payload || typeof payload !== "object") return [];
  const containers = [payload];
  if (payload.result && typeof payload.result === "object") containers.push(payload.result);
  if (payload.response && typeof payload.response === "object") containers.push(payload.response);
  return containers;
}

function candidateItems(container) {
  const items = [];
  if (Array.isArray(container.data)) items.push.apply(items, container.data);
  if (Array.isArray(container.images)) items.push.apply(items, container.images);
  items.push(container);
  return items.filter((item) => item && typeof item === "object");
}

function extractImageCandidate(payload) {
  const containers = responseContainers(payload);
  const allItems = [];
  for (const container of containers) allItems.push.apply(allItems, candidateItems(container));

  if (payload && Array.isArray(payload.candidates)) {
    for (const candidate of payload.candidates) {
      const content = candidate && candidate.content;
      if (content && Array.isArray(content.parts)) allItems.push.apply(allItems, content.parts);
    }
  }

  const base64Candidates = [];
  const urlCandidates = [];
  for (const item of allItems) {
    const base64 = item.b64_json || item.base64 || item.image_base64;
    if (typeof base64 === "string" && base64.trim()) {
      base64Candidates.push({ kind: "base64", value: base64, contentType: item.mime_type || item.content_type || "" });
    }
    if (typeof item.url === "string" && item.url.trim()) {
      urlCandidates.push({ kind: "url", value: item.url.trim(), contentType: item.mime_type || item.content_type || "" });
    }
    const inlineData = item.inlineData || item.inline_data;
    if (inlineData && typeof inlineData === "object") {
      const inlineBase64 = inlineData.data || inlineData.b64_json || inlineData.base64;
      if (typeof inlineBase64 === "string" && inlineBase64.trim()) {
        base64Candidates.push({
          kind: "base64",
          value: inlineBase64,
          contentType: inlineData.mimeType || inlineData.mime_type || inlineData.contentType || inlineData.content_type || ""
        });
      }
    }
    const fileData = item.fileData || item.file_data;
    if (fileData && typeof fileData === "object") {
      const fileUrl = fileData.fileUri || fileData.file_uri || fileData.url;
      if (typeof fileUrl === "string" && fileUrl.trim()) {
        urlCandidates.push({
          kind: "url",
          value: fileUrl.trim(),
          contentType: fileData.mimeType || fileData.mime_type || fileData.contentType || fileData.content_type || ""
        });
      }
    }
  }

  const candidates = base64Candidates.length ? base64Candidates : urlCandidates;
  if (!candidates.length) return null;
  return Object.assign({}, candidates[0], { count: candidates.length });
}

function extractTextCandidate(payload) {
  const containers = responseContainers(payload);
  const texts = [];
  const appendContentText = (content) => {
    if (typeof content === "string" && content.trim()) {
      texts.push(content.trim());
      return;
    }
    if (!Array.isArray(content)) return;
    const joined = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.output_text === "string") return part.output_text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (joined) texts.push(joined);
  };
  for (const container of containers) {
    if (typeof container.text === "string" && container.text.trim()) texts.push(container.text.trim());
    if (typeof container.output_text === "string" && container.output_text.trim()) texts.push(container.output_text.trim());
    appendContentText(container.content);
    if (Array.isArray(container.output)) {
      for (const item of container.output) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.text === "string" && item.text.trim()) texts.push(item.text.trim());
        appendContentText(item.content);
      }
    }
    if (Array.isArray(container.choices)) {
      for (const choice of container.choices) {
        if (!choice || typeof choice !== "object") continue;
        appendContentText(choice.message && choice.message.content);
        appendContentText(choice.delta && choice.delta.content);
        if (typeof choice.text === "string" && choice.text.trim()) texts.push(choice.text.trim());
      }
    }
    if (!Array.isArray(container.candidates)) continue;
    for (const candidate of container.candidates) {
      const content = candidate && candidate.content;
      if (!content || !Array.isArray(content.parts)) continue;
      const candidateText = content.parts
        .map((part) => part && typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n")
        .trim();
      if (candidateText) texts.push(candidateText);
    }
  }
  return texts.length ? texts[0] : "";
}

function promptReferenceMentions(value) {
  return String(value || "").match(/@(?:图片|图层|选区|全图|图)(?:[一二三四五六七八九十百零〇两\d]+)?/g) || [];
}

function cleanOptimizedPrompt(value) {
  let text = String(value || "").trim();
  const fenced = /^```(?:[a-z]+)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^(?:优化后的提示词|优化结果|提示词)\s*[：:]\s*/i, "").trim();
  if (
    text.length >= 2 &&
    ((text[0] === "\"" && text[text.length - 1] === "\"") ||
      (text[0] === "“" && text[text.length - 1] === "”"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function parseJsonObject(value) {
  if (!value || typeof value !== "string") return null;
  const text = value.trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function extractHistoryRecords(payload) {
  const records = [];
  const seen = new Set();
  const addArray = (value) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== "object" || seen.has(item)) continue;
      seen.add(item);
      records.push(item);
    }
  };
  const listKeys = ["items", "records", "list", "history", "results", "data"];
  const roots = [payload];
  if (payload && typeof payload === "object") {
    roots.push(payload.data, payload.result, payload.response);
  }
  for (const root of roots) {
    if (!root) continue;
    addArray(root);
    if (typeof root !== "object" || Array.isArray(root)) continue;
    for (const key of listKeys) addArray(root[key]);
    for (const key of ["pagination", "page", "payload"]) {
      const nested = root[key];
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
      for (const listKey of listKeys) addArray(nested[listKey]);
    }
  }
  return records;
}

function historyValueSources(record) {
  const sources = [];
  const seen = new Set();
  const add = (value) => {
    if (!value) return;
    const parsed = parseJsonObject(value);
    const candidate = parsed || value;
    if (
      candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
      !seen.has(candidate) && sources.length < 24
    ) {
      seen.add(candidate);
      sources.push(candidate);
    }
  };
  add(record);
  if (record && typeof record === "object") {
    for (const key of ["request", "input", "params", "request_body", "request_data", "metadata", "meta"]) {
      add(record[key]);
    }
  }
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    for (const key of ["body", "payload", "data", "request", "input", "params", "request_body", "request_data"]) {
      add(source[key]);
    }
  }
  return sources;
}

function firstHistoryValue(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim()) return value;
    }
  }
  return "";
}

function allHistoryValues(sources, keys) {
  const values = [];
  const seen = new Set();
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      const normalized = String(value === undefined || value === null ? "" : value).trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(normalized);
    }
  }
  return values;
}

function historyTimestamp(value) {
  if (value === undefined || value === null || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function historyRecordMetadata(record) {
  const sources = historyValueSources(record);
  const ids = allHistoryValues(sources, ["task_id", "taskId", "request_id", "requestId", "id", "record_id", "recordId", "generation_id", "generationId", "log_id", "logId"]);
  return {
    id: ids[0] || "",
    ids,
    prompt: String(firstHistoryValue(sources, ["prompt", "request_prompt", "input_prompt"]) || ""),
    model: String(firstHistoryValue(sources, ["model", "model_name", "modelName"]) || ""),
    size: String(firstHistoryValue(sources, ["size", "image_size", "imageSize", "resolution"]) || ""),
    status: String(firstHistoryValue(sources, [
      "status_label", "statusLabel", "task_status_label", "taskStatusLabel",
      "status", "state", "task_status", "taskStatus"
    ]) || ""),
    createdAt: historyTimestamp(firstHistoryValue(sources, ["created_at", "createdAt", "create_time", "createTime", "timestamp", "time"]))
  };
}

function directHistoryCandidate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^data:image\/[^;,]+;base64,/i.test(text)) {
    return { kind: "base64", value: text, contentType: text.slice(5, text.indexOf(";")), count: 1 };
  }
  if (/^https:\/\//i.test(text) || /^\//.test(text)) {
    return { kind: "url", value: text, contentType: "", count: 1 };
  }
  if (text.length > 128 && /^[A-Za-z0-9+/_=-]+$/.test(text)) {
    return { kind: "base64", value: text, contentType: "", count: 1 };
  }
  return null;
}

function extractHistoryImageCandidates(record) {
  if (!record || typeof record !== "object") return [];
  const queue = [];
  const seen = new Set();
  const candidates = [];
  const seenCandidates = new Set();
  const addCandidate = (candidate) => {
    if (!candidate || !candidate.kind || !candidate.value) return;
    const value = String(candidate.value || "").trim();
    if (!value) return;
    const key = `${candidate.kind}:${value}`;
    if (seenCandidates.has(key)) return;
    seenCandidates.add(key);
    candidates.push({
      kind: candidate.kind,
      value,
      contentType: String(candidate.contentType || ""),
      count: 1
    });
  };
  const add = (value) => {
    if (!value) return;
    const direct = directHistoryCandidate(value);
    if (direct) addCandidate(direct);
    const parsed = parseJsonObject(value);
    const candidate = parsed || value;
    if (Array.isArray(candidate)) {
      for (const item of candidate) add(item);
      return;
    }
    if (candidate && typeof candidate === "object" && !seen.has(candidate)) {
      seen.add(candidate);
      queue.push(candidate);
    }
  };

  add(record);
  for (const key of [
    "output", "outputs", "result", "results", "response", "response_data", "responseData",
    "response_body", "responseBody", "data", "images", "image"
  ]) add(record[key]);

  for (const value of queue) {
    if (!value || typeof value !== "object") continue;
    for (const key of [
      "output", "outputs", "result", "results", "response", "response_data", "responseData",
      "response_body", "responseBody", "data", "images", "image"
    ]) add(value[key]);
    const directBase64 = firstHistoryValue([value], [
      "b64_json", "base64", "image_base64", "imageBase64", "output_base64", "outputBase64",
      "result_base64", "resultBase64"
    ]);
    if (typeof directBase64 === "string" && directBase64.trim()) {
      addCandidate({
        kind: "base64",
        value: directBase64.trim(),
        contentType: String(value.mime_type || value.content_type || ""),
        count: 1
      });
    }
    const directUrl = firstHistoryValue([value], [
      "url", "image_url", "imageUrl", "output_url", "outputUrl", "result_url", "resultUrl",
      "output_image_url", "outputImageUrl", "generated_image_url", "generatedImageUrl", "file_url", "fileUrl",
      "download_url", "downloadUrl"
    ]);
    if (typeof directUrl === "string" && directUrl.trim()) {
      addCandidate({
        kind: "url",
        value: directUrl.trim(),
        contentType: String(value.mime_type || value.content_type || ""),
        count: 1
      });
    }
    const candidate = extractImageCandidate(value);
    if (candidate) addCandidate(candidate);
  }
  return candidates.map((candidate) => Object.assign({}, candidate, { count: candidates.length }));
}

function extractHistoryImageCandidate(record) {
  const candidates = extractHistoryImageCandidates(record);
  return candidates.length ? candidates[0] : null;
}

function historyRecordKey(record) {
  const metadata = historyRecordMetadata(record);
  if (metadata.id) return `id:${metadata.id}`;
  const candidate = extractHistoryImageCandidate(record);
  const candidateValue = candidate ? String(candidate.value || "") : "";
  const candidateMark = candidateValue
    ? `${candidateValue.length}:${candidateValue.slice(0, 32)}:${candidateValue.slice(-32)}`
    : "";
  const combined = [metadata.createdAt, metadata.model, metadata.size, metadata.prompt, candidateMark].join("|");
  return combined.replace(/\|/g, "") ? `meta:${combined}` : "";
}

function extractErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback || "接口返回了未知错误";
  const containers = responseContainers(payload);
  for (const container of containers) {
    if (container.error && typeof container.error === "object" && typeof container.error.message === "string") {
      return container.error.message;
    }
    if (typeof container.error === "string") return container.error;
    for (const key of ["message", "msg", "detail"]) {
      if (typeof container[key] === "string" && container[key].trim()) return container[key];
    }
  }
  return fallback || "接口返回了未知错误";
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  throw new Error("无效的二进制图片数据");
}

function bytesToString(bytes) {
  if (!bytes) return "";
  let value = "";
  for (let i = 0; i < bytes.length; i += 1) value += String.fromCharCode(bytes[i]);
  return value;
}

function utf8BytesToString(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
  if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
  let output = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    let codePoint = first;
    let length = 1;
    if ((first & 0xe0) === 0xc0) {
      codePoint = first & 0x1f;
      length = 2;
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = first & 0x0f;
      length = 3;
    } else if ((first & 0xf8) === 0xf0) {
      codePoint = first & 0x07;
      length = 4;
    }
    if (index + length > bytes.length) {
      output += "\ufffd";
      break;
    }
    let valid = length === 1 || first >= 0xc2;
    for (let offset = 1; offset < length; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) valid = false;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (!valid || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      output += "\ufffd";
      index += 1;
      continue;
    }
    if (codePoint <= 0xffff) {
      output += String.fromCharCode(codePoint);
    } else {
      codePoint -= 0x10000;
      output += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
    }
    index += length;
  }
  return output;
}

module.exports = {
  asFiniteNumber,
  normalizeBounds,
  clampBounds,
  computeTopLeftAlignmentOffset,
  normalizeRgbColor,
  rgbToHsl,
  hslToRgb,
  recolorSelectedPixels,
  rgbToOklab,
  oklabToRgb,
  analyzeColorRegion,
  transferColorRegion,
  nominalRatio,
  findClosestRatio,
  parseSize,
  resolveOutputSize,
  computeCoverCrop,
  normalizePricingModelName,
  extractPricingSnapshot,
  normalizeBase64,
  estimateBase64Bytes,
  base64ToArrayBuffer,
  arrayBufferToBase64,
  detectImageType,
  extractImageCandidate,
  extractTextCandidate,
  promptReferenceMentions,
  cleanOptimizedPrompt,
  extractHistoryRecords,
  historyRecordMetadata,
  extractHistoryImageCandidates,
  extractHistoryImageCandidate,
  historyRecordKey,
  extractErrorMessage,
  exactArrayBuffer,
  bytesToString,
  utf8BytesToString
};
