"use strict";

const API_CONFIG = Object.freeze({
  endpoint: "https://www.katuai.cn/v1/images/edits",
  taskEndpoint: "https://www.katuai.cn/v1/images/tasks",
  historyEndpoint: "https://www.katuai.cn/v1/images/history",
  pricingEndpoint: "https://www.katuai.cn/api/open/v1/pricing",
  promptOptimizerEndpoint: "https://ark.cn-beijing.volces.com/api/coding/v3/responses",
  volcImageEndpoint: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  promptOptimizerModel: "ark-code-latest",
  promptOptimizerMaxOutputTokens: 1800,
  promptOptimizerTimeoutMs: 60 * 1000,
  asyncPollIntervalMs: 10 * 1000,
  asyncPollTimeoutMs: 5 * 60 * 1000,
  historyPageSize: 50,
  maxHistoryPages: 10,
  maxConcurrentRequests: 8,
  maxPromptResponseBytes: 512 * 1024,
  model: "gpt-image-2.5-sunburst",
  responseFormat: "b64_json",
  timeoutMs: 10 * 60 * 1000,
  maxImageBytes: 64 * 1024 * 1024,
  maxJsonBytes: 90 * 1024 * 1024,
  maxPricingBytes: 256 * 1024,
  maxUploadBytes: 64 * 1024 * 1024,
  maxInputPixels: 40 * 1024 * 1024,
  maxOutputPixels: 40 * 1024 * 1024
});

const UPDATE_CONFIG = Object.freeze({
  currentVersion: "1.10.1",
  latestReleaseApi: "https://api.github.com/repos/qa963886265/x-image-photoshop/releases/latest",
  releasesPage: "https://github.com/qa963886265/x-image-photoshop/releases",
  updaterFolder: "updater",
  updaterFile: "JXImageUpdater.exe",
  automaticCheckIntervalMs: 12 * 60 * 60 * 1000,
  maxResponseBytes: 512 * 1024
});

const MODEL_CONFIGS = Object.freeze({
  "image-2": Object.freeze({
    apiModel: "image-2",
    pricingModel: "image-2",
    label: "Image 2",
    shortLabel: "Image 2",
    aliases: Object.freeze(["image-2", "gpt-image-2", "gp-image-2"]),
    supportedRatios: Object.freeze(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "3:1", "1:3", "21:9", "9:21", "5:4", "4:5"]),
    supportedSizes: Object.freeze(["1K", "2K"])
  }),
  "gm-3.1-flash-image-preview": Object.freeze({
    apiModel: "gm-3.1-flash-image-preview",
    pricingModel: "gm-3.1-flash-image-preview",
    label: "Gemini Flash（香蕉 2.0）",
    shortLabel: "Gemini Flash",
    aliases: Object.freeze(["gm-3.1-flash-image-preview", "gemini-3.1-flash-image-preview", "Gemini Flash", "Gemini 2 Flash", "香蕉 2.0", "香蕉2"]),
    supportedRatios: Object.freeze(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:4", "4:5"]),
    supportedSizes: Object.freeze(["1K", "2K"])
  }),
  "gm-3-pro-image-preview": Object.freeze({
    apiModel: "gm-3-pro-image-preview",
    pricingModel: "gm-3-pro-image-preview",
    label: "Gemini Pro（香蕉 Pro）",
    shortLabel: "Gemini Pro",
    aliases: Object.freeze(["gm-3-pro-image-preview", "gemini-3-pro-image-preview", "Gemini Pro", "香蕉 Pro", "香蕉Pro"]),
    supportedRatios: Object.freeze(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:4", "4:5"]),
    supportedSizes: Object.freeze(["1K", "2K"])
  }),
  "gpt-image-2.5-sunburst": Object.freeze({
    apiModel: "gpt-image-2.5-sunburst",
    pricingModel: "gpt-image-2.5-sunburst",
    label: "Image 2.5",
    shortLabel: "Image 2.5",
    aliases: Object.freeze(["gpt-image-2.5-sunburst", "Image-2.5 Subrt", "GPT 2.5"]),
    supportedRatios: Object.freeze(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:4", "4:5"]),
    supportedSizes: Object.freeze(["1K", "2K", "4K"])
  })
});

const RATIO_SIZES = Object.freeze({
  "1:1": Object.freeze({ "1K": "1024x1024", "2K": "2048x2048", "4K": "2880x2880" }),
  "16:9": Object.freeze({ "1K": "1536x864", "2K": "2048x1152", "4K": "3840x2160" }),
  "9:16": Object.freeze({ "1K": "864x1536", "2K": "1152x2048", "4K": "2160x3840" }),
  "4:3": Object.freeze({ "1K": "1344x1008", "2K": "2048x1536", "4K": "3312x2480" }),
  "3:4": Object.freeze({ "1K": "1008x1344", "2K": "1536x2048", "4K": "2480x3312" }),
  "3:2": Object.freeze({ "1K": "1536x1024", "2K": "2048x1360", "4K": "3520x2352" }),
  "2:3": Object.freeze({ "1K": "1024x1536", "2K": "1360x2048", "4K": "2352x3520" }),
  "3:1": Object.freeze({ "1K": "2016x672", "2K": "3072x1024", "4K": "3840x1280" }),
  "1:3": Object.freeze({ "1K": "672x2016", "2K": "1024x3072", "4K": "1280x3840" }),
  "21:9": Object.freeze({ "1K": "1536x656", "2K": "2048x880", "4K": "3840x1648" }),
  "9:21": Object.freeze({ "1K": "656x1536", "2K": "880x2048", "4K": "1648x3840" }),
  "5:4": Object.freeze({ "1K": "1280x1024", "2K": "2048x1648", "4K": "3200x2560" }),
  "4:5": Object.freeze({ "1K": "1024x1280", "2K": "1648x2048", "4K": "2560x3200" })
});

const RATIO_ORDER = Object.freeze(Object.keys(RATIO_SIZES));

module.exports = {
  API_CONFIG,
  UPDATE_CONFIG,
  MODEL_CONFIGS,
  RATIO_SIZES,
  RATIO_ORDER
};
