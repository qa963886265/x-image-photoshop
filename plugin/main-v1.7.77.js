"use strict";

const photoshop = require("photoshop");
const uxp = require("uxp");
const { API_CONFIG, UPDATE_CONFIG, MODEL_CONFIGS } = require("./lib/constants.js");
const { createStyleLibraryUpdater, sha256Hex } = require("./lib/style-library-updates.js");
let GPT_IMAGE2_STYLE_LIBRARY = null;
const {
  clampBounds,
  computeTopLeftAlignmentOffset,
  resolveOutputSize,
  computeCoverCrop,
  extractPricingSnapshot,
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
  utf8BytesToString,
  normalizeRgbColor,
  recolorSelectedPixels,
  analyzeColorRegion,
  transferColorRegion
} = require("./lib/utils.js");

const { app, core, imaging, action, constants } = photoshop;
const { localFileSystem, formats, secureStorage } = uxp.storage;
const shell = uxp.shell;

const API_KEY_STORAGE = "llai_selection_editor_api_key";
const ARK_API_KEY_STORAGE = "jx_image_ark_prompt_api_key";
const VOLC_IMAGE_API_KEY_STORAGE = "jx_image_volc_generation_api_key";
const VOLC_RESULT_IMAGE_HOST = "ark-acg-cn-beijing.tos-cn-beijing.volces.com";
const SETTINGS_STORAGE = "llai_selection_editor_settings_v2";
const PRICING_STORAGE = "llai_selection_editor_pricing_v2";
const UPDATE_CHECK_STORAGE = "llai_selection_editor_update_check_v1";
const BUDGET_STORAGE = "llai_selection_editor_budget_v1";
const SETTINGS_SCHEMA_VERSION = 7;
const MAX_REFERENCES = 6;
// The outfit workflow has its own pool.  Keeping it separate prevents the
// editor's eight-reference limit from disabling an empty outfit slot.
const MAX_OUTFIT_REFERENCES = 8;
const MAX_PRODUCT_REFERENCES = 2;
const PRODUCT_TYPE_VALUES = Object.freeze(["clean", "scene", "studio", "platform"]);
const PRODUCT_PLATFORM_VALUES = Object.freeze(["general", "tmall", "jd", "pdd", "redbook", "amazon"]);
const PRODUCT_COMPOSITION_VALUES = Object.freeze(["center", "fashion", "detail", "space", "scene"]);
const DEFAULT_PRODUCT_DRAFT = Object.freeze({
  type: "clean",
  category: "鞋",
  platform: "general",
  retention: "鞋子的一致",
  backgroundDescription: "",
  composition: "center",
  protectBrand: true,
  extraPrompt: ""
});
const MAX_RESULTS = 50;
const RESULT_HISTORY_PAGE_SIZE = 4;
const MAX_FAVORITE_PROMPTS = 12;
const MAX_ACTIVE_JOBS = 8;
const PRICING_SIZES = Object.freeze(["1K", "2K", "4K"]);
const VOLC_PRICES = Object.freeze({ "1K": 0.3, "1.5K": 0.3, "2K": 0.6 });
function volcFixedPrice(size) {
  const price = normalizePriceValue(VOLC_PRICES[String(size || "")]);
  return price === null ? 0.3 : price;
}
const PRICING_REFRESH_MS = 2 * 60 * 1000;
const PRICING_TIMEOUT_MS = 12 * 1000;
const PRICE_BYPASS_CONFIRM_MS = 60 * 1000;
const HISTORY_REQUEST_TIMEOUT_MS = 20 * 1000;
const ASYNC_TASK_REQUEST_TIMEOUT_MS = 20 * 1000;
const HISTORY_RECOVERY_POLL_MS = 10 * 1000;
const HISTORY_RECOVERY_TIMEOUT_MS = 5 * 60 * 1000;
const HISTORY_RECORD_MATCH_MAX_LAG_MS = 20 * 60 * 1000;
const HISTORY_PENDING_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const GENERATION_PROGRESS_TICK_MS = 280;
const GENERATION_PROGRESS_COMPLETION_MS = 620;
const PERSISTENT_HISTORY_SCHEMA_VERSION = 3;
const PENDING_HISTORY_RECOVERY_REVISION = 5;
const PERSISTENT_HISTORY_FOLDER = "generated-history";
const PERSISTENT_HISTORY_INDEX = "history-index.json";
const PERSISTENT_HISTORY_INDEX_BACKUP = "history-index.bak.json";
const PERSISTENT_HISTORY_INDEX_TEMP = "history-index.next.json";
const COLOR_SAMPLE_POLL_MS = 250;
const COLOR_SAMPLE_TIMEOUT_MS = 60 * 1000;
const STATUS_HIDE_DELAY_MS = 5000;
const COLOR_REPLACE_MAX_PIXELS = 12 * 1024 * 1024;
const COLOR_REPLACE_TOLERANCE = 0.55;
const PALETTE_MATCH_MAX_PIXELS = 6 * 1024 * 1024;
const LOCAL_EDIT_MODES = Object.freeze(["general", "head", "upper", "pants", "outfit", "product"]);

const state = {
  references: [],
  outfitReferences: [],
  productReferences: [],
  targetSnapshot: null,
  outfitTargetSnapshot: null,
  productTargetSnapshot: null,
  outfitType: "full",
  outfitTargetReferenceId: null,
  outfitFaceReferenceId: null,
  outfitBackgroundReferenceId: null,
  outfitGarmentReferenceIds: ["", "", ""],
  results: [],
  resultHistoryPageIndex: 0,
  selectedResultId: null,
  resultSequence: 0,
  favoritePrompts: [],
  apiKey: "",
  arkApiKey: "",
  volcImageApiKey: "",
  running: false,
  runSubmissionPending: false,
  preparingJob: false,
  capturing: false,
  inserting: false,
  generationJobs: [],
  generationJobSequence: 0,
  selectionRevision: 0,
  referenceSequence: 0,
  resumeAfterKey: false,
  pendingKeyProvider: "katu",
  promptOptimizing: false,
  optimizedPromptValue: "",
  resumePromptOptimizationAfterKey: false,
  resumePromptOptimizationToRun: false,
  pricingRunConfirmation: null,
  pendingHistoryTasks: [],
  loadingPersistentHistory: false,
  recoveringPendingHistory: false,
  pendingHistoryRecoveryStopRequested: false,
  historyPersistenceError: "",
  paletteProcessing: false,
  paletteSample: null,
  checkingUpdate: false,
  installingUpdate: false,
  updateAvailable: null,
  updateLastCheckedAt: 0,
  activeWorkspace: "editor",
  activeSettingsSection: "keys",
  activeCreativeTool: "outfit",
  productReferenceIds: { main: "", scene: "" },
  // Outfit and product helpers temporarily reuse state.references. Keep their
  // async mutations serialized so one pool cannot restore over another.
  referencePoolMutations: { outfit: 0, product: 0 },
  dailyBudget: null,
  dailySpend: { date: "", amount: 0 },
  selfCheckRunning: false,
  settingsReturnWorkspace: "editor",
  resumeRunOptions: null,
  pricing: {
    prices: { "1K": null, "1.5K": null, "2K": null, "4K": null },
    enabled: { "1K": false, "1.5K": false, "2K": false, "4K": false },
    fetchedAt: 0,
    serviceUpdatedAt: "",
    source: "none",
    changes: {},
    unacknowledgedIncreases: {},
    error: "",
    checking: false
  }
};

const DEFAULT_OUTFIT_STYLE_PROMPT = "天猫高级感棚拍、浅蓝色背景主图、自然站姿、服装细节清晰";
const DEFAULT_OUTFIT_EXTRA_PROMPT = "背景浅蓝色";

const elements = {};
const islandSelectControls = new Map();
let islandSelectDocumentListenerAttached = false;
let pricingRefreshTimer = null;
let pricingRequest = null;
let fitNoticeBaseText = "";
let lastHistoryPreviewClickId = "";
let lastHistoryPreviewClickAt = 0;
let lastPromptSelection = null;
let promptSelectionCaptureTimer = null;
let promptHasFocus = false;
let promptPointerActive = false;
let promptSelectionFreezeUntil = 0;
let promptCaretMirror = null;
let referenceLayoutTimer = null;
let resultHistoryLayoutTimer = null;
let referenceListWidth = 0;
let referenceTileSize = 80;
let notificationLayoutTimer = null;
let generationProgressTimer = null;
let statusHideTimer = null;
let persistentHistoryFolderPromise = null;
let historyPersistenceQueue = Promise.resolve();
let pendingHistoryRecoveryController = null;
let promptOptimizationController = null;
let colorSamplingTimer = null;
let colorSamplingInitialHex = "";
let colorSamplingStartedAt = 0;
let resultPreviewZoom = 1;
let resultPreviewDragging = false;
let resultPreviewDragStartX = 0;
let resultPreviewDragStartY = 0;
let resultPreviewDragScrollLeft = 0;
let resultPreviewDragScrollTop = 0;
let resultPreviewSourceResultId = null;
let resultPreviewPendingResultId = null;
let resultPreviewOpenRequestToken = 0;
let visibleResultPreviewIds = new Set();
let taskDrawerResultId = null;
let activeNetworkRequests = 0;
const pendingNetworkRequests = [];
let resultPreviewLastStandardWheelAt = 0;
let resultPreviewWheelTimer = null;
let resultPreviewPendingWheel = null;
let resultStageZoom = 1;
let resultStageOffsetX = 0;
let resultStageOffsetY = 0;
let resultStageDragging = false;
let resultStageDragMoved = false;
let resultStageSuppressClickUntil = 0;
let resultStageDragStartX = 0;
let resultStageDragStartY = 0;
let resultStageDragOriginX = 0;
let resultStageDragOriginY = 0;
let resultStageLastWheelAt = 0;
let resultStageLastWheelType = "";
let promptMentionMatch = null;
let promptMentionActiveIndex = 0;
let promptMentionTriggerIndex = null;
let promptMentionTriggerExpiresAt = 0;
let promptMentionRetrySequence = 0;
let pendingReferenceMentionSelection = null;
const boundPromptEditors = new WeakSet();
let promptContinuationState = null;
let promptContinuationSequence = 0;
let promptContinuationFocused = false;
let promptContinuationBlinkTimer = null;
let styleLibraryPageIndex = 0;
let styleLibrarySearchTimer = null;
let styleLibraryDetailTemplateId = "";
let styleLibraryDetailImageRequestToken = 0;
let styleLibraryUpdater = null;
let pendingStyleLibrary = null;
let styleLibraryUpdateState = null;
const STYLE_LIBRARY_CACHE_FILE = "prompt-library-cache-v1.json";
const STYLE_LIBRARY_CACHE_MAX_BYTES = 24 * 1024 * 1024;
let pluginDestroyed = false;
const STYLE_LIBRARY_PAGE_SIZE = 8;
// Avoid duplicating large source files in memory for a panel thumbnail. The
// temporary UXP File remains available as the display and upload fallback.
const REFERENCE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const RESULT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
// Keep previews enabled so every reference card reflects the image that will
// be sent to the model. The original File remains the generation source; the
// preview URL is only a panel display optimization.
const ENABLE_REFERENCE_PREVIEWS = true;

function byId(id) {
  return document.getElementById(id);
}

function normalizeModelIdentifier(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function getModelConfig(modelName) {
  const direct = MODEL_CONFIGS[String(modelName || "")];
  if (direct) return direct;
  const normalized = normalizeModelIdentifier(modelName);
  if (normalized) {
    const match = Object.values(MODEL_CONFIGS).find((config) => (
      [config.apiModel, config.pricingModel].concat(config.aliases || [])
        .some((alias) => normalizeModelIdentifier(alias) === normalized)
    ));
    if (match) return match;
  }
  return MODEL_CONFIGS[API_CONFIG.model];
}

function getSelectedModelConfig() {
  const selected = String(elements.modelChannel && elements.modelChannel.value || API_CONFIG.model);
  return getModelConfig(selected);
}

function selectedApiModel() {
  return getSelectedModelConfig().apiModel;
}

function modelProvider(modelConfig) {
  return (modelConfig && modelConfig.provider) || "katu";
}

function isVolcModel(modelName) {
  return modelProvider(getModelConfig(modelName)) === "volc";
}

function cacheElements() {
  const ids = [
    "pluginVersion", "brandSettingsOpen", "settingsWorkspaceTab", "workspaceTabs",
    "referenceStrip", "referenceList", "referenceAddWrap", "referenceAdd", "referenceSourceMenu", "referenceQuickActions", "referenceQuickLayer", "referenceQuickSelection", "referenceQuickClear",
    "referenceFromSelection", "referenceFromLayer", "referenceFromLocal", "referenceEmptyHint", "referenceCount",
    "precisionPlacement", "precisionPlacementToggle", "prompt", "promptCount", "promptMentionMenu", "promptContinuationCapture", "promptContinuationCaret", "modelChannel", "aspectRatio", "resolution", "generationCount",
    "resolvedDimensions", "run", "stop", "editorClear", "insert", "resultStage", "resultEmpty", "resultImage",
    "resultPreviewOverlay", "resultPreviewViewport", "resultPreviewImage", "resultPreviewClose", "resultPreviewSave", "resultPreviewCopyPrompt", "resultPreviewResolution",
    "taskDrawerOverlay", "taskDrawerClose", "taskDrawerImage", "taskDrawerTitle",
    "taskDrawerModel", "taskDrawerSize", "taskDrawerTime", "taskDrawerPrompt", "taskDrawerReuse", "taskDrawerInsert",
    "notificationLayer", "status", "statusIcon", "statusTitle", "statusDetail", "statusClose",
    "keyOverlay", "keyTitle", "keyInput",
    "keyError", "cancelKey", "saveKey", "promptLibrary", "favoritePrompt", "styleLibraryOpen", "styleLibraryWorkspace", "styleLibraryClose", "styleLibrarySearch", "styleLibraryCategory", "styleLibraryCount", "styleLibraryList", "styleLibraryPrevious", "styleLibraryNext", "styleLibraryPage", "styleLibraryTotal", "styleLibraryDetailOverlay", "styleLibraryDetailClose", "styleLibraryDetailImage", "styleLibraryDetailImageEmpty", "styleLibraryDetailTitle", "styleLibraryDetailMeta", "styleLibraryDetailPrompt", "styleLibraryDetailApply",
    "styleLibraryUpdateStatus",
    "editorWorkspaceTab", "outfitWorkspaceTab", "editorWorkspace", "outfitWorkspace",
    "creativeOutfitTab", "creativeProductTab", "creativePendingTabOne", "creativePendingTabTwo",
    "creativeOutfitPanel", "outfitPrimaryActions", "creativeToolPlaceholder", "creativeToolPlaceholderTitle", "creativeToolPlaceholderText",
    "creativeProductPanel", "productReferenceCount", "productMainReferenceTile", "productMainReferenceImage", "productMainReferenceAdd", "productMainReferenceMenu", "productMainReferenceRemove",
    "productMainFromSelection", "productMainFromLayer", "productMainFromLocal",
    "productSceneReferenceTile", "productSceneReferenceImage", "productSceneReferenceAdd", "productSceneReferenceMenu", "productSceneReferenceRemove",
    "productSceneFromSelection", "productSceneFromLayer", "productSceneFromLocal",
    "productTypeGroup", "productCategory", "productPlatform", "productRetention", "productBackgroundDescription", "productComposition", "productProtectBrand", "productExtraPrompt",
    "productAspectRatio", "productResolution", "productGenerationCount", "productRun",
    "settingsWorkspace", "resultPanel", "settingsApiKey", "settingsApiState", "settingsActiveKeyState", "settingsSaveApiKey", "settingsTestApi",
    "settingsKeysTab", "settingsDefaultsTab", "settingsCostTab",
    "settingsMaskFeatherRadius", "maskFeatherControl", "maskFeatherEnabled", "settingsSaveDefaults",
    "settingsVersion", "settingsCheckUpdate", "settingsBack",
    "settingsCheckSummary", "checkPhotoshopState", "checkApiState", "checkPricingState", "checkHistoryState", "checkStorageState", "checkUpdaterState", "settingsRunSelfCheck", "settingsCheckDetail",
    "settingsBudgetState", "budgetCurrentEstimate", "budgetTodayTotal", "budgetTodayRemaining", "settingsDailyBudget", "settingsSaveBudget", "settingsResetBudget",
    "outfitReferenceCount", "outfitTargetAddWrap", "outfitTargetPreview", "outfitTargetEmpty", "outfitTargetSourceMenu", "outfitFacePreview", "outfitFaceEmpty", "outfitFaceAddWrap", "outfitFaceAdd", "outfitFaceSourceMenu", "outfitBackgroundAddWrap", "outfitBackgroundPreview", "outfitBackgroundEmpty", "outfitBackgroundAdd", "outfitBackgroundSourceMenu", "outfitClearBackground", "outfitAddBackgroundSelection", "outfitAddBackgroundLayer", "outfitAddBackgroundLocal", "outfitGarmentList",
    "outfitTargetMetric", "outfitGarmentMetric", "outfitTaskMetric", "outfitResultMetric",
    "outfitCaptureTarget", "outfitAddTargetSelection", "outfitAddTargetLayer", "outfitAddTargetLocal", "outfitClearTarget",
    "outfitAddFaceSelection", "outfitAddFaceLocal", "outfitAddFaceLayer", "outfitClearFace",
    "outfitPrompt", "outfitExtraPrompt", "outfitBackgroundOrdinal", "outfitModelChannel", "outfitResolution", "outfitGenerationCount",
    "outfitRun", "outfitStop", "outfitInsert",
    "resultHistory", "resultHistoryPagination", "resultHistoryPrevious", "resultHistoryNext", "resultHistoryPageButtons", "resultHistoryTotal", "resultHistoryRunning", "generationQueue"
  ];
  for (const id of ids) elements[id] = byId(id);
}

function getPromptValue() {
  return String(elements.prompt && elements.prompt.value || "").replace(/\r?\n/g, "\n");
}

function normalizePromptForOptimization(value) {
  return String(value || "").replace(/\r?\n/g, "\n").trim();
}

function isPromptAlreadyOptimized(value) {
  const prompt = normalizePromptForOptimization(value);
  return Boolean(prompt && prompt === state.optimizedPromptValue);
}

function markPromptOptimized(value) {
  state.optimizedPromptValue = normalizePromptForOptimization(value);
}

function setPromptValue(value) {
  if (!elements.prompt) return;
  elements.prompt.value = String(value || "").slice(0, 20000);
  if (lastPromptSelection) {
    const valueLength = getPromptValue().length;
    const start = Math.max(0, Math.min(valueLength, lastPromptSelection.start));
    lastPromptSelection = {
      start,
      end: Math.max(start, Math.min(valueLength, lastPromptSelection.end))
    };
  }
}

function getKeyInputValue() {
  return String(elements.keyInput && elements.keyInput.value || "").replace(/\s+/g, "");
}

function setKeyInputValue(value) {
  if (elements.keyInput) elements.keyInput.value = String(value || "");
}

function isPromptDisabled() {
  return !elements.prompt || Boolean(elements.prompt.disabled);
}

function setPromptDisabled(disabled) {
  if (!elements.prompt) return;
  const locked = Boolean(disabled);
  if (locked && promptContinuationState) deactivatePromptContinuation();
  if (Boolean(elements.prompt.disabled) !== locked) elements.prompt.disabled = locked;
}

function readPromptSelection() {
  const valueLength = getPromptValue().length;
  if (promptContinuationState && elements.promptContinuationCapture) {
    const captureStart = elements.promptContinuationCapture.selectionStart;
    const captureEnd = elements.promptContinuationCapture.selectionEnd;
    if (typeof captureStart === "number" && typeof captureEnd === "number") {
      const offset = promptContinuationState.before.length;
      return {
        start: Math.max(0, Math.min(valueLength, offset + captureStart)),
        end: Math.max(0, Math.min(valueLength, offset + captureEnd))
      };
    }
  }
  const rawStart = elements.prompt && elements.prompt.selectionStart;
  const rawEnd = elements.prompt && elements.prompt.selectionEnd;
  if (typeof rawStart !== "number" || typeof rawEnd !== "number") {
    return null;
  }
  return {
    start: Math.max(0, Math.min(valueLength, rawStart)),
    end: Math.max(0, Math.min(valueLength, rawEnd))
  };
}

function rememberPromptSelection() {
  const selection = readPromptSelection();
  if (selection) lastPromptSelection = selection;
  return selection;
}

function ensurePromptCaretMirror() {
  if (promptCaretMirror && promptCaretMirror.parentNode) return promptCaretMirror;
  const mirror = document.createElement("div");
  mirror.className = "prompt-caret-mirror";
  mirror.setAttribute("aria-hidden", "true");
  document.body.appendChild(mirror);
  promptCaretMirror = mirror;
  return mirror;
}

function updatePromptCaretMirrorLayout(mirror) {
  const editor = elements.prompt;
  if (!mirror || !editor) return { lineHeight: 18, paddingTop: 9, width: 1 };
  let computed = null;
  try {
    computed = typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(editor)
      : null;
  } catch (_) {
    computed = null;
  }
  const editorWidth = Math.max(
    1,
    Number(editor.clientWidth) ||
    Number(editor.getBoundingClientRect && editor.getBoundingClientRect().width) ||
    1
  );
  const lineHeight = Math.max(1, parseFloat(computed && computed.lineHeight) || 18);
  const paddingTop = Math.max(0, parseFloat(computed && computed.paddingTop) || 9);
  mirror.style.width = `${editorWidth}px`;
  mirror.style.fontFamily = computed && computed.fontFamily
    ? computed.fontFamily
    : '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", Arial';
  mirror.style.fontSize = computed && computed.fontSize ? computed.fontSize : "12px";
  mirror.style.fontWeight = computed && computed.fontWeight ? computed.fontWeight : "500";
  mirror.style.letterSpacing = computed && computed.letterSpacing ? computed.letterSpacing : "0.01em";
  mirror.style.lineHeight = `${lineHeight}px`;
  mirror.style.paddingTop = computed && computed.paddingTop ? computed.paddingTop : "9px";
  mirror.style.paddingRight = computed && computed.paddingRight ? computed.paddingRight : "7px";
  mirror.style.paddingBottom = computed && computed.paddingBottom ? computed.paddingBottom : "9px";
  mirror.style.paddingLeft = computed && computed.paddingLeft ? computed.paddingLeft : "7px";
  return { lineHeight, paddingTop, width: editorWidth };
}

function measurePromptCaretPosition(mirror, value, index, layout) {
  mirror.textContent = value.slice(0, index);
  const marker = document.createElement("span");
  marker.className = "prompt-caret-marker";
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  try {
    const mirrorBounds = mirror.getBoundingClientRect();
    const markerBounds = marker.getBoundingClientRect();
    const x = Number(markerBounds.left) - Number(mirrorBounds.left);
    const y = Number(markerBounds.top) - Number(mirrorBounds.top);
    return {
      index,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      row: Math.max(0, Math.round(((Number.isFinite(y) ? y : 0) - layout.paddingTop) / layout.lineHeight))
    };
  } catch (_) {
    return null;
  }
}

function estimatePromptCaretFromPointer(event) {
  if (!elements.prompt || !event) return null;
  const value = getPromptValue();
  if (!value) return 0;
  let editorBounds = null;
  try {
    editorBounds = elements.prompt.getBoundingClientRect();
  } catch (_) {
    editorBounds = null;
  }
  if (!editorBounds) return null;
  const rawClientX = Number(event.clientX);
  const rawClientY = Number(event.clientY);
  const fallbackX = Number(event.offsetX);
  const fallbackY = Number(event.offsetY);
  const targetX = (
    Number.isFinite(rawClientX)
      ? rawClientX - Number(editorBounds.left)
      : (Number.isFinite(fallbackX) ? fallbackX : 0)
  ) + (Number(elements.prompt.scrollLeft) || 0);
  const targetY = (
    Number.isFinite(rawClientY)
      ? rawClientY - Number(editorBounds.top)
      : (Number.isFinite(fallbackY) ? fallbackY : 0)
  ) + (Number(elements.prompt.scrollTop) || 0);

  const mirror = ensurePromptCaretMirror();
  const layout = updatePromptCaretMirrorLayout(mirror);
  const targetRow = Math.max(0, Math.floor((targetY - layout.paddingTop) / layout.lineHeight));
  const cache = new Map();
  const measure = (index) => {
    const boundedIndex = Math.max(0, Math.min(value.length, index));
    if (!cache.has(boundedIndex)) {
      cache.set(
        boundedIndex,
        measurePromptCaretPosition(mirror, value, boundedIndex, layout)
      );
    }
    return cache.get(boundedIndex);
  };

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const position = measure(middle);
    if (!position) return null;
    if (
      position.row < targetRow ||
      (position.row === targetRow && position.x < targetX)
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const candidates = [low - 1, low, low + 1]
    .filter((index, position, items) => (
      index >= 0 &&
      index <= value.length &&
      items.indexOf(index) === position
    ))
    .map(measure)
    .filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((first, second) => {
    const firstScore = Math.abs(first.row - targetRow) * Math.max(100, layout.width) +
      Math.abs(first.x - targetX);
    const secondScore = Math.abs(second.row - targetRow) * Math.max(100, layout.width) +
      Math.abs(second.x - targetX);
    return firstScore - secondScore;
  });
  return candidates[0].index;
}

function rememberPromptPointerSelection(event) {
  const nativeSelection = normalizePromptSelectionAroundMentions(getPromptValue(), readPromptSelection());
  const previousSelection = lastPromptSelection;
  const nativeSelectionChanged = Boolean(
    nativeSelection && (
      !previousSelection ||
      nativeSelection.start !== previousSelection.start ||
      nativeSelection.end !== previousSelection.end
    )
  );
  if (
    nativeSelection &&
    (nativeSelection.start !== nativeSelection.end || nativeSelectionChanged)
  ) {
    lastPromptSelection = nativeSelection;
    promptSelectionFreezeUntil = Date.now() + 350;
    return nativeSelection;
  }
  const estimatedCaret = estimatePromptCaretFromPointer(event);
  if (Number.isInteger(estimatedCaret)) {
    lastPromptSelection = normalizePromptSelectionAroundMentions(
      getPromptValue(),
      { start: estimatedCaret, end: estimatedCaret }
    );
    promptSelectionFreezeUntil = Date.now() + 350;
    return lastPromptSelection;
  }
  return rememberPromptSelection();
}

function getPromptSelection() {
  const valueLength = getPromptValue().length;
  const liveSelection = promptHasFocus ? readPromptSelection() : null;
  const selection = liveSelection || lastPromptSelection || { start: valueLength, end: valueLength };
  const start = Math.max(0, Math.min(valueLength, Number(selection.start) || 0));
  const end = Math.max(start, Math.min(valueLength, Number(selection.end) || start));
  return { start, end };
}

function schedulePromptSelectionCapture(forceCapture = false) {
  if (promptSelectionCaptureTimer !== null) clearTimeout(promptSelectionCaptureTimer);
  promptSelectionCaptureTimer = setTimeout(() => {
    promptSelectionCaptureTimer = null;
    if (Date.now() < promptSelectionFreezeUntil) return;
    if (!forceCapture && !promptHasFocus && !promptPointerActive) return;
    rememberPromptSelection();
  }, 40);
}

function freezePromptSelectionCapture() {
  if (promptSelectionCaptureTimer !== null) {
    clearTimeout(promptSelectionCaptureTimer);
    promptSelectionCaptureTimer = null;
  }
}

function setPromptSelection(start, end, applyToEditor = true) {
  if (!elements.prompt) return;
  const value = getPromptValue();
  const boundedStart = Math.max(0, Math.min(value.length, Number(start) || 0));
  const boundedEnd = Math.max(boundedStart, Math.min(value.length, Number(end) || boundedStart));
  lastPromptSelection = { start: boundedStart, end: boundedEnd };
  if (!applyToEditor) return;
  if (promptContinuationState && elements.promptContinuationCapture) {
    const offset = promptContinuationState.before.length;
    const bufferLength = String(elements.promptContinuationCapture.value || "").length;
    const relativeStart = boundedStart - offset;
    const relativeEnd = boundedEnd - offset;
    if (relativeStart >= 0 && relativeEnd <= bufferLength) {
      try {
        elements.promptContinuationCapture.selectionStart = relativeStart;
        elements.promptContinuationCapture.selectionEnd = relativeEnd;
      } catch (_) {
        // The logical caret remains available when an older host rejects selection properties.
      }
      return;
    }
  }
  try {
    if ("selectionStart" in elements.prompt && "selectionEnd" in elements.prompt) {
      elements.prompt.selectionStart = boundedStart;
      elements.prompt.selectionEnd = boundedEnd;
    }
  } catch (_) {
    // The editor remains usable when an older host does not expose caret APIs.
  }
  try {
    if (typeof elements.prompt.setSelectionRange === "function") {
      elements.prompt.setSelectionRange(boundedStart, boundedEnd, "none");
    }
  } catch (_) {
    // Some UXP versions only support the selectionStart/selectionEnd properties.
  }
}

function dispatchSelectChange(select) {
  let event = null;
  try {
    event = new Event("change", { bubbles: true });
  } catch (_) {
    event = document.createEvent("Event");
    event.initEvent("change", true, false);
  }
  select.dispatchEvent(event);
}

function closeIslandSelect(control, restoreFocus) {
  if (!control) return;
  control.root.classList.remove("is-open");
  control.menu.classList.add("is-hidden");
  control.trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    try {
      control.trigger.focus();
    } catch (_) {
      // Focus restoration is non-critical.
    }
  }
}

function closeAllIslandSelects(exceptControl) {
  islandSelectControls.forEach((control) => {
    if (control !== exceptControl) closeIslandSelect(control, false);
  });
}

function focusIslandOption(control, direction) {
  if (!control) return;
  const items = Array.from(control.menu.children || []).filter(
    (child) => child.classList && child.classList.contains("island-select-option") && !child.disabled
  );
  if (!items.length) return;
  const activeIndex = items.indexOf(document.activeElement);
  const selectedIndex = items.findIndex((item) => item.classList.contains("is-selected"));
  let nextIndex = activeIndex;
  if (direction === "first") nextIndex = 0;
  else if (direction === "last") nextIndex = items.length - 1;
  else if (direction === "next") nextIndex = activeIndex < 0 ? Math.max(0, selectedIndex) : (activeIndex + 1) % items.length;
  else if (direction === "previous") nextIndex = activeIndex < 0 ? Math.max(0, selectedIndex) : (activeIndex - 1 + items.length) % items.length;
  else nextIndex = Math.max(0, selectedIndex);
  try {
    items[nextIndex].focus();
  } catch (_) {
    // Pointer selection remains available when focus APIs are limited.
  }
}

function openIslandSelect(select, control, focusOption) {
  if (!select || !control || select.disabled) return;
  closeAllIslandSelects(control);
  refreshIslandSelect(select, true);
  control.root.classList.add("is-open");
  control.menu.classList.remove("is-hidden");
  control.trigger.setAttribute("aria-expanded", "true");
  // Anchor below the picker while matching both edges of the prompt section.
  if (select === elements.promptLibrary) {
    control.root.style.setProperty("position", "relative", "important");
    control.root.style.setProperty("width", "100%", "important");
    control.root.style.setProperty("min-width", "0", "important");
    control.root.style.setProperty("max-width", "100%", "important");
    control.root.style.setProperty("overflow", "visible", "important");
    control.menu.style.setProperty("position", "absolute", "important");
    const promptFrame = document.querySelector("#editorWorkspace > .prompt-card");
    // Use the full prompt card as the containing block, not the narrow picker.
    if (promptFrame && control.menu.parentNode !== promptFrame) {
      promptFrame.appendChild(control.menu);
    }
    control.menu.classList.add("prompt-library-wide-menu");
    control.menu.style.setProperty("right", "auto", "important");
    control.menu.style.setProperty("top", "calc(100% + 2px)", "important");
    control.menu.style.setProperty("bottom", "auto", "important");
    control.menu.style.setProperty("left", "3px", "important");
    const promptCardWidth = promptFrame
      ? (Number(promptFrame.clientWidth) || Number(promptFrame.getBoundingClientRect().width) || 0)
      : 0;
    control.menu.style.setProperty("width", `${Math.max(1, promptCardWidth)}px`, "important");
    control.menu.style.setProperty("min-width", "0", "important");
    control.menu.style.setProperty("max-width", "none", "important");
    const promptRowCount = Math.max(1, Math.min(MAX_FAVORITE_PROMPTS,
      Array.from(control.menu.children || []).filter((item) => item.classList.contains("island-select-option")).length));
    control.menu.style.setProperty("height", `${promptRowCount * 20 + 7}px`, "important");
    control.menu.style.setProperty("min-height", "0px", "important");
    control.menu.style.setProperty("max-height", `${MAX_FAVORITE_PROMPTS * 20 + 7}px`, "important");
    control.menu.style.setProperty("margin", "0", "important");
    control.menu.style.setProperty("padding", "3px 3px 2px", "important");
    control.menu.style.setProperty("overflow-y", "hidden", "important");
    control.menu.style.setProperty("box-sizing", "border-box", "important");
    control.menu.style.setProperty("border", "1px solid #dfbd51", "important");
    control.menu.style.setProperty("border-radius", "6px", "important");
    control.menu.style.setProperty("background", "#ffeea0", "important");
    control.menu.style.setProperty("box-shadow", "0 3px 7px rgba(174, 130, 43, 0.25)", "important");
    // Pin the lower inset above native button painting in UXP.
    let bottomSpace = control.menu.querySelector(".prompt-library-bottom-space");
    if (!bottomSpace) {
      bottomSpace = document.createElement("div");
      bottomSpace.className = "prompt-library-bottom-space";
      bottomSpace.setAttribute("aria-hidden", "true");
    }
    control.menu.appendChild(bottomSpace);
  }
  if (select === elements.aspectRatio) {
    const bounds = control.root.getBoundingClientRect();
    const viewportHeight = Number(window.innerHeight) || document.documentElement.clientHeight;
    const viewportWidth = Number(window.innerWidth) || document.documentElement.clientWidth;
    const optionCount = Array.from(select.options || []).filter((option) => !option.hidden).length;
    const menuHeight = (1 + Math.ceil(Math.max(0, optionCount - 1) / 3)) * 26 + 10;
    const spaceBelow = Math.max(0, viewportHeight - bounds.bottom - 8);
    const spaceAbove = Math.max(0, bounds.top - 8);
    const openAbove = menuHeight > spaceBelow && spaceAbove > spaceBelow;
    const menuWidth = Math.max(1, Math.min(240, viewportWidth - 16));
    const menuLeft = Math.max(8, Math.min(bounds.left, viewportWidth - menuWidth - 8));
    control.menu.style.setProperty("top", openAbove ? "auto" : "calc(100% + 4px)", "important");
    control.menu.style.setProperty("bottom", openAbove ? "calc(100% + 4px)" : "auto", "important");
    control.menu.style.setProperty("left", `${menuLeft - bounds.left}px`, "important");
    control.menu.style.setProperty("right", "auto", "important");
    control.menu.style.setProperty("width", `${menuWidth}px`, "important");
    control.menu.style.setProperty("max-height", `${openAbove ? spaceAbove : spaceBelow}px`, "important");
    control.menu.style.setProperty("margin", "0", "important");
  }
  if (select === elements.resolution) {
    refreshLivePricing("resolution-menu").catch(() => {});
  }
  if (focusOption) setTimeout(() => focusIslandOption(control, "selected"), 0);
}

function selectIslandOption(select, control, index) {
  // The custom menu only contains visible options. Map its index back to the
  // native select instead of indexing through hidden unsupported sizes.
  const options = select
    ? Array.from(select.options || []).filter((item) => !item.hidden)
    : [];
  const option = options[index];
  if (!option || select.disabled || option.disabled) return;
  select.selectedIndex = Array.from(select.options || []).indexOf(option);
  dispatchSelectChange(select);
  syncIslandSelects();
  closeIslandSelect(control, true);
}

function refreshIslandSelect(select, rebuildOptions) {
  const control = islandSelectControls.get(select);
  if (!control) return;
  const options = Array.from(select.children || []).filter((child) => (
    child.tagName === "OPTION" && !child.hidden
  ));
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === select.value));
  const selectedOption = options[selectedIndex] || null;
  control.trigger.disabled = Boolean(select.disabled);
  control.root.classList.toggle("is-disabled", Boolean(select.disabled));
  control.value.textContent = select === elements.promptLibrary
    ? "选择提示词"
    : (selectedOption ? selectedOption.textContent : "请选择");
  control.value.title = selectedOption ? (selectedOption.title || selectedOption.textContent) : "请选择";

  if (rebuildOptions) {
    let menuItems = Array.from(control.menu.children || []).filter(
      (child) => child.classList && child.classList.contains("island-select-option")
    );
    if (menuItems.length !== options.length) {
      while (control.menu.firstChild) control.menu.removeChild(control.menu.firstChild);
      options.forEach(() => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "island-select-option";
        item.setAttribute("role", "option");
        item.addEventListener("click", () => {
          selectIslandOption(select, control, Number(item.__islandOptionIndex));
        });
        item.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            focusIslandOption(control, "next");
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            focusIslandOption(control, "previous");
          } else if (event.key === "Home") {
            event.preventDefault();
            focusIslandOption(control, "first");
          } else if (event.key === "End") {
            event.preventDefault();
            focusIslandOption(control, "last");
          } else if (event.key === "Escape") {
            event.preventDefault();
            closeIslandSelect(control, true);
          }
        });
        control.menu.appendChild(item);
      });
      menuItems = Array.from(control.menu.children || []).filter(
        (child) => child.classList && child.classList.contains("island-select-option")
      );
    }
    options.forEach((option, index) => {
      const item = menuItems[index];
      item.__islandOptionIndex = index;
      item.textContent = option.textContent;
      item.title = option.title || option.textContent;
      item.disabled = Boolean(option.disabled);
      item.classList.toggle("is-selected", index === selectedIndex);
      item.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");
    });
  }
}

function syncIslandSelects() {
  islandSelectControls.forEach((_, select) => refreshIslandSelect(select, false));
}

function initializeIslandSelects() {
  [
    elements.promptLibrary,
    elements.modelChannel,
    elements.aspectRatio,
    elements.resolution,
    elements.generationCount,
    elements.outfitModelChannel,
    elements.outfitResolution,
    elements.outfitGenerationCount,
    elements.productPlatform,
    elements.productComposition,
    elements.productAspectRatio,
    elements.productResolution,
    elements.productGenerationCount,
    elements.styleLibraryCategory
  ].forEach((select) => {
    if (!select || islandSelectControls.has(select)) return;
    select.classList.add("native-select-control");

    const root = document.createElement("div");
    root.className = `island-select-control island-select-${select.id}`;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "island-select-trigger";
    trigger.setAttribute("aria-label", select.getAttribute("aria-label") || select.id);
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const value = document.createElement("span");
    value.className = "island-select-value";
    const arrow = document.createElement("span");
    arrow.className = "island-select-arrow";
    arrow.setAttribute("aria-hidden", "true");
    if (select === elements.promptLibrary) arrow.textContent = "\u25be";
    const menu = document.createElement("div");
    menu.className = "island-select-menu is-hidden";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", select.getAttribute("aria-label") || select.id);
    trigger.appendChild(value);
    trigger.appendChild(arrow);
    root.appendChild(trigger);
    root.appendChild(menu);
    select.parentNode.insertBefore(root, select.nextSibling);
    const control = { root, trigger, value, arrow, menu };
    islandSelectControls.set(select, control);

    root.addEventListener("click", (event) => event.stopPropagation());
    menu.addEventListener("click", (event) => event.stopPropagation());
    trigger.addEventListener("click", () => {
      if (select.disabled) return;
      if (root.classList.contains("is-open")) closeIslandSelect(control, false);
      else openIslandSelect(select, control, false);
    });
    trigger.addEventListener("keydown", (event) => {
      if (select.disabled) return;
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!root.classList.contains("is-open")) openIslandSelect(select, control, true);
        else focusIslandOption(control, event.key === "ArrowUp" ? "previous" : "next");
      } else if (event.key === "Escape" && root.classList.contains("is-open")) {
        event.preventDefault();
        closeIslandSelect(control, false);
      }
    });
    refreshIslandSelect(select, true);
  });

  if (!islandSelectDocumentListenerAttached) {
    document.addEventListener("click", () => closeAllIslandSelects(null));
    islandSelectDocumentListenerAttached = true;
  }
}

function sanitizeMessage(value) {
  let message = String(value || "未知错误");
  if (state.apiKey) message = message.split(state.apiKey).join("[已隐藏]");
  if (state.arkApiKey) message = message.split(state.arkApiKey).join("[已隐藏]");
  message = message.replace(/katu-sk-[A-Za-z0-9_-]+/gi, "[已隐藏的 API Key]");
  message = message.replace(/\bark-[A-Za-z0-9_-]{24,}\b/gi, "[已隐藏的方舟 API Key]");
  message = message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已隐藏]");
  return message.replace(/\s+/g, " ").trim().slice(0, 360);
}

function hideStatus() {
  if (statusHideTimer !== null) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  if (elements.notificationLayer) elements.notificationLayer.classList.add("is-hidden");
  if (elements.status) elements.status.classList.add("is-hidden");
}

function setStatus(kind, title, detail) {
  if (pluginDestroyed || !elements.status || !elements.statusIcon || !elements.statusTitle || !elements.statusDetail) return;
  const resolvedKind = kind || "idle";
  if (statusHideTimer !== null) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  syncNotificationLayout();
  elements.status.dataset.kind = resolvedKind;
  elements.statusIcon.textContent = {
    idle: "i",
    working: "…",
    success: "✓",
    warning: "!",
    error: "×"
  }[resolvedKind] || "i";
  elements.statusTitle.textContent = sanitizeMessage(title);
  elements.statusDetail.textContent = sanitizeMessage(detail || "");
  if (elements.notificationLayer) elements.notificationLayer.classList.remove("is-hidden");
  elements.status.classList.remove("is-hidden");
  // Notifications are transient. Long-running work is still represented by
  // the task progress area, so it does not need to keep this bar open.
  statusHideTimer = setTimeout(() => {
    statusHideTimer = null;
    if (elements.notificationLayer) elements.notificationLayer.classList.add("is-hidden");
    if (elements.status) elements.status.classList.add("is-hidden");
  }, STATUS_HIDE_DELAY_MS);
}

function normalizeUpdateVersion(value) {
  const text = String(value || "").trim().replace(/^v/i, "").split(/[+-]/)[0];
  return /^\d+\.\d+\.\d+$/.test(text) ? text : "";
}

function compareUpdateVersions(left, right) {
  const a = normalizeUpdateVersion(left).split(".").map(Number);
  const b = normalizeUpdateVersion(right).split(".").map(Number);
  if (a.length !== 3 || b.length !== 3) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function renderUpdateControl() {
  if (!elements.pluginVersion) return;
  const availableVersion = state.updateAvailable && state.updateAvailable.version;
  const hasUpdate = Boolean(
    availableVersion && compareUpdateVersions(availableVersion, UPDATE_CONFIG.currentVersion) > 0
  );
  elements.pluginVersion.classList.toggle("has-update", hasUpdate);
  elements.pluginVersion.textContent = hasUpdate
    ? `v${UPDATE_CONFIG.currentVersion} · 更新`
    : `v${UPDATE_CONFIG.currentVersion}`;
  elements.pluginVersion.title = hasUpdate
    ? `发现 v${availableVersion}，点击开始更新`
    : "检查更新";
  elements.pluginVersion.setAttribute(
    "aria-label",
    hasUpdate
      ? `当前版本 v${UPDATE_CONFIG.currentVersion}，发现新版 v${availableVersion}，点击开始更新`
      : `当前版本 v${UPDATE_CONFIG.currentVersion}，点击检查更新`
  );
}

function showUpdateAvailableNotice(source) {
  const availableVersion = state.updateAvailable && state.updateAvailable.version;
  if (!availableVersion || compareUpdateVersions(availableVersion, UPDATE_CONFIG.currentVersion) <= 0) {
    return false;
  }
  setStatus(
    "warning",
    `发现新版 v${availableVersion}`,
    source === "cache"
      ? "上次检查已确认有新版本；点击左上角图标或带“更新”的版本号开始更新"
      : "点击左上角图标或带“更新”的版本号，即可启动自动更新程序"
  );
  return true;
}

function saveUpdateCheckCache() {
  try {
    localStorage.setItem(UPDATE_CHECK_STORAGE, JSON.stringify({
      checkedAt: state.updateLastCheckedAt,
      availableVersion: state.updateAvailable && state.updateAvailable.version || ""
    }));
  } catch (_) {
    // Update checking still works when localStorage is unavailable.
  }
}

function loadUpdateCheckCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(UPDATE_CHECK_STORAGE) || "{}");
    state.updateLastCheckedAt = Number(cached.checkedAt) || 0;
    const availableVersion = normalizeUpdateVersion(cached.availableVersion);
    if (availableVersion && compareUpdateVersions(availableVersion, UPDATE_CONFIG.currentVersion) > 0) {
      state.updateAvailable = { version: availableVersion, cached: true };
    }
  } catch (_) {
    // Ignore a cleared or damaged optional cache.
  }
  renderUpdateControl();
}

async function fetchLatestPluginRelease() {
  const response = await limitedFetch(`${UPDATE_CONFIG.latestReleaseApi}?_=${Date.now()}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    credentials: "omit",
    redirect: "error"
  });
  if (response.status === 404) {
    const error = new Error("GitHub 仓库还没有发布 Release");
    error.noRelease = true;
    throw error;
  }
  const rawBuffer = await readBoundedResponse(response, UPDATE_CONFIG.maxResponseBytes, "更新信息");
  const raw = utf8BytesToString(new Uint8Array(rawBuffer));
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (_) {
    throw new Error("GitHub 返回了无法解析的更新信息");
  }
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
  const version = normalizeUpdateVersion(payload && payload.tag_name);
  if (!version) throw new Error("最新 Release 的版本标签不正确");
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const zipAsset = assets.find((asset) => (
    asset && /\.zip$/i.test(String(asset.name || "")) && Number(asset.size) > 0
  ));
  return {
    version,
    tag: String(payload.tag_name || ""),
    assetName: zipAsset ? String(zipAsset.name || "") : "GitHub 源码归档",
    releaseUrl: String(payload.html_url || UPDATE_CONFIG.releasesPage)
  };
}

async function checkForPluginUpdate(manual) {
  if (state.checkingUpdate) return Boolean(state.updateAvailable);
  state.checkingUpdate = true;
  updateControls();
  if (manual) setStatus("working", "正在检查更新", "正在读取 GitHub Releases");
  try {
    const release = await fetchLatestPluginRelease();
    state.updateLastCheckedAt = Date.now();
    state.updateAvailable = compareUpdateVersions(release.version, UPDATE_CONFIG.currentVersion) > 0
      ? release
      : null;
    saveUpdateCheckCache();
    renderUpdateControl();
    if (state.updateAvailable) {
      showUpdateAvailableNotice("network");
      return true;
    }
    if (manual) setStatus("success", "当前已经是最新版", `即杏智绘 v${UPDATE_CONFIG.currentVersion}`);
    return false;
  } catch (error) {
    state.updateLastCheckedAt = Date.now();
    saveUpdateCheckCache();
    if (manual) {
      setStatus(
        error && error.noRelease ? "idle" : "warning",
        error && error.noRelease ? "暂时没有可安装的更新" : "检查更新失败",
        error && (error.message || error)
      );
    }
    return false;
  } finally {
    state.checkingUpdate = false;
    updateControls();
  }
}

async function launchPluginUpdater() {
  const pluginFolder = await localFileSystem.getPluginFolder();
  const updaterFolder = await pluginFolder.getEntry(UPDATE_CONFIG.updaterFolder);
  const updaterFile = await updaterFolder.getEntry(UPDATE_CONFIG.updaterFile);
  const updaterPath = localFileSystem.getNativePath(updaterFile);
  if (!updaterPath) throw new Error("无法定位更新程序");
  const result = await shell.openPath(updaterPath, "用于下载并安装即杏智绘的新版本");
  if (result) throw new Error(result);
  setStatus(
    "working",
    "正在静默更新",
    "文档已保存；更新程序将关闭 Photoshop、替换插件文件并自动重新打开"
  );
}

async function saveOpenDocumentsBeforeUpdate() {
  const documents = Array.from(app.documents || []);
  const unsavedDocuments = documents.filter((document) => !document.saved);
  if (!unsavedDocuments.length) return 0;

  setStatus(
    "working",
    `正在保存 ${unsavedDocuments.length} 个 Photoshop 文档`,
    "未保存过的新文档会显示保存位置窗口；取消保存将停止更新"
  );
  await core.executeAsModal(async () => {
    for (const document of unsavedDocuments) {
      await document.save();
      if (!document.saved) throw new Error(`“${document.title || document.name || "未命名文档"}”没有保存，更新已停止`);
    }
  }, {
    commandName: "保存文档并准备更新",
    interactive: true,
    timeOut: 30
  });

  const stillUnsaved = Array.from(app.documents || []).filter((document) => !document.saved);
  if (stillUnsaved.length) throw new Error("仍有文档没有保存，更新已停止");
  return unsavedDocuments.length;
}

async function prepareAndLaunchPluginUpdate() {
  if (isUpdateBlocked()) {
    setStatus("warning", "当前不能更新", "请等待生成、素材读取或历史查询结束后再试");
    return false;
  }
  state.installingUpdate = true;
  updateControls();
  try {
    await saveOpenDocumentsBeforeUpdate();
    setStatus("working", "文档保存完成", "正在启动静默更新，随后会自动关闭 Photoshop");
    await launchPluginUpdater();
    return true;
  } catch (error) {
    state.installingUpdate = false;
    updateControls();
    setStatus("warning", "更新已停止", error.message || error);
    throw error;
  }
}

function isUpdateBlocked() {
  return Boolean(
    state.checkingUpdate || state.installingUpdate || state.preparingJob || state.capturing ||
    state.inserting || state.loadingPersistentHistory || state.paletteProcessing ||
    state.promptOptimizing || state.generationJobs.length || state.recoveringPendingHistory
  );
}

async function handleUpdateControlActivation() {
  if (isUpdateBlocked()) return false;
  if (!state.updateAvailable) {
    const available = await checkForPluginUpdate(true);
    if (!available || isUpdateBlocked()) return false;
  }
  if (isUpdateBlocked()) return false;
  return await prepareAndLaunchPluginUpdate();
}

function updateControls() {
  state.running = state.generationJobs.length > 0;
  const operationBusy = state.preparingJob || state.capturing || state.inserting || state.loadingPersistentHistory || state.paletteProcessing || state.installingUpdate;
  const busy = operationBusy || state.promptOptimizing;
  const promptBusy = state.inserting || state.loadingPersistentHistory || state.paletteProcessing || state.installingUpdate || state.promptOptimizing;
  Array.from(elements.referenceList && elements.referenceList.querySelectorAll(".reference-thumb") || []).forEach((node) => {
    // UXP's native HTML5 drop event is unreliable. Reordering is handled by
    // the mouse drag fallback in bindEvents instead.
    node.setAttribute("draggable", "false");
    const image = node.querySelector(".reference-thumb-image");
    if (image) image.setAttribute("draggable", "false");
  });
  const full = state.references.length >= MAX_REFERENCES;
  const outfitFull = outfitReferencePool().length >= MAX_OUTFIT_REFERENCES;
  const productFull = productReferencePool().length >= MAX_PRODUCT_REFERENCES;
  const outfitPoolBusy = referencePoolMutationActive("outfit");
  const productPoolBusy = referencePoolMutationActive("product");
  const selectedResult = getSelectedResult();
  const updateBlocked = isUpdateBlocked();
  if (elements.pluginVersion) {
    if ("disabled" in elements.pluginVersion) elements.pluginVersion.disabled = updateBlocked;
    elements.pluginVersion.setAttribute("aria-disabled", updateBlocked ? "true" : "false");
  }
  if (elements.settingsCheckUpdate) elements.settingsCheckUpdate.disabled = updateBlocked;
  // The source menu must remain openable while another panel operation is
  // finishing. The actual capture/import functions still validate whether
  // the operation can start; disabling this button makes UXP swallow the
  // click entirely, leaving the reference area looking dead.
  elements.referenceAdd.disabled = full;
  elements.referenceFromSelection.disabled = full;
  elements.referenceFromLayer.disabled = full;
  elements.referenceFromLocal.disabled = full;
  if (elements.referenceQuickLayer) elements.referenceQuickLayer.disabled = full;
  if (elements.referenceQuickSelection) elements.referenceQuickSelection.disabled = full;
  if (elements.referenceQuickClear) elements.referenceQuickClear.disabled = state.references.length === 0;
  elements.run.disabled = busy || state.runSubmissionPending || state.generationJobs.length >= MAX_ACTIVE_JOBS;
  if (elements.editorClear) elements.editorClear.disabled = busy || state.generationJobs.length > 0 || (!state.references.length && !getPromptValue());
  elements.insert.disabled = busy || !selectedResult;
  const editorActionRow = elements.run && elements.run.parentElement;
  if (editorActionRow) {
    editorActionRow.style.setProperty("position", "relative", "important");
    editorActionRow.style.setProperty("top", "0", "important");
    editorActionRow.style.setProperty("transform", "translateY(-3px)", "important");
    Array.from(editorActionRow.querySelectorAll("button")).forEach((button) => {
      button.style.setProperty("position", "static", "important");
      button.style.setProperty("top", "0", "important");
      button.style.setProperty("transform", "none", "important");
    });
  }
  const generationCanStop = state.generationJobs.some((job) => !job.controller.signal.aborted);
  const historyCanStop = Boolean(
    state.recoveringPendingHistory && pendingHistoryRecoveryController &&
    !pendingHistoryRecoveryController.signal.aborted
  );
  if (elements.stop) elements.stop.disabled = !generationCanStop && !historyCanStop;
  elements.aspectRatio.disabled = busy;
  elements.modelChannel.disabled = busy;
  elements.resolution.disabled = busy;
  elements.generationCount.disabled = busy;
  elements.precisionPlacement.disabled = busy;
  elements.precisionPlacementToggle.setAttribute("aria-disabled", busy ? "true" : "false");
  setPromptDisabled(promptBusy);
  // Keep the picker clickable even when the library is empty so it can explain
  // its empty state instead of looking like a broken control.
  elements.promptLibrary.disabled = promptBusy;
  elements.favoritePrompt.disabled = promptBusy || !getPromptValue().trim();
  if (elements.styleLibraryOpen) elements.styleLibraryOpen.disabled = promptBusy;
  const outfitTargetFull = outfitFull && !outfitTargetReference();
  const outfitFaceFull = outfitFull && !outfitFaceReference();
  const outfitBackgroundFull = outfitFull && !outfitBackgroundReference();
  elements.outfitCaptureTarget.disabled = busy || outfitPoolBusy || outfitTargetFull;
  elements.outfitAddTargetSelection.disabled = busy || outfitPoolBusy || outfitTargetFull;
  elements.outfitAddTargetLayer.disabled = busy || outfitPoolBusy || outfitTargetFull;
  elements.outfitAddTargetLocal.disabled = busy || outfitPoolBusy || outfitTargetFull;
  elements.outfitFaceAdd.disabled = busy || outfitPoolBusy || outfitFaceFull;
  elements.outfitAddFaceSelection.disabled = busy || outfitPoolBusy || outfitFaceFull;
  elements.outfitAddFaceLocal.disabled = busy || outfitPoolBusy || outfitFaceFull;
  elements.outfitAddFaceLayer.disabled = busy || outfitPoolBusy || outfitFaceFull;
  elements.outfitClearTarget.disabled = busy || outfitPoolBusy || !outfitTargetReference();
  elements.outfitClearFace.disabled = busy || outfitPoolBusy || !outfitFaceReference();
  if (elements.outfitBackgroundAdd) elements.outfitBackgroundAdd.disabled = busy || outfitPoolBusy || outfitBackgroundFull;
  if (elements.outfitAddBackgroundSelection) elements.outfitAddBackgroundSelection.disabled = busy || outfitPoolBusy || outfitBackgroundFull;
  if (elements.outfitAddBackgroundLayer) elements.outfitAddBackgroundLayer.disabled = busy || outfitPoolBusy || outfitBackgroundFull;
  if (elements.outfitAddBackgroundLocal) elements.outfitAddBackgroundLocal.disabled = busy || outfitPoolBusy || outfitBackgroundFull;
  if (elements.outfitClearBackground) elements.outfitClearBackground.disabled = busy || outfitPoolBusy || !outfitBackgroundReference();
  document.querySelectorAll('[role="radio"][data-outfit-mode]').forEach((button) => {
    button.disabled = busy || outfitPoolBusy;
    button.setAttribute("aria-disabled", busy || outfitPoolBusy ? "true" : "false");
  });
  Array.from(elements.outfitGarmentList.querySelectorAll("button") || []).forEach((button) => {
    const removeIndex = button.getAttribute("data-outfit-garment-remove");
    const menuIndex = button.getAttribute("data-outfit-garment-menu");
    const sourceIndex = button.getAttribute("data-outfit-garment-selection") ||
      button.getAttribute("data-outfit-garment-layer") || button.getAttribute("data-outfit-garment-local");
    const slotIndex = menuIndex !== null ? menuIndex : sourceIndex;
    const replacingFilledSlot = slotIndex !== null && slotIndex !== undefined && Boolean(
      outfitGarmentSlotReferences()[Math.max(0, Math.min(2, Number(slotIndex) || 0))]
    );
    button.disabled = busy || outfitPoolBusy || (outfitFull && removeIndex === null && !replacingFilledSlot);
  });
  elements.outfitModelChannel.disabled = busy;
  elements.outfitResolution.disabled = busy;
  elements.outfitGenerationCount.disabled = busy;
  elements.outfitPrompt.disabled = promptBusy;
  elements.outfitExtraPrompt.disabled = promptBusy;
  elements.outfitRun.disabled = busy || outfitPoolBusy || state.runSubmissionPending || state.generationJobs.length >= MAX_ACTIVE_JOBS;
  elements.outfitStop.disabled = !generationCanStop && !historyCanStop;
  elements.outfitInsert.disabled = elements.insert.disabled;
  if (elements.productMainReferenceAdd) elements.productMainReferenceAdd.disabled = busy || productPoolBusy || (productFull && !productReference("main"));
  if (elements.productSceneReferenceAdd) elements.productSceneReferenceAdd.disabled = busy || productPoolBusy || (productFull && !productReference("scene"));
  if (elements.productMainReferenceRemove) elements.productMainReferenceRemove.disabled = busy || productPoolBusy || !productReference("main");
  if (elements.productSceneReferenceRemove) elements.productSceneReferenceRemove.disabled = busy || productPoolBusy || !productReference("scene");
  Array.from(elements.productTypeGroup && elements.productTypeGroup.querySelectorAll("[data-product-type]") || []).forEach((button) => {
    button.disabled = promptBusy;
  });
  if (elements.productCategory) elements.productCategory.disabled = promptBusy;
  if (elements.productPlatform) elements.productPlatform.disabled = promptBusy;
  if (elements.productRetention) elements.productRetention.disabled = promptBusy;
  if (elements.productBackgroundDescription) elements.productBackgroundDescription.disabled = promptBusy;
  if (elements.productComposition) elements.productComposition.disabled = promptBusy;
  if (elements.productProtectBrand) elements.productProtectBrand.disabled = promptBusy;
  if (elements.productExtraPrompt) elements.productExtraPrompt.disabled = promptBusy;
  if (elements.productAspectRatio) elements.productAspectRatio.disabled = busy;
  if (elements.productResolution) elements.productResolution.disabled = busy;
  if (elements.productGenerationCount) elements.productGenerationCount.disabled = busy;
  if (elements.productRun) elements.productRun.disabled = busy || productPoolBusy || state.runSubmissionPending || state.generationJobs.length >= MAX_ACTIVE_JOBS;
  if (elements.settingsRunSelfCheck) elements.settingsRunSelfCheck.disabled = state.selfCheckRunning || state.preparingJob || state.inserting;
  syncIslandSelects();
}

function updatePromptCount() {
  let prompt = getPromptValue();
  if (prompt.length > 20000) {
    const selection = getPromptSelection();
    prompt = prompt.slice(0, 20000);
    setPromptValue(prompt);
    setPromptSelection(Math.min(selection.start, prompt.length), Math.min(selection.end, prompt.length));
  }
  elements.promptCount.textContent = `${prompt.length} / 20000 · Ctrl+Enter 运行`;
  updateFavoriteButton();
  updateControls();
}

function normalizePromptList(value, limit) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const item of value) {
    const prompt = String(item || "").trim();
    if (!prompt || output.includes(prompt)) continue;
    output.push(prompt.slice(0, 20000));
    if (output.length >= limit) break;
  }
  return output;
}

function truncatePromptLabel(prompt, limit) {
  const compact = String(prompt || "").replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : compact;
}

function appendFavoritePromptOptions(prompts) {
  prompts.forEach((prompt, index) => {
    const option = document.createElement("option");
    option.value = `favorite:${index}`;
    option.textContent = truncatePromptLabel(prompt, 38);
    option.title = prompt;
    elements.promptLibrary.appendChild(option);
  });
}

function renderPromptLibrary() {
  while (elements.promptLibrary.firstChild) {
    elements.promptLibrary.removeChild(elements.promptLibrary.firstChild);
  }
  if (state.favoritePrompts.length) {
    appendFavoritePromptOptions(state.favoritePrompts);
    elements.promptLibrary.value = "favorite:0";
  } else {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "暂无收藏";
    elements.promptLibrary.appendChild(placeholder);
    elements.promptLibrary.value = "";
  }
  refreshIslandSelect(elements.promptLibrary, true);
  updateFavoriteButton();
}

function updateFavoriteButton() {
  if (!elements.favoritePrompt || !elements.prompt) return;
  const prompt = getPromptValue().trim();
  const saved = Boolean(prompt) && state.favoritePrompts.includes(prompt);
  elements.favoritePrompt.textContent = saved ? "已收藏" : "收藏";
  elements.favoritePrompt.classList.toggle("is-saved", saved);
}

function toggleFavoritePrompt() {
  const prompt = getPromptValue().trim();
  if (!prompt) return;
  const index = state.favoritePrompts.indexOf(prompt);
  if (index >= 0) {
    state.favoritePrompts.splice(index, 1);
    setStatus("idle", "已取消收藏", truncatePromptLabel(prompt, 42));
  } else {
    state.favoritePrompts.unshift(prompt);
    state.favoritePrompts = normalizePromptList(state.favoritePrompts, MAX_FAVORITE_PROMPTS);
    setStatus("success", "提示词已收藏", `最多保留 ${MAX_FAVORITE_PROMPTS} 条收藏`);
  }
  saveSettings();
  renderPromptLibrary();
  updateControls();
}

function applyPromptLibrarySelection() {
  const value = String(elements.promptLibrary.value || "");
  const match = /^favorite:(\d+)$/.exec(value);
  if (!match) return;
  const prompt = state.favoritePrompts[Number(match[1])];
  if (prompt) {
    setPromptValue(prompt);
    elements.prompt.focus();
    setPromptSelection(prompt.length, prompt.length);
    updatePromptCount();
  }
  refreshIslandSelect(elements.promptLibrary, false);
}

function styleLibraryText(value) {
  if (value && typeof value === "object") return String(value.zh || value.en || "").trim();
  return String(value || "").trim();
}

function styleLibraryTemplates() {
  if (!GPT_IMAGE2_STYLE_LIBRARY) {
    try {
      GPT_IMAGE2_STYLE_LIBRARY = require("./lib/gpt-image2-style-library.json");
    } catch (_) {
      GPT_IMAGE2_STYLE_LIBRARY = { templates: [], categories: [] };
    }
  }
  return Array.isArray(GPT_IMAGE2_STYLE_LIBRARY.templates)
    ? GPT_IMAGE2_STYLE_LIBRARY.templates
    : [];
}

function initializeStyleLibraryCategories(rebuild = false) {
  styleLibraryTemplates();
  if (!elements.styleLibraryCategory || (!rebuild && elements.styleLibraryCategory.options.length)) return;
  const selected = elements.styleLibraryCategory.value;
  while (elements.styleLibraryCategory.firstChild) elements.styleLibraryCategory.removeChild(elements.styleLibraryCategory.firstChild);
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部分类";
  elements.styleLibraryCategory.appendChild(all);
  const categories = Array.isArray(GPT_IMAGE2_STYLE_LIBRARY && GPT_IMAGE2_STYLE_LIBRARY.categories)
    ? GPT_IMAGE2_STYLE_LIBRARY.categories
    : [];
  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = String(category && category.value || "");
    option.textContent = styleLibraryText(category && category.title) || option.value;
    if (option.value) elements.styleLibraryCategory.appendChild(option);
  });
  elements.styleLibraryCategory.value = categories.some((category) => category.value === selected) ? selected : "";
  refreshIslandSelect(elements.styleLibraryCategory, true);
}

function renderStyleLibraryUpdateStatus(status = styleLibraryUpdateState) {
  if (!elements.styleLibraryUpdateStatus || pluginDestroyed) return;
  let message = "本地词库 · 打开时检查更新";
  if (status) {
    if (status.phase === "loading" || status.phase === "checking") message = "正在检查更新 · 已有词库可继续使用";
    else if (status.phase === "updating") message = "正在同步新词条 · 已有词库可继续使用";
    else if (status.phase === "error" || status.phase === "offline") message = "暂时无法更新 · 继续使用已有词库";
    else if (status.phase === "cached") message = "已加载本地缓存 · 打开时检查更新";
    else {
      const changes = [];
      if (status.added > 0) changes.push(`新增 ${status.added} 条`);
      if (status.updated > 0) changes.push(`修订 ${status.updated} 条`);
      const time = status.checkedAt ? new Date(status.checkedAt) : null;
      const checkedTime = time && !Number.isNaN(time.getTime())
        ? `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}` : "";
      message = changes.length ? `已更新 · ${changes.join("，")}` : (checkedTime ? `${checkedTime} 已检查 · 暂无更新` : message);
      if (status.failedSources && status.failedSources.length) message = changes.length
        ? `${message} · 部分来源暂不可用` : "部分来源暂不可用 · 保留已有词条";
      if (status.cacheError) message += " · 缓存未保存，下次将重新同步";
    }
  }
  if (pendingStyleLibrary) message += " · 关闭详情后刷新列表";
  elements.styleLibraryUpdateStatus.textContent = message;
  elements.styleLibraryUpdateStatus.title = status && status.generatedAt
    ? `${message}；来源发布于 ${status.generatedAt}；仅打开词库时检查，按上游实际发布时间同步。`
    : `${message}；仅打开词库时检查，按上游实际发布时间同步。`;
}

function acceptUpdatedStyleLibrary(library) {
  if (pluginDestroyed) return;
  // A detail dialog must keep the exact prompt the user is reading until it
  // closes, including when they apply it while an update finishes.
  if (styleLibraryDetailTemplateId) {
    pendingStyleLibrary = library;
    renderStyleLibraryUpdateStatus();
    return;
  }
  const anchor = styleLibraryPageIndex > 0
    ? matchingStyleLibraryTemplates()[styleLibraryPageIndex * STYLE_LIBRARY_PAGE_SIZE] : null;
  GPT_IMAGE2_STYLE_LIBRARY = library;
  initializeStyleLibraryCategories(true);
  if (anchor) {
    const index = matchingStyleLibraryTemplates().findIndex((item) => item.id === anchor.id);
    if (index >= 0) styleLibraryPageIndex = Math.floor(index / STYLE_LIBRARY_PAGE_SIZE);
  }
  if (state.activeWorkspace === "library") renderStyleLibrary();
}

async function requestStyleLibraryJson(url, maxBytes, signal, expectedHash) {
  return withRequestTimeout(signal, 15000, async (requestSignal) => {
    const response = await limitedFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      credentials: "omit",
      redirect: "error",
      signal: requestSignal
    });
    if (!response.ok) throw new Error(`词库来源暂不可用（HTTP ${response.status}）`);
    const buffer = await readBoundedResponse(response, maxBytes, "词库数据");
    if (expectedHash && sha256Hex(new Uint8Array(buffer)) !== String(expectedHash).toLowerCase()) {
      throw new Error("词库来源版本校验失败");
    }
    return JSON.parse(utf8BytesToString(new Uint8Array(buffer)));
  });
}

async function readStyleLibraryCache() {
  const folder = await localFileSystem.getDataFolder();
  let file;
  try { file = await folder.getEntry(STYLE_LIBRARY_CACHE_FILE); } catch (_) { return null; }
  const metadata = await file.getMetadata();
  if (Number(metadata.size) > STYLE_LIBRARY_CACHE_MAX_BYTES) throw new Error("词库缓存过大");
  const raw = String(await file.read({ format: formats.utf8 }) || "");
  if (raw.length > STYLE_LIBRARY_CACHE_MAX_BYTES) throw new Error("词库缓存过大");
  return JSON.parse(raw);
}

async function writeStyleLibraryCache(cache) {
  if (pluginDestroyed) return;
  const raw = JSON.stringify(cache);
  if (raw.length > STYLE_LIBRARY_CACHE_MAX_BYTES) throw new Error("词库缓存过大");
  const folder = await localFileSystem.getDataFolder();
  if (pluginDestroyed) return;
  const nextFile = await folder.createFile("prompt-library-cache-v1.next.json", { overwrite: true });
  await nextFile.write(raw, { format: formats.utf8 });
  if (pluginDestroyed) return;
  await nextFile.moveTo(folder, { newName: STYLE_LIBRARY_CACHE_FILE, overwrite: true });
}

function getStyleLibraryUpdater() {
  if (!styleLibraryUpdater) {
    styleLibraryTemplates();
    styleLibraryUpdater = createStyleLibraryUpdater({
      bundled: GPT_IMAGE2_STYLE_LIBRARY,
      requestJson: requestStyleLibraryJson,
      readCache: readStyleLibraryCache,
      writeCache: writeStyleLibraryCache,
      onLibrary: acceptUpdatedStyleLibrary,
      onStatus: (status) => {
        if (pluginDestroyed) return;
        styleLibraryUpdateState = status;
        renderStyleLibraryUpdateStatus();
      }
    });
  }
  return styleLibraryUpdater;
}

function refreshStyleLibraryOnOpen() {
  // No polling or focus handler: only entering this workspace triggers a
  // check. Concurrent opens share the updater's in-flight request.
  return getStyleLibraryUpdater().refresh({ force: true }).catch(() => {
    styleLibraryUpdateState = { phase: "error" };
    renderStyleLibraryUpdateStatus();
  });
}

function styleLibraryTemplatePrompt(template) {
  const originalPrompt = String(template && template.prompt || "").trim();
  if (originalPrompt) return originalPrompt.slice(0, 20000);
  const title = styleLibraryText(template && template.title) || "图像创作模板";
  const useWhen = styleLibraryText(template && template.useWhen);
  const guidance = Array.isArray(template && template.guidance && template.guidance.zh)
    ? template.guidance.zh
    : [];
  const pitfalls = Array.isArray(template && template.pitfalls && template.pitfalls.zh)
    ? template.pitfalls.zh
    : [];
  const styles = Array.isArray(template && template.styles) ? template.styles : [];
  const scenes = Array.isArray(template && template.scenes) ? template.scenes : [];
  const sections = [`【${title}】`];
  if (useWhen) sections.push(`创作目标：${useWhen}`);
  if (styles.length || scenes.length) sections.push(`视觉方向：${[...styles, ...scenes].join("、")}`);
  if (guidance.length) sections.push(`画面要求：\n${guidance.map((item) => `- ${String(item || "").trim()}`).filter(Boolean).join("\n")}`);
  if (pitfalls.length) sections.push(`避免：\n${pitfalls.map((item) => `- ${String(item || "").trim()}`).filter(Boolean).join("\n")}`);
  sections.push("请保持主体清晰、构图完整、文字可读；根据当前参考图和画布比例完成创作。");
  return sections.join("\n\n").slice(0, 20000);
}

function matchingStyleLibraryTemplates() {
  const category = String(elements.styleLibraryCategory && elements.styleLibraryCategory.value || "");
  const query = String(elements.styleLibrarySearch && elements.styleLibrarySearch.value || "").trim().toLowerCase();
  return styleLibraryTemplates().filter((template) => {
    if (category && String(template && template.category || "") !== category) return false;
    if (!query) return true;
    const content = [
      styleLibraryText(template && template.title),
      styleLibraryText(template && template.description),
      styleLibraryText(template && template.useWhen),
      String(template && template.prompt || ""),
      String(template && template.author || ""),
      String(template && template.sourceTitle || ""),
      ...(Array.isArray(template && template.styles) ? template.styles : []),
      ...(Array.isArray(template && template.scenes) ? template.scenes : []),
      ...(Array.isArray(template && template.tags) ? template.tags : [])
    ].join(" ").toLowerCase();
    return content.includes(query);
  });
}

function renderStyleLibraryPagination(pageCount, totalItems) {
  if (elements.styleLibraryTotal) elements.styleLibraryTotal.textContent = `共 ${totalItems} 个`;
  if (!elements.styleLibraryPage) return;
  while (elements.styleLibraryPage.firstChild) elements.styleLibraryPage.removeChild(elements.styleLibraryPage.firstChild);
  if (!pageCount) return;
  const currentPage = styleLibraryPageIndex + 1;
  const pages = [];
  if (pageCount <= 7) {
    for (let page = 1; page <= pageCount; page += 1) pages.push(page);
  } else {
    pages.push(1);
    if (currentPage <= 3) {
      for (let page = 2; page <= Math.min(pageCount - 1, currentPage + 1); page += 1) pages.push(page);
      if (currentPage + 1 < pageCount - 1) pages.push("…");
    } else {
      pages.push("…");
      for (let page = Math.max(2, currentPage - 1); page <= Math.min(pageCount - 1, currentPage + 1); page += 1) pages.push(page);
      if (currentPage + 1 < pageCount - 1) pages.push("…");
    }
    pages.push(pageCount);
  }
  pages.forEach((page) => {
    const control = document.createElement("span");
    if (page === "…") {
      control.className = "style-library-ellipsis";
      control.textContent = "…";
    } else {
      control.className = "style-library-page-button";
      control.textContent = String(page);
      control.setAttribute("role", "button");
      control.setAttribute("tabindex", "0");
      control.setAttribute("data-style-library-page", String(page - 1));
      if (page === currentPage) {
        control.classList.add("is-active");
        control.setAttribute("aria-current", "page");
      }
    }
    elements.styleLibraryPage.appendChild(control);
  });
}

function renderStyleLibrary() {
  if (!elements.styleLibraryList) return;
  initializeStyleLibraryCategories();
  const templates = matchingStyleLibraryTemplates();
  if (elements.styleLibraryCount) elements.styleLibraryCount.textContent = `${templates.length} 个模板`;
  while (elements.styleLibraryList.firstChild) elements.styleLibraryList.removeChild(elements.styleLibraryList.firstChild);
  if (!templates.length) {
    styleLibraryPageIndex = 0;
    renderStyleLibraryPagination(0, 0);
    if (elements.styleLibraryPrevious) elements.styleLibraryPrevious.disabled = true;
    if (elements.styleLibraryNext) elements.styleLibraryNext.disabled = true;
    const empty = document.createElement("p");
    empty.className = "style-library-empty";
    empty.textContent = "没有匹配的模板";
    elements.styleLibraryList.appendChild(empty);
    return;
  }
  const pageCount = Math.max(1, Math.ceil(templates.length / STYLE_LIBRARY_PAGE_SIZE));
  styleLibraryPageIndex = Math.max(0, Math.min(styleLibraryPageIndex, pageCount - 1));
  const pageStart = styleLibraryPageIndex * STYLE_LIBRARY_PAGE_SIZE;
  const pageTemplates = templates.slice(pageStart, pageStart + STYLE_LIBRARY_PAGE_SIZE);
  renderStyleLibraryPagination(pageCount, templates.length);
  if (elements.styleLibraryPrevious) elements.styleLibraryPrevious.disabled = styleLibraryPageIndex <= 0;
  if (elements.styleLibraryNext) elements.styleLibraryNext.disabled = styleLibraryPageIndex >= pageCount - 1;
  pageTemplates.forEach((template) => {
    const item = document.createElement("div");
    item.className = "style-library-item";
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.setAttribute("data-style-template-id", String(template.id || ""));
    item.title = "追加到当前提示词";
    const coverUrl = String(template.coverUrl || "").trim();
    const thumb = document.createElement(coverUrl ? "img" : "span");
    thumb.className = coverUrl ? "style-library-thumb" : "style-library-thumb style-library-thumb-empty";
    if (coverUrl) {
      thumb.src = coverUrl;
      thumb.alt = "";
      thumb.loading = "lazy";
      thumb.addEventListener("error", () => {
        const fallback = document.createElement("span");
        fallback.className = "style-library-thumb style-library-thumb-empty";
        fallback.setAttribute("aria-hidden", "true");
        if (thumb.parentNode) thumb.parentNode.replaceChild(fallback, thumb);
      }, { once: true });
    }
    const content = document.createElement("span");
    content.className = "style-library-content";
    const title = document.createElement("strong");
    title.textContent = styleLibraryText(template.title) || "未命名模板";
    const description = document.createElement("span");
    description.className = "style-library-description";
    const descriptionText = styleLibraryText(template.description) || styleLibraryText(template.useWhen) || String(template.prompt || "");
    description.textContent = descriptionText.length > 160 ? descriptionText.slice(0, 160) + "..." : descriptionText;
    const tags = document.createElement("span");
    tags.className = "style-library-tags";
    tags.textContent = [String(template.sourceTitle || ""), String(template.author || ""), ...(template.tags || []), ...(template.styles || []), ...(template.scenes || [])].filter(Boolean).slice(0, 5).join(" · " );
    content.appendChild(title);
    content.appendChild(description);
    if (tags.textContent) content.appendChild(tags);
    item.appendChild(thumb);
    item.appendChild(content);
    elements.styleLibraryList.appendChild(item);
  });
}

function closeStyleLibraryDetail() {
  styleLibraryDetailImageRequestToken += 1;
  styleLibraryDetailTemplateId = "";
  if (elements.styleLibraryDetailOverlay) elements.styleLibraryDetailOverlay.classList.add("is-hidden");
  if (elements.styleLibraryWorkspace) elements.styleLibraryWorkspace.classList.remove("is-detail-open");
  if (elements.styleLibraryDetailImage) {
    elements.styleLibraryDetailImage.removeAttribute("src");
    elements.styleLibraryDetailImage.classList.add("is-hidden");
  }
  if (elements.styleLibraryDetailImageEmpty) elements.styleLibraryDetailImageEmpty.classList.remove("is-hidden");
  if (pendingStyleLibrary) {
    const library = pendingStyleLibrary;
    pendingStyleLibrary = null;
    acceptUpdatedStyleLibrary(library);
    renderStyleLibraryUpdateStatus();
  }
}

function openStyleLibraryDetail(id) {
  const template = styleLibraryTemplates().find((item) => String(item && item.id || "") === String(id || ""));
  if (!template || !elements.styleLibraryDetailOverlay) return;
  // A custom category menu is rendered outside the native select. Close it
  // before the modal is revealed so it cannot remain above the detail image.
  closeAllIslandSelects(null);
  styleLibraryDetailTemplateId = String(template.id || "");
  if (elements.styleLibraryDetailTitle) elements.styleLibraryDetailTitle.textContent = styleLibraryText(template.title) || "提示词详情";
  if (elements.styleLibraryDetailMeta) elements.styleLibraryDetailMeta.textContent = [String(template.sourceTitle || ""), String(template.author || ""), ...(template.tags || [])].filter(Boolean).slice(0, 8).join(" · " );
  if (elements.styleLibraryDetailPrompt) elements.styleLibraryDetailPrompt.textContent = String(template.prompt || "").trim();
  const image = elements.styleLibraryDetailImage;
  const empty = elements.styleLibraryDetailImageEmpty;
  const coverUrl = String(template.coverUrl || "").trim();
  const imageRequestToken = ++styleLibraryDetailImageRequestToken;
  if (image) {
    image.removeAttribute("src");
    image.classList.toggle("is-hidden", !coverUrl);
    image.onerror = () => {
      if (imageRequestToken !== styleLibraryDetailImageRequestToken) return;
      image.removeAttribute("src");
      image.classList.add("is-hidden");
      if (empty) empty.classList.remove("is-hidden");
    };
    image.onload = () => {
      if (imageRequestToken !== styleLibraryDetailImageRequestToken) return;
      image.classList.remove("is-hidden");
      if (empty) empty.classList.add("is-hidden");
    };
  }
  if (empty) empty.classList.toggle("is-hidden", Boolean(coverUrl));
  if (elements.styleLibraryWorkspace) elements.styleLibraryWorkspace.classList.add("is-detail-open");
  elements.styleLibraryDetailOverlay.classList.remove("is-hidden");
  // Keep keyboard events inside the UXP dialog instead of the Photoshop canvas.
  setTimeout(() => {
    if (elements.styleLibraryDetailOverlay.classList.contains("is-hidden")) return;
    if (typeof elements.styleLibraryDetailOverlay.focus === "function") elements.styleLibraryDetailOverlay.focus();
  }, 0);
  // UXP may skip loading a remote img while its overlay is display:none.
  // Make the dialog visible first, then start the request on the next turn.
  if (image && coverUrl) {
    setTimeout(() => {
      if (imageRequestToken !== styleLibraryDetailImageRequestToken) return;
      image.src = coverUrl;
    }, 0);
  }
}

function setStyleLibraryOpen(open) {
  if (open) {
    showWorkspace("library");
    setTimeout(() => elements.styleLibrarySearch && elements.styleLibrarySearch.focus(), 0);
  } else {
    showWorkspace("editor");
  }
}

function applyStyleLibraryTemplate(id) {
  const template = styleLibraryTemplates().find((item) => String(item && item.id || "") === String(id || ""));
  if (!template) return;
  const addition = styleLibraryTemplatePrompt(template);
  const current = getPromptValue().trim();
  const next = current ? `${current}\n\n${addition}` : addition;
  setPromptValue(next);
  state.optimizedPromptValue = "";
  setPromptSelection(next.length, next.length);
  updatePromptCount();
  showWorkspace("editor");
  elements.prompt.focus();
  setStatus("success", "词库模板已追加", styleLibraryText(template.title));
}

function formatReferenceType(mode) {
  if (mode === "selection") return "选区";
  if (mode === "layer") return "图层";
  if (mode === "import") return "导入";
  return "全图";
}

function formatReferenceOrdinal(value) {
  const numerals = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  return numerals[Number(value)] || String(value);
}

function buildReferenceLayerName(index) {
  return `图片${formatReferenceOrdinal(Math.max(1, Number(index) || 1))}`;
}

function formatReferenceLabel(reference, index) {
  if (!reference) return "参考图";
  const resolvedIndex = Number.isInteger(index)
    ? index
    : state.references.findIndex((item) => item.id === reference.id);
  let ordinal = 0;
  for (let position = 0; position <= resolvedIndex; position += 1) {
    if (state.references[position] && state.references[position].mode === reference.mode) ordinal += 1;
  }
  return `${formatReferenceType(reference.mode)}${formatReferenceOrdinal(Math.max(1, ordinal))}`;
}

async function renameLayerById(document, layerId, nextName) {
  const layer = findLayerById(document && document.layers, layerId);
  const name = String(nextName || "").trim();
  if (!layer || !name) return false;
  layer.name = name;
  return true;
}

function getPrimaryReference() {
  return state.references.find((reference) => reference && reference.snapshot) || null;
}

function getGenerationSnapshot() {
  if (state.targetSnapshot) return state.targetSnapshot;
  const primaryReference = getPrimaryReference();
  return primaryReference ? primaryReference.snapshot : null;
}

function hasPhotoshopTarget(snapshot) {
  return Boolean(
    snapshot && snapshot.mode === "selection" &&
    snapshot.documentId !== null && snapshot.documentId !== undefined
  );
}

function hasPhotoshopDocument(snapshot) {
  return Boolean(
    snapshot &&
    snapshot.documentId !== null &&
    snapshot.documentId !== undefined
  );
}

function hasCurrentPhotoshopDocument() {
  try {
    return Boolean(typeof app !== "undefined" && app.documents && app.documents.length);
  } catch (_) {
    return false;
  }
}

function canInsertResultIntoCurrentDocument(result) {
  return Boolean(result && (hasPhotoshopDocument(result.snapshot) || hasCurrentPhotoshopDocument()));
}

function syncNotificationLayout() {
  if (!elements.notificationLayer) return;
  elements.notificationLayer.style.left = "";
  elements.notificationLayer.style.right = "";
  elements.notificationLayer.style.width = "";
}

function scheduleNotificationLayout() {
  if (notificationLayoutTimer !== null) clearTimeout(notificationLayoutTimer);
  notificationLayoutTimer = setTimeout(() => {
    notificationLayoutTimer = null;
    syncNotificationLayout();
  }, 100);
}

function syncResultHistoryTileLayout(fallbackTileSize = referenceTileSize) {
  if (!elements.resultHistory) return;
  const items = Array.from(elements.resultHistory.children || []).filter((child) => (
    child.classList && child.classList.contains("result-history-item")
  ));

  let containerWidth = Number(elements.resultHistory.clientWidth) || 0;
  if (!containerWidth) {
    try {
      const bounds = elements.resultHistory.getBoundingClientRect();
      containerWidth = Number(bounds && bounds.width) || 0;
    } catch (_) {
      containerWidth = 0;
    }
  }

  const columnCount = 4;
  // clientWidth includes the history area's inner border/padding. Reserve
  // enough room for both edges so the fourth tile never wraps unexpectedly.
  const horizontalPadding = 8;
  const totalGap = 4 * (columnCount - 1);
  const measuredSize = containerWidth > horizontalPadding + totalGap
    ? Math.floor((containerWidth - horizontalPadding - totalGap) / columnCount)
    : 0;
  const tileWidth = Math.max(72, measuredSize || Number(fallbackTileSize) || 80);
  const tileHeight = Math.max(86, Math.round(tileWidth * 4 / 3) - 10);
  const widthValue = `${tileWidth}px`;
  const heightValue = `${tileHeight}px`;

  items.forEach((item, index) => {
    item.style.width = widthValue;
    item.style.height = heightValue;
    item.style.flexBasis = widthValue;
    item.style.marginRight = (index + 1) % columnCount === 0 ? "0px" : "4px";
    item.style.marginBottom = "4px";
  });

  // Pagination stays below the single visible row; reserve the remaining
  // history area for the portrait 3:4 thumbnails.
  const historyHeight = tileHeight + 10;
  elements.resultHistory.style.height = `${historyHeight}px`;
  elements.resultHistory.style.minHeight = `${historyHeight}px`;
  elements.resultHistory.style.maxHeight = `${historyHeight}px`;
}

function scheduleResultHistoryTileLayout() {
  if (resultHistoryLayoutTimer !== null) clearTimeout(resultHistoryLayoutTimer);
  resultHistoryLayoutTimer = setTimeout(() => {
    resultHistoryLayoutTimer = null;
    syncResultHistoryTileLayout();
  }, 80);
}

function syncReferenceTileLayout() {
  if (!elements.referenceList || !elements.referenceStrip || !elements.referenceAddWrap) return;
  if (elements.referenceQuickActions) {
    if (elements.referenceQuickActions.parentNode) {
      elements.referenceQuickActions.parentNode.removeChild(elements.referenceQuickActions);
    }
    elements.referenceQuickActions.style.setProperty("display", "none", "important");
    elements.referenceQuickActions.style.setProperty("visibility", "hidden", "important");
    elements.referenceQuickActions.style.setProperty("opacity", "0", "important");
    elements.referenceQuickActions.style.setProperty("pointer-events", "none", "important");
    Array.from(elements.referenceQuickActions.querySelectorAll(".reference-quick-button") || []).forEach((button) => {
      button.style.setProperty("display", "none", "important");
      button.style.setProperty("visibility", "hidden", "important");
      button.style.setProperty("opacity", "0", "important");
      button.style.setProperty("pointer-events", "none", "important");
    });
  }
  const children = Array.from(elements.referenceList.children || []);
  const tiles = children.filter((child) => (
    child.classList &&
    child.classList.contains("reference-thumb")
  ));

  // UXP does not reliably support CSS Grid. Reset legacy fixed widths first,
  // then measure the actual flex container at the current panel size.
  elements.referenceStrip.style.setProperty("position", "relative", "important");
  elements.referenceList.style.setProperty("display", "flex", "important");
  elements.referenceList.style.setProperty("position", "relative", "important");
  elements.referenceList.style.setProperty("flex", "1 1 auto", "important");
  elements.referenceList.style.setProperty("flex-wrap", "nowrap", "important");
  elements.referenceList.style.setProperty("width", "100%", "important");
  elements.referenceList.style.setProperty("min-width", "0", "important");
  elements.referenceList.style.setProperty("max-width", "none", "important");
  // Use real margins for UXP, which can ignore flex gap and join the cards.
  elements.referenceList.style.setProperty("gap", "0px", "important");
  elements.referenceList.style.setProperty("column-gap", "0px", "important");
  elements.referenceList.style.setProperty("row-gap", "0px", "important");
  // Keep the list inset identical to the render pass so every reference tile
  // and the permanent add tile share one baseline.
  elements.referenceList.style.setProperty("padding", "2px 0 2px 6px", "important");
  elements.referenceList.style.setProperty("box-sizing", "border-box", "important");
  elements.referenceList.style.setProperty("overflow", "visible", "important");

  // The list is inset inside the strip. Measure its actual box so six tiles
  // always fit on one row, including the permanent add tile.
  let containerWidth = 0;
  try {
    const bounds = elements.referenceList.getBoundingClientRect();
    containerWidth = Number(bounds && bounds.width) || 0;
  } catch (_) {
    containerWidth = 0;
  }
  containerWidth = Math.max(
    containerWidth,
    Number(elements.referenceList.clientWidth) || 0,
    Number(elements.referenceStrip.clientWidth) || 0,
    Number(typeof window !== "undefined" && window.innerWidth) || 0,
    Number(document.documentElement && document.documentElement.clientWidth) || 0,
    Number(document.body && document.body.clientWidth) || 0
  );
  const columnCount = 6;
  const columnGap = 2;
  // The panel uses a fixed six-slot contract with the compact dimensions
  // requested for the source frame.
  const tileWidth = Math.max(1, Math.floor((Math.max(0, containerWidth - 14 - 10) - (columnCount - 1) * columnGap) / columnCount));
  const tileHeight = 92;
  referenceListWidth = containerWidth || referenceListWidth;
  referenceTileSize = tileWidth;
  const widthValue = `${tileWidth}px`;
  const heightValue = `${tileHeight}px`;
  const visibleTileCount = state.references.length;
  const referenceFull = visibleTileCount >= MAX_REFERENCES;
  const flowItemCount = visibleTileCount + (referenceFull ? 0 : 1);
  const rowCount = Math.max(1, Math.ceil(flowItemCount / columnCount));
  // Keep the tile's 4px top inset while removing the unused bottom inset.
  // Four-pixel outer inset plus the 92px tile gives a stable 100px source
  // frame. The same contract is used before and after references are added.
  const listHeight = tileHeight * rowCount + (rowCount - 1) * 4 + 8;

  // Resize the containers before touching individual images. UXP can reject
  // an image style during a delayed layout pass; the second row must still be
  // contained instead of overlapping the prompt card below it.
  elements.referenceList.style.setProperty("height", `${listHeight}px`, "important");
  elements.referenceList.style.setProperty("min-height", `${listHeight}px`, "important");
  elements.referenceList.style.setProperty("max-height", `${listHeight}px`, "important");
  // Keep a small bottom inset inside the outer frame while the list itself
  // ends at the bottom edge of the 92px tiles.
  const sourceHeight = listHeight;
  const sourceCard = elements.referenceStrip && elements.referenceStrip.parentElement;
  if (elements.referenceStrip) {
    elements.referenceStrip.style.setProperty("height", `${sourceHeight}px`, "important");
    elements.referenceStrip.style.setProperty("min-height", `${sourceHeight}px`, "important");
    elements.referenceStrip.style.setProperty("max-height", `${sourceHeight}px`, "important");
  }
  if (sourceCard) {
    sourceCard.style.setProperty("height", `${sourceHeight}px`, "important");
    sourceCard.style.setProperty("min-height", `${sourceHeight}px`, "important");
    sourceCard.style.setProperty("max-height", `${sourceHeight}px`, "important");
  }

  elements.referenceAddWrap.style.setProperty("position", "relative", "important");
  elements.referenceAddWrap.style.setProperty("top", "0", "important");
  elements.referenceAddWrap.style.setProperty("right", "auto", "important");
  elements.referenceAddWrap.style.setProperty("left", "0", "important");
  elements.referenceAddWrap.style.setProperty("display", referenceFull ? "none" : "block", "important");
  elements.referenceAddWrap.style.setProperty("visibility", referenceFull ? "hidden" : "visible", "important");
  elements.referenceAddWrap.style.setProperty("width", widthValue, "important");
  elements.referenceAddWrap.style.setProperty("min-width", widthValue, "important");
  elements.referenceAddWrap.style.setProperty("max-width", widthValue, "important");
  elements.referenceAddWrap.style.setProperty("height", heightValue, "important");
  elements.referenceAddWrap.style.setProperty("min-height", heightValue, "important");
  elements.referenceAddWrap.style.setProperty("max-height", heightValue, "important");
  elements.referenceAddWrap.style.setProperty("flex", `0 0 ${widthValue}`, "important");
  elements.referenceAddWrap.style.setProperty("margin-top", "0", "important");
  elements.referenceAddWrap.style.setProperty("margin-left", "0", "important");
  elements.referenceAddWrap.style.setProperty("margin-right", "0px", "important");
  elements.referenceAddWrap.style.setProperty("margin-bottom", visibleTileCount < (rowCount - 1) * columnCount ? "4px" : "0", "important");
  elements.referenceAddWrap.style.setProperty("box-sizing", "border-box", "important");
  elements.referenceAddWrap.style.setProperty("transform", "none", "important");
  elements.referenceAddWrap.style.setProperty("transform-origin", "top left", "important");

  if (elements.referenceAdd) {
    elements.referenceAdd.style.setProperty("width", "100%", "important");
    elements.referenceAdd.style.setProperty("min-width", "0", "important");
    elements.referenceAdd.style.setProperty("max-width", "100%", "important");
  }

  let referenceIndex = 0;
  tiles.forEach((tile, index) => {
    tile.style.setProperty("width", widthValue, "important");
    tile.style.setProperty("min-width", widthValue, "important");
    tile.style.setProperty("max-width", widthValue, "important");
    tile.style.setProperty("height", heightValue, "important");
    tile.style.setProperty("min-height", heightValue, "important");
    tile.style.setProperty("max-height", heightValue, "important");
    tile.style.setProperty("flex", `0 0 ${widthValue}`, "important");
    tile.style.setProperty("box-sizing", "border-box", "important");
    tile.style.setProperty("position", "relative", "important");
    tile.style.setProperty("top", "0", "important");
    tile.style.setProperty("right", "auto", "important");
    tile.style.setProperty("left", "0", "important");
    tile.style.setProperty("margin-top", "0", "important");
    tile.style.setProperty("margin-left", "0", "important");
    tile.style.setProperty("margin-right", referenceIndex < flowItemCount - 1 ? `${columnGap}px` : "0px", "important");
    tile.style.setProperty("margin-bottom", referenceIndex < (rowCount - 1) * columnCount ? "4px" : "0", "important");
    tile.style.setProperty("transform", "none", "important");
    tile.style.setProperty("transform-origin", "top left", "important");
    tile.style.setProperty("border-radius", "6px", "important");
    referenceIndex += 1;
    const image = tile.querySelector(".reference-thumb-image");
    if (image) {
      image.style.setProperty("width", "100%", "important");
      image.style.setProperty("min-width", "0", "important");
      image.style.setProperty("height", heightValue, "important");
      image.style.setProperty("max-width", "100%", "important");
      image.style.setProperty("max-height", heightValue, "important");
      image.style.setProperty("top", "0", "important");
      image.style.setProperty("left", "0", "important");
      image.style.setProperty("right", "auto", "important");
      image.style.setProperty("bottom", "auto", "important");
      image.style.setProperty("border-radius", "6px", "important");
    }
    const caption = tile.querySelector(".reference-caption");
    if (caption) {
      caption.style.setProperty("border-radius", "0 0 6px 6px", "important");
      caption.style.setProperty("transform", "translateY(-1px)", "important");
    }
  });
}

function scheduleReferenceTileLayout() {
  // Layout is synchronized synchronously by renderReferences/reorderReferenceNodes.
  // Avoid delayed duplicate passes: UXP can repeatedly reflow image tiles and freeze.
  if (referenceLayoutTimer !== null) {
    clearTimeout(referenceLayoutTimer);
    referenceLayoutTimer = null;
  }
}

let referenceMenuOpenedAt = 0;

function closeReferenceSourceMenu() {
  if (!elements.referenceSourceMenu || !elements.referenceAddWrap) return;
  referenceMenuOpenedAt = 0;
  elements.referenceSourceMenu.classList.add("is-menu-hidden");
  elements.referenceAddWrap.classList.remove("is-menu-open");
  elements.referenceAdd.setAttribute("aria-expanded", "false");
  elements.referenceAdd.style.setProperty("display", "block", "important");
  elements.referenceSourceMenu.style.setProperty("display", "none", "important");
  elements.referenceSourceMenu.style.setProperty("visibility", "hidden", "important");
  elements.referenceSourceMenu.style.setProperty("opacity", "0", "important");
  elements.referenceSourceMenu.style.setProperty("pointer-events", "none", "important");
}

function openReferenceSourceMenu() {
  if (!elements.referenceSourceMenu || !elements.referenceAddWrap) return;
  if (elements.referenceAdd && elements.referenceAdd.disabled) return;
  referenceMenuOpenedAt = Date.now();
  elements.referenceSourceMenu.classList.remove("is-menu-hidden");
  elements.referenceAddWrap.classList.add("is-menu-open");
  elements.referenceAdd.setAttribute("aria-expanded", "true");
  elements.referenceAdd.style.setProperty("display", "none", "important");
  elements.referenceSourceMenu.style.setProperty("position", "absolute", "important");
  elements.referenceSourceMenu.style.setProperty("top", "0", "important");
  elements.referenceSourceMenu.style.setProperty("left", "0", "important");
  elements.referenceSourceMenu.style.setProperty("right", "auto", "important");
  elements.referenceSourceMenu.style.setProperty("bottom", "auto", "important");
  elements.referenceSourceMenu.style.setProperty("width", "68px", "important");
  elements.referenceSourceMenu.style.setProperty("height", "92px", "important");
  elements.referenceSourceMenu.style.setProperty("z-index", "300", "important");
  elements.referenceSourceMenu.style.setProperty("display", "flex", "important");
  elements.referenceSourceMenu.style.setProperty("visibility", "visible", "important");
  elements.referenceSourceMenu.style.setProperty("opacity", "1", "important");
  elements.referenceSourceMenu.style.setProperty("pointer-events", "auto", "important");
  elements.referenceSourceMenu.style.setProperty("background", "#ffeea0", "important");
  const sourceLabels = [
    [elements.referenceFromSelection, "选区"],
    [elements.referenceFromLayer, "图层"],
    [elements.referenceFromLocal, "本地"]
  ];
  sourceLabels.forEach(([button, label]) => {
    if (!button) return;
    button.textContent = "";
    const text = document.createElement("span");
    text.className = "reference-source-label";
    text.textContent = label;
    text.style.setProperty("display", "block", "important");
    text.style.setProperty("font-size", "14px", "important");
    text.style.setProperty("line-height", "26px", "important");
    text.style.setProperty("transform", "none", "important");
    text.style.setProperty("transform-origin", "center center", "important");
    text.style.setProperty("zoom", "0.5", "important");
    button.appendChild(text);
  });
  Array.from(elements.referenceSourceMenu.querySelectorAll("button") || []).forEach((button) => {
    button.style.setProperty("font-size", "0", "important");
    button.style.setProperty("font-weight", "600", "important");
    button.style.setProperty("line-height", "26px", "important");
    button.style.setProperty("padding", "0", "important");
    button.style.setProperty("text-align", "center", "important");
    button.style.setProperty("white-space", "nowrap", "important");
    button.style.setProperty("text-overflow", "clip", "important");
    button.style.setProperty("overflow", "hidden", "important");
  });
}

function toggleReferenceSourceMenu() {
  if (elements.referenceSourceMenu.classList.contains("is-menu-hidden")) openReferenceSourceMenu();
  else closeReferenceSourceMenu();
}

function closeOutfitMaterialMenu(tile) {
  if (!tile) return;
  const menu = tile.querySelector(".outfit-material-menu");
  const trigger = tile.querySelector(".outfit-material-add");
  if (menu) menu.classList.add("is-menu-hidden");
  tile.classList.remove("is-menu-open");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
}

function closeOutfitMaterialMenus(exceptTile = null) {
  Array.from(document.querySelectorAll(".outfit-material-tile") || []).forEach((tile) => {
    if (tile !== exceptTile) closeOutfitMaterialMenu(tile);
  });
}

function outfitReferencePool() {
  if (!Array.isArray(state.outfitReferences)) state.outfitReferences = [];
  return state.outfitReferences;
}

function productReferencePool() {
  if (!Array.isArray(state.productReferences)) state.productReferences = [];
  return state.productReferences;
}

let referencePoolMutationTail = Promise.resolve();

function referencePoolMutationActive(poolName) {
  const key = poolName === "product" ? "product" : "outfit";
  return Boolean(state.referencePoolMutations && Number(state.referencePoolMutations[key]) > 0);
}

function enqueueReferencePoolMutation(poolName, callback) {
  const key = poolName === "product" ? "product" : "outfit";
  if (!state.referencePoolMutations) state.referencePoolMutations = { outfit: 0, product: 0 };
  state.referencePoolMutations[key] = Math.max(0, Number(state.referencePoolMutations[key]) || 0) + 1;
  if (elements.referenceAdd) updateControls();

  const operation = referencePoolMutationTail.then(
    () => callback(),
    () => callback()
  );
  // Keep the queue usable after a failed operation; the caller still receives
  // the original rejection from `operation` below.
  referencePoolMutationTail = operation.catch(() => {});
  return operation.finally(() => {
    state.referencePoolMutations[key] = Math.max(
      0,
      (Number(state.referencePoolMutations[key]) || 0) - 1
    );
    if (elements.referenceAdd) updateControls();
  });
}

// Reuse the well-tested Photoshop capture/import pipeline while keeping the
// resulting references out of the image-editing strip.  The strip is hidden
// while this runs, so the temporary render is never visible to the user.
async function withOutfitReferencePool(callback) {
  return enqueueReferencePoolMutation("outfit", async () => {
    const editorReferences = state.references;
    const editorTargetSnapshot = state.targetSnapshot;
    state.references = outfitReferencePool();
    state.targetSnapshot = state.outfitTargetSnapshot || null;
    try {
      return await callback();
    } finally {
      state.outfitReferences = state.references;
      state.outfitTargetSnapshot = state.targetSnapshot;
      state.references = editorReferences;
      state.targetSnapshot = editorTargetSnapshot;
      // Capture helpers render their active pool. Restore the editor strip after
      // swapping back so switching pages never shows outfit materials there.
      renderReferences();
      renderOutfitWorkspace();
      updateControls();
    }
  });
}

async function withProductReferencePool(callback) {
  return enqueueReferencePoolMutation("product", async () => {
    const editorReferences = state.references;
    const editorTargetSnapshot = state.targetSnapshot;
    state.references = productReferencePool();
    state.targetSnapshot = state.productTargetSnapshot || null;
    try {
      return await callback();
    } finally {
      state.productReferences = state.references;
      state.productTargetSnapshot = state.targetSnapshot;
      state.references = editorReferences;
      state.targetSnapshot = editorTargetSnapshot;
      renderReferences();
      renderProductWorkspace();
      updateControls();
    }
  });
}

function toggleOutfitMaterialMenu(tile) {
  if (!tile) return;
  const menu = tile.querySelector(".outfit-material-menu");
  const trigger = tile.querySelector(".outfit-material-add");
  if (!menu || !trigger || trigger.disabled) return;
  if (!menu.classList.contains("is-menu-hidden")) {
    closeOutfitMaterialMenu(tile);
    return;
  }
  closeReferenceSourceMenu();
  closeOutfitMaterialMenus(tile);
  menu.classList.remove("is-menu-hidden");
  tile.classList.add("is-menu-open");
  trigger.setAttribute("aria-expanded", "true");
}

function outfitTargetReference() {
  const targetId = String(state.outfitTargetReferenceId || "");
  if (!targetId) return null;
  return outfitReferencePool().find((reference) => reference && String(reference.id || "") === targetId) || null;
}

function outfitFaceReference() {
  const faceId = String(state.outfitFaceReferenceId || "");
  if (!faceId) return null;
  return outfitReferencePool().find((reference) => reference && String(reference.id || "") === faceId) || null;
}

function outfitBackgroundReference() {
  const backgroundId = String(state.outfitBackgroundReferenceId || "");
  if (!backgroundId) return null;
  return outfitReferencePool().find((reference) => reference && String(reference.id || "") === backgroundId) || null;
}

function outfitGarmentSlotReferences() {
  return normalizeOutfitGarmentReferenceIds(state.outfitGarmentReferenceIds).map((referenceId) => (
    referenceId
      ? outfitReferencePool().find((reference) => reference && reference.id === referenceId) || null
      : null
  ));
}

function normalizeOutfitGarmentReferenceIds(referenceIds) {
  const source = Array.isArray(referenceIds) ? referenceIds : [];
  return Array.from({ length: 3 }, (_, index) => String(source[index] || ""));
}

function referenceImageSource(reference) {
  if (!reference || reference.released) return null;
  // ImageBlob URLs are fast when the host supports them. Temporary UXP Files
  // remain the authoritative fallback because some Photoshop versions do not
  // expose ImageBlob or reject an object URL while decoding an image.
  return (ENABLE_REFERENCE_PREVIEWS && reference.previewUrl) || reference.file || null;
}

function setReferenceImageSource(imageElement, reference, onFailure) {
  if (!imageElement) return false;
  const previewSource = ENABLE_REFERENCE_PREVIEWS && reference && reference.previewUrl
    ? reference.previewUrl
    : null;
  const fileSource = reference && !reference.released ? reference.file : null;
  const sources = [];
  if (previewSource) sources.push(previewSource);
  if (fileSource && fileSource !== previewSource) sources.push(fileSource);
  const token = {};
  imageElement.__referenceSourceToken = token;
  imageElement.removeAttribute("src");
  imageElement.onerror = null;
  if (!sources.length) {
    if (typeof onFailure === "function") onFailure();
    return false;
  }
  let sourceIndex = 0;
  const handleFailure = () => {
    if (imageElement.__referenceSourceToken !== token) return;
    sourceIndex += 1;
    if (sourceIndex < sources.length) {
      try {
        imageElement.src = sources[sourceIndex];
        return;
      } catch (_) {
        // Try the terminal failure path below.
      }
    }
    imageElement.onerror = null;
    imageElement.removeAttribute("src");
    if (typeof onFailure === "function") onFailure();
  };
  imageElement.onerror = handleFailure;
  try {
    imageElement.src = sources[0];
    return true;
  } catch (_) {
    handleFailure();
    return sourceIndex < sources.length;
  }
}

function outfitGarmentPreviewSource(reference) {
  return referenceImageSource(reference);
}

function isUsableOutfitGarmentReference(reference) {
  const previewSource = outfitGarmentPreviewSource(reference);
  return Boolean(
    reference && !reference.released &&
    (!previewSource || reference.outfitFailedPreviewSource !== previewSource)
  );
}

function outfitGarmentReferences() {
  return outfitGarmentSlotReferences().filter(Boolean);
}

function renderOutfitMetrics() {
  const target = outfitTargetReference();
  const garments = outfitGarmentReferences();
  if (elements.outfitTargetMetric) {
    elements.outfitTargetMetric.textContent = target ? "已获取" : "未获取";
    elements.outfitTargetMetric.parentNode && elements.outfitTargetMetric.parentNode.classList.toggle("is-ready", Boolean(target));
  }
  if (elements.outfitGarmentMetric) {
    elements.outfitGarmentMetric.textContent = `${garments.length} 张`;
    elements.outfitGarmentMetric.parentNode && elements.outfitGarmentMetric.parentNode.classList.toggle("is-ready", garments.length > 0);
  }
  const background = outfitBackgroundReference();
  if (elements.outfitReferenceCount) {
    elements.outfitReferenceCount.title = background ? "已添加场景背景参考图" : "可选：添加场景背景参考图";
  }
  if (elements.outfitTaskMetric) {
    const active = state.generationJobs.length + (state.recoveringPendingHistory ? 1 : 0);
    elements.outfitTaskMetric.textContent = `${active} 个`;
    elements.outfitTaskMetric.parentNode && elements.outfitTaskMetric.parentNode.classList.toggle("is-ready", active > 0);
  }
  if (elements.outfitResultMetric) {
    elements.outfitResultMetric.textContent = `${state.results.length} 张`;
    elements.outfitResultMetric.parentNode && elements.outfitResultMetric.parentNode.classList.toggle("is-ready", state.results.length > 0);
  }
}

function renderTaskCenterSummary() {
  if (elements.resultHistoryRunning) {
    const active = state.generationJobs.length + (state.recoveringPendingHistory ? 1 : 0);
    elements.resultHistoryRunning.textContent = `${active} 个任务中`;
  }
  renderOutfitMetrics();
}

function showWorkspace(workspace) {
  // The model outfit workspace is temporarily disabled; legacy callers fall
  // back to the editor instead of reopening the hidden page.
  const next = workspace === "settings"
    ? "settings"
    : (workspace === "library" ? "library" : "editor");
  if (next === "settings" && state.activeWorkspace !== "settings") {
    state.settingsReturnWorkspace = "editor";
  }
  if (state.activeWorkspace === "settings" && next !== "settings") {
    state.resumePromptOptimizationAfterKey = false;
    state.resumePromptOptimizationToRun = false;
  }
  state.activeWorkspace = next;
  if (next !== "library") closeStyleLibraryDetail();
  const outfitActive = next === "outfit";
  const settingsActive = next === "settings";
  const libraryActive = next === "library";
  document.body.classList.toggle("is-library-workspace-active", libraryActive);
  document.body.classList.toggle("is-settings-workspace-active", settingsActive);
  if (!outfitActive) {
    document.body.classList.remove("is-outfit-workspace-active");
    document.documentElement.classList.remove("is-outfit-workspace-active");
  }
  elements.editorWorkspace.classList.toggle("is-hidden", outfitActive || settingsActive || libraryActive);
  elements.outfitWorkspace.classList.toggle("is-hidden", !outfitActive);
  elements.settingsWorkspace.classList.toggle("is-hidden", !settingsActive);
  if (elements.styleLibraryWorkspace) elements.styleLibraryWorkspace.classList.toggle("is-hidden", !libraryActive);
  // Each workspace starts at its header. This prevents a long form from
  // carrying its previous scroll position into another workspace.
  const scrollRoot = document.scrollingElement || document.documentElement;
  if (scrollRoot) scrollRoot.scrollTop = 0;
  if (document.body) document.body.scrollTop = 0;
  if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
  elements.resultPanel.classList.toggle("is-hidden", settingsActive || libraryActive);
  syncResultPreviewRetention();
  elements.editorWorkspaceTab.classList.toggle("is-active", next === "editor");
  elements.outfitWorkspaceTab.classList.toggle("is-active", outfitActive);
  if (elements.styleLibraryOpen) elements.styleLibraryOpen.classList.toggle("is-active", libraryActive);
  if (elements.settingsWorkspaceTab) elements.settingsWorkspaceTab.classList.toggle("is-active", settingsActive);
  elements.editorWorkspaceTab.setAttribute("aria-selected", next === "editor" ? "true" : "false");
  elements.outfitWorkspaceTab.setAttribute("aria-selected", outfitActive ? "true" : "false");
  if (elements.styleLibraryOpen) elements.styleLibraryOpen.setAttribute("aria-selected", libraryActive ? "true" : "false");
  if (elements.settingsWorkspaceTab) elements.settingsWorkspaceTab.setAttribute("aria-selected", settingsActive ? "true" : "false");
  if (elements.workspaceTabs) elements.workspaceTabs.classList.toggle("is-settings-active", settingsActive);
  if (elements.workspaceTabs) elements.workspaceTabs.classList.toggle("is-outfit-active", outfitActive);
  if (elements.workspaceTabs) elements.workspaceTabs.classList.toggle("is-library-active", libraryActive);
  [elements.editorWorkspaceTab, elements.outfitWorkspaceTab, elements.styleLibraryOpen, elements.settingsWorkspaceTab].forEach((tab) => {
    if (tab && tab.parentNode && tab.parentNode.classList) tab.parentNode.classList.toggle("is-active", tab.classList.contains("is-active"));
  });
  closeReferenceSourceMenu();
  closeOutfitMaterialMenus();
  if (libraryActive) {
    renderStyleLibrary();
    refreshStyleLibraryOnOpen();
    return;
  }
  if (outfitActive) {
    syncOutfitControlsFromMain();
    renderOutfitWorkspace();
  }
  renderProductWorkspace();
  if (settingsActive) {
    syncSettingsWorkspace();
    syncBudgetInput();
    showSettingsSection(state.activeSettingsSection || "keys");
  }
  updateResolvedSize();
  updateControls();
  renderTaskCenterSummary();
}

function showSettingsSection(section) {
  const allowed = new Set(["keys", "defaults", "cost"]);
  const next = allowed.has(String(section || "")) ? String(section) : "keys";
  state.activeSettingsSection = next;
  const tabs = Array.from(document.querySelectorAll("[data-settings-section-tab]") || []);
  tabs.forEach((tab) => {
    const active = String(tab.getAttribute("data-settings-section-tab") || "") === next;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  const panels = Array.from(document.querySelectorAll("[data-settings-section-panel]") || []);
  panels.forEach((panel) => {
    const active = String(panel.getAttribute("data-settings-section-panel") || "") === next;
    panel.classList.toggle("is-hidden", !active);
  });
  if (next === "cost") renderBudgetSummary();
  if (elements.settingsWorkspaceTab) {
    const active = state.activeWorkspace === "settings";
    elements.settingsWorkspaceTab.classList.toggle("is-active", active);
    elements.settingsWorkspaceTab.setAttribute("aria-selected", active ? "true" : "false");
  }
  [elements.editorWorkspaceTab, elements.outfitWorkspaceTab, elements.settingsWorkspaceTab].forEach((tab) => {
    if (tab && tab.parentNode && tab.parentNode.classList) tab.parentNode.classList.toggle("is-active", tab.classList.contains("is-active"));
  });
}

function showCreativeTool(tool) {
  const selected = tool === "outfit" ? "outfit" : tool;
  state.activeCreativeTool = selected;
  const tabs = [
    [elements.creativeOutfitTab, "outfit"],
    [elements.creativeProductTab, "product"],
    [elements.creativePendingTabOne, "pending-one"],
    [elements.creativePendingTabTwo, "pending-two"]
  ];
  tabs.forEach(([tab, name]) => {
    if (!tab) return;
    const active = name === selected;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  const outfitActive = selected === "outfit";
  const productActive = selected === "product";
  document.body.classList.toggle("is-outfit-workspace-active", outfitActive);
  document.documentElement.classList.toggle("is-outfit-workspace-active", outfitActive);
  elements.outfitWorkspace.classList.toggle("is-outfit-tool-active", outfitActive);
  elements.outfitWorkspace.classList.toggle("is-product-tool-active", productActive);
  if (elements.outfitPrimaryActions) elements.outfitPrimaryActions.classList.toggle("is-hidden", !outfitActive);
  elements.creativeOutfitPanel.classList.toggle("is-hidden", !outfitActive);
  if (elements.creativeProductPanel) elements.creativeProductPanel.classList.toggle("is-hidden", !productActive);
  elements.creativeToolPlaceholder.classList.toggle("is-hidden", outfitActive || productActive);
  if (!outfitActive && !productActive) {
    const pending = selected.indexOf("pending") === 0;
    elements.creativeToolPlaceholderTitle.textContent = pending ? "待添加" : "商品主图 / 场景图";
    elements.creativeToolPlaceholderText.textContent = pending
      ? "这里预留给后续创作工具。"
      : "功能正在添加，当前可先使用“图像编辑”完成商品主图与场景图生成。";
  } else {
    if (outfitActive) {
      if (elements.creativeOutfitPanel) elements.creativeOutfitPanel.scrollTop = 0;
      renderOutfitWorkspace();
    }
    else renderProductWorkspace();
  }
}

const PRODUCT_TYPE_DETAILS = Object.freeze({
  clean: {
    label: "白底主图",
    instruction: "以[附图1:商品参考图]中的商品为唯一核心主体，生成干净明亮的白底或浅色背景商品主图；商品居中突出，边缘清晰，阴影自然，适合电商平台首图。"
  },
  scene: {
    label: "场景主图",
    instruction: "将[附图1:商品参考图]中的商品自然放入与商品品类和用途匹配的商业场景；商品必须清晰完整，场景只用于加强展示，不能喧宾夺主。"
  },
  studio: {
    label: "棚拍质感",
    instruction: "以[附图1:商品参考图]中的商品为唯一核心主体，生成专业影棚布光的商品展示图；材质反光、接触阴影和空间层次自然，画面干净高级。"
  },
  platform: {
    label: "平台风格图",
    instruction: "按照所选平台常见的商品主图视觉规范进行构图，保持[附图1:商品参考图]中的商品清晰完整，不新增误导性卖点、无关文字或无关商品。"
  }
});

const PRODUCT_PLATFORM_LABELS = Object.freeze({
  general: "通用电商",
  tmall: "淘宝/天猫",
  jd: "京东",
  pdd: "拼多多",
  redbook: "小红书",
  amazon: "亚马逊"
});

const PRODUCT_COMPOSITION_LABELS = Object.freeze({
  center: "居中突出",
  fashion: "时尚摄影",
  detail: "近景细节",
  space: "空间留白",
  scene: "场景融入"
});

function normalizeProductEnum(value, allowed, fallback) {
  const normalized = String(value || "");
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeProductText(value, fallback, maxLength) {
  const source = value === undefined || value === null ? fallback : value;
  return String(source || "").replace(/\r?\n/g, "\n").trim().slice(0, maxLength);
}

function normalizeProductDraft(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    type: normalizeProductEnum(source.type, PRODUCT_TYPE_VALUES, DEFAULT_PRODUCT_DRAFT.type),
    category: normalizeProductText(source.category, DEFAULT_PRODUCT_DRAFT.category, 100),
    platform: normalizeProductEnum(source.platform, PRODUCT_PLATFORM_VALUES, DEFAULT_PRODUCT_DRAFT.platform),
    retention: normalizeProductText(source.retention, DEFAULT_PRODUCT_DRAFT.retention, 2000),
    backgroundDescription: normalizeProductText(source.backgroundDescription, DEFAULT_PRODUCT_DRAFT.backgroundDescription, 2000),
    composition: normalizeProductEnum(source.composition, PRODUCT_COMPOSITION_VALUES, DEFAULT_PRODUCT_DRAFT.composition),
    protectBrand: typeof source.protectBrand === "boolean" ? source.protectBrand : DEFAULT_PRODUCT_DRAFT.protectBrand,
    extraPrompt: normalizeProductText(source.extraPrompt, DEFAULT_PRODUCT_DRAFT.extraPrompt, 4000)
  };
}

function selectedProductType() {
  const selected = elements.productTypeGroup && (
    elements.productTypeGroup.querySelector('[data-product-type][aria-checked="true"]') ||
    elements.productTypeGroup.querySelector("[data-product-type].is-selected")
  );
  return normalizeProductEnum(
    selected && selected.getAttribute("data-product-type"),
    PRODUCT_TYPE_VALUES,
    DEFAULT_PRODUCT_DRAFT.type
  );
}

function setSelectedProductType(value) {
  const type = normalizeProductEnum(value, PRODUCT_TYPE_VALUES, DEFAULT_PRODUCT_DRAFT.type);
  Array.from(elements.productTypeGroup && elements.productTypeGroup.querySelectorAll("[data-product-type]") || []).forEach((button) => {
    const selected = button.getAttribute("data-product-type") === type;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", selected ? "true" : "false");
  });
  return type;
}

function productBrandProtected() {
  return !elements.productProtectBrand || elements.productProtectBrand.getAttribute("aria-checked") !== "false";
}

function setProductBrandProtected(value) {
  if (!elements.productProtectBrand) return;
  const checked = Boolean(value);
  elements.productProtectBrand.classList.toggle("is-checked", checked);
  elements.productProtectBrand.setAttribute("aria-checked", checked ? "true" : "false");
  const label = elements.productProtectBrand.querySelector(".product-switch-label");
  if (label) label.textContent = checked ? "严格保留" : "基础保留";
}

function readProductDraft() {
  return normalizeProductDraft({
    type: selectedProductType(),
    category: elements.productCategory && elements.productCategory.value,
    platform: elements.productPlatform && elements.productPlatform.value,
    retention: elements.productRetention && elements.productRetention.value,
    backgroundDescription: elements.productBackgroundDescription && elements.productBackgroundDescription.value,
    composition: elements.productComposition && elements.productComposition.value,
    protectBrand: productBrandProtected(),
    extraPrompt: elements.productExtraPrompt && elements.productExtraPrompt.value
  });
}

function applyProductDraft(value) {
  const source = value && typeof value === "object" ? value : {};
  const legacyPrompt = !Object.prototype.hasOwnProperty.call(source, "extraPrompt")
    ? String(source.prompt || "").slice(0, 4000)
    : source.extraPrompt;
  const draft = normalizeProductDraft({ ...source, extraPrompt: legacyPrompt });
  setSelectedProductType(draft.type);
  if (elements.productCategory) elements.productCategory.value = draft.category;
  if (elements.productPlatform) elements.productPlatform.value = draft.platform;
  if (elements.productRetention) elements.productRetention.value = draft.retention;
  if (elements.productBackgroundDescription) elements.productBackgroundDescription.value = draft.backgroundDescription;
  if (elements.productComposition) elements.productComposition.value = draft.composition;
  setProductBrandProtected(draft.protectBrand);
  if (elements.productExtraPrompt) elements.productExtraPrompt.value = draft.extraPrompt;
  refreshIslandSelect(elements.productPlatform, true);
  refreshIslandSelect(elements.productComposition, true);
  return draft;
}

function productDraftSummary(value) {
  const draft = normalizeProductDraft(value);
  return [
    `主图类型：${PRODUCT_TYPE_DETAILS[draft.type].label}`,
    `商品品类：${draft.category || "未指定"}`,
    `平台/用途：${PRODUCT_PLATFORM_LABELS[draft.platform]}`,
    `商品保留要求：${draft.retention || "与商品参考图保持一致"}`,
    `背景/风格要求：${draft.backgroundDescription || "按主图类型自动处理"}`,
    `构图方式：${PRODUCT_COMPOSITION_LABELS[draft.composition]}`,
    `品牌包装：${draft.protectBrand ? "严格保留" : "基础保留"}`,
    `补充需求：${draft.extraPrompt || "无"}`
  ].join("\n");
}

function buildProductPrompt(value, hasSceneReference) {
  const draft = normalizeProductDraft(value);
  const typeDetails = PRODUCT_TYPE_DETAILS[draft.type];
  const platform = PRODUCT_PLATFORM_LABELS[draft.platform];
  const composition = PRODUCT_COMPOSITION_LABELS[draft.composition];
  const backgroundReference = hasSceneReference
    ? [
      "[附图2:背景/风格参考图]",
      "只参考其背景、色调、光影、材质、摆拍方式或商业摄影质感，不要复制其中的无关主体。",
      draft.backgroundDescription ? `用户填写的背景/风格要求：${draft.backgroundDescription}` : ""
    ].filter(Boolean).join("\n")
    : (draft.backgroundDescription
      ? draft.backgroundDescription
      : "未上传额外背景或风格参考图，请根据主图类型、商品品类、平台用途和构图方式生成克制、适合商品展示的背景。");
  const brandRequirement = draft.protectBrand
    ? "必须严格保留商品包装、Logo、文字、颜色、版式、品牌元素和产品结构，不要改写、乱码、伪造或变形。"
    : "不额外锁定包装版式；若原商品包含真实包装、Logo、文字或品牌信息，仍不得伪造、改写、生成乱码或变形。";
  const identityRequirement = draft.protectBrand
    ? "严格保留[附图1:商品参考图]中的商品外观、包装、Logo、文字、颜色、材质、结构、比例、图案和核心卖点元素。"
    : "严格保留[附图1:商品参考图]中的商品外观、颜色、材质、结构、比例、图案和核心卖点元素；不得伪造或改写原有品牌信息。";
  const prompt = [
    "请基于[附图1:商品参考图]生成一张专业电商商品展示图，商品必须清晰突出，适合用于平台主图或商品场景图。",
    "",
    "【主图类型】",
    `- 主图类型：${typeDetails.label}。${typeDetails.instruction}`,
    "",
    "【商品品类】",
    draft.category || "未指定商品品类",
    "",
    "【平台/用途】",
    platform,
    "",
    "【商品保留要求】",
    draft.retention || "商品主体与商品参考图保持一致",
    "",
    "【背景/风格参考】",
    backgroundReference,
    "",
    "【构图方式】",
    composition,
    "",
    "【品牌包装】",
    brandRequirement,
    "",
    "【核心要求】",
    "- 商品是画面绝对主体，必须清晰、完整、醒目，不能被背景、道具或装饰元素遮挡。",
    `- ${identityRequirement}`,
    "- 可以优化背景、摆放方式、光影、阴影、反光、景深和商业摄影质感，但不能改商品本身。",
    "- 如果原商品包含文字、Logo、包装或品牌信息，必须尽量准确清晰，避免乱码、错字、变形、伪造品牌或无关文字。",
    "- 背景和道具必须服务于商品展示，不能喧宾夺主，不能新增无关商品或误导性卖点。",
    "- 商品边缘、接触阴影、反光、透视和空间关系要自然真实，避免抠图感、漂浮感、比例失衡和过度锐化。",
    "- 输出高清、干净、商业化、适合电商使用。",
    "",
    "【补充需求】",
    draft.extraPrompt || "无额外补充需求。"
  ].join("\n");
  return prompt.slice(0, 20000);
}

function productReference(role) {
  const id = String(state.productReferenceIds && state.productReferenceIds[role] || "");
  return productReferencePool().find((reference) => String(reference.id) === id) || null;
}

function renderProductWorkspace() {
  if (!elements.creativeProductPanel) return;
  const main = productReference("main");
  const scene = productReference("scene");
  const renderSlot = (reference, image, add, remove, tile) => {
    if (!image || !add || !remove || !tile) return;
    tile.classList.toggle("has-image", Boolean(reference));
    image.classList.toggle("is-hidden", !reference);
    add.classList.toggle("is-hidden", Boolean(reference));
    remove.classList.toggle("is-hidden", !reference);
    if (reference) {
      const previewReady = setReferenceImageSource(image, reference, () => {
        image.classList.add("is-hidden");
        add.classList.remove("is-hidden");
        remove.classList.add("is-hidden");
        tile.classList.remove("has-image");
      });
      image.classList.toggle("is-hidden", !previewReady);
    } else {
      image.onerror = null;
      image.removeAttribute("src");
      image.classList.add("is-hidden");
    }
  };
  renderSlot(main, elements.productMainReferenceImage, elements.productMainReferenceAdd, elements.productMainReferenceRemove, elements.productMainReferenceTile);
  renderSlot(scene, elements.productSceneReferenceImage, elements.productSceneReferenceAdd, elements.productSceneReferenceRemove, elements.productSceneReferenceTile);
  const count = Number(Boolean(main)) + Number(Boolean(scene));
  elements.productReferenceCount.textContent = `${count} 张参考`;
}

function closeProductReferenceMenus(except) {
  [
    [elements.productMainReferenceMenu, elements.productMainReferenceAdd],
    [elements.productSceneReferenceMenu, elements.productSceneReferenceAdd]
  ].forEach(([menu, trigger]) => {
    if (!menu || menu === except) return;
    menu.classList.add("is-menu-hidden");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  });
}

function toggleProductReferenceMenu(role) {
  const menu = role === "scene" ? elements.productSceneReferenceMenu : elements.productMainReferenceMenu;
  const trigger = role === "scene" ? elements.productSceneReferenceAdd : elements.productMainReferenceAdd;
  if (!menu || !trigger || trigger.disabled) return;
  const willOpen = menu.classList.contains("is-menu-hidden");
  closeProductReferenceMenus(menu);
  menu.classList.toggle("is-menu-hidden", !willOpen);
  trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

async function removeProductReference(role, reportStatus = true) {
  let removed = false;
  await withProductReferencePool(async () => {
    const reference = productReference(role);
    if (!reference) return;
    removed = true;
    state.productReferenceIds[role] = "";
    const usedByOtherRole = Object.keys(state.productReferenceIds).some((key) => (
      key !== role && String(state.productReferenceIds[key] || "") === String(reference.id)
    ));
    if (!usedByOtherRole) {
      const index = state.references.findIndex((item) => item.id === reference.id);
      if (index >= 0) {
        state.references.splice(index, 1);
        await releaseReference(reference);
        if (state.targetSnapshot && state.targetSnapshot.sourceReferenceId === reference.id) chooseReplacementTarget();
      }
    }
  });
  if (removed && reportStatus) setStatus("idle", "已移除商品素材", role === "main" ? "请重新添加商品主体" : "场景参考已清除");
}

async function captureProductReference(role, source) {
  closeProductReferenceMenus();
  const reference = await withProductReferencePool(async () => {
    const previous = productReference(role);
    const pool = state.references;
    let detachedIndex = -1;
    if (previous && pool.length >= MAX_PRODUCT_REFERENCES) {
      detachedIndex = pool.indexOf(previous);
      if (detachedIndex >= 0) pool.splice(detachedIndex, 1);
    }
    let added = [];
    try {
      if (source === "selection") {
        const captured = await captureSource("selection", { assignAsTarget: false });
        if (captured) added = [captured];
      } else if (source === "layer") {
        added = await captureSelectedLayers({ maxCount: 1 });
      } else {
        added = await importReferenceImages({ maxCount: 1, allowMultiple: false });
      }
      const nextReference = added && added[0];
      if (!nextReference) {
        if (detachedIndex >= 0 && !pool.includes(previous)) {
          previous.inReferenceList = true;
          pool.splice(Math.min(detachedIndex, pool.length), 0, previous);
        }
        return null;
      }
      nextReference.productRole = role;
      state.productReferenceIds[role] = nextReference.id;
      if (role === "main") {
        const index = pool.findIndex((item) => item.id === nextReference.id);
        if (index > 0) pool.splice(0, 0, pool.splice(index, 1)[0]);
      }
      if (previous && previous.id !== nextReference.id) {
        const previousIndex = pool.findIndex((item) => item.id === previous.id);
        if (previousIndex >= 0) pool.splice(previousIndex, 1);
        await releaseReference(previous);
      }
      return nextReference;
    } catch (error) {
      if (detachedIndex >= 0 && !pool.includes(previous)) {
        previous.inReferenceList = true;
        pool.splice(Math.min(detachedIndex, pool.length), 0, previous);
      }
      throw error;
    }
  });
  if (!reference) return;
  setStatus("success", role === "main" ? "商品主体已添加" : "场景参考已添加", "可以继续填写主图设置并生成");
}

function normalizeRunControlOverrides(value) {
  if (!value || typeof value !== "object") return null;
  const aspectRatio = String(value.aspectRatio || "");
  const resolution = String(value.resolution || "");
  const generationCount = Number(value.generationCount);
  if (!elements.aspectRatio.querySelector(`option[value="${aspectRatio}"]`)) return null;
  if (!["1K", "1.5K", "2K", "4K"].includes(resolution)) return null;
  if (![1, 2, 3, 4].includes(generationCount)) return null;
  return {
    aspectRatio,
    resolution,
    generationCount: String(generationCount),
    precisionPlacement: Boolean(value.precisionPlacement)
  };
}

async function handleRunWithControlOverrides(options = {}) {
  const guardAlreadyHeld = Boolean(options._submissionGuardAcquired);
  if (!guardAlreadyHeld) {
    if (state.runSubmissionPending) return;
    state.runSubmissionPending = true;
    updateControls();
  }
  const controlOverrides = normalizeRunControlOverrides(options.controlOverrides);
  if (!controlOverrides) {
    try {
      return await handleRun({ ...options, _submissionGuardAcquired: true });
    } finally {
      if (!guardAlreadyHeld) {
        state.runSubmissionPending = false;
        updateControls();
      }
    }
  }
  const previous = {
    aspectRatio: elements.aspectRatio.value,
    resolution: elements.resolution.value,
    generationCount: elements.generationCount.value,
    precisionPlacement: elements.precisionPlacement.checked
  };
  elements.aspectRatio.value = controlOverrides.aspectRatio;
  elements.resolution.value = controlOverrides.resolution;
  elements.generationCount.value = controlOverrides.generationCount;
  elements.precisionPlacement.checked = controlOverrides.precisionPlacement;
  syncModelCapabilities();
  syncIslandSelects();
  updateResolvedSize();
  try {
    return await handleRun({ ...options, controlOverrides, _submissionGuardAcquired: true });
  } finally {
    elements.aspectRatio.value = previous.aspectRatio;
    elements.resolution.value = previous.resolution;
    elements.generationCount.value = previous.generationCount;
    elements.precisionPlacement.checked = previous.precisionPlacement;
    syncModelCapabilities();
    syncIslandSelects();
    updateResolvedSize();
    saveSettings();
    if (!guardAlreadyHeld) {
      state.runSubmissionPending = false;
      updateControls();
    }
  }
}

async function handleProductRun() {
  const main = productReference("main");
  if (!main || !main.snapshot) {
    setStatus("error", "缺少商品主体", "请先从选区、图层或本地添加商品主体");
    return;
  }
  const productDraft = readProductDraft();
  if (!productDraft.category) {
    setStatus("error", "缺少商品品类", "请填写商品品类，例如鞋、服装或数码产品");
    try { elements.productCategory.focus(); } catch (_) {}
    return;
  }
  const scene = productReference("scene");
  const references = [main, scene].filter(Boolean);
  main.productRole = "main";
  if (scene) scene.productRole = "scene";
  const prompt = buildProductPrompt(productDraft, Boolean(scene));
  await handleRunWithControlOverrides({
    promptOverride: prompt,
    archivePromptOverride: productDraftSummary(productDraft),
    productDraft,
    skipPromptOptimization: true,
    referencesOverride: references,
    snapshotOverride: main.snapshot,
    localEditMode: "product",
    controlOverrides: {
      aspectRatio: elements.productAspectRatio.value,
      resolution: elements.productResolution.value,
      generationCount: elements.productGenerationCount.value,
      precisionPlacement: false
    }
  });
}

function budgetDateKey(date = new Date()) {
  const safe = new Date(date || Date.now());
  return [safe.getFullYear(), String(safe.getMonth() + 1).padStart(2, "0"), String(safe.getDate()).padStart(2, "0")].join("-");
}

function normalizeBudgetState() {
  const today = budgetDateKey();
  if (!state.dailySpend || state.dailySpend.date !== today) state.dailySpend = { date: today, amount: 0 };
  state.dailySpend.amount = normalizePriceValue(state.dailySpend.amount) || 0;
  const limit = normalizePriceValue(state.dailyBudget);
  state.dailyBudget = limit !== null && limit > 0 ? limit : null;
}

function saveBudgetState() {
  normalizeBudgetState();
  try {
    localStorage.setItem(BUDGET_STORAGE, JSON.stringify({ limit: state.dailyBudget, dailySpend: state.dailySpend }));
  } catch (_) {
    // Cost protection remains active for the current session.
  }
}

function loadBudgetState() {
  try {
    const saved = JSON.parse(localStorage.getItem(BUDGET_STORAGE) || "{}");
    state.dailyBudget = saved.limit;
    state.dailySpend = saved.dailySpend || state.dailySpend;
  } catch (_) {
    state.dailyBudget = null;
  }
  normalizeBudgetState();
  syncBudgetInput();
}

function syncBudgetInput() {
  normalizeBudgetState();
  if (elements.settingsDailyBudget) {
    elements.settingsDailyBudget.value = state.dailyBudget === null ? "" : String(state.dailyBudget);
  }
}

function currentEstimatedCost() {
  const productActive = state.activeWorkspace === "outfit" && state.activeCreativeTool === "product";
  const sizeControl = productActive ? elements.productResolution : elements.resolution;
  const countControl = productActive ? elements.productGenerationCount : elements.generationCount;
  const size = String(sizeControl && sizeControl.value || "1K");
  const price = modelProvider(getSelectedModelConfig()) === "volc"
    ? volcFixedPrice(size)
    : normalizePriceValue(state.pricing.prices[size]);
  const count = Math.max(1, Math.min(4, Number(countControl && countControl.value) || 1));
  return price === null ? null : normalizePriceValue(price * count);
}

function renderBudgetSummary() {
  normalizeBudgetState();
  if (!elements.budgetCurrentEstimate) return;
  const estimate = currentEstimatedCost();
  const spent = normalizePriceValue(state.dailySpend.amount) || 0;
  const remaining = state.dailyBudget === null ? null : Math.max(0, state.dailyBudget - spent);
  elements.budgetCurrentEstimate.textContent = estimate === null ? "价格待刷新" : formatYuan(estimate);
  elements.budgetTodayTotal.textContent = formatYuan(spent);
  elements.budgetTodayRemaining.textContent = remaining === null ? "不限" : formatYuan(remaining);
  elements.settingsBudgetState.textContent = state.dailyBudget === null ? "未设置上限" : `上限 ${formatYuan(state.dailyBudget)}`;
  elements.settingsBudgetState.classList.toggle("is-ready", state.dailyBudget !== null);
}

function budgetAllowance(estimate) {
  normalizeBudgetState();
  const cost = normalizePriceValue(estimate);
  if (state.dailyBudget === null) return { ok: true };
  if (cost === null) return { ok: false, priceUnknown: true, limit: state.dailyBudget };
  const spent = normalizePriceValue(state.dailySpend.amount) || 0;
  const projected = normalizePriceValue(spent + cost) || spent;
  return projected <= state.dailyBudget + 0.000001
    ? { ok: true, projected }
    : { ok: false, spent, cost, projected, limit: state.dailyBudget };
}

function commitBudgetEstimate(estimate) {
  const cost = normalizePriceValue(estimate);
  if (cost === null) return;
  normalizeBudgetState();
  state.dailySpend.amount = normalizePriceValue(state.dailySpend.amount + cost) || state.dailySpend.amount;
  saveBudgetState();
  renderBudgetSummary();
}

function saveDailyBudgetSetting() {
  const raw = String(elements.settingsDailyBudget.value || "").trim();
  if (raw && (!Number.isFinite(Number(raw)) || Number(raw) <= 0)) throw new Error("每日上限必须大于 0，或留空表示不限");
  state.dailyBudget = raw ? normalizePriceValue(Number(raw)) : null;
  saveBudgetState();
  syncBudgetInput();
  renderBudgetSummary();
  setStatus("success", "费用保护已保存", state.dailyBudget === null ? "当前不限制每日预计费用" : `每日预计费用达到 ${formatYuan(state.dailyBudget)} 前会停止新任务`);
}

function resetDailyBudgetSpend() {
  state.dailySpend = { date: budgetDateKey(), amount: 0 };
  saveBudgetState();
  renderBudgetSummary();
  setStatus("success", "今日费用记录已清除", "只清除插件本地预计记录，不影响服务端账单");
}

function historyRecordPrice(record) {
  if (!record || typeof record !== "object") return null;
  const stack = [record];
  const seen = new Set();
  const keys = [
    "cost", "cost_price", "costPrice", "price", "api_price", "apiPrice",
    "amount", "fee", "charge", "spent", "add_count", "addCount"
  ];
  for (let index = 0; index < stack.length && index < 40; index += 1) {
    const item = stack[index];
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(item, key)) {
        const value = normalizePriceValue(Math.abs(Number(item[key])));
        if (value !== null && value > 0) return value;
      }
    }
    Object.keys(item).forEach((key) => {
      const value = item[key];
      if (value && typeof value === "object") stack.push(value);
    });
  }
  return null;
}

function historyRecordSizeTier(metadata) {
  const raw = String(metadata && metadata.size || "").trim().toUpperCase();
  if (/^4K/.test(raw) || /3840|4096|2880|3520|3312/.test(raw)) return "4K";
  if (/^2K/.test(raw) || /2048|2160/.test(raw)) return "2K";
  if (/^1\.5K/.test(raw)) return "1.5K";
  return "1K";
}

function historyRecordEstimatedPrice(record) {
  const direct = historyRecordPrice(record);
  if (direct !== null) return direct;
  const metadata = historyRecordMetadata(record);
  const size = historyRecordSizeTier(metadata);
  const model = getModelConfig(metadata.model || API_CONFIG.model);
  if (modelProvider(model) === "volc") return volcFixedPrice(size);
  const price = normalizePriceValue(state.pricing.prices[size]);
  return price === null ? 0 : price;
}

function styleActionButton(element, tone) {
  if (!element) return;
  const palette = {
    primary: { bg: "#21c7b9", border: "#0f9f94", fg: "#ffffff" },
    secondary: { bg: "#f7e2c2", border: "#d39c5e", fg: "#7a4d16" },
    success: { bg: "#9fd98b", border: "#6ea958", fg: "#ffffff" },
    neutral: { bg: "#f6eddc", border: "#d9c2a0", fg: "#6a4a1e" }
  };
  const colors = palette[tone] || palette.neutral;
  Object.assign(element.style, {
    appearance: "none",
    borderRadius: "8px",
    minHeight: "36px",
    padding: "0 16px",
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.fg,
    fontWeight: "700",
    fontSize: "14px",
    lineHeight: "1",
    boxShadow: "none"
  });
}

function bindSecretToggle(input, button) {
  if (!input || !button) return;
  const sync = () => {
    const hidden = input.type !== "text";
    button.textContent = hidden ? "显示" : "隐藏";
    button.setAttribute("aria-pressed", hidden ? "false" : "true");
  };
  button.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
    sync();
  });
  sync();
}

function setSelfCheckState(element, ok, text) {
  if (!element) return;
  element.textContent = String(text || (ok ? "正常" : "异常"));
  const item = element.parentNode;
  if (item && item.classList) item.classList.toggle("is-error", !ok);
}

async function runPluginSelfCheck() {
  if (state.selfCheckRunning) return;
  state.selfCheckRunning = true;
  elements.settingsRunSelfCheck.disabled = true;
  elements.settingsCheckSummary.textContent = "检查中";
  const failures = [];
  try {
    const psVersion = String(app.version || "未知版本");
    const uxpVersion = String(uxp.versions && uxp.versions.uxp || "未知");
    setSelfCheckState(elements.checkPhotoshopState, Boolean(app && app.documents), `PS ${psVersion} / UXP ${uxpVersion}`);

    let historyResponse = null;
    if (!state.apiKey) {
      setSelfCheckState(elements.checkApiState, false, "未设置密钥");
      setSelfCheckState(elements.checkHistoryState, false, "等待密钥");
      failures.push("API Key 未设置");
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        historyResponse = await limitedFetch(`${API_CONFIG.historyEndpoint}?page=1&page_size=1`, {
          method: "GET",
          headers: { Authorization: `Bearer ${state.apiKey}` },
          credentials: "omit",
          redirect: "error",
          signal: controller.signal
        });
        const ok = historyResponse.ok;
        setSelfCheckState(elements.checkApiState, ok, ok ? "连接正常" : `HTTP ${historyResponse.status}`);
        setSelfCheckState(elements.checkHistoryState, ok, ok ? "可查询" : `HTTP ${historyResponse.status}`);
        if (!ok) failures.push(`API / 历史接口 HTTP ${historyResponse.status}`);
      } catch (error) {
        const message = isAbortError(error) ? "连接超时" : "连接失败";
        setSelfCheckState(elements.checkApiState, false, message);
        setSelfCheckState(elements.checkHistoryState, false, message);
        failures.push(`API / 历史接口${message}`);
      } finally {
        clearTimeout(timeout);
      }
    }

    const pricing = await refreshLivePricing("self-check");
    setSelfCheckState(elements.checkPricingState, Boolean(pricing && pricing.ok), pricing && pricing.ok ? "实时价格正常" : "价格不可用");
    if (!pricing || !pricing.ok) failures.push("价格接口不可用");

    let storageOk = false;
    try {
      const folder = await localFileSystem.getTemporaryFolder();
      const file = await folder.createFile(`jx-self-check-${Date.now()}.tmp`, { overwrite: true });
      await file.write(new Uint8Array([74, 88]), { format: formats.binary });
      await file.delete();
      storageOk = true;
    } catch (_) {
      storageOk = false;
    }
    setSelfCheckState(elements.checkStorageState, storageOk, storageOk ? "读写正常" : "无法写入");
    if (!storageOk) failures.push("本地存储无法写入");

    let updaterOk = false;
    try {
      const pluginFolder = await localFileSystem.getPluginFolder();
      const updaterFolder = await pluginFolder.getEntry(UPDATE_CONFIG.updaterFolder);
      const updaterFile = await updaterFolder.getEntry(UPDATE_CONFIG.updaterFile);
      updaterOk = Boolean(localFileSystem.getNativePath(updaterFile));
    } catch (_) {
      updaterOk = false;
    }
    setSelfCheckState(elements.checkUpdaterState, updaterOk, updaterOk ? (state.updateAvailable ? `可更新 v${state.updateAvailable.version}` : "程序可用") : "程序缺失");
    if (!updaterOk) failures.push("更新程序缺失");

    elements.settingsCheckSummary.textContent = failures.length ? `${failures.length} 项需处理` : "全部正常";
    elements.settingsCheckSummary.classList.toggle("is-ready", failures.length === 0);
    elements.settingsCheckDetail.textContent = failures.length ? failures.join("；") : "Photoshop、接口、本地存储和更新程序均可用。";
    setStatus(failures.length ? "warning" : "success", failures.length ? "插件自检完成" : "插件状态正常", elements.settingsCheckDetail.textContent);
  } finally {
    state.selfCheckRunning = false;
    elements.settingsRunSelfCheck.disabled = false;
  }
}

function syncSettingsWorkspace() {
  if (!elements.settingsWorkspace) return;
  elements.settingsApiKey.value = "";
  elements.settingsApiKey.placeholder = state.apiKey
    ? "已保存密钥；输入新密钥可替换"
    : "输入 katu-sk-...";
  elements.settingsApiState.textContent = state.apiKey ? "已保存" : "未设置";
  elements.settingsApiState.classList.toggle("is-ready", Boolean(state.apiKey));
  if (elements.settingsActiveKeyState) {
    const selectedModel = getSelectedModelConfig();
    const volcSelected = modelProvider(selectedModel) === "volc";
    const activeKey = volcSelected
      ? (state.volcImageApiKey || state.apiKey)
      : (state.apiKey || state.volcImageApiKey);
    elements.settingsActiveKeyState.textContent = volcSelected
      ? `火山生成密钥${activeKey ? ` · ${maskApiKey(activeKey)}` : " · 未保存"}`
      : `API Key${activeKey ? ` · ${maskApiKey(activeKey)}` : " · 未保存"}`;
  }
  syncMaskFeatherSetting();
  elements.settingsVersion.textContent = `v${UPDATE_CONFIG.currentVersion}`;
  elements.settingsBack.textContent = "返回图像编辑";
  renderBudgetSummary();
}

async function saveSettingsApiKey() {
  const entered = String(elements.settingsApiKey.value || "").replace(/\s+/g, "");
  if (!entered) {
    if (!state.apiKey) throw new Error("请输入 API Key");
    elements.settingsApiState.textContent = "继续使用已保存密钥";
    return;
  }
  if (!/^katu-sk-[A-Za-z0-9_-]+$/i.test(entered)) throw new Error("API Key 格式不正确");
  await saveApiKey(entered);
  elements.settingsApiKey.value = "";
  elements.settingsApiKey.placeholder = "已保存密钥；输入新密钥可替换";
  elements.settingsApiState.textContent = "已保存";
  elements.settingsApiState.classList.add("is-ready");
  setStatus("success", "API Key 已保存", "新请求会使用设置页中保存的密钥");
}

async function testSettingsApiConnection() {
  const entered = String(elements.settingsApiKey.value || "").replace(/\s+/g, "");
  const apiKey = entered || state.apiKey;
  if (!apiKey) throw new Error("请先输入或保存 API Key");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  elements.settingsApiState.textContent = "连接中";
  try {
    const response = await limitedFetch(`${API_CONFIG.historyEndpoint}?page=1&page_size=1`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(response.status === 401 ? "API Key 无效" : `连接失败（HTTP ${response.status}）`);
    elements.settingsApiState.textContent = "连接正常";
    elements.settingsApiState.classList.add("is-ready");
    setStatus("success", "API 连接正常", "已成功访问生成历史接口，没有发送生成请求");
  } catch (error) {
    elements.settingsApiState.textContent = "连接失败";
    elements.settingsApiState.classList.remove("is-ready");
    if (isAbortError(error)) throw new Error("连接测试超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function saveDefaultGenerationSettings() {
  syncMaskFeatherSetting();
  saveSettings();
  setStatus("success", "羽化范围已保存", `${maskFeatherRadius()}px`);
}

function syncOutfitControlsFromMain() {
  if (!elements.outfitModelChannel) return;
  elements.outfitModelChannel.value = elements.modelChannel.value;
  elements.outfitResolution.value = elements.resolution.value;
  elements.outfitGenerationCount.value = elements.generationCount.value;
  refreshIslandSelect(elements.outfitModelChannel, true);
  refreshIslandSelect(elements.outfitResolution, true);
  refreshIslandSelect(elements.outfitGenerationCount, true);
}

function syncMainControlsFromOutfit() {
  elements.modelChannel.value = elements.outfitModelChannel.value;
  elements.resolution.value = elements.outfitResolution.value;
  elements.generationCount.value = elements.outfitGenerationCount.value;
  elements.aspectRatio.value = "auto";
  elements.precisionPlacement.checked = true;
  syncModelCapabilities();
  syncOutfitControlsFromMain();
  syncIslandSelects();
  updateResolvedSize();
}

function renderOutfitBackgroundWorkspace() {
  const wrap = elements.outfitBackgroundAddWrap;
  const image = elements.outfitBackgroundPreview;
  const empty = elements.outfitBackgroundEmpty;
  const add = elements.outfitBackgroundAdd;
  const remove = elements.outfitClearBackground;
  if (!wrap || !image || !empty || !add || !remove) return;
  const background = outfitBackgroundReference();
  const ordinal = outfitSlotLabels().length + 3;
  if (elements.outfitBackgroundOrdinal) {
    elements.outfitBackgroundOrdinal.textContent = `选填 · 生成时作为附图${ordinal}`;
  }
  wrap.classList.toggle("has-image", Boolean(background));
  add.classList.toggle("is-hidden", Boolean(background));
  remove.classList.toggle("is-hidden", !background);
  remove.disabled = !background;
  if (background) {
    const previewReady = setReferenceImageSource(image, background, () => {
      image.classList.add("is-hidden");
      empty.classList.remove("is-hidden");
      add.classList.remove("is-hidden");
      remove.classList.add("is-hidden");
      wrap.classList.remove("has-image");
    });
    image.classList.toggle("is-hidden", !previewReady);
    empty.classList.toggle("is-hidden", previewReady);
    closeOutfitMaterialMenu(wrap);
  } else {
    image.onerror = null;
    image.removeAttribute("src");
    image.classList.add("is-hidden");
    empty.classList.remove("is-hidden");
  }
}

function renderOutfitWorkspace() {
  if (!elements.outfitTargetPreview || !elements.outfitGarmentList) return;
  const target = outfitTargetReference();
  elements.outfitTargetAddWrap.classList.toggle("has-image", Boolean(target));
  elements.outfitCaptureTarget.classList.toggle("is-hidden", Boolean(target));
  elements.outfitClearTarget.classList.toggle("is-hidden", !target);
  if (target) closeOutfitMaterialMenu(elements.outfitTargetAddWrap);
  if (target) {
    const previewReady = setReferenceImageSource(elements.outfitTargetPreview, target, () => {
      elements.outfitTargetPreview.classList.add("is-hidden");
      elements.outfitTargetEmpty.classList.remove("is-hidden");
      elements.outfitCaptureTarget.classList.remove("is-hidden");
      elements.outfitClearTarget.classList.add("is-hidden");
      elements.outfitTargetAddWrap.classList.remove("has-image");
    });
    elements.outfitTargetPreview.classList.toggle("is-hidden", !previewReady);
    elements.outfitTargetEmpty.classList.toggle("is-hidden", previewReady);
  } else {
    elements.outfitTargetPreview.onerror = null;
    elements.outfitTargetPreview.removeAttribute("src");
    elements.outfitTargetPreview.classList.add("is-hidden");
    elements.outfitTargetEmpty.classList.remove("is-hidden");
  }

  const face = outfitFaceReference();
  elements.outfitFaceAddWrap.classList.toggle("has-image", Boolean(face));
  elements.outfitFaceAdd.classList.toggle("is-hidden", Boolean(face));
  elements.outfitClearFace.classList.toggle("is-hidden", !face);
  if (face) closeOutfitMaterialMenu(elements.outfitFaceAddWrap);
  if (face) {
    const previewReady = setReferenceImageSource(elements.outfitFacePreview, face, () => {
      elements.outfitFacePreview.classList.add("is-hidden");
      elements.outfitFaceEmpty.classList.remove("is-hidden");
      elements.outfitFaceAdd.classList.remove("is-hidden");
      elements.outfitClearFace.classList.add("is-hidden");
      elements.outfitFaceAddWrap.classList.remove("has-image");
    });
    elements.outfitFacePreview.classList.toggle("is-hidden", !previewReady);
    elements.outfitFaceEmpty.classList.toggle("is-hidden", previewReady);
  } else {
    elements.outfitFacePreview.onerror = null;
    elements.outfitFacePreview.removeAttribute("src");
    elements.outfitFacePreview.classList.add("is-hidden");
    elements.outfitFaceEmpty.classList.remove("is-hidden");
  }
  elements.outfitClearFace.disabled = !face;
  renderOutfitBackgroundWorkspace();

  const garments = outfitGarmentSlotReferences();
  const slotLabels = outfitSlotLabels();
  elements.outfitGarmentList.classList.remove("slots-1", "slots-2", "slots-3");
  elements.outfitGarmentList.classList.add(`slots-${slotLabels.length}`);
  const descriptions = {
    "模特全身服饰图": "上传完整服饰参考图，尽量包含全身或完整上下身细节。",
    "模特上衣图": "上传上衣参考图，尽量包含领口、袖型、材质和图案。",
    "模特裤子/下装图": "上传裤子、半裙或下装参考图，尽量包含版型和腰线。",
    "模特鞋子图": "上传鞋子参考图，尽量包含鞋型、材质、颜色和鞋跟细节。"
  };
  for (let index = 0; index < 3; index += 1) {
    const slot = byId(`outfitGarmentSlot${index}`);
    const label = byId(`outfitGarmentSlotLabel${index}`);
    const description = byId(`outfitGarmentSlotDescription${index}`);
    const preview = byId(`outfitGarmentSlotPreview${index}`);
    const image = byId(`outfitGarmentSlotImage${index}`);
    const empty = byId(`outfitGarmentSlotEmpty${index}`);
    const add = byId(`outfitGarmentSlotAdd${index}`);
    const remove = byId(`outfitGarmentSlotRemove${index}`);
    const selectionButton = byId(`outfitGarmentSlotSelection${index}`);
    const localButton = byId(`outfitGarmentSlotLocal${index}`);
    const layerButton = byId(`outfitGarmentSlotLayer${index}`);
    const visible = index < slotLabels.length;
    const slotLabel = slotLabels[index] || "";
    const reference = visible ? garments[index] : null;
    const previewSource = outfitGarmentPreviewSource(reference);
    const displayReference = isUsableOutfitGarmentReference(reference) ? reference : null;
    slot.style.display = visible ? "flex" : "none";
    slot.classList.toggle("has-image", Boolean(displayReference));
    slot.classList.toggle("is-empty", !displayReference);
    if (preview) {
      preview.classList.toggle("has-image", Boolean(displayReference));
      const menu = preview.querySelector(".outfit-material-menu");
      const menuIsOpen = Boolean(menu && !menu.classList.contains("is-menu-hidden"));
      if (!visible || displayReference || !menuIsOpen) closeOutfitMaterialMenu(preview);
    }
    if (label) label.textContent = slotLabel;
    if (description) description.textContent = descriptions[slotLabel] || "上传对应服饰参考图。";
    if (image) {
      image.alt = slotLabel;
      if (displayReference) {
        const recoverFailedPreview = () => {
          // UXP can reject restored files either while assigning src or later
          // during image decoding. In both cases the material must stay replaceable.
          if (outfitGarmentSlotReferences()[index] !== reference) return;
          image.onerror = null;
          reference.outfitFailedPreviewSource = previewSource;
          image.removeAttribute("src");
          image.classList.add("is-hidden");
          slot.classList.remove("has-image");
          slot.classList.add("is-empty");
          if (preview) preview.classList.remove("has-image");
          if (empty) empty.classList.remove("is-hidden");
          if (add) add.classList.remove("is-hidden");
          if (remove) remove.classList.add("is-hidden");
          setTimeout(() => {
            if (outfitGarmentSlotReferences()[index] !== reference) return;
            renderOutfitWorkspace();
            updateControls();
          }, 0);
        };
        const previewReady = setReferenceImageSource(image, reference, recoverFailedPreview);
        image.classList.toggle("is-hidden", !previewReady);
      } else {
        image.onerror = null;
        image.removeAttribute("src");
        image.classList.add("is-hidden");
      }
    }
    if (empty) empty.classList.toggle("is-hidden", Boolean(displayReference));
    if (add) {
      add.classList.toggle("is-hidden", Boolean(displayReference));
      add.setAttribute("aria-label", `添加${slotLabel}`);
    }
    if (remove) {
      remove.classList.toggle("is-hidden", !displayReference);
      remove.setAttribute("aria-label", `移除${slotLabel}`);
    }
    if (selectionButton) selectionButton.textContent = "从选区获取";
    if (layerButton) layerButton.textContent = "从图层获取";
    if (localButton) localButton.textContent = "从本地添加";
  }
  const filledGarments = garments.slice(0, slotLabels.length).filter(isUsableOutfitGarmentReference).length;
  const requiredReady = Boolean(target && face && filledGarments === slotLabels.length);
  elements.outfitReferenceCount.textContent = requiredReady
    ? `素材齐全 · ${filledGarments} / ${slotLabels.length} 张服饰参考`
    : `${filledGarments} / ${slotLabels.length} 张服饰参考`;
  elements.outfitReferenceCount.classList.toggle("is-ready", requiredReady);
  renderOutfitMetrics();
}

async function captureOutfitMaterialReference(source, options = {}) {
  const replacing = options.replacingReference || null;
  const pool = state.references;
  let detachedIndex = -1;
  if (replacing && pool.length >= MAX_OUTFIT_REFERENCES) {
    detachedIndex = pool.indexOf(replacing);
    if (detachedIndex >= 0) pool.splice(detachedIndex, 1);
  }
  try {
    const reference = source === "selection"
      ? await captureSource("selection", {
        assignAsTarget: Boolean(options.assignAsTarget),
        silentStatus: true
      })
      : (source === "layer"
        ? (await captureSelectedLayers({ maxCount: 1 }))[0] || null
        : (await importReferenceImages({ maxCount: 1, allowMultiple: false }))[0] || null);
    if (!reference && detachedIndex >= 0) {
      pool.splice(Math.min(detachedIndex, pool.length), 0, replacing);
    } else if (reference && replacing && replacing.id !== reference.id) {
      const previousIndex = pool.indexOf(replacing);
      if (previousIndex >= 0) pool.splice(previousIndex, 1);
      await releaseReference(replacing);
    }
    return reference;
  } catch (error) {
    if (detachedIndex >= 0 && !pool.includes(replacing)) {
      replacing.inReferenceList = true;
      pool.splice(Math.min(detachedIndex, pool.length), 0, replacing);
    }
    throw error;
  }
}

async function captureOutfitTarget(source = "selection") {
  await withOutfitReferencePool(async () => {
    const previous = outfitTargetReference();
    const previousWasGlobalTarget = Boolean(
      previous && state.targetSnapshot && state.targetSnapshot.sourceReferenceId === previous.id
    );
    const captured = await captureOutfitMaterialReference(source, {
      assignAsTarget: source === "selection",
      replacingReference: previous
    });
    if (!captured) return;
    captured.outfitRole = "target";
    captured.outfitSlotIndex = -1;
    state.outfitTargetReferenceId = captured.id;
    if (source === "selection") state.targetSnapshot = captured.snapshot;
    state.outfitTargetSnapshot = state.targetSnapshot;
    elements.precisionPlacement.checked = hasPhotoshopTarget(captured.snapshot);
    if (source !== "selection" && previousWasGlobalTarget) {
      state.targetSnapshot = null;
      state.outfitTargetSnapshot = null;
    }
    setStatus(
      "success",
      "模特姿势图已添加",
      source === "selection"
        ? "已记录 Photoshop 选区；生成后可精确放回这个位置和尺寸"
        : "已设为换装主图；生成后可从结果区插入 Photoshop"
    );
  });
}

async function clearOutfitTarget() {
  if (state.preparingJob || state.capturing || state.inserting) return;
  await withOutfitReferencePool(async () => {
    const target = outfitTargetReference();
    if (!target) return;
    await removeReference(target.id);
    state.outfitTargetReferenceId = null;
    state.outfitTargetSnapshot = null;
    setStatus("idle", "模特姿势图已清除", "可重新从选区、图层或本地添加");
  });
}

async function addOutfitFace(source) {
  await withOutfitReferencePool(async () => {
    const previous = outfitFaceReference();
    const reference = await captureOutfitMaterialReference(source, {
      assignAsTarget: false,
      replacingReference: previous
    });
    if (!reference) return;
    reference.outfitRole = "face";
    reference.outfitSlotIndex = -1;
    state.outfitFaceReferenceId = reference.id;
    setStatus("success", "模特人脸图已添加", "生成时会用这张图保持人物五官、脸型和身份特征");
  });
}

async function clearOutfitFace() {
  if (state.preparingJob || state.capturing || state.inserting) return;
  await withOutfitReferencePool(async () => {
    const face = outfitFaceReference();
    if (!face) return;
    await removeReference(face.id);
    state.outfitFaceReferenceId = null;
    setStatus("idle", "模特人脸图已清除", "可重新从选区、图层或本地添加");
  });
}

async function addOutfitBackground(source) {
  await withOutfitReferencePool(async () => {
    const previous = outfitBackgroundReference();
    const reference = await captureOutfitMaterialReference(source, {
      assignAsTarget: false,
      replacingReference: previous
    });
    if (!reference) return;
    reference.outfitRole = "background";
    reference.outfitSlotIndex = -1;
    state.outfitBackgroundReferenceId = reference.id;
    setStatus("success", "场景背景图已添加", "生成时会作为附图背景参考，不会替代模特或服饰素材");
  });
}

async function clearOutfitBackground() {
  if (state.preparingJob || state.capturing || state.inserting) return;
  await withOutfitReferencePool(async () => {
    const background = outfitBackgroundReference();
    if (!background) return;
    await removeReference(background.id);
    state.outfitBackgroundReferenceId = null;
    setStatus("idle", "场景背景图已清除", "可重新从选区、图层或本地添加");
  });
}

async function setOutfitGarmentSlot(index, source) {
  await withOutfitReferencePool(async () => {
    const slotIndex = Math.max(0, Math.min(2, Number(index) || 0));
    const previousIds = outfitGarmentSlotReferences().map((reference) => reference ? reference.id : "");
    const previousId = previousIds[slotIndex] || "";
    const previous = previousId
      ? outfitReferencePool().find((item) => item && item.id === previousId) || null
      : null;
    const reference = await captureOutfitMaterialReference(source, {
      assignAsTarget: false,
      replacingReference: previous
    });
    if (!reference) return;
    reference.outfitRole = slotIndex === 0 ? "full-or-upper" : (slotIndex === 1 ? "pants" : "shoes");
    reference.outfitSlotIndex = slotIndex;
    const nextIds = previousIds.slice();
    nextIds[slotIndex] = reference.id;
    state.outfitGarmentReferenceIds = normalizeOutfitGarmentReferenceIds(nextIds);
    setStatus("success", `${outfitSlotLabels()[slotIndex] || "服饰参考"}已添加`, "素材顺序已固定，生成时会按对应服饰位置引用");
  });
}

async function removeOutfitGarmentSlot(index) {
  await withOutfitReferencePool(async () => {
    const slotIndex = Math.max(0, Math.min(2, Number(index) || 0));
    const references = outfitGarmentSlotReferences();
    const reference = references[slotIndex];
    if (!reference) return;
    state.outfitGarmentReferenceIds = normalizeOutfitGarmentReferenceIds(references.map((item, referenceIndex) => (
      referenceIndex === slotIndex || !item ? "" : item.id
    )));
    await removeReference(reference.id);
  });
}

async function clearOutfitGarments() {
  await withOutfitReferencePool(async () => {
    const garments = outfitGarmentReferences().slice();
    state.outfitGarmentReferenceIds = ["", "", ""];
    for (const reference of garments) await removeReference(reference.id);
    setStatus("idle", "服装参考已清空", "模特姿势图仍然保留");
  });
}

async function handleOutfitTypeChange(value = selectedOutfitType()) {
  if (state.preparingJob || state.capturing || state.inserting) return;
  closeOutfitMaterialMenus();
  const previousType = normalizeOutfitType(state.outfitType);
  const nextType = normalizeOutfitType(value);
  setSelectedOutfitType(nextType);
  if (previousType === nextType) {
    renderOutfitWorkspace();
    return;
  }

  let indexesToClear = [];
  if (previousType === "full" || nextType === "full") {
    indexesToClear = [0, 1, 2];
  } else if (previousType === "separatesShoes" && nextType === "separates") {
    indexesToClear = [2];
  }

  await withOutfitReferencePool(async () => {
    const slotReferences = outfitGarmentSlotReferences();
    const nextIds = normalizeOutfitGarmentReferenceIds(state.outfitGarmentReferenceIds);
    const referencesToRemove = [];
    indexesToClear.forEach((index) => {
      if (slotReferences[index]) referencesToRemove.push(slotReferences[index]);
      nextIds[index] = "";
    });
    state.outfitGarmentReferenceIds = nextIds;
    for (const reference of Array.from(new Set(referencesToRemove))) {
      await removeReference(reference.id);
    }
    if (referencesToRemove.length) {
      setStatus("idle", "服饰参考已按新布局重置", "布局含义发生变化，请把服饰图放入新的对应框内");
    }
  });
}

async function handleOutfitRun() {
  syncMainControlsFromOutfit();
  const outfitPrompt = String(elements.outfitPrompt.value || "").trim() || DEFAULT_OUTFIT_STYLE_PROMPT;
  const outfitExtraPrompt = String(elements.outfitExtraPrompt.value || "").trim() || DEFAULT_OUTFIT_EXTRA_PROMPT;
  elements.outfitPrompt.value = outfitPrompt;
  elements.outfitExtraPrompt.value = outfitExtraPrompt;
  await handleRun({
    forceModelOutfit: true,
    skipPromptOptimization: true,
    outfitType: selectedOutfitType(),
    outfitPromptOverride: outfitPrompt,
    outfitExtraPromptOverride: outfitExtraPrompt
  });
}

function renderReferences() {
  const sourceCard = elements.referenceStrip && elements.referenceStrip.parentElement;
  const hasSecondRow = false;
  const sourceHeight = 100;
  if (elements.referenceStrip) {
    elements.referenceStrip.style.setProperty("height", `${sourceHeight}px`, "important");
    elements.referenceStrip.style.setProperty("min-height", `${sourceHeight}px`, "important");
    elements.referenceStrip.style.setProperty("max-height", `${sourceHeight}px`, "important");
  }
  if (sourceCard) {
    sourceCard.classList.toggle("has-second-reference-row", hasSecondRow);
    sourceCard.style.setProperty("height", `${sourceHeight}px`, "important");
    sourceCard.style.setProperty("min-height", `${sourceHeight}px`, "important");
    sourceCard.style.setProperty("max-height", `${sourceHeight}px`, "important");
  }
  const activeIds = new Set(state.references.map((reference) => reference.id));
  const existingNodes = new Map();
  Array.from(elements.referenceList.children || []).forEach((child) => {
    if (child.classList && child.classList.contains("reference-thumb")) {
      const referenceId = child.getAttribute("data-reference-drag-id");
      if (!activeIds.has(referenceId)) elements.referenceList.removeChild(child);
      else existingNodes.set(referenceId, child);
    }
  });

  state.references.forEach((reference, index) => {
    const existing = existingNodes.get(reference.id);
    if (existing) {
      const image = existing.querySelector(".reference-thumb-image");
      if (image) setReferenceImageSource(image, reference);
      existing.__referenceItem = reference;
      return;
    }
    const displayLabel = formatReferenceLabel(reference, index);
    const thumb = document.createElement("div");
    thumb.className = "reference-thumb";
    thumb.__referenceItem = reference;
    thumb.setAttribute("data-reference-drag-id", reference.id);
    thumb.setAttribute("data-reference-prompt-id", reference.id);
    thumb.setAttribute("draggable", "false");
    if (state.targetSnapshot && state.targetSnapshot.sourceReferenceId === reference.id) {
      thumb.classList.add("is-target");
    }
    const originalName = reference.originalName ? ` · ${reference.originalName}` : "";
    thumb.title = `${displayLabel}${originalName} · ${reference.bounds.width}×${reference.bounds.height} · 可拖动调整顺序`;

    const image = document.createElement("img");
    image.className = "reference-thumb-image";
    image.alt = `参考图 ${index + 1}`;
    image.setAttribute("draggable", "false");
    setReferenceImageSource(image, reference);

    const number = document.createElement("span");
    number.className = "reference-index animal-reference-tag";
    number.textContent = String(index + 1);

    const type = document.createElement("span");
    type.className = "reference-type animal-reference-type";
    type.textContent = displayLabel;
    const dimensions = document.createElement("span");
    dimensions.className = "reference-dimensions";
    dimensions.textContent = referenceDimensionsLabel(reference);

    const remove = document.createElement("span");
    remove.className = "reference-remove animal-thumb-button animal-thumb-danger";
    remove.textContent = "×";
    remove.setAttribute("role", "button");
    remove.setAttribute("tabindex", "0");
    remove.setAttribute("aria-label", `移除${displayLabel}`);
    remove.setAttribute("data-reference-id", reference.id);
    remove.setAttribute("draggable", "false");
    remove.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeReference(reference.id).catch((error) => {
        setStatus("error", "无法删除参考图", error.message || error);
      });
    });

    let controlsHideTimer = null;
    const showReferenceControls = () => {
      if (controlsHideTimer !== null) {
        clearTimeout(controlsHideTimer);
        controlsHideTimer = null;
      }
      thumb.classList.add("is-controls-visible");
    };
    const scheduleReferenceControlsHide = () => {
      if (controlsHideTimer !== null) clearTimeout(controlsHideTimer);
      controlsHideTimer = setTimeout(() => {
        controlsHideTimer = null;
        thumb.classList.remove("is-controls-visible");
      }, 160);
    };
    thumb.addEventListener("mouseenter", showReferenceControls);
    thumb.addEventListener("mousemove", showReferenceControls);
    thumb.addEventListener("mouseleave", scheduleReferenceControlsHide);
    remove.addEventListener("mouseenter", showReferenceControls);
    remove.addEventListener("mouseleave", scheduleReferenceControlsHide);
    remove.addEventListener("focus", showReferenceControls);
    remove.addEventListener("blur", scheduleReferenceControlsHide);

    const caption = document.createElement("div");
    caption.className = "reference-caption animal-reference-toolbar";
    caption.appendChild(type);
    caption.appendChild(dimensions);

    thumb.appendChild(image);
    thumb.appendChild(number);
    thumb.appendChild(caption);
    thumb.appendChild(remove);
    elements.referenceList.insertBefore(thumb, elements.referenceAddWrap);
  });

  reorderReferenceNodes();

  // Keep the action tile in the reference list for the restored layout.
  if (!elements.referenceList.contains(elements.referenceAddWrap)) {
    elements.referenceList.appendChild(elements.referenceAddWrap);
  }
  elements.referenceAddWrap.classList.remove("is-hidden");
  elements.referenceAddWrap.style.display = "block";
  elements.referenceAddWrap.style.visibility = "visible";
  elements.referenceAddWrap.style.opacity = "1";
  elements.referenceAddWrap.style.position = "relative";
  elements.referenceAddWrap.style.removeProperty("width");
  elements.referenceAddWrap.style.removeProperty("height");
  elements.referenceAddWrap.style.removeProperty("min-width");
  elements.referenceAddWrap.style.removeProperty("min-height");
  elements.referenceAddWrap.style.removeProperty("top");
  elements.referenceAddWrap.style.removeProperty("left");
  elements.referenceAddWrap.style.setProperty("width", "68px", "important");
  elements.referenceAddWrap.style.setProperty("min-width", "68px", "important");
  elements.referenceAddWrap.style.setProperty("max-width", "68px", "important");
  elements.referenceAddWrap.style.setProperty("height", "92px", "important");
  elements.referenceAddWrap.style.setProperty("min-height", "92px", "important");
  elements.referenceAddWrap.style.setProperty("max-height", "92px", "important");
  elements.referenceAddWrap.style.setProperty("flex", "0 0 68px", "important");
  elements.referenceAddWrap.style.setProperty("border-radius", "6px", "important");
  // Share the same unshifted baseline as the filled reference tiles.
  elements.referenceAddWrap.style.setProperty("transform", "none", "important");
  elements.referenceAddWrap.style.setProperty("transform-origin", "top left", "important");
  elements.referenceAdd.style.setProperty("width", "68px", "important");
  elements.referenceAdd.style.setProperty("min-width", "68px", "important");
  elements.referenceAdd.style.setProperty("max-width", "68px", "important");
  elements.referenceAdd.style.setProperty("height", "92px", "important");
  elements.referenceAdd.style.setProperty("min-height", "92px", "important");
  elements.referenceAdd.style.setProperty("max-height", "92px", "important");
  elements.referenceAdd.style.setProperty("border-radius", "6px", "important");

  const hasReferences = state.references.length > 0;
  elements.referenceList.classList.toggle("has-references", hasReferences);
  elements.referenceCount.textContent = `${state.references.length} / ${MAX_REFERENCES}`;
  elements.referenceEmptyHint.classList.toggle("is-hidden", state.references.length > 0);
  if (!referenceMenuOpenedAt && !elements.referenceAddWrap.classList.contains("is-menu-open")) {
    closeReferenceSourceMenu();
  }
  const referenceFull = state.references.length >= MAX_REFERENCES;
  // Keep the add tile visible as a permanent entry point. When full, the
  // button is disabled but the frame remains available for a clear count.
  elements.referenceAddWrap.classList.remove("is-hidden");
  elements.referenceAddWrap.classList.toggle("is-reference-full", referenceFull);
  elements.referenceAdd.disabled = referenceFull;
  if (referenceFull) {
    closeReferenceSourceMenu();
  }
  // Final runtime guard: UXP sometimes reapplies stale hidden styles after
  // renderReferences() completes, so force the list and add tile visible here.
  elements.referenceList.style.setProperty("display", "flex", "important");
  elements.referenceList.style.setProperty("flex-wrap", "nowrap", "important");
  elements.referenceList.style.setProperty("align-content", "flex-start", "important");
  elements.referenceList.style.setProperty("width", "100%", "important");
  elements.referenceList.style.setProperty("min-width", "0", "important");
  elements.referenceList.style.setProperty("max-width", "none", "important");
  elements.referenceList.style.setProperty("gap", "0px", "important");
  elements.referenceList.style.setProperty("column-gap", "0px", "important");
  elements.referenceList.style.setProperty("row-gap", "0px", "important");
  // Keep the render pass aligned with syncReferenceTileLayout.
  elements.referenceList.style.setProperty("padding", "2px 0 2px 6px", "important");
  elements.referenceList.style.setProperty("box-sizing", "border-box", "important");
  elements.referenceList.style.setProperty("visibility", "visible", "important");
  elements.referenceList.style.setProperty("opacity", "1", "important");
  elements.referenceAddWrap.style.setProperty("display", referenceFull ? "none" : "block", "important");
  elements.referenceAddWrap.style.setProperty("visibility", referenceFull ? "hidden" : "visible", "important");
  elements.referenceAddWrap.style.setProperty("opacity", "1", "important");
  elements.referenceAddWrap.style.setProperty("margin-right", "0px", "important");
  if (elements.referenceQuickActions) {
    elements.referenceQuickActions.style.setProperty("display", "none", "important");
    elements.referenceQuickActions.style.setProperty("visibility", "hidden", "important");
    elements.referenceQuickActions.style.setProperty("opacity", "0", "important");
    elements.referenceQuickActions.style.setProperty("pointer-events", "none", "important");
    Array.from(elements.referenceQuickActions.querySelectorAll(".reference-quick-button") || []).forEach((button) => {
      button.style.setProperty("display", "none", "important");
      button.style.setProperty("visibility", "hidden", "important");
      button.style.setProperty("opacity", "0", "important");
      button.style.setProperty("pointer-events", "none", "important");
    });
  }
  syncReferenceTileLayout();
  renderOutfitWorkspace();
  updateResolvedSize();
  updateControls();
}

function outputBasis() {
  if (state.activeWorkspace === "outfit" && state.activeCreativeTool === "outfit") {
    const target = outfitTargetReference();
    return target && target.snapshot ? target.snapshot : null;
  }
  if (state.activeWorkspace === "outfit" && state.activeCreativeTool === "product") {
    const main = productReference("main");
    return main && main.snapshot ? main.snapshot : null;
  }
  return getGenerationSnapshot();
}

function ratioNumber(label) {
  const parts = String(label || "").split(":");
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  return width > 0 && height > 0 ? width / height : NaN;
}

function closestSupportedRatio(width, height, supportedRatios) {
  const actual = Number(width) / Number(height);
  if (!(actual > 0) || !Number.isFinite(actual)) return supportedRatios[0] || "1:1";
  let best = supportedRatios[0] || "1:1";
  let bestDistance = Infinity;
  supportedRatios.forEach((ratio) => {
    const nominal = ratioNumber(ratio);
    if (!(nominal > 0)) return;
    const distance = Math.abs(Math.log(actual / nominal));
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  });
  return best;
}

function resolveModelOutputSize(aspectRatio, resolution, sourceWidth, sourceHeight, modelConfig) {
  const model = modelConfig || getSelectedModelConfig();
  if (modelProvider(model) === "volc") {
    const requestedSize = String(resolution || "2K");
    if (!model.supportedSizes.includes(requestedSize)) throw new Error(`${model.shortLabel} 仅支持 ${model.supportedSizes.join(" / ")}`);
    const automatic = aspectRatio === "auto";
    const ratio = automatic ? "auto" : String(aspectRatio || "1:1");
    if (!automatic && !model.supportedRatios.includes(ratio)) {
      throw new Error(`${model.shortLabel} 不支持 ${ratio} 比例`);
    }
    return { ratio, resolution: requestedSize, size: requestedSize, width: 0, height: 0, automatic };
  }
  const automatic = aspectRatio === "auto";
  const ratio = automatic
    ? closestSupportedRatio(sourceWidth, sourceHeight, model.supportedRatios)
    : String(aspectRatio || "1:1");
  if (!model.supportedRatios.includes(ratio)) {
    throw new Error(`${model.shortLabel} 不支持 ${ratio} 比例`);
  }
  if (!model.supportedSizes.includes(String(resolution))) {
    throw new Error(`${model.shortLabel} 不支持 ${resolution} 分辨率`);
  }
  const resolved = resolveOutputSize(ratio, resolution, sourceWidth, sourceHeight);
  resolved.automatic = automatic;
  return resolved;
}

function syncResolutionOptions(control, model, preferredValue) {
  if (!control) return;
  const requested = preferredValue === undefined ? control.value : String(preferredValue || "");
  const sizes = model.supportedSizes;
  const options = Array.from(control.options || []);
  // Rebuild native options instead of relying on option.hidden, which UXP's
  // native selects do not consistently respect. This also adds missing 4K.
  if (options.length !== sizes.length || options.some((option, index) => option.value !== sizes[index])) {
    while (control.firstChild) control.removeChild(control.firstChild);
    sizes.forEach((size) => {
      const option = document.createElement("option");
      option.value = size;
      option.textContent = size;
      control.appendChild(option);
    });
  }
  Array.from(control.options || []).forEach((option) => {
    option.hidden = false;
    option.disabled = false;
  });
  control.value = sizes.includes(requested) ? requested : (sizes[0] || "");
  refreshIslandSelect(control, true);
}

function syncModelCapabilities() {
  const model = getSelectedModelConfig();
  Array.from(elements.aspectRatio.options || []).forEach((option) => {
    option.disabled = option.value !== "auto" && !model.supportedRatios.includes(option.value);
  });
  if (elements.aspectRatio.value !== "auto" && !model.supportedRatios.includes(elements.aspectRatio.value)) {
    elements.aspectRatio.value = "auto";
  }
  syncResolutionOptions(elements.resolution, model);
  syncResolutionOptions(elements.outfitResolution, model, elements.resolution.value);
  syncResolutionOptions(elements.productResolution, model);
  refreshIslandSelect(elements.aspectRatio, true);
}

function resetPricingStateForModel() {
  state.pricing.prices = { "1K": null, "1.5K": null, "2K": null, "4K": null };
  state.pricing.enabled = { "1K": false, "1.5K": false, "2K": false, "4K": false };
  state.pricing.fetchedAt = 0;
  state.pricing.serviceUpdatedAt = "";
  state.pricing.source = "none";
  state.pricing.changes = {};
  state.pricing.unacknowledgedIncreases = {};
  state.pricing.error = "";
  state.pricingRunConfirmation = null;
}

function normalizePriceValue(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? Math.round(price * 10000) / 10000 : null;
}

function formatYuan(value) {
  const price = normalizePriceValue(value);
  if (price === null) return "--";
  return `¥${price < 0.01 && price > 0 ? price.toFixed(4) : price.toFixed(2)}`;
}

function formatCompactPrice(value) {
  const price = normalizePriceValue(value);
  if (price === null) return "--";
  return price.toFixed(2);
}

function hasUsablePricing() {
  return PRICING_SIZES.some((size) => normalizePriceValue(state.pricing.prices[size]) !== null);
}

function pricingCostNotice() {
  if (modelProvider(getSelectedModelConfig()) === "volc") {
    const productActive = state.activeWorkspace === "outfit" && state.activeCreativeTool === "product";
    const sizeControl = productActive ? elements.productResolution : elements.resolution;
    const countControl = productActive ? elements.productGenerationCount : elements.generationCount;
    const selectedSize = sizeControl ? String(sizeControl.value || "2K") : "2K";
    const count = Math.max(1, Math.min(4, Number(countControl && countControl.value) || 1));
    const unitPrice = volcFixedPrice(selectedSize);
    return `；GPT 2.5 价格以咖图实时价格为准 ${formatYuan(unitPrice)}/张，预计 ${formatYuan(unitPrice * count)}`;
  }
  const productActive = state.activeWorkspace === "outfit" && state.activeCreativeTool === "product";
  const sizeControl = productActive ? elements.productResolution : elements.resolution;
  const countControl = productActive ? elements.productGenerationCount : elements.generationCount;
  const selectedSize = sizeControl ? String(sizeControl.value || "1K") : "1K";
  const count = Math.max(1, Math.min(4, Number(countControl && countControl.value) || 1));
  const selectedPrice = normalizePriceValue(state.pricing.prices[selectedSize]);
  const pendingIncrease = state.pricing.unacknowledgedIncreases[selectedSize];

  if (pendingIncrease) {
    return `；${selectedSize} 已涨至 ${formatYuan(pendingIncrease.after)}，首次运行会暂停确认`;
  }
  if (state.pricing.source === "none" && !state.pricing.error) {
    return "；实时价格获取中";
  }
  if (state.pricing.error) {
    return "；实时价格不可用，运行前会重新核对";
  }
  if (state.pricing.source === "cache") {
    return selectedPrice === null
      ? "；实时价格获取中"
      : `；缓存单价 ${formatYuan(selectedPrice)}，正在核对实时价格`;
  }
  if (!state.pricing.enabled[selectedSize] || selectedPrice === null) {
    return `；${selectedSize} 已停用，本次不会发送付费请求`;
  }
  return `；单价 ${formatYuan(selectedPrice)}，${count} 张预计 ${formatYuan(selectedPrice * count)}`;
}

function setFitNotice(message) {
  fitNoticeBaseText = String(message || "");
  if (elements.fitNotice) {
    elements.fitNotice.textContent = `${fitNoticeBaseText}${pricingCostNotice()}`;
  }
}

function renderPricing() {
  if (!elements.resolution) return;
  const model = getSelectedModelConfig();
  const volc = modelProvider(model) === "volc";
  const waitingForFirstPrice = state.pricing.source === "none" && !state.pricing.error;
  [elements.resolution, elements.outfitResolution, elements.productResolution].filter(Boolean).forEach((control) => {
    const options = Array.from(control.options || []);
    let optionsChanged = false;
    const priceSizes = volc ? model.supportedSizes.slice() : PRICING_SIZES;
    priceSizes.forEach((size) => {
      const option = options.find((item) => item.value === size);
      if (!option) return;
      const price = volc ? volcFixedPrice(size) : normalizePriceValue(state.pricing.prices[size]);
      const enabled = Boolean(state.pricing.enabled[size]);
      const change = state.pricing.changes[size];
      let nextTitle = `${size} 实时 API 单价`;
      if (change && normalizePriceValue(change.before) !== null && normalizePriceValue(change.after) !== null) {
        const increased = change.after > change.before;
        nextTitle = `${size} 单价${increased ? "上涨" : "下降"}：原价 ${formatYuan(change.before)}，现价 ${formatYuan(change.after)}`;
      }
      const modelUnsupported = !model.supportedSizes.includes(size);
      // A missing live price must not disable a size the model supports. The
      // run-time pricing check still blocks or confirms the paid request.
      const serverDisabled = modelUnsupported;
      let nextLabel = "";
      if (modelUnsupported) {
        nextLabel = `${size} · 该模型不支持`;
        nextTitle = `${model.shortLabel} 不支持 ${size}`;
      } else if (volc) {
        nextLabel = `${size}-${formatCompactPrice(price)}`;
        nextTitle = `${model.shortLabel} 直连火山方舟，固定单价 ${formatYuan(price)} / 张`;
      } else if (waitingForFirstPrice) {
        nextLabel = `${size} · 获取中…`;
      } else if (serverDisabled) {
        nextLabel = `${size} · 已停用`;
      } else if (price !== null) {
        nextLabel = `${size} · ${formatYuan(price)}`;
      } else {
        nextLabel = `${size} · 价格不可用`;
      }
      if (option.title !== nextTitle) {
        option.title = nextTitle;
        optionsChanged = true;
      }
      if (Boolean(option.disabled) !== serverDisabled) {
        option.disabled = serverDisabled;
        optionsChanged = true;
      }
      if (option.textContent !== nextLabel) {
        option.textContent = nextLabel;
        optionsChanged = true;
      }
    });
    refreshIslandSelect(control, optionsChanged);
  });
  if (fitNoticeBaseText && elements.fitNotice) {
    elements.fitNotice.textContent = `${fitNoticeBaseText}${pricingCostNotice()}`;
  }
  renderBudgetSummary();
}

function loadCachedPricing() {
  try {
    const cached = JSON.parse(localStorage.getItem(PRICING_STORAGE) || "{}");
    if (cached.model !== selectedApiModel() || !cached.prices || !cached.enabled) return;
    let found = false;
    PRICING_SIZES.forEach((size) => {
      const price = normalizePriceValue(cached.prices[size]);
      state.pricing.prices[size] = price;
      state.pricing.enabled[size] = Boolean(cached.enabled[size]) && price !== null;
      if (price !== null) found = true;
    });
    if (!found) return;
    state.pricing.fetchedAt = Number(cached.fetchedAt) || 0;
    state.pricing.serviceUpdatedAt = String(cached.serviceUpdatedAt || "");
    state.pricing.source = "cache";
  } catch (_) {
    // Ignore missing or damaged non-sensitive price cache.
  }
}

function savePricingCache() {
  try {
    localStorage.setItem(PRICING_STORAGE, JSON.stringify({
      model: selectedApiModel(),
      prices: state.pricing.prices,
      enabled: state.pricing.enabled,
      fetchedAt: state.pricing.fetchedAt,
      serviceUpdatedAt: state.pricing.serviceUpdatedAt
    }));
  } catch (_) {
    // Price caching is optional; live verification still runs before generation.
  }
}

async function fetchPricingSnapshot(modelConfig) {
  const model = modelConfig || getSelectedModelConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICING_TIMEOUT_MS);
  try {
    const pricingUrl = `${API_CONFIG.pricingEndpoint}?_=${Date.now()}`;
    const response = await limitedFetch(pricingUrl, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal
    });
    const rawBuffer = await readBoundedResponse(response, API_CONFIG.maxPricingBytes, "价格响应");
    const raw = utf8BytesToString(new Uint8Array(rawBuffer));
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (_) {
      throw new Error("实时价格接口返回了无法解析的内容");
    }
    if (!response.ok) throw new Error(`实时价格接口请求失败（HTTP ${response.status}）`);
    const snapshot = extractPricingSnapshot(payload, model.pricingModel, PRICING_SIZES);
    if (!snapshot) throw new Error(`实时价格中没有找到 ${model.shortLabel}`);
    if (!PRICING_SIZES.some((size) => snapshot.enabled[size])) {
      throw new Error(`${model.shortLabel} 当前没有可用的实时价格`);
    }
    return { ...snapshot, apiModel: model.apiModel };
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("实时价格核对超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshLivePricing(reason) {
  const model = getSelectedModelConfig();
  const modelAtStart = model.apiModel;
  if (modelProvider(model) === "volc") {
    state.pricing.checking = false;
    state.pricing.source = "live";
    state.pricing.error = "";
    state.pricing.fetchedAt = Date.now();
    state.pricing.prices = { "1K": VOLC_PRICES["1K"], "1.5K": VOLC_PRICES["1.5K"], "2K": VOLC_PRICES["2K"], "4K": null };
    state.pricing.enabled = { "1K": true, "1.5K": true, "2K": true, "4K": false };
    renderPricing();
    updateControls();
    return { ok: true, volc: true, model: modelAtStart };
  }
  if (pricingRequest) {
    const activeRequest = pricingRequest;
    const activeResult = await activeRequest.promise;
    if (activeRequest.model === modelAtStart) return activeResult;
    if (selectedApiModel() !== modelAtStart) {
      return { ok: false, stale: true, reason: reason || "refresh", model: modelAtStart };
    }
    return await refreshLivePricing(reason);
  }
  state.pricing.checking = true;
  renderPricing();
  updateControls();

  const requestPromise = (async () => {
    try {
      const snapshot = await fetchPricingSnapshot(model);
      if (selectedApiModel() !== modelAtStart) {
        return { ok: false, stale: true, reason: reason || "refresh", model: modelAtStart };
      }
      const detectedChanges = {};
      PRICING_SIZES.forEach((size) => {
        const before = normalizePriceValue(state.pricing.prices[size]);
        const after = normalizePriceValue(snapshot.prices[size]);
        if (before !== null && after !== null && Math.abs(before - after) > 0.000001) {
          const change = { before, after, detectedAt: Date.now() };
          detectedChanges[size] = change;
          state.pricing.changes[size] = change;
          const pending = state.pricing.unacknowledgedIncreases[size];
          if (after > before) {
            state.pricing.unacknowledgedIncreases[size] = {
              before: pending ? pending.before : before,
              after,
              detectedAt: Date.now()
            };
          } else if (pending && after > pending.before) {
            state.pricing.unacknowledgedIncreases[size] = {
              before: pending.before,
              after,
              detectedAt: Date.now()
            };
          } else {
            delete state.pricing.unacknowledgedIncreases[size];
          }
        }
      });
      state.pricing.prices = snapshot.prices;
      state.pricing.enabled = snapshot.enabled;
      state.pricing.serviceUpdatedAt = snapshot.serviceUpdatedAt;
      state.pricing.fetchedAt = Date.now();
      state.pricing.source = "live";
      state.pricing.error = "";
      savePricingCache();
      return { ok: true, reason: reason || "refresh", changes: detectedChanges, model: modelAtStart };
    } catch (error) {
      if (selectedApiModel() !== modelAtStart) {
        return { ok: false, stale: true, reason: reason || "refresh", model: modelAtStart };
      }
      state.pricing.error = sanitizeMessage(error && (error.message || error));
      state.pricing.source = hasUsablePricing() ? "cache" : "none";
      return { ok: false, reason: reason || "refresh", error: state.pricing.error, model: modelAtStart };
    }
  })();
  pricingRequest = { model: modelAtStart, promise: requestPromise };

  try {
    return await requestPromise;
  } finally {
    if (pricingRequest && pricingRequest.promise === requestPromise) pricingRequest = null;
    state.pricing.checking = false;
    renderPricing();
    updateControls();
  }
}

function pricingRunConfirmationKey() {
  return [
    selectedApiModel(),
    String(elements.resolution && elements.resolution.value || "1K"),
    String(getGenerationCount()),
    String(elements.aspectRatio && elements.aspectRatio.value || "auto")
  ].join("|");
}

async function verifyLivePricingBeforeRun() {
  if (modelProvider(getSelectedModelConfig()) === "volc") {
    const selectedSize = String(elements.resolution.value || "2K");
    const unitPrice = volcFixedPrice(selectedSize);
    return {
      ok: true,
      size: selectedSize,
      unitPrice,
      estimatedCost: unitPrice * getGenerationCount(),
      priceUnverified: false
    };
  }
  const selectedSize = String(elements.resolution.value || "1K");
  const refreshResult = await refreshLivePricing("run");
  if (!refreshResult.ok) {
    const confirmationKey = pricingRunConfirmationKey();
    const previous = state.pricingRunConfirmation;
    const confirmed = Boolean(
      previous && previous.key === confirmationKey &&
      Date.now() - Number(previous.createdAt || 0) <= PRICE_BYPASS_CONFIRM_MS
    );
    if (confirmed) {
      state.pricingRunConfirmation = null;
      const cachedPrice = normalizePriceValue(state.pricing.prices[selectedSize]);
      return {
        ok: true,
        size: selectedSize,
        unitPrice: cachedPrice,
        estimatedCost: cachedPrice === null ? null : cachedPrice * getGenerationCount(),
        priceUnverified: true,
        priceWarning: refreshResult.error || "当前无法查询实时价格"
      };
    }
    state.pricingRunConfirmation = { key: confirmationKey, createdAt: Date.now() };
    return {
      ok: false,
      title: "当前无法查询实时价格",
      detail: `${refreshResult.error || "价格接口暂不可用"}；本次未发送付费请求。确认继续时，请在 60 秒内再次点击“运行”`
    };
  }
  state.pricingRunConfirmation = null;
  const price = normalizePriceValue(state.pricing.prices[selectedSize]);
  if (!state.pricing.enabled[selectedSize] || price === null) {
    return {
      ok: false,
      title: `${selectedSize} 当前不可用`,
      detail: "价格页显示该规格已停用；本次未发送付费请求"
    };
  }
  const pendingIncrease = state.pricing.unacknowledgedIncreases[selectedSize];
  if (pendingIncrease) {
    delete state.pricing.unacknowledgedIncreases[selectedSize];
    renderPricing();
    return {
      ok: false,
      title: `${selectedSize} 单价已上涨`,
      detail: `${formatYuan(pendingIncrease.before)} → ${formatYuan(pendingIncrease.after)}；请确认预计费用后再次点击运行`
    };
  }
  return {
    ok: true,
    size: selectedSize,
    unitPrice: price,
    estimatedCost: price * getGenerationCount()
  };
}

function startPricingAutoRefresh() {
  if (pricingRefreshTimer !== null) clearInterval(pricingRefreshTimer);
  pricingRefreshTimer = setInterval(() => {
    refreshLivePricing("timer").catch(() => {});
  }, PRICING_REFRESH_MS);
}

function setResolvedDimensionsText(text) {
  if (elements.resolvedDimensions) elements.resolvedDimensions.textContent = String(text || "");
}

function updateResolvedSize() {
  renderPricing();
  const model = getSelectedModelConfig();
  const basis = outputBasis();
  const modelOutfitEnabled = state.activeWorkspace === "outfit" && state.activeCreativeTool === "outfit";
  const productEnabled = state.activeWorkspace === "outfit" && state.activeCreativeTool === "product";
  const ratioControl = productEnabled ? elements.productAspectRatio : elements.aspectRatio;
  const resolutionControl = productEnabled ? elements.productResolution : elements.resolution;
  const ratioValue = String(ratioControl && ratioControl.value || "auto");
  const resolutionValue = String(resolutionControl && resolutionControl.value || "1K");
  const autoRetouch = ratioValue === "auto";
  const workflowLabel = modelOutfitEnabled ? "模特换装" : (productEnabled ? "商品图" : (autoRetouch ? "修图" : "作图"));
  if (modelProvider(model) === "volc") {
    const displayRatio = ratioValue === "auto" ? "auto" : ratioValue;
    setResolvedDimensionsText(`${model.shortLabel} · ${workflowLabel} · ${displayRatio} · ${resolutionValue}`);
    setFitNotice(ratioValue === "auto"
      ? `自动匹配画面比例；火山直连的实际输出尺寸以生成结果为准`
      : `固定比例 ${ratioValue} 作图；火山直连的实际输出尺寸以生成结果为准`);
    return;
  }
  if (!basis) {
    setResolvedDimensionsText(`${model.shortLabel} · ${workflowLabel} · ${resolutionValue} · 等待参考图`);
    setFitNotice(autoRetouch
      ? `自动匹配画面比例${generationRequestNotice()}`
      : `固定比例作图${generationRequestNotice()}`);
    return;
  }

  try {
    const resolved = resolveModelOutputSize(
      ratioValue,
      resolutionValue,
      basis.bounds.width,
      basis.bounds.height,
      model
    );
    setResolvedDimensionsText(`${model.shortLabel} · ${modelOutfitEnabled ? "模特换装 · " : (productEnabled ? "商品图 · " : (resolved.automatic ? "修图 · " : "作图 · "))}${resolved.ratio} · ${resolved.size}`);
    const sourceRatio = basis.bounds.width / basis.bounds.height;
    const targetRatio = resolved.width / resolved.height;
    const mismatch = Math.abs(Math.log(sourceRatio / targetRatio));
    const fitMessage = autoRetouch
      ? (mismatch > 0.025
        ? "自动匹配；回填时等比覆盖并居中裁切"
        : "自动匹配；不会拉伸图像")
      : "固定比例作图";
    setFitNotice(`${fitMessage}${generationRequestNotice()}`);
  } catch (error) {
    setResolvedDimensionsText("尺寸错误");
    setFitNotice(sanitizeMessage(error.message));
  }
}

function getGenerationCount() {
  const value = Number(elements.generationCount.value);
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 1;
}

function expandSelectionContextBounds(bounds, documentWidth, documentHeight) {
  if (!bounds) return null;
  const ratio = { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 };
  const minimum = Math.max(12, Math.min(32, Math.round(Math.min(bounds.width, bounds.height) * 0.03)));
  const expanded = {
    left: bounds.left - Math.max(minimum, Math.round(bounds.width * ratio.left)),
    top: bounds.top - Math.max(minimum, Math.round(bounds.height * ratio.top)),
    right: bounds.right + Math.max(minimum, Math.round(bounds.width * ratio.right)),
    bottom: bounds.bottom + Math.max(minimum, Math.round(bounds.height * ratio.bottom))
  };
  return clampBounds(expanded, documentWidth, documentHeight) || bounds;
}

function normalizeOutfitType(value) {
  const type = String(value || "full");
  if (type === "upper") return "separates";
  if (type === "lower") return "separatesShoes";
  return ["full", "separates", "separatesShoes"].includes(type) ? type : "full";
}

function outfitSlotLabels(type = selectedOutfitType()) {
  return {
    full: ["模特全身服饰图"],
    separates: ["模特上衣图", "模特裤子/下装图"],
    separatesShoes: ["模特上衣图", "模特裤子/下装图", "模特鞋子图"]
  }[normalizeOutfitType(type)];
}

function selectedOutfitType() {
  const selected = document.querySelector('[role="radio"][data-outfit-mode].is-selected') ||
    document.querySelector('[role="radio"][data-outfit-mode][aria-checked="true"]');
  return normalizeOutfitType(selected && selected.getAttribute("data-outfit-mode") || state.outfitType);
}

function setSelectedOutfitType(value) {
  const type = normalizeOutfitType(value);
  document.querySelectorAll('[role="radio"][data-outfit-mode]').forEach((button) => {
    const selected = normalizeOutfitType(button.getAttribute("data-outfit-mode")) === type;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
  });
  state.outfitType = type;
  if (elements.outfitBackgroundOrdinal) {
    elements.outfitBackgroundOrdinal.textContent = `选填 · 生成时作为附图${outfitSlotLabels(type).length + 3}`;
  }
}

function buildLocalEditPrompt(userPrompt, snapshot, references) {
  const cleanPrompt = String(userPrompt || "").trim();
  if (!snapshot) return cleanPrompt;
  if (String(snapshot.localEditMode || "") === "outfit") {
    const selectionTarget = snapshot.mode === "selection";
    const type = normalizeOutfitType(snapshot.outfitType);
    const stylePrompt = String(snapshot.outfitPrompt || cleanPrompt || "").trim() || DEFAULT_OUTFIT_STYLE_PROMPT;
    const extraPrompt = String(snapshot.outfitExtraPrompt || "").trim() || DEFAULT_OUTFIT_EXTRA_PROMPT;
    const templates = {
      full: {
        mode: "模特全身服饰图(1张图)",
        backgroundOrdinal: 4,
        references: [
          "- [附图1:模特姿势图]：模特姿势、身体姿态、画面构图和基础场景参考。",
          "- [附图2:模特人脸图]：人物五官、人脸轮廓、肤色和辨识度参考。",
          "- [附图3:模特全身服饰图]：完整服饰造型参考，重点还原服装整体轮廓、颜色、材质、版型、纹理和上下身细节。"
        ]
      },
      separates: {
        mode: "模特上衣+裤子(2张图)",
        backgroundOrdinal: 5,
        references: [
          "- [附图1:模特姿势图]：模特姿势、身体姿态、画面构图和基础场景参考。",
          "- [附图2:模特人脸图]：人物五官、人脸轮廓、肤色和辨识度参考。",
          "- [附图3:模特上衣图]：上衣款式、颜色、材质、领口、袖型、图案和版型参考。",
          "- [附图4:模特裤子/下装图]：下装款式、颜色、材质、腰线、裤型/裙型、长度和褶皱细节参考。"
        ]
      },
      separatesShoes: {
        mode: "模特上衣+裤子+鞋子(3张图)",
        backgroundOrdinal: 6,
        references: [
          "- [附图1:模特姿势图]：模特姿势、身体姿态、画面构图和基础场景参考。",
          "- [附图2:模特人脸图]：人物五官、人脸轮廓、肤色和辨识度参考。",
          "- [附图3:模特上衣图]：上衣款式、颜色、材质、领口、袖型、图案和版型参考。",
          "- [附图4:模特裤子/下装图]：下装款式、颜色、材质、腰线、裤型/裙型、长度和褶皱细节参考。",
          "- [附图5:模特鞋子图]：鞋子款式、颜色、材质、鞋型、鞋跟高度和细节参考。"
        ]
      }
    };
    const baseTemplate = templates[type];
    const template = {
      ...baseTemplate,
      references: baseTemplate.references.slice()
    };
    const backgroundReference = Array.isArray(references)
      ? references.find((reference) => reference && reference.outfitRole === "background")
      : null;
    if (backgroundReference || snapshot.outfitBackgroundReferenceId) {
      template.references.push(`- [附图${template.backgroundOrdinal}:场景背景图]：完整的场景背景造型参考，重点还原场景或背景的细节。`);
    }
    const promptSections = [
      `请基于[附图1:模特姿势图]中的模特姿势、身体比例、构图和场景，换上[附图2:模特人脸图]中的人物人脸，并按“${template.mode}”方式穿上服饰参考图中的服装，生成一张专业电商模特换装图。`,
      `【参考图说明】\n${template.references.join("\n")}`,
      `【画面风格与电商要求】\n${stylePrompt}${backgroundReference || snapshot.outfitBackgroundReferenceId
        ? `\n场景和背景以[附图${template.backgroundOrdinal}:场景背景图]为参考，重点保持其空间结构、色调、光影和背景细节。`
        : ""}`,
      [
        "【核心要求】",
        "- 人脸必须自然融合到模特头部，五官特征清晰稳定，不能出现换脸痕迹。",
        `- 按“${template.mode}”方式处理服饰参考，服装和鞋履必须忠实还原对应参考图的颜色、材质、剪裁、图案和关键细节。`,
        "- 姿势和身体比例参考姿势图，动作自然，衣服褶皱与身体结构匹配。",
        "- 光影方向、色温、阴影和背景透视保持统一，整体像真实商业摄影。",
        "- 输出高清、干净、适合电商主图或详情页使用。"
      ].join("\n"),
      `【补充需求】\n${extraPrompt}`
    ];
    if (selectionTarget) {
      promptSections.push("【选区回填要求】\n仅修改附图1当前选区及必要衔接边缘；选区外、画布尺寸和主体位置保持不变。");
    }
    return promptSections.join("\n\n").slice(0, 20000);
  }
  if (String(snapshot.localEditMode || "") === "product") {
    const protection = [
      "商品图任务：图片一是必须完整保留的商品主体，其余图片仅用于场景、构图、光线或风格参考。",
      "不得改变商品外形、比例、颜色、材质、包装、商标、文字、图案和关键结构，不得增加或删除商品部件。",
      "不得把场景参考中的商品、人物或文字复制到结果中；商品边缘、接触阴影、透视和环境反射必须自然。",
      "输出只能包含一张完整成图，不要输出排版说明、对比图、分镜或水印。"
    ].join("");
    const separator = "\n\n";
    const allowedPromptLength = Math.max(0, 20000 - separator.length - protection.length);
    return `${cleanPrompt.slice(0, allowedPromptLength)}${separator}${protection}`;
  }
  if (snapshot.mode !== "selection") return cleanPrompt;
  const protection = [
    "局部编辑要求：只完成用户要求的局部修改。",
    "图片中包含选区周围的衔接参考，请保持周围参考像素的构图、位置、光线和纹理稳定。",
    "不得移动主体，不得改变画面尺寸，不得重画选区外内容；选区边缘需要与原图自然连续。"
  ].join("");
  const separator = "\n\n";
  const allowedPromptLength = Math.max(0, 20000 - separator.length - protection.length);
  return `${cleanPrompt.slice(0, allowedPromptLength)}${separator}${protection}`;
}

function generationRequestNotice() {
  const productActive = state.activeWorkspace === "outfit" && state.activeCreativeTool === "product";
  const count = productActive
    ? Math.max(1, Math.min(4, Number(elements.productGenerationCount && elements.productGenerationCount.value) || 1))
    : getGenerationCount();
  return count > 1 ? `；${count} 张并发 ${count} 次请求` : "";
}

function maskFeatherRadius(value = elements.settingsMaskFeatherRadius.value) {
  const number = Number(value);
  return value === "" || value == null || !Number.isFinite(number)
    ? 50 : Math.max(0, Math.min(500, Math.round(number)));
}

function syncMaskFeatherSetting() {
  const radius = maskFeatherRadius();
  elements.settingsMaskFeatherRadius.value = String(radius);
  if (elements.maskFeatherControl) {
    elements.maskFeatherControl.title = `羽化蒙版：${radius}px，可在设置中修改`;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE, JSON.stringify({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      model: selectedApiModel(),
      aspectRatio: elements.aspectRatio.value,
      resolution: elements.resolution.value,
      generationCount: getGenerationCount(),
      precisionPlacement: elements.precisionPlacement.checked,
      maskFeatherRadius: maskFeatherRadius(),
      maskFeatherEnabled: elements.maskFeatherEnabled.checked,
      favoritePrompts: state.favoritePrompts,
      outfit: {
        type: selectedOutfitType(),
        prompt: String(elements.outfitPrompt && elements.outfitPrompt.value || DEFAULT_OUTFIT_STYLE_PROMPT).slice(0, 20000),
        extraPrompt: String(elements.outfitExtraPrompt && elements.outfitExtraPrompt.value || DEFAULT_OUTFIT_EXTRA_PROMPT).slice(0, 20000)
      },
      product: {
        ...readProductDraft(),
        aspectRatio: String(elements.productAspectRatio && elements.productAspectRatio.value || "1:1"),
        resolution: String(elements.productResolution && elements.productResolution.value || "1K"),
        generationCount: Number(elements.productGenerationCount && elements.productGenerationCount.value) || 1
      }
    }));
  } catch (_) {
    // Non-sensitive preferences are optional.
  }
}

function loadSettings() {
  let defaultModelMigrated = false;
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) || "{}");
    if (Number(settings.schemaVersion) >= 7 && settings.model && elements.modelChannel.querySelector(`option[value="${settings.model}"]`)) {
      elements.modelChannel.value = settings.model;
    } else {
      elements.modelChannel.value = API_CONFIG.model;
      defaultModelMigrated = true;
    }
    if (settings.aspectRatio && elements.aspectRatio.querySelector(`option[value="${settings.aspectRatio}"]`)) {
      elements.aspectRatio.value = settings.aspectRatio;
    }
    if (
      Number(settings.schemaVersion) >= 5 &&
      ["1K", "1.5K", "2K", "4K"].includes(settings.resolution)
    ) {
      syncResolutionOptions(elements.resolution, getSelectedModelConfig(), settings.resolution);
    }
    if ([1, 2, 3, 4].includes(Number(settings.generationCount))) {
      elements.generationCount.value = String(settings.generationCount);
    }
    if (typeof settings.precisionPlacement === "boolean") {
      elements.precisionPlacement.checked = settings.precisionPlacement;
    }
    elements.settingsMaskFeatherRadius.value = String(maskFeatherRadius(settings.maskFeatherRadius));
    elements.maskFeatherEnabled.checked = settings.maskFeatherEnabled !== false;
    syncMaskFeatherSetting();
    state.favoritePrompts = normalizePromptList(settings.favoritePrompts, MAX_FAVORITE_PROMPTS);
    if (settings.outfit && typeof settings.outfit === "object") {
      setSelectedOutfitType(settings.outfit.type);
      if (elements.outfitPrompt) {
        elements.outfitPrompt.value = String(settings.outfit.prompt || DEFAULT_OUTFIT_STYLE_PROMPT).slice(0, 20000);
      }
      if (elements.outfitExtraPrompt) {
        elements.outfitExtraPrompt.value = String(settings.outfit.extraPrompt || DEFAULT_OUTFIT_EXTRA_PROMPT).slice(0, 20000);
      }
    } else {
      setSelectedOutfitType(state.outfitType);
    }
    if (settings.product && typeof settings.product === "object") {
      applyProductDraft(settings.product);
      if (
        elements.productAspectRatio && settings.product.aspectRatio &&
        elements.productAspectRatio.querySelector(`option[value="${settings.product.aspectRatio}"]`)
      ) {
        elements.productAspectRatio.value = settings.product.aspectRatio;
      }
      if (elements.productResolution && ["1K", "1.5K", "2K", "4K"].includes(settings.product.resolution)) {
        syncResolutionOptions(elements.productResolution, getSelectedModelConfig(), settings.product.resolution);
      }
      if (elements.productGenerationCount && [1, 2, 3, 4].includes(Number(settings.product.generationCount))) {
        elements.productGenerationCount.value = String(settings.product.generationCount);
      }
    } else {
      applyProductDraft(DEFAULT_PRODUCT_DRAFT);
    }
    // Product reference files are restored from task history, not localStorage.
    // Clear stale IDs from an earlier session while retaining the draft fields.
    state.productReferenceIds = { main: "", scene: "" };
  } catch (_) {
    // Use defaults when preferences were cleared or corrupted.
  }
  if (elements.outfitPrompt && !String(elements.outfitPrompt.value || "").trim()) {
    elements.outfitPrompt.value = DEFAULT_OUTFIT_STYLE_PROMPT;
  }
  if (elements.outfitExtraPrompt && !String(elements.outfitExtraPrompt.value || "").trim()) {
    elements.outfitExtraPrompt.value = DEFAULT_OUTFIT_EXTRA_PROMPT;
  }
  setSelectedOutfitType(state.outfitType);
  syncModelCapabilities();
  syncIslandSelects();
  renderPromptLibrary();
  renderProductWorkspace();
  if (defaultModelMigrated) saveSettings();
}

function safeStorageFileName(value) {
  const name = String(value || "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,220}$/.test(name) ? name : "";
}

function storageBounds(bounds) {
  if (!bounds) return null;
  const left = Number(bounds.left) || 0;
  const top = Number(bounds.top) || 0;
  const right = Number.isFinite(Number(bounds.right)) ? Number(bounds.right) : left + (Number(bounds.width) || 0);
  const bottom = Number.isFinite(Number(bounds.bottom)) ? Number(bounds.bottom) : top + (Number(bounds.height) || 0);
  return {
    left,
    top,
    right,
    bottom,
    // Photoshop can return stale width/height fields after a selection or
    // layer transform. The edges are the authoritative rectangle.
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function serializeSnapshot(snapshot, maskFileName) {
  if (!snapshot) return null;
  let mask = null;
  if (snapshot.mask) {
    mask = {
      fileName: safeStorageFileName(maskFileName),
      width: Number(snapshot.mask.width) || 0,
      height: Number(snapshot.mask.height) || 0,
      bounds: storageBounds(snapshot.mask.bounds)
    };
  } else if (snapshot.maskUnavailable && snapshot.persistedMask) {
    mask = {
      fileName: safeStorageFileName(snapshot.persistedMask.fileName),
      width: Number(snapshot.persistedMask.width) || 0,
      height: Number(snapshot.persistedMask.height) || 0,
      bounds: storageBounds(snapshot.persistedMask.bounds)
    };
  }
  return {
    id: String(snapshot.id || ""),
    sourceReferenceId: String(snapshot.sourceReferenceId || ""),
    mode: String(snapshot.mode || "import"),
    documentId: snapshot.documentId === null || snapshot.documentId === undefined
      ? null
      : Number(snapshot.documentId),
    documentTitle: String(snapshot.documentTitle || ""),
    documentWidth: Number(snapshot.documentWidth) || 0,
    documentHeight: Number(snapshot.documentHeight) || 0,
    documentResolution: Number(snapshot.documentResolution) || 72,
    documentMode: snapshot.documentMode === undefined ? null : snapshot.documentMode,
    bounds: storageBounds(snapshot.bounds),
    sourcePixelWidth: Number(snapshot.sourcePixelWidth) || 0,
    sourcePixelHeight: Number(snapshot.sourcePixelHeight) || 0,
    editBounds: storageBounds(snapshot.editBounds),
    localEditMode: LOCAL_EDIT_MODES.includes(String(snapshot.localEditMode || ""))
      ? String(snapshot.localEditMode)
      : "",
    outfitType: String(snapshot.localEditMode || "") === "outfit"
      ? normalizeOutfitType(snapshot.outfitType)
      : "",
    outfitFaceReferenceId: String(snapshot.outfitFaceReferenceId || ""),
    outfitBackgroundReferenceId: String(snapshot.outfitBackgroundReferenceId || ""),
    outfitGarmentReferenceIds: Array.isArray(snapshot.outfitGarmentReferenceIds)
      ? snapshot.outfitGarmentReferenceIds.slice(0, 3).map((referenceId) => String(referenceId || ""))
      : [],
    product: String(snapshot.localEditMode || "") === "product"
      ? normalizeProductDraft(snapshot.product)
      : null,
    solid: Boolean(snapshot.solid),
    mask,
    layerId: snapshot.layerId === null || snapshot.layerId === undefined ? null : Number(snapshot.layerId),
    layerName: String(snapshot.layerName || ""),
    insertionAnchorLayerId: snapshot.insertionAnchorLayerId === null || snapshot.insertionAnchorLayerId === undefined
      ? null
      : Number(snapshot.insertionAnchorLayerId),
    insertionAnchorLayerName: String(snapshot.insertionAnchorLayerName || ""),
    insertionAnchorParentId: snapshot.insertionAnchorParentId === null || snapshot.insertionAnchorParentId === undefined
      ? null
      : Number(snapshot.insertionAnchorParentId),
    capturedAt: new Date(snapshot.capturedAt || Date.now()).toISOString()
  };
}

function deserializeSnapshot(value, maskBytes, maskUnavailable) {
  if (!value || !value.bounds) return null;
  const bounds = storageBounds(value.bounds);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const persistedMask = value.mask ? {
    fileName: safeStorageFileName(value.mask.fileName),
    width: Number(value.mask.width) || 0,
    height: Number(value.mask.height) || 0,
    bounds: storageBounds(value.mask.bounds)
  } : null;
  const mask = persistedMask && maskBytes ? {
    bytes: maskBytes,
    width: persistedMask.width,
    height: persistedMask.height,
    bounds: persistedMask.bounds
  } : null;
  return {
    id: String(value.id || ""),
    sourceReferenceId: String(value.sourceReferenceId || ""),
    mode: String(value.mode || "import"),
    documentId: value.documentId === null || value.documentId === undefined ? null : Number(value.documentId),
    documentTitle: String(value.documentTitle || ""),
    documentWidth: Number(value.documentWidth) || 0,
    documentHeight: Number(value.documentHeight) || 0,
    documentResolution: Number(value.documentResolution) || 72,
    documentMode: value.documentMode === undefined ? null : value.documentMode,
    bounds,
    sourcePixelWidth: Number(value.sourcePixelWidth) || 0,
    sourcePixelHeight: Number(value.sourcePixelHeight) || 0,
    editBounds: storageBounds(value.editBounds),
    localEditMode: LOCAL_EDIT_MODES.includes(String(value.localEditMode || ""))
      ? String(value.localEditMode)
      : "",
    outfitType: String(value.localEditMode || "") === "outfit"
      ? normalizeOutfitType(value.outfitType)
      : "",
    outfitFaceReferenceId: String(value.outfitFaceReferenceId || ""),
    outfitBackgroundReferenceId: String(value.outfitBackgroundReferenceId || ""),
    outfitGarmentReferenceIds: Array.isArray(value.outfitGarmentReferenceIds)
      ? value.outfitGarmentReferenceIds.slice(0, 3).map((referenceId) => String(referenceId || ""))
      : [],
    product: String(value.localEditMode || "") === "product"
      ? normalizeProductDraft(value.product)
      : null,
    solid: Boolean(value.solid),
    mask,
    maskUnavailable: Boolean(persistedMask && maskUnavailable),
    persistedMask,
    layerId: value.layerId === null || value.layerId === undefined ? null : Number(value.layerId),
    layerName: String(value.layerName || ""),
    insertionAnchorLayerId: value.insertionAnchorLayerId === null || value.insertionAnchorLayerId === undefined
      ? null
      : Number(value.insertionAnchorLayerId),
    insertionAnchorLayerName: String(value.insertionAnchorLayerName || ""),
    insertionAnchorParentId: value.insertionAnchorParentId === null || value.insertionAnchorParentId === undefined
      ? null
      : Number(value.insertionAnchorParentId),
    capturedAt: new Date(value.capturedAt || Date.now())
  };
}

async function getFolderEntrySafely(folder, fileName) {
  const safeName = safeStorageFileName(fileName);
  if (!folder || !safeName) return null;
  try {
    return await folder.getEntry(safeName);
  } catch (_) {
    return null;
  }
}

async function getPersistentHistoryFolder() {
  if (!persistentHistoryFolderPromise) {
    persistentHistoryFolderPromise = (async () => {
      const dataFolder = await localFileSystem.getDataFolder();
      const existing = await getFolderEntrySafely(dataFolder, PERSISTENT_HISTORY_FOLDER);
      return existing || await dataFolder.createFolder(PERSISTENT_HISTORY_FOLDER);
    })().catch((error) => {
      persistentHistoryFolderPromise = null;
      throw error;
    });
  }
  return await persistentHistoryFolderPromise;
}

function snapshotMaskBytes(snapshot) {
  if (!snapshot || !snapshot.mask || !snapshot.mask.bytes) return null;
  const source = snapshot.mask.bytes;
  if (source instanceof Uint8Array) {
    const owned = new Uint8Array(source.byteLength);
    owned.set(source);
    return owned;
  }
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  if (ArrayBuffer.isView(source)) {
    const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const owned = new Uint8Array(view.byteLength);
    owned.set(view);
    return owned;
  }
  return null;
}

async function writeSnapshotMask(folder, snapshot, fileName) {
  const bytes = snapshotMaskBytes(snapshot);
  if (!bytes) return null;
  const safeName = safeStorageFileName(fileName);
  if (!safeName) throw new Error("无法建立选区蒙版保存文件");
  const expected = (Number(snapshot.mask.width) || 0) * (Number(snapshot.mask.height) || 0);
  if (!(expected > 0) || bytes.byteLength !== expected) {
    throw new Error("选区蒙版数据不完整，无法保存生成历史");
  }
  const file = await folder.createFile(safeName, { overwrite: true });
  await file.write(exactArrayBuffer(bytes), { format: formats.binary });
  return file;
}

async function ensureSnapshotMaskStored(owner, prefix) {
  if (!owner || !owner.snapshot || !owner.snapshot.mask) return null;
  if (owner.maskFile && owner.maskFileName) return owner.maskFile;
  const folder = await getPersistentHistoryFolder();
  const safeId = String(owner.id || Date.now()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120) || String(Date.now());
  owner.maskFileName = safeStorageFileName(owner.maskFileName) || `${prefix}-mask-${safeId}.bin`;
  owner.maskFile = await writeSnapshotMask(folder, owner.snapshot, owner.maskFileName);
  return owner.maskFile;
}

async function loadSnapshotMask(folder, maskRecord) {
  if (!maskRecord) return { bytes: null, file: null, fileName: "", unavailable: false };
  const fileName = safeStorageFileName(maskRecord.fileName);
  const width = Number(maskRecord.width) || 0;
  const height = Number(maskRecord.height) || 0;
  if (!fileName || !(width > 0) || !(height > 0)) {
    return { bytes: null, file: null, fileName, unavailable: true };
  }
  const file = await getFolderEntrySafely(folder, fileName);
  if (!file) return { bytes: null, file: null, fileName, unavailable: true };
  try {
    const raw = await file.read({ format: formats.binary });
    const view = new Uint8Array(exactArrayBuffer(raw));
    if (view.byteLength !== width * height) {
      return { bytes: null, file, fileName, unavailable: true };
    }
    const bytes = new Uint8Array(view.byteLength);
    bytes.set(view);
    return { bytes, file, fileName, unavailable: false };
  } catch (_) {
    return { bytes: null, file, fileName, unavailable: true };
  }
}

async function loadSerializedSnapshot(folder, value) {
  const loadedMask = await loadSnapshotMask(folder, value && value.mask);
  return {
    snapshot: deserializeSnapshot(value, loadedMask.bytes, loadedMask.unavailable),
    maskFile: loadedMask.file,
    maskFileName: loadedMask.fileName
  };
}

function serializeTaskArchive(taskArchive, result) {
  if (!taskArchive) return null;
  const references = Array.isArray(taskArchive.references)
    ? taskArchive.references.map((reference) => ({
      id: String(reference && reference.id || ""),
      mode: String(reference && reference.mode || reference && reference.snapshot && reference.snapshot.mode || "import"),
      role: String(reference && reference.outfitRole || ""),
      productRole: ["main", "scene"].includes(String(reference && reference.productRole || ""))
        ? String(reference.productRole)
        : "",
      slotIndex: Number.isInteger(Number(reference && reference.outfitSlotIndex))
        ? Number(reference.outfitSlotIndex)
        : null,
      layerName: String(reference && reference.layerName || reference && reference.snapshot && reference.snapshot.layerName || ""),
      fileName: safeStorageFileName(reference && reference.persistentTaskFileName),
      mime: String(reference && reference.mime || "image/jpeg"),
      snapshot: serializeSnapshot(reference && reference.snapshot, "")
    })).filter((reference) => reference.snapshot)
    : [];
  return {
    id: String(taskArchive.id || ""),
    sequence: Number(taskArchive.sequence) || Number(result && result.sequence) || 0,
    prompt: String(taskArchive.prompt || result && result.prompt || "").slice(0, 20000),
    promptOptimized: Boolean(taskArchive.promptOptimized),
    model: String(taskArchive.model || taskArchive.requested && taskArchive.requested.model || ""),
    modelLabel: String(taskArchive.modelLabel || ""),
    requested: taskArchive.requested || result && result.requested || null,
    generationCount: Number(taskArchive.generationCount) || 1,
    aspectRatio: String(taskArchive.aspectRatio || "auto"),
    resolution: String(taskArchive.resolution || taskArchive.requested && taskArchive.requested.resolution || "1K"),
    precisionPlacement: Boolean(taskArchive.precisionPlacement),
    outfitPrompt: String(taskArchive.outfitPrompt || "").slice(0, 20000),
    outfitExtraPrompt: String(taskArchive.outfitExtraPrompt || "").slice(0, 20000),
    product: String(taskArchive.localEditMode || "") === "product"
      ? normalizeProductDraft(taskArchive.product)
      : null,
    localEditMode: LOCAL_EDIT_MODES.includes(String(taskArchive.localEditMode || ""))
      ? String(taskArchive.localEditMode)
      : "general",
    outfitType: String(taskArchive.localEditMode || "") === "outfit"
      ? normalizeOutfitType(taskArchive.outfitType || taskArchive.snapshot && taskArchive.snapshot.outfitType)
      : "",
    outfitBackgroundReferenceId: String(taskArchive.outfitBackgroundReferenceId || taskArchive.snapshot && taskArchive.snapshot.outfitBackgroundReferenceId || ""),
    createdAt: new Date(taskArchive.createdAt || result && result.createdAt || Date.now()).toISOString(),
    snapshot: serializeSnapshot(taskArchive.snapshot || result && result.snapshot, result && result.maskFileName),
    references
  };
}

function archivedReferenceDescriptor(value, resultSnapshot) {
  const storedSnapshot = value && value.snapshot
    ? deserializeSnapshot(value.snapshot, null, Boolean(value.snapshot.mask))
    : null;
  const snapshot = storedSnapshot && resultSnapshot && (
    String(storedSnapshot.sourceReferenceId || "") === String(resultSnapshot.sourceReferenceId || "")
  ) ? resultSnapshot : storedSnapshot;
  if (!snapshot) return null;
  return {
    id: String(value && value.id || snapshot.sourceReferenceId || `archived-ref-${Date.now()}`),
    mode: String(value && value.mode || snapshot.mode || "import"),
    file: null,
    mime: String(value && value.mime || "image/jpeg"),
    previewUrl: null,
    bounds: snapshot.bounds,
    snapshot,
    layerName: String(value && value.layerName || snapshot.layerName || ""),
    outfitRole: String(value && value.role || ""),
    productRole: ["main", "scene"].includes(String(value && value.productRole || ""))
      ? String(value.productRole)
      : "",
    outfitSlotIndex: value && value.slotIndex !== null && value.slotIndex !== undefined
      ? Number(value.slotIndex)
      : null,
    capturedAt: snapshot.capturedAt,
    inReferenceList: false,
    resultOwners: 0,
    released: false,
    requiresRecapture: true
  };
}

function fallbackTaskArchive(result) {
  if (!result || !result.snapshot) return null;
  const requested = result.requested || {};
  const snapshot = result.snapshot;
  const reference = hasPhotoshopDocument(snapshot)
    ? archivedReferenceDescriptor({
      id: snapshot.sourceReferenceId,
      mode: snapshot.mode,
      layerName: snapshot.layerName,
      snapshot: serializeSnapshot(snapshot, result.maskFileName)
    }, snapshot)
    : null;
  const references = reference ? [reference] : [];
  if (reference && String(snapshot.localEditMode || "") === "product") {
    reference.productRole = "main";
  }
  if (reference && String(snapshot.localEditMode || "") === "outfit") {
    reference.outfitRole = "target";
    reference.outfitSlotIndex = -1;
  }
  const localEditMode = LOCAL_EDIT_MODES.includes(String(snapshot.localEditMode || ""))
    ? String(snapshot.localEditMode)
    : "general";
  const fallbackProduct = localEditMode === "product"
    ? normalizeProductDraft(snapshot.product || { extraPrompt: result.prompt || "" })
    : null;
  return {
    id: String(result.sourceJobId || `history-${result.id}`),
    sequence: Number(result.sequence) || 0,
    prompt: String(result.prompt || ""),
    promptOptimized: false,
    model: String(requested.model || API_CONFIG.model),
    modelLabel: String(requested.modelLabel || ""),
    snapshot,
    references: reference ? [reference] : [],
    requested,
    generationCount: Math.max(1, Math.min(4, Number(requested.generationCount || requested.n || result.count) || 1)),
    aspectRatio: String(requested.aspectRatio || "auto"),
    resolution: String(requested.resolution || "1K"),
    precisionPlacement: hasPhotoshopTarget(snapshot),
    outfitPrompt: "",
    outfitExtraPrompt: "",
    product: fallbackProduct,
    localEditMode,
    outfitType: String(snapshot.localEditMode || "") === "outfit"
      ? normalizeOutfitType(snapshot.outfitType)
      : "",
    outfitBackgroundReferenceId: String(snapshot.outfitBackgroundReferenceId || ""),
    createdAt: result.createdAt,
    historyOwners: 0,
    reconstructed: !references.length || references.some((reference) => !reference.file)
  };
}

async function deserializeTaskArchive(folder, value, result) {
  if (!value || !result) return fallbackTaskArchive(result);
  const resultSnapshot = result.snapshot;
  const references = [];
  if (Array.isArray(value.references)) {
    for (const storedReference of value.references) {
      const reference = archivedReferenceDescriptor(storedReference, resultSnapshot);
      if (!reference) continue;
      const fileName = safeStorageFileName(storedReference && storedReference.fileName);
      const file = await getFolderEntrySafely(folder, fileName);
      if (file) {
        reference.file = file;
        reference.persistentTaskFile = file;
        reference.persistentTaskFileName = fileName;
        reference.requiresRecapture = false;
        reference.preserveFile = true;
        await createReferencePreview(reference);
      }
      references.push(reference);
    }
  }
  if (!references.length && hasPhotoshopDocument(resultSnapshot)) {
    const fallback = fallbackTaskArchive(result);
    if (fallback) references.push(...fallback.references);
  }
  return {
    id: String(value.id || result.sourceJobId || `history-${result.id}`),
    sequence: Number(value.sequence) || Number(result.sequence) || 0,
    prompt: String(value.prompt || result.prompt || ""),
    promptOptimized: Boolean(value.promptOptimized),
    model: String(value.model || value.requested && value.requested.model || result.requested && result.requested.model || API_CONFIG.model),
    modelLabel: String(value.modelLabel || value.requested && value.requested.modelLabel || ""),
    snapshot: resultSnapshot,
    references,
    requested: value.requested || result.requested || null,
    generationCount: Math.max(1, Math.min(4, Number(value.generationCount) || 1)),
    aspectRatio: String(value.aspectRatio || "auto"),
    resolution: String(value.resolution || value.requested && value.requested.resolution || "1K"),
    precisionPlacement: typeof value.precisionPlacement === "boolean"
      ? value.precisionPlacement
      : hasPhotoshopTarget(resultSnapshot),
    outfitPrompt: String(value.outfitPrompt || "").slice(0, 20000),
    outfitExtraPrompt: String(value.outfitExtraPrompt || "").slice(0, 20000),
    product: String(value.localEditMode || "") === "product"
      ? normalizeProductDraft(value.product || { extraPrompt: value.prompt || result.prompt || "" })
      : null,
    localEditMode: LOCAL_EDIT_MODES.includes(String(value.localEditMode || ""))
      ? String(value.localEditMode)
      : "general",
    outfitType: String(value.localEditMode || "") === "outfit"
      ? normalizeOutfitType(value.outfitType || resultSnapshot && resultSnapshot.outfitType)
      : "",
    outfitBackgroundReferenceId: String(value.outfitBackgroundReferenceId || resultSnapshot && resultSnapshot.outfitBackgroundReferenceId || ""),
    createdAt: new Date(value.createdAt || result.createdAt || Date.now()),
    historyOwners: 0,
    reconstructed: true
  };
}

function ensureResultTaskArchive(result) {
  if (!result) return null;
  if (!result.taskArchive) result.taskArchive = fallbackTaskArchive(result);
  return result.taskArchive;
}

function serializePersistentResult(result) {
  return {
    id: String(result.id || ""),
    sequence: Number(result.sequence) || 0,
    fileName: safeStorageFileName(result.storageFileName || (result.file && result.file.name)),
    mime: String(result.mime || ""),
    extension: String(result.extension || ""),
    byteLength: Number(result.byteLength) || 0,
    width: Number(result.width) || 0,
    height: Number(result.height) || 0,
    count: Number(result.count) || 1,
    prompt: String(result.prompt || "").slice(0, 20000),
    requestPrompt: String(result.requestPrompt || result.prompt || "").slice(0, 20000),
    requested: result.requested || null,
    createdAt: new Date(result.createdAt || Date.now()).toISOString(),
    insertedAt: result.insertedAt ? new Date(result.insertedAt).toISOString() : null,
    precisePlacement: typeof result.precisePlacement === "boolean" ? result.precisePlacement : null,
    imageFingerprint: String(result.imageFingerprint || ""),
    recoveredFromHistory: Boolean(result.recoveredFromHistory),
    historyRecordKey: String(result.historyRecordKey || ""),
    sourceJobId: String(result.sourceJobId || ""),
    snapshot: serializeSnapshot(result.snapshot, result.maskFileName),
    taskArchive: serializeTaskArchive(result.taskArchive, result)
  };
}

function serializePendingHistoryTask(task) {
  return {
    id: String(task.id || ""),
    sequence: Number(task.sequence) || 0,
    prompt: String(task.prompt || "").slice(0, 20000),
    requestPrompt: String(task.requestPrompt || task.prompt || "").slice(0, 20000),
    model: String(task.model || task.requested && task.requested.model || API_CONFIG.model),
    requested: task.requested || null,
    requestedCount: Number(task.requestedCount) || 1,
    submittedCount: Number(task.submittedCount) || 0,
    resolvedCount: Number(task.resolvedCount) || 0,
    knownFailedCount: Number(task.knownFailedCount) || 0,
    apiKeyFingerprint: String(task.apiKeyFingerprint || ""),
    asyncTasks: Array.isArray(task.asyncTasks) ? task.asyncTasks.map((entry) => ({
      requestIndex: Math.max(0, Number(entry && entry.requestIndex) || 0),
      id: String(entry && entry.id || ""),
      taskIds: Array.isArray(entry && entry.taskIds) ? entry.taskIds.map(String).filter(Boolean) : [],
      statusUrl: String(entry && entry.statusUrl || ""),
      status: String(entry && entry.status || "queued"),
      submittedAt: Math.max(0, Number(entry && entry.submittedAt) || 0),
      lastCheckedAt: Math.max(0, Number(entry && entry.lastCheckedAt) || 0),
      pollElapsedMs: Math.max(0, Number(entry && entry.pollElapsedMs) || 0),
      resolved: Boolean(entry && entry.resolved),
      failed: Boolean(entry && entry.failed)
    })) : [],
    aspectRatio: String(task.aspectRatio || "auto"),
    resolution: String(task.resolution || "1K"),
    precisionPlacement: Boolean(task.precisionPlacement),
    localEditMode: LOCAL_EDIT_MODES.includes(String(task.localEditMode || ""))
      ? String(task.localEditMode)
      : "general",
    recoveryRevision: PENDING_HISTORY_RECOVERY_REVISION,
    autoRecoveryExhausted: false,
    autoRecoveryStartedAt: 0,
    recoveryElapsedMs: 0,
    createdAt: new Date(task.createdAt || Date.now()).toISOString(),
    historyBaselineKeys: Array.from(task.historyBaselineKeys || []).map(String),
    recoveredHistoryKeys: Array.from(task.recoveredHistoryKeys || []).map(String),
    snapshot: serializeSnapshot(task.snapshot, task.maskFileName),
    taskArchive: serializeTaskArchive(task.taskArchive, task)
  };
}

function pendingHistoryOutstandingCount(task) {
  if (!task) return 0;
  const submitted = Math.max(0, Math.min(Number(task.requestedCount) || 0, Number(task.submittedCount) || 0));
  const entries = Array.isArray(task.asyncTasks) ? task.asyncTasks : [];
  const resolvedEntries = new Set(entries.filter((entry) => entry && entry.resolved).map((entry) => Number(entry.requestIndex) || 0)).size;
  const failedEntries = new Set(entries.filter((entry) => entry && entry.failed && !entry.resolved).map((entry) => Number(entry.requestIndex) || 0)).size;
  const resolved = Math.max(0, Number(task.resolvedCount) || 0, resolvedEntries);
  const knownFailed = Math.max(0, Number(task.knownFailedCount) || 0, failedEntries);
  return Math.max(0, submitted - resolved - knownFailed);
}

function reconcilePendingAsyncTaskResolution(task, loadedResults) {
  if (!task || !Array.isArray(task.asyncTasks)) return false;
  const results = Array.isArray(loadedResults) ? loadedResults : [];
  const taskResults = results.filter((result) => (
    String(result.sourceJobId || "") === String(task.id || "")
  ));
  let changed = false;
  let confirmedResolved = 0;
  task.asyncTasks.forEach((entry) => {
    if (!entry || entry.failed) return;
    const hasStoredResult = taskResults.some((result) => resultMatchesAsyncEntry(result, entry));
    if (hasStoredResult) {
      confirmedResolved += 1;
      if (!entry.resolved || entry.status !== "succeeded") changed = true;
      entry.resolved = true;
      entry.status = "succeeded";
      return;
    }
    if (!entry.resolved) return;
    entry.resolved = false;
    if (asyncTaskTerminal(entry.status)) entry.status = "running";
    changed = true;
  });
  const previousResolvedCount = Math.max(0, Number(task.resolvedCount) || 0);
  const unmatchedStoredResults = taskResults.filter((result) => (
    !task.asyncTasks.some((entry) => entry && resultMatchesAsyncEntry(result, entry))
  )).length;
  const requestsWithoutAsyncIds = Math.max(
    0,
    Math.min(Number(task.submittedCount) || 0, Number(task.requestedCount) || 0) - task.asyncTasks.length
  );
  const nextResolvedCount = Math.min(
    Number(task.requestedCount) || confirmedResolved,
    confirmedResolved + Math.min(requestsWithoutAsyncIds, unmatchedStoredResults)
  );
  if (nextResolvedCount !== previousResolvedCount) changed = true;
  task.resolvedCount = nextResolvedCount;
  if (changed) {
    task.autoRecoveryExhausted = false;
    task.autoRecoveryStartedAt = 0;
    task.recoveryElapsedMs = 0;
  }
  return changed;
}

function recoverableCompletedTaskRecord(record, loadedResults) {
  if (!record || !Array.isArray(record.asyncTasks) || !record.asyncTasks.length) return false;
  const createdAt = Date.parse(String(record.createdAt || "")) || 0;
  if (!createdAt || Date.now() - createdAt > HISTORY_PENDING_RETENTION_MS) return false;
  const requestedCount = Math.max(1, Math.min(4, Number(record.requestedCount) || 1));
  const storedCount = (Array.isArray(loadedResults) ? loadedResults : []).filter((result) => (
    String(result.sourceJobId || "") === String(record.id || "")
  )).length;
  return storedCount < requestedCount && record.asyncTasks.some((entry) => Boolean(
    entry && entry.id && !entry.failed
  ));
}

function pendingRecoveryElapsedMs(task, now = Date.now()) {
  if (!task) return 0;
  const stored = Math.max(0, Number(task.recoveryElapsedMs) || 0);
  const startedAt = Math.max(0, Number(task.autoRecoveryStartedAt) || 0);
  return Math.min(
    HISTORY_RECOVERY_TIMEOUT_MS,
    stored + (startedAt ? Math.max(0, Number(now) - startedAt) : 0)
  );
}

function finishPendingRecoverySession(task, now = Date.now()) {
  if (!task) return;
  task.recoveryElapsedMs = pendingRecoveryElapsedMs(task, now);
  task.autoRecoveryStartedAt = 0;
  if (task.recoveryElapsedMs >= HISTORY_RECOVERY_TIMEOUT_MS) task.autoRecoveryExhausted = true;
}

async function ensureTaskArchiveReferencesStored(folder, result) {
  const taskArchive = result && result.taskArchive;
  if (!taskArchive || !Array.isArray(taskArchive.references)) return;
  const archiveId = String(taskArchive.id || result.id || Date.now())
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 96) || String(Date.now());

  for (let index = 0; index < taskArchive.references.length; index += 1) {
    const reference = taskArchive.references[index];
    if (!reference || !reference.file || reference.released) continue;

    const storedName = safeStorageFileName(reference.persistentTaskFileName);
    if (storedName) {
      const storedFile = reference.persistentTaskFile || await getFolderEntrySafely(folder, storedName);
      if (storedFile) {
        reference.persistentTaskFile = storedFile;
        reference.persistentTaskFileName = storedName;
        continue;
      }
    }

    const sourceName = String(reference.file.name || "");
    const sourceExtension = (/\.([A-Za-z0-9]{2,5})$/.exec(sourceName) || [])[1];
    const extension = String(sourceExtension || (String(reference.mime).includes("png") ? "png" : "jpg")).toLowerCase();
    const referenceId = String(reference.id || index + 1)
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 72) || String(index + 1);
    const fileName = `task-ref-${archiveId}-${index + 1}-${referenceId}.${extension}`;
    const bytes = exactArrayBuffer(await reference.file.read({ format: formats.binary }));
    if (!bytes.byteLength || bytes.byteLength > API_CONFIG.maxUploadBytes) {
      throw new Error(`任务参考图 ${index + 1} 无法保存到生成历史`);
    }
    const storedFile = await folder.createFile(fileName, { overwrite: true });
    await storedFile.write(bytes, { format: formats.binary });
    reference.persistentTaskFile = storedFile;
    reference.persistentTaskFileName = fileName;
  }
}

function persistentTaskReferenceNames(index) {
  const names = new Set();
  const collect = (archive) => {
    if (!archive || !Array.isArray(archive.references)) return;
    archive.references.forEach((reference) => {
      const fileName = safeStorageFileName(reference && reference.fileName);
      if (fileName) names.add(fileName);
    });
  };
  (Array.isArray(index && index.results) ? index.results : []).forEach((record) => collect(record && record.taskArchive));
  (Array.isArray(index && index.pendingTasks) ? index.pendingTasks : []).forEach((record) => collect(record && record.taskArchive));
  return names;
}

async function cleanupOrphanTaskReferences(folder, index) {
  if (!folder || typeof folder.getEntries !== "function") return;
  const retained = persistentTaskReferenceNames(index);
  let entries = [];
  try {
    entries = await folder.getEntries();
  } catch (_) {
    return;
  }
  for (const entry of Array.from(entries || [])) {
    const name = safeStorageFileName(entry && entry.name);
    if (!/^task-ref-/i.test(name) || retained.has(name)) continue;
    await safeDelete(entry);
  }
}

async function readHistoryIndexCandidate(folder, fileName) {
  const file = await getFolderEntrySafely(folder, fileName);
  if (!file) return null;
  try {
    const raw = String(await file.read({ format: formats.utf8 }) || "");
    const index = JSON.parse(raw);
    if (!index || typeof index !== "object" || Array.isArray(index)) return null;
    return {
      file,
      fileName,
      raw,
      index,
      savedAt: Date.parse(String(index.savedAt || "")) || 0
    };
  } catch (_) {
    return null;
  }
}

async function writeHistoryTextFile(folder, fileName, text) {
  const file = await folder.createFile(fileName, { overwrite: true });
  await file.write(String(text || ""), { format: formats.utf8 });
  return file;
}

function isSupportedHistoryIndex(index) {
  const version = Number(index && index.schemaVersion) || 1;
  return Boolean(index && typeof index === "object" && !Array.isArray(index)) && (
    version >= 1 && version <= PERSISTENT_HISTORY_SCHEMA_VERSION
  );
}

async function promoteHistoryIndex(folder, nextFile) {
  if (!nextFile || typeof nextFile.moveTo !== "function") {
    throw new Error("Local history does not support atomic index replacement");
  }
  await nextFile.moveTo(folder, {
    newName: PERSISTENT_HISTORY_INDEX,
    overwrite: true
  });
  const promoted = await readHistoryIndexCandidate(folder, PERSISTENT_HISTORY_INDEX);
  if (!promoted || !isSupportedHistoryIndex(promoted.index)) {
    throw new Error("Local history index could not be validated after replacement");
  }
  return promoted;
}

async function persistHistoryStateNow() {
  const folder = await getPersistentHistoryFolder();
  for (const result of state.results) {
    await ensureSnapshotMaskStored(result, "result");
    await ensureTaskArchiveReferencesStored(folder, result);
  }
  for (const task of state.pendingHistoryTasks) {
    await ensureSnapshotMaskStored(task, "pending");
    await ensureTaskArchiveReferencesStored(folder, task);
  }
  const index = {
    schemaVersion: PERSISTENT_HISTORY_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    resultSequence: Number(state.resultSequence) || 0,
    generationJobSequence: Number(state.generationJobSequence) || 0,
    results: state.results.filter((result) => result && result.file && !result.released).map(serializePersistentResult),
    pendingTasks: state.pendingHistoryTasks.map(serializePendingHistoryTask)
  };
  const serialized = JSON.stringify(index);
  const current = await readHistoryIndexCandidate(folder, PERSISTENT_HISTORY_INDEX);
  if (current && current.raw && isSupportedHistoryIndex(current.index)) {
    await writeHistoryTextFile(folder, PERSISTENT_HISTORY_INDEX_BACKUP, current.raw);
  }
  const nextFile = await writeHistoryTextFile(folder, PERSISTENT_HISTORY_INDEX_TEMP, serialized);
  const nextText = String(await nextFile.read({ format: formats.utf8 }) || "");
  const verified = JSON.parse(nextText);
  if (!verified || Number(verified.schemaVersion) !== PERSISTENT_HISTORY_SCHEMA_VERSION) {
    throw new Error("本地生成历史索引校验失败");
  }
  await promoteHistoryIndex(folder, nextFile);
  await cleanupOrphanTaskReferences(folder, index);
  state.historyPersistenceError = "";
  return true;
}

function queuePersistHistoryState() {
  historyPersistenceQueue = historyPersistenceQueue.catch(() => false).then(async () => {
    try {
      return await persistHistoryStateNow();
    } catch (error) {
      state.historyPersistenceError = sanitizeMessage(error && (error.message || error));
      return false;
    }
  });
  return historyPersistenceQueue;
}

async function loadPersistentHistoryState() {
  state.results.forEach(revokeResultPreview);
  state.loadingPersistentHistory = true;
  updateControls();
  let needsCleanup = false;
  try {
    const folder = await getPersistentHistoryFolder();
    const candidates = [];
    for (const fileName of [
      PERSISTENT_HISTORY_INDEX,
      PERSISTENT_HISTORY_INDEX_TEMP,
      PERSISTENT_HISTORY_INDEX_BACKUP
    ]) {
      const candidate = await readHistoryIndexCandidate(folder, fileName);
      if (candidate && isSupportedHistoryIndex(candidate.index)) {
        candidates.push(candidate);
      } else if (candidate || await getFolderEntrySafely(folder, fileName)) {
        needsCleanup = true;
      }
    }
    if (!candidates.length) {
      const hasIndexFile = await getFolderEntrySafely(folder, PERSISTENT_HISTORY_INDEX);
      if (hasIndexFile) state.historyPersistenceError = "本地生成历史索引无法读取，将从新的结果重新记录";
      return;
    }
    candidates.sort((left, right) => right.savedAt - left.savedAt || (
      left.fileName === PERSISTENT_HISTORY_INDEX ? -1 : 1
    ));
    const selectedIndex = candidates[0];
    const index = selectedIndex.index;
    if (selectedIndex.fileName !== PERSISTENT_HISTORY_INDEX) needsCleanup = true;
    const historySchemaVersion = Number(index.schemaVersion) || 1;
    if (historySchemaVersion < PERSISTENT_HISTORY_SCHEMA_VERSION) needsCleanup = true;

    const loadedResults = [];
    const resultRecords = Array.isArray(index.results) ? index.results.slice(0, MAX_RESULTS) : [];
    for (const record of resultRecords) {
      const fileName = safeStorageFileName(record && record.fileName);
      const file = await getFolderEntrySafely(folder, fileName);
      if (!file) {
        needsCleanup = true;
        continue;
      }
      let buffer = null;
      let detected = null;
      try {
        buffer = exactArrayBuffer(await file.read({ format: formats.binary }));
        detected = detectImageType(buffer);
        if (!buffer.byteLength || detected.width * detected.height > API_CONFIG.maxOutputPixels) {
          throw new Error("本地历史图片无效");
        }
      } catch (_) {
        await safeDelete(file);
        needsCleanup = true;
        continue;
      }
      const loadedSnapshot = await loadSerializedSnapshot(folder, record.snapshot);
      if (!loadedSnapshot.snapshot) {
        await safeDelete(file);
        await safeDelete(loadedSnapshot.maskFile);
        needsCleanup = true;
        continue;
      }
      const createdAt = new Date(record.createdAt || Date.now());
      const result = {
        id: String(record.id || `result-restored-${Date.now()}-${loadedResults.length + 1}`),
        sequence: Math.max(1, Number(record.sequence) || loadedResults.length + 1),
        file,
        storageFileName: fileName,
        previewUrl: null,
        mime: detected.mime,
        extension: detected.extension,
        byteLength: buffer.byteLength,
        width: detected.width,
        height: detected.height,
        count: Number(record.count) || 1,
        snapshot: loadedSnapshot.snapshot,
        maskFile: loadedSnapshot.maskFile,
        maskFileName: loadedSnapshot.maskFileName,
        requested: record.requested || null,
        prompt: String(record.prompt || "").slice(0, 20000),
        requestPrompt: String(record.requestPrompt || record.prompt || "").slice(0, 20000),
        taskArchive: null,
        imageFingerprint: String(record.imageFingerprint || imageBufferFingerprint(buffer)),
        recoveredFromHistory: Boolean(record.recoveredFromHistory),
        historyRecordKey: String(record.historyRecordKey || ""),
        sourceJobId: String(record.sourceJobId || ""),
        createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
        insertedAt: record.insertedAt ? new Date(record.insertedAt) : null,
        precisePlacement: typeof record.precisePlacement === "boolean" ? record.precisePlacement : null,
        openedAt: null,
        openedFiles: [],
        persistent: true,
        released: false
      };
      result.taskArchive = await deserializeTaskArchive(folder, record.taskArchive, result);
      loadedResults.push(result);
    }
    loadedResults.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    state.results = loadedResults.slice(0, MAX_RESULTS);
    state.resultHistoryPageIndex = 0;
    state.resultSequence = Math.max(
      Number(index.resultSequence) || 0,
      ...state.results.map((result) => Number(result.sequence) || 0)
    );
    state.generationJobSequence = Math.max(0, Number(index.generationJobSequence) || 0);

    const pendingTasks = [];
    const pendingRecords = Array.isArray(index.pendingTasks) ? index.pendingTasks.slice() : [];
    const backupCandidate = candidates.find((candidate) => (
      candidate.fileName === PERSISTENT_HISTORY_INDEX_BACKUP
    ));
    const backupRecords = backupCandidate && Array.isArray(backupCandidate.index.pendingTasks)
      ? backupCandidate.index.pendingTasks
      : [];
    const currentPendingIds = new Set(pendingRecords.map((record) => String(record && record.id || "")));
    backupRecords.forEach((record) => {
      const id = String(record && record.id || "");
      if (!id || currentPendingIds.has(id) || !recoverableCompletedTaskRecord(record, loadedResults)) return;
      pendingRecords.push(record);
      currentPendingIds.add(id);
      needsCleanup = true;
    });
    const now = Date.now();
    for (const record of pendingRecords) {
      const createdAt = new Date(record && record.createdAt || Date.now());
      const createdTime = createdAt.getTime();
      const loadedSnapshot = await loadSerializedSnapshot(folder, record && record.snapshot);
      if (
        !loadedSnapshot.snapshot || Number.isNaN(createdTime) ||
        now - createdTime > HISTORY_PENDING_RETENTION_MS
      ) {
        await safeDelete(loadedSnapshot.maskFile);
        needsCleanup = true;
        continue;
      }
      const requestedCount = Math.max(1, Math.min(4, Number(record.requestedCount) || 1));
      const recoveryRevision = Math.max(0, Number(record.recoveryRevision) || 0);
      const recoveryStateIsCurrent = recoveryRevision >= PENDING_HISTORY_RECOVERY_REVISION;
      // The five-minute limit applies to one plugin session. A previous
      // session must not permanently hide a task that completed later.
      const recoveryElapsedMs = 0;
      const autoRecoveryStartedAt = 0;
      const task = {
        id: String(record.id || `pending-${createdTime}-${pendingTasks.length + 1}`),
        sequence: Number(record.sequence) || pendingTasks.length + 1,
        prompt: String(record.prompt || "").slice(0, 20000),
        requestPrompt: String(record.requestPrompt || record.prompt || "").slice(0, 20000),
        model: String(record.model || record.requested && record.requested.model || API_CONFIG.model),
        requested: record.requested || null,
        requestedCount,
        submittedCount: Math.max(0, Math.min(requestedCount, Number(record.submittedCount) || 0)),
        resolvedCount: Math.max(0, Number(record.resolvedCount) || 0),
        knownFailedCount: Math.max(0, Number(record.knownFailedCount) || 0),
        apiKeyFingerprint: String(record.apiKeyFingerprint || ""),
        asyncTasks: Array.isArray(record.asyncTasks) ? record.asyncTasks.map((entry) => ({
          requestIndex: Math.max(0, Number(entry && entry.requestIndex) || 0),
          id: String(entry && entry.id || ""),
          taskIds: Array.isArray(entry && entry.taskIds) ? entry.taskIds.map(String).filter(Boolean) : [],
          statusUrl: String(entry && entry.statusUrl || ""),
          status: String(entry && entry.status || "queued"),
          submittedAt: Math.max(0, Number(entry && entry.submittedAt) || 0),
          lastCheckedAt: Math.max(0, Number(entry && entry.lastCheckedAt) || 0),
          pollElapsedMs: Math.max(0, Number(entry && entry.pollElapsedMs) || 0),
          resolved: Boolean(entry && entry.resolved),
          failed: Boolean(entry && entry.failed)
        })).filter((entry) => entry.id) : [],
        aspectRatio: String(record.aspectRatio || "auto"),
        resolution: String(record.resolution || "1K"),
        precisionPlacement: Boolean(record.precisionPlacement),
        localEditMode: LOCAL_EDIT_MODES.includes(String(record.localEditMode || ""))
          ? String(record.localEditMode)
          : "general",
        recoveryRevision: PENDING_HISTORY_RECOVERY_REVISION,
        autoRecoveryExhausted: false,
        autoRecoveryStartedAt,
        recoveryElapsedMs,
        createdAt,
        historyBaselineKeys: new Set(Array.isArray(record.historyBaselineKeys) ? record.historyBaselineKeys.map(String) : []),
        recoveredHistoryKeys: new Set(Array.isArray(record.recoveredHistoryKeys) ? record.recoveredHistoryKeys.map(String) : []),
        snapshot: loadedSnapshot.snapshot,
        maskFile: loadedSnapshot.maskFile,
        maskFileName: loadedSnapshot.maskFileName,
        taskArchive: null
      };
      const pendingArchiveResult = {
        id: task.id,
        sequence: task.sequence,
        sourceJobId: task.id,
        prompt: task.prompt,
        requested: task.requested,
        snapshot: task.snapshot,
        maskFileName: task.maskFileName,
        createdAt: task.createdAt
      };
      task.taskArchive = record.taskArchive
        ? await deserializeTaskArchive(folder, record.taskArchive, pendingArchiveResult)
        : fallbackTaskArchive(pendingArchiveResult);
      if (!recoveryStateIsCurrent && reconcilePendingAsyncTaskResolution(task, loadedResults)) {
        needsCleanup = true;
      }
      const locallyStoredRequestKeys = new Set();
      const completedHistoryKeys = new Set(Array.from(task.recoveredHistoryKeys || []).map(String));
      state.results.forEach((result) => {
        if (result.sourceJobId !== task.id) return;
        const rawHistoryKey = String(result.historyRecordKey || "");
        const historyKey = historyRecordBaseKey(rawHistoryKey);
        if (historyKey !== rawHistoryKey && !completedHistoryKeys.has(historyKey)) return;
        locallyStoredRequestKeys.add(historyKey || String(result.id || result.storageFileName || locallyStoredRequestKeys.size));
      });
      task.resolvedCount = Math.min(
        task.requestedCount,
        Math.max(task.resolvedCount, locallyStoredRequestKeys.size)
      );
      if (pendingHistoryOutstandingCount(task) <= 0) {
        await safeDelete(task.maskFile);
        needsCleanup = true;
        continue;
      }
      pendingTasks.push(task);
    }
    state.pendingHistoryTasks = pendingTasks;
    state.selectedResultId = state.results.length ? state.results[0].id : null;
    await cleanupOrphanTaskReferences(folder, {
      ...index,
      pendingTasks: pendingRecords
    });
    renderResultHistory();
  } catch (error) {
    state.historyPersistenceError = sanitizeMessage(error && (error.message || error));
  } finally {
    state.loadingPersistentHistory = false;
    updateControls();
    if (needsCleanup) queuePersistHistoryState();
  }
}

async function registerPendingHistoryTask(job) {
  const task = {
    id: job.id,
    sequence: job.sequence,
    prompt: job.prompt,
    requestPrompt: job.requestPrompt || job.prompt,
    model: job.model || job.requested && job.requested.model || API_CONFIG.model,
    requested: job.requested,
    requestedCount: job.requestedCount,
    submittedCount: 0,
    resolvedCount: 0,
    knownFailedCount: 0,
    apiKeyFingerprint: apiKeyFingerprint(job.apiKey),
    asyncTasks: [],
    aspectRatio: job.aspectRatio,
    resolution: job.resolution,
    precisionPlacement: job.precisionPlacement,
    localEditMode: job.localEditMode || "general",
    recoveryRevision: PENDING_HISTORY_RECOVERY_REVISION,
    autoRecoveryExhausted: false,
    autoRecoveryStartedAt: 0,
    recoveryElapsedMs: 0,
    createdAt: job.createdAt,
    historyBaselineKeys: new Set(),
    recoveredHistoryKeys: new Set(),
    snapshot: job.snapshot,
    maskFile: null,
    maskFileName: "",
    taskArchive: job.taskArchive
  };
  job.pendingHistoryTask = task;
  state.pendingHistoryTasks = state.pendingHistoryTasks.filter((item) => item.id !== task.id);
  state.pendingHistoryTasks.push(task);
  await ensureSnapshotMaskStored(task, "pending");
  const persisted = await queuePersistHistoryState();
  if (!persisted) {
    state.pendingHistoryTasks = state.pendingHistoryTasks.filter((item) => item.id !== task.id);
    await safeDelete(task.maskFile);
    task.maskFile = null;
    throw new Error("无法保存待找回任务；为避免断线后丢失结果，本次没有发送生成请求");
  }
  return task;
}

function pendingTaskForJob(job) {
  if (job && job.pendingHistoryTask) return job.pendingHistoryTask;
  return state.pendingHistoryTasks.find((task) => task.id === (job && job.id)) || null;
}

async function updatePendingHistoryTask(job) {
  const task = pendingTaskForJob(job);
  if (!task) return false;
  if (job && job.historyBaselineKeys) task.historyBaselineKeys = new Set(job.historyBaselineKeys);
  if (job && job.taskArchive) task.taskArchive = job.taskArchive;
  if (job && job.apiKey) task.apiKeyFingerprint = apiKeyFingerprint(job.apiKey);
  return await queuePersistHistoryState();
}

function pendingAsyncTaskEntry(task, requestIndex) {
  return task && Array.isArray(task.asyncTasks)
    ? task.asyncTasks.find((entry) => Number(entry.requestIndex) === Number(requestIndex)) || null
    : null;
}

async function markPendingAsyncTaskSubmitted(job, requestIndex, taskInfo) {
  const task = pendingTaskForJob(job);
  if (!task || !taskInfo || !taskInfo.id) return false;
  if (!Array.isArray(task.asyncTasks)) task.asyncTasks = [];
  let entry = pendingAsyncTaskEntry(task, requestIndex);
  if (!entry) {
    entry = { requestIndex: Number(requestIndex) || 0 };
    task.asyncTasks.push(entry);
  }
  entry.id = String(taskInfo.id || "");
  entry.taskIds = Array.isArray(taskInfo.taskIds) ? taskInfo.taskIds.map(String).filter(Boolean) : [];
  entry.statusUrl = String(taskInfo.statusUrl || "");
  entry.status = String(taskInfo.status || "queued");
  entry.submittedAt = Date.now();
  entry.lastCheckedAt = 0;
  entry.pollElapsedMs = 0;
  entry.resolved = false;
  entry.failed = false;
  return await updatePendingHistoryTask(job);
}

async function updatePendingAsyncTask(job, requestIndex, update) {
  const task = pendingTaskForJob(job);
  const entry = pendingAsyncTaskEntry(task, requestIndex);
  if (!entry) return false;
  const previousStatus = String(entry.status || "");
  const previousStatusUrl = String(entry.statusUrl || "");
  const previousCheckedAt = Number(entry.lastCheckedAt) || 0;
  const updateId = String(update && update.id || "").trim();
  const primaryUpdate = !updateId || updateId === String(entry.id || "").trim();
  if (primaryUpdate) {
    entry.status = String(update && update.status || entry.status || "running");
    entry.statusUrl = String(update && update.statusUrl || entry.statusUrl || "");
  }
  entry.lastCheckedAt = Date.now();
  entry.pollElapsedMs = Math.max(Number(entry.pollElapsedMs) || 0, Number(update && update.pollElapsedMs) || 0);
  if (
    entry.status === previousStatus && entry.statusUrl === previousStatusUrl &&
    entry.lastCheckedAt - previousCheckedAt < 30000
  ) return true;
  return await updatePendingHistoryTask(job);
}

async function markPendingRequestSubmitted(job) {
  const task = pendingTaskForJob(job);
  if (!task) return false;
  const previous = Number(task.submittedCount) || 0;
  task.submittedCount = Math.min(task.requestedCount, Number(task.submittedCount || 0) + 1);
  const persisted = await updatePendingHistoryTask(job);
  if (!persisted) task.submittedCount = previous;
  return persisted;
}

async function unmarkPendingRequestSubmitted(job) {
  const task = pendingTaskForJob(job);
  if (!task) return false;
  task.submittedCount = Math.max(0, Number(task.submittedCount || 0) - 1);
  return await updatePendingHistoryTask(job);
}

async function markPendingRequestResolved(job, historyKey, requestIndex, asyncTaskId) {
  const task = pendingTaskForJob(job);
  if (!task) return false;
  let entry = pendingAsyncTaskEntry(task, requestIndex);
  if (!entry && asyncTaskId) entry = (task.asyncTasks || []).find((item) => String(item.id) === String(asyncTaskId));
  const baseHistoryKey = historyRecordBaseKey(historyKey);
  const alreadyResolved = Boolean(
    entry && entry.resolved ||
    baseHistoryKey && task.recoveredHistoryKeys && task.recoveredHistoryKeys.has(baseHistoryKey)
  );
  if (alreadyResolved) return true;
  task.resolvedCount = Math.min(task.requestedCount, Number(task.resolvedCount || 0) + 1);
  if (baseHistoryKey) task.recoveredHistoryKeys.add(baseHistoryKey);
  if (entry) {
    entry.resolved = true;
    entry.failed = false;
    entry.status = "succeeded";
    entry.lastCheckedAt = Date.now();
  }
  return await updatePendingHistoryTask(job);
}

async function markPendingRequestKnownFailed(job, requestIndex) {
  const task = pendingTaskForJob(job);
  if (!task) return false;
  const entry = pendingAsyncTaskEntry(task, requestIndex);
  const alreadyFailed = Boolean(entry && entry.failed);
  if (!alreadyFailed) {
    task.knownFailedCount = Math.min(task.requestedCount, Number(task.knownFailedCount || 0) + 1);
  }
  if (entry) {
    entry.failed = true;
    entry.status = "failed";
    entry.lastCheckedAt = Date.now();
  }
  return await updatePendingHistoryTask(job);
}

async function removePendingHistoryTask(taskOrId) {
  const id = typeof taskOrId === "string" ? taskOrId : String(taskOrId && taskOrId.id || "");
  const index = state.pendingHistoryTasks.findIndex((task) => task.id === id);
  if (index < 0) return false;
  const removed = state.pendingHistoryTasks.splice(index, 1)[0];
  await safeDelete(removed.maskFile);
  removed.maskFile = null;
  if (removed.taskArchive && Number(removed.taskArchive.historyOwners || 0) <= 0) {
    removed.taskArchive.references = Array.isArray(removed.taskArchive.references)
      ? removed.taskArchive.references.map((reference) => {
        if (reference && reference.persistentTaskFileName) {
          reference.file = reference.persistentTaskFile || reference.file;
          reference.preserveFile = false;
        }
        return reference;
      })
      : [];
  }
  await queuePersistHistoryState();
  return true;
}

function stringToUtf8Bytes(value) {
  const text = String(value || "");
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  const bytes = [];
  const encoded = encodeURIComponent(text);
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "%") {
      bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return new Uint8Array(bytes);
}

function apiKeyFingerprint(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${text.length}:${hash.toString(16).padStart(8, "0")}`;
}

function maskApiKey(value) {
  const text = String(value || "").trim();
  if (!text) return "未命名 Key";
  if (text.includes(":")) return `Key ${text.slice(-6)}`;
  if (text.length <= 12) return text;
  return `${text.slice(0, 7)}...${text.slice(-6)}`;
}

async function loadApiKey() {
  try {
    const stored = await secureStorage.getItem(API_KEY_STORAGE);
    if (stored && stored.length) {
      state.apiKey = typeof stored === "string"
        ? stored
        : utf8BytesToString(stored instanceof Uint8Array ? stored : new Uint8Array(stored));
      return Boolean(state.apiKey);
    }
  } catch (_) {
    state.apiKey = "";
  }
  return false;
}

async function saveApiKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("请输入 API Key");
  await secureStorage.setItem(API_KEY_STORAGE, stringToUtf8Bytes(key));
  state.apiKey = key;
}

async function clearStoredApiKey() {
  state.apiKey = "";
  try {
    const existing = await secureStorage.getItem(API_KEY_STORAGE);
    if (existing && existing.length) await secureStorage.removeItem(API_KEY_STORAGE);
  } catch (_) {
    // The next run still opens the key dialog even if storage cleanup failed.
  }
}

async function clearStoredApiKeyIfMatches(expectedKey) {
  const key = String(expectedKey || "");
  if (!key || state.apiKey !== key) return false;
  await clearStoredApiKey();
  return true;
}

async function clearStoredApiKeyIfFingerprintMatches(expectedFingerprint) {
  const fingerprint = String(expectedFingerprint || "");
  if (!fingerprint || apiKeyFingerprint(state.apiKey) !== fingerprint) return false;
  await clearStoredApiKey();
  return true;
}

async function loadArkApiKey() {
  try {
    const stored = await secureStorage.getItem(ARK_API_KEY_STORAGE);
    if (stored && stored.length) {
      state.arkApiKey = typeof stored === "string"
        ? stored
        : utf8BytesToString(stored instanceof Uint8Array ? stored : new Uint8Array(stored));
      return Boolean(state.arkApiKey);
    }
  } catch (_) {
    state.arkApiKey = "";
  }
  return false;
}

async function saveArkApiKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("请输入方舟 API Key");
  await secureStorage.setItem(ARK_API_KEY_STORAGE, stringToUtf8Bytes(key));
  state.arkApiKey = key;
}

async function clearStoredArkApiKey() {
  state.arkApiKey = "";
  try {
    const existing = await secureStorage.getItem(ARK_API_KEY_STORAGE);
    if (existing && existing.length) await secureStorage.removeItem(ARK_API_KEY_STORAGE);
  } catch (_) {
    // The user can replace the key from settings even if cleanup failed.
  }
}

async function loadVolcImageApiKey() {
  try {
    const stored = await secureStorage.getItem(VOLC_IMAGE_API_KEY_STORAGE);
    if (stored && stored.length) {
      state.volcImageApiKey = typeof stored === "string"
        ? stored
        : utf8BytesToString(stored instanceof Uint8Array ? stored : new Uint8Array(stored));
      return Boolean(state.volcImageApiKey);
    }
  } catch (_) {
    state.volcImageApiKey = "";
  }
  return false;
}

async function saveVolcImageApiKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("请输入火山方舟生成 API Key");
  await secureStorage.setItem(VOLC_IMAGE_API_KEY_STORAGE, stringToUtf8Bytes(key));
  state.volcImageApiKey = key;
}

async function clearStoredVolcImageApiKey() {
  state.volcImageApiKey = "";
  try {
    const existing = await secureStorage.getItem(VOLC_IMAGE_API_KEY_STORAGE);
    if (existing && existing.length) await secureStorage.removeItem(VOLC_IMAGE_API_KEY_STORAGE);
  } catch (_) {
    // The user can replace the key from settings even if cleanup failed.
  }
}

async function clearStoredVolcImageApiKeyIfMatches(expectedKey) {
  const key = String(expectedKey || "");
  if (!key || state.volcImageApiKey !== key) return false;
  await clearStoredVolcImageApiKey();
  return true;
}

async function clearStoredGenerationKeyForJob(job) {
  return isVolcModel(job && job.model)
    ? await clearStoredVolcImageApiKeyIfMatches(job && job.apiKey)
    : await clearStoredApiKeyIfMatches(job && job.apiKey);
}

function showKeyDialog(resumeAfterSave, provider = "katu") {
  state.resumeAfterKey = Boolean(resumeAfterSave);
  state.pendingKeyProvider = provider === "volc" ? "volc" : "katu";
  setKeyInputValue("");
  elements.keyError.textContent = "";
  if (elements.keyTitle) {
    elements.keyTitle.textContent = provider === "volc"
      ? "GPT 2.5 需要 API Key"
      : "首次运行需要 API Key";
  }
  if (elements.keyInput) {
    elements.keyInput.placeholder = provider === "volc" ? "请输入火山方舟生成 API Key（ark-...）" : "请输入 API Key";
  }
  elements.keyOverlay.classList.remove("is-hidden");
  setTimeout(() => elements.keyInput.focus(), 0);
}

function hideKeyDialog() {
  elements.keyOverlay.classList.add("is-hidden");
  setKeyInputValue("");
  elements.keyError.textContent = "";
  state.pendingKeyProvider = "katu";
}

async function safeDelete(entry) {
  if (!entry) return;
  try {
    await entry.delete();
  } catch (_) {
    // Temporary storage may already have removed the entry.
  }
}

function revokeReferencePreview(reference) {
  if (!reference || !reference.previewUrl) return;
  try {
    URL.revokeObjectURL(reference.previewUrl);
  } catch (_) {
    // The host may already have released the URL.
  }
  reference.previewUrl = null;
}

async function createReferencePreview(reference) {
  if (
    !ENABLE_REFERENCE_PREVIEWS || !reference || reference.released || !reference.file ||
    typeof ImageBlob === "undefined" || typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) return;
  try {
    revokeReferencePreview(reference);
    try {
      const metadata = await reference.file.getMetadata();
      const size = Number(metadata && metadata.size);
      if (size > REFERENCE_PREVIEW_MAX_BYTES) return;
    } catch (_) {
      // Some UXP File implementations do not expose metadata; read below.
    }
    const fileBytes = await reference.file.read({ format: formats.binary });
    const buffer = exactArrayBuffer(fileBytes);
    if (!buffer || buffer.byteLength > REFERENCE_PREVIEW_MAX_BYTES) return;
    // Layer exports can be PNG even when the temporary file is named .jpg.
    // Detect the actual bytes before building the thumbnail URL.
    let detected = null;
    try {
      detected = detectImageType(buffer);
    } catch (_) {
      detected = null;
    }
    const mime = detected && detected.mime
      ? detected.mime
      : (reference.mime || "image/jpeg");
    reference.mime = mime;
    // Use the same preview pipeline as generated images. Photoshop UXP can
    // render ImageBlob object URLs reliably, while large data URLs paint as
    // empty reference tiles in the panel.
    const imageBlob = new ImageBlob(buffer, { type: mime });
    reference.previewUrl = URL.createObjectURL(imageBlob);
  } catch (_) {
    reference.previewUrl = null;
  }
}

async function maybeReleaseReference(reference) {
  if (
    !reference || reference.released || reference.inReferenceList ||
    Number(reference.resultOwners) > 0
  ) return;
  revokeReferencePreview(reference);
  if (!reference.preserveFile) await safeDelete(reference.file);
  reference.file = null;
  reference.released = true;
}

async function releaseReference(reference) {
  if (!reference) return;
  reference.inReferenceList = false;
  await maybeReleaseReference(reference);
}

function retainGenerationJobReferences(job) {
  job.references.forEach((reference) => {
    reference.resultOwners = Number(reference.resultOwners || 0) + 1;
  });
}

async function releaseGenerationJobReferences(job) {
  const references = job.references.splice(0);
  for (const reference of references) {
    reference.resultOwners = Math.max(0, Number(reference.resultOwners || 0) - 1);
    await maybeReleaseReference(reference);
  }
}

function retainTaskArchive(taskArchive) {
  if (!taskArchive || !Array.isArray(taskArchive.references)) return;
  const previousOwners = Number(taskArchive.historyOwners || 0);
  taskArchive.historyOwners = previousOwners + 1;
  if (previousOwners > 0) return;
  taskArchive.references.forEach((reference) => {
    reference.resultOwners = Number(reference.resultOwners || 0) + 1;
  });
}

async function releaseTaskArchive(taskArchive) {
  if (!taskArchive || !Array.isArray(taskArchive.references)) return;
  const previousOwners = Number(taskArchive.historyOwners || 0);
  taskArchive.historyOwners = Math.max(0, previousOwners - 1);
  if (previousOwners !== 1) return;
  for (const reference of taskArchive.references) {
    reference.resultOwners = Math.max(0, Number(reference.resultOwners || 0) - 1);
    await maybeReleaseReference(reference);
  }
}

function getSelectedResult() {
  return state.results.find((result) => result.id === state.selectedResultId) || null;
}

function revokeResultPreview(result) {
  if (!result) return;
  result.previewRequestToken = Number(result.previewRequestToken || 0) + 1;
  result.previewLoadPromise = null;
  if (result.previewUrl) {
    try {
      URL.revokeObjectURL(result.previewUrl);
    } catch (_) {
      // The host may already have released the URL.
    }
  }
  result.previewUrl = null;
}

async function createResultPreview(result, buffer) {
  if (
    !result || result.released || !buffer ||
    buffer.byteLength > RESULT_PREVIEW_MAX_BYTES ||
    typeof ImageBlob === "undefined" || typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) return false;
  try {
    revokeResultPreview(result);
    const requestToken = result.previewRequestToken;
    const imageBlob = new ImageBlob(exactArrayBuffer(buffer), { type: result.mime });
    const previewUrl = URL.createObjectURL(imageBlob);
    if (result.released || requestToken !== result.previewRequestToken) {
      URL.revokeObjectURL(previewUrl);
      return false;
    }
    result.previewUrl = previewUrl;
    return true;
  } catch (_) {
    result.previewUrl = null;
    return false;
  }
}

async function ensureResultPreview(result) {
  if (!result || result.released || !result.file) return false;
  if (result.previewUrl) return true;
  // Large results are shown from their persistent UXP File. Avoid reading
  // them again just to create a second in-memory Blob for a thumbnail.
  if (Number(result.byteLength) > RESULT_PREVIEW_MAX_BYTES) return false;
  if (result.previewLoadPromise) return result.previewLoadPromise;
  const requestToken = Number(result.previewRequestToken || 0) + 1;
  result.previewRequestToken = requestToken;
  const previewLoadPromise = (async () => {
    try {
      const buffer = exactArrayBuffer(await result.file.read({ format: formats.binary }));
      if (
        !buffer.byteLength || result.released ||
        requestToken !== result.previewRequestToken
      ) return false;
      return await createResultPreview(result, buffer);
    } catch (_) {
      return false;
    }
  })();
  result.previewLoadPromise = previewLoadPromise;
  try {
    return await previewLoadPromise;
  } finally {
    if (result.previewLoadPromise === previewLoadPromise) result.previewLoadPromise = null;
  }
}

function resultPreviewRetentionIds() {
  const historyVisible = state.activeWorkspace === "editor" || state.activeWorkspace === "outfit";
  const retained = historyVisible ? new Set(visibleResultPreviewIds) : new Set();
  if (state.selectedResultId) retained.add(state.selectedResultId);
  if (resultPreviewSourceResultId) retained.add(resultPreviewSourceResultId);
  if (taskDrawerResultId) retained.add(taskDrawerResultId);
  return retained;
}

function refreshResultPreviewConsumers(result) {
  if (!result) return;
  if (elements.resultHistory) {
    Array.from(elements.resultHistory.querySelectorAll("[data-result-preview]") || []).forEach((image) => {
      if (image.getAttribute("data-result-preview") === result.id) setImageSource(image, result);
    });
  }
  if (state.selectedResultId === result.id && elements.resultImage) setImageSource(elements.resultImage, result);
  if (resultPreviewSourceResultId === result.id && elements.resultPreviewImage) setImageSource(elements.resultPreviewImage, result);
  if (taskDrawerResultId === result.id && elements.taskDrawerImage) setImageSource(elements.taskDrawerImage, result);
}

function clearResultHistoryPreviewConsumers(result) {
  if (!result || !elements.resultHistory) return;
  Array.from(elements.resultHistory.querySelectorAll("[data-result-preview]") || []).forEach((image) => {
    if (image.getAttribute("data-result-preview") === result.id) image.removeAttribute("src");
  });
}

function syncResultPreviewRetention() {
  const retained = resultPreviewRetentionIds();
  state.results.forEach((result) => {
    if (retained.has(result.id)) {
      ensureResultPreview(result).then((ready) => {
        if (resultPreviewRetentionIds().has(result.id)) refreshResultPreviewConsumers(result);
        else if (ready) revokeResultPreview(result);
      }).catch(() => {});
      return;
    }
    clearResultHistoryPreviewConsumers(result);
    revokeResultPreview(result);
  });
}

async function releaseResult(result) {
  if (!result || result.released) return;
  revokeResultPreview(result);
  const openedFiles = Array.isArray(result.openedFiles) ? result.openedFiles.splice(0) : [];
  for (const openedFile of openedFiles) await safeDelete(openedFile);
  await safeDelete(result.file);
  await safeDelete(result.maskFile);
  await releaseTaskArchive(result.taskArchive);
  result.taskArchive = null;
  result.file = null;
  result.maskFile = null;
  result.released = true;
}

function setImageSource(imageElement, item) {
  if (!imageElement) return false;
  const previewSource = item && item.previewUrl;
  const fileSource = item && item.file;
  const sources = [];
  if (previewSource) sources.push(previewSource);
  if (fileSource && fileSource !== previewSource) sources.push(fileSource);
  const token = {};
  imageElement.__resultSourceToken = token;
  imageElement.removeAttribute("src");
  imageElement.onerror = null;
  if (!sources.length) return false;
  let sourceIndex = 0;
  const handleFailure = () => {
    if (imageElement.__resultSourceToken !== token) return;
    sourceIndex += 1;
    if (sourceIndex < sources.length) {
      try {
        imageElement.src = sources[sourceIndex];
        return;
      } catch (_) {
        // Try the terminal failure path below.
      }
    }
    imageElement.onerror = null;
    imageElement.removeAttribute("src");
  };
  imageElement.onerror = handleFailure;
  try {
    imageElement.src = sources[0];
    return true;
  } catch (_) {
    handleFailure();
    return sourceIndex < sources.length;
  }
}

function applyResultPreviewZoom() {
  const image = elements.resultPreviewImage;
  const viewport = elements.resultPreviewViewport;
  if (!image || !viewport) return;
  const naturalWidth = Number(image.naturalWidth) || 0;
  const naturalHeight = Number(image.naturalHeight) || 0;
  const viewportWidth = Math.max(1, Number(viewport.clientWidth) - 8);
  const viewportHeight = Math.max(1, Number(viewport.clientHeight) - 8);
  if (naturalWidth > 0 && naturalHeight > 0) {
    const fitScale = Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight);
    const displayScale = Math.max(0.05, fitScale * resultPreviewZoom);
    const displayWidth = Math.max(1, Math.round(naturalWidth * displayScale));
    const displayHeight = Math.max(1, Math.round(naturalHeight * displayScale));
    image.style.width = `${displayWidth}px`;
    image.style.height = `${displayHeight}px`;
    const isOverflowing = displayWidth > viewportWidth || displayHeight > viewportHeight;
    viewport.classList.toggle("is-zoomed", isOverflowing);
    if (!isOverflowing) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
  }
}

function setResultPreviewZoom(value, anchorEvent = null) {
  const viewport = elements.resultPreviewViewport;
  const image = elements.resultPreviewImage;
  const previousRect = image && typeof image.getBoundingClientRect === "function"
    ? image.getBoundingClientRect()
    : null;
  const viewportRect = viewport && typeof viewport.getBoundingClientRect === "function"
    ? viewport.getBoundingClientRect()
    : null;
  const eventX = Number(anchorEvent && anchorEvent.clientX);
  const eventY = Number(anchorEvent && anchorEvent.clientY);
  const anchorX = viewportRect
    ? Math.max(viewportRect.left, Math.min(viewportRect.right, Number.isFinite(eventX) ? eventX : viewportRect.left + viewportRect.width / 2))
    : 0;
  const anchorY = viewportRect
    ? Math.max(viewportRect.top, Math.min(viewportRect.bottom, Number.isFinite(eventY) ? eventY : viewportRect.top + viewportRect.height / 2))
    : 0;
  const imageRatioX = previousRect && previousRect.width > 0
    ? Math.max(0, Math.min(1, (anchorX - previousRect.left) / previousRect.width))
    : 0.5;
  const imageRatioY = previousRect && previousRect.height > 0
    ? Math.max(0, Math.min(1, (anchorY - previousRect.top) / previousRect.height))
    : 0.5;

  resultPreviewZoom = Math.max(0.25, Math.min(8, Math.round(Number(value) * 4) / 4));
  applyResultPreviewZoom();

  if (!anchorEvent || !viewport || !image || typeof image.getBoundingClientRect !== "function") return;
  const nextRect = image.getBoundingClientRect();
  viewport.scrollLeft += nextRect.left + nextRect.width * imageRatioX - anchorX;
  viewport.scrollTop += nextRect.top + nextRect.height * imageRatioY - anchorY;
}

function normalizedWheelDelta(event) {
  let delta = Number(event && event.deltaY);
  if (!Number.isFinite(delta) || delta === 0) {
    const wheelDeltaY = Number(event && event.wheelDeltaY);
    if (Number.isFinite(wheelDeltaY) && wheelDeltaY !== 0) delta = -wheelDeltaY;
  }
  if (!Number.isFinite(delta) || delta === 0) {
    const wheelDelta = Number(event && event.wheelDelta);
    if (Number.isFinite(wheelDelta) && wheelDelta !== 0) delta = -wheelDelta;
  }
  if (!Number.isFinite(delta) || delta === 0) {
    const detail = Number(event && event.detail);
    if (Number.isFinite(detail) && detail !== 0) delta = detail;
  }
  return Number.isFinite(delta) ? delta : 0;
}

function focusResultPreviewViewport() {
  const viewport = elements.resultPreviewViewport;
  if (!viewport || elements.resultPreviewOverlay.classList.contains("is-hidden")) return;
  try {
    viewport.focus({ preventScroll: true });
  } catch (_) {
    try {
      viewport.focus();
    } catch (_) {
      // UXP may reject focus while the floating panel is being activated.
    }
  }
}

function resultPreviewEventIsInsideViewport(event) {
  const viewport = elements.resultPreviewViewport;
  if (!event || !viewport || elements.resultPreviewOverlay.classList.contains("is-hidden")) return false;
  let target = event.target;
  while (target && target !== document) {
    if (target === elements.resultPreviewClose) return false;
    if (target === viewport) return true;
    target = target.parentNode;
  }
  if (typeof viewport.getBoundingClientRect !== "function") return false;
  const rect = viewport.getBoundingClientRect();
  const clientX = Number(event.clientX);
  const clientY = Number(event.clientY);
  return Number.isFinite(clientX) && Number.isFinite(clientY) &&
    clientX >= Number(rect.left) && clientX <= Number(rect.right) &&
    clientY >= Number(rect.top) && clientY <= Number(rect.bottom);
}

function consumeResultPreviewWheelEvent(event) {
  if (!event) return;
  if (typeof event.preventDefault === "function") event.preventDefault();
  if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  else if (typeof event.stopPropagation === "function") event.stopPropagation();
  try {
    event.cancelBubble = true;
    event.returnValue = false;
  } catch (_) {
    // Some UXP event fields are read-only; the methods above still consume the event.
  }
}

function bindResultPreviewWheelCapture(type) {
  try {
    document.addEventListener(type, handleResultPreviewWheel, { capture: true, passive: false });
  } catch (_) {
    document.addEventListener(type, handleResultPreviewWheel, true);
  }
}

function flushResultPreviewWheelZoom() {
  const pending = resultPreviewPendingWheel;
  resultPreviewWheelTimer = null;
  resultPreviewPendingWheel = null;
  if (!pending || elements.resultPreviewOverlay.classList.contains("is-hidden")) return;
  setResultPreviewZoom(pending.zoom, pending.anchor);
}

function queueResultPreviewWheelZoom(delta, event) {
  const pendingZoom = resultPreviewPendingWheel
    ? resultPreviewPendingWheel.zoom
    : resultPreviewZoom;
  resultPreviewPendingWheel = {
    zoom: pendingZoom + (delta < 0 ? 0.25 : -0.25),
    anchor: {
      clientX: Number(event && event.clientX),
      clientY: Number(event && event.clientY)
    }
  };
  if (resultPreviewWheelTimer !== null) return;
  resultPreviewWheelTimer = setTimeout(flushResultPreviewWheelZoom, 16);
}

function handleResultPreviewWheel(event) {
  if (!resultPreviewEventIsInsideViewport(event)) return;
  consumeResultPreviewWheelEvent(event);
  focusResultPreviewViewport();
  const delta = normalizedWheelDelta(event);
  if (delta === 0) return;
  const now = Date.now();
  const eventType = String(event && event.type || "wheel");
  if (eventType === "wheel") resultPreviewLastStandardWheelAt = now;
  else if (eventType === "mousewheel" && now - resultPreviewLastStandardWheelAt < 500) return;
  queueResultPreviewWheelZoom(delta, event);
}

function applyResultStageView() {
  if (!elements.resultImage || !elements.resultStage) return;
  const zoom = Math.max(1, resultStageZoom);
  elements.resultImage.style.transform = zoom === 1
    ? ""
    : `translate(${Math.round(resultStageOffsetX)}px, ${Math.round(resultStageOffsetY)}px) scale(${zoom})`;
  elements.resultStage.classList.toggle("is-zoomed", zoom > 1);
  elements.resultStage.classList.toggle("is-panning", resultStageDragging);
}

function resetResultStageView() {
  resultStageZoom = 1;
  resultStageOffsetX = 0;
  resultStageOffsetY = 0;
  resultStageDragging = false;
  resultStageDragMoved = false;
  resultStageSuppressClickUntil = 0;
  applyResultStageView();
}

function setResultStageZoom(value) {
  resultStageZoom = Math.max(1, Math.min(4, Math.round(Number(value) * 4) / 4));
  if (resultStageZoom === 1) {
    resultStageOffsetX = 0;
    resultStageOffsetY = 0;
  }
  applyResultStageView();
}

function handleResultStageWheel(event) {
  const delta = normalizedWheelDelta(event);
  if (delta === 0) return;
  const now = Date.now();
  const eventType = String(event && event.type || "wheel");
  if (eventType !== resultStageLastWheelType && now - resultStageLastWheelAt < 40) return;
  resultStageLastWheelAt = now;
  resultStageLastWheelType = eventType;
  if (event && typeof event.preventDefault === "function") event.preventDefault();
  setResultStageZoom(resultStageZoom + (delta < 0 ? 0.25 : -0.25));
}

function beginResultStagePan(event) {
  if (Number(event.button) !== 0) return;
  if (event && typeof event.preventDefault === "function") event.preventDefault();
  if (resultStageZoom <= 1) return;
  resultStageDragging = true;
  resultStageDragMoved = false;
  resultStageDragStartX = Number(event.clientX) || 0;
  resultStageDragStartY = Number(event.clientY) || 0;
  resultStageDragOriginX = resultStageOffsetX;
  resultStageDragOriginY = resultStageOffsetY;
  applyResultStageView();
}

function moveResultStagePan(event) {
  if (!resultStageDragging) return;
  const deltaX = (Number(event.clientX) || 0) - resultStageDragStartX;
  const deltaY = (Number(event.clientY) || 0) - resultStageDragStartY;
  if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) resultStageDragMoved = true;
  const maxX = Math.max(0, Number(elements.resultStage.clientWidth) * (resultStageZoom - 1) / 2);
  const maxY = Math.max(0, Number(elements.resultStage.clientHeight) * (resultStageZoom - 1) / 2);
  resultStageOffsetX = Math.max(-maxX, Math.min(maxX, resultStageDragOriginX + deltaX));
  resultStageOffsetY = Math.max(-maxY, Math.min(maxY, resultStageDragOriginY + deltaY));
  applyResultStageView();
  if (event && typeof event.preventDefault === "function") event.preventDefault();
}

function endResultStagePan() {
  if (!resultStageDragging) return;
  resultStageDragging = false;
  resultStageSuppressClickUntil = resultStageDragMoved ? Date.now() + 250 : 0;
  applyResultStageView();
}

function handleResultStageClick(event) {
  if (Date.now() < resultStageSuppressClickUntil) {
    resultStageSuppressClickUntil = 0;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    return;
  }
  openResultPreview();
}

function beginResultPreviewPan(event) {
  focusResultPreviewViewport();
  const button = Number(event && event.button);
  if (Number.isFinite(button) && button !== 0) return;
  if (!elements.resultPreviewViewport.classList.contains("is-zoomed")) return;
  resultPreviewDragging = true;
  resultPreviewDragStartX = Number(event.clientX) || 0;
  resultPreviewDragStartY = Number(event.clientY) || 0;
  resultPreviewDragScrollLeft = Number(elements.resultPreviewViewport.scrollLeft) || 0;
  resultPreviewDragScrollTop = Number(elements.resultPreviewViewport.scrollTop) || 0;
  elements.resultPreviewViewport.classList.add("is-panning");
  if (event && typeof event.preventDefault === "function") event.preventDefault();
}

function moveResultPreviewPan(event) {
  if (!resultPreviewDragging) return;
  const deltaX = (Number(event.clientX) || 0) - resultPreviewDragStartX;
  const deltaY = (Number(event.clientY) || 0) - resultPreviewDragStartY;
  elements.resultPreviewViewport.scrollLeft = resultPreviewDragScrollLeft - deltaX;
  elements.resultPreviewViewport.scrollTop = resultPreviewDragScrollTop - deltaY;
  event.preventDefault();
}

function endResultPreviewPan() {
  resultPreviewDragging = false;
  elements.resultPreviewViewport.classList.remove("is-panning");
}

function finishResultPreviewOpen() {
  if (!resultPreviewPendingResultId) return;
  const result = getSelectedResult();
  if (!result || result.id !== resultPreviewPendingResultId) {
    resultPreviewPendingResultId = null;
    return;
  }
  resultPreviewPendingResultId = null;
  if (elements.resultPreviewResolution) {
    elements.resultPreviewResolution.textContent = resultDimensionsLabel(result);
  }
  resultPreviewZoom = 1;
  document.body.classList.add("is-result-preview-open");
  elements.resultPreviewOverlay.classList.remove("is-hidden");
  applyResultPreviewZoom();
  focusResultPreviewViewport();
  setTimeout(applyResultPreviewZoom, 0);
  setTimeout(focusResultPreviewViewport, 0);
}

function handleResultPreviewImageLoad() {
  if (resultPreviewPendingResultId) finishResultPreviewOpen();
  if (!elements.resultPreviewOverlay.classList.contains("is-hidden")) {
    applyResultPreviewZoom();
    setTimeout(applyResultPreviewZoom, 0);
  }
}

async function openResultPreview() {
  const result = getSelectedResult();
  if (!result) return;
  const openRequestToken = ++resultPreviewOpenRequestToken;
  const previewReady = await ensureResultPreview(result);
  if (
    openRequestToken !== resultPreviewOpenRequestToken ||
    getSelectedResult() !== result
  ) return;
  if (!previewReady && !result.file) return;
  const sourceReady = (
    resultPreviewSourceResultId === result.id &&
    Number(elements.resultPreviewImage.naturalWidth) > 0 &&
    Number(elements.resultPreviewImage.naturalHeight) > 0
  );
  resultPreviewPendingResultId = result.id;
  resultPreviewZoom = 1;
  document.body.classList.add("is-result-preview-open");
  elements.resultPreviewOverlay.classList.remove("is-hidden");
  if (sourceReady) {
    finishResultPreviewOpen();
    return;
  }
  if (!setImageSource(elements.resultPreviewImage, result)) {
    closeResultPreview();
    return;
  }
  resultPreviewSourceResultId = result.id;
  finishResultPreviewOpen();
}

function closeResultPreview() {
  resultPreviewOpenRequestToken += 1;
  endResultPreviewPan();
  if (resultPreviewWheelTimer !== null) clearTimeout(resultPreviewWheelTimer);
  resultPreviewWheelTimer = null;
  resultPreviewPendingWheel = null;
  resultPreviewPendingResultId = null;
  document.body.classList.remove("is-result-preview-open");
  elements.resultPreviewOverlay.classList.add("is-hidden");
  elements.resultPreviewImage.removeAttribute("src");
  elements.resultPreviewImage.style.width = "";
  elements.resultPreviewImage.style.height = "";
  elements.resultPreviewViewport.classList.remove("is-zoomed");
  elements.resultPreviewViewport.scrollLeft = 0;
  elements.resultPreviewViewport.scrollTop = 0;
  resultPreviewSourceResultId = null;
  resultPreviewZoom = 1;
  syncResultPreviewRetention();
}

async function saveResultPreviewToLocal() {
  const result = getSelectedResult();
  if (!result) {
    setStatus("warning", "没有可保存的图片", "请先打开一张生成结果");
    return;
  }
  try {
    if (!result.file) throw new Error("生成图原文件已不可用，请重新生成");
    const bytes = exactArrayBuffer(await result.file.read({ format: formats.binary }));
    const detected = detectImageType(bytes);
    const ext = detected.extension;
    const filename = `即杏智绘_生成图_${String(result.sequence || result.id || "preview").replace(/[^\w\u4e00-\u9fa5-]+/g, "_")}.${ext}`;
    const destination = await localFileSystem.getFileForSaving(filename, { types: [ext] });
    if (!destination) {
      setStatus("idle", "已取消保存", "没有写入文件");
      return;
    }
    await destination.write(bytes, { format: formats.binary });
    setStatus("success", "已保存至本地", filename);
  } catch (error) {
    setStatus("error", "保存失败", error.message || error);
  }
}

async function copyResultPromptToClipboard(resultId = "") {
  const result = resultId
    ? state.results.find((item) => item.id === resultId)
    : getSelectedResult();
  if (!result) {
    setStatus("warning", "没有可复制的提示词", "请先打开一张生成结果");
    return;
  }
  const archive = ensureResultTaskArchive(result) || {};
  const prompt = String(result.prompt || archive.prompt || "").trim();
  if (!prompt) {
    setStatus("warning", "没有保存的提示词", "这张历史图没有可复制的原始提示词");
    return;
  }
  try {
    // Use the native UXP clipboard after declaring its manifest permission.
    // Browser and selection fallbacks keep older Photoshop builds usable.
    let copied = false;
    if (uxp.clipboard && typeof uxp.clipboard.writeText === "function") {
      try {
        await uxp.clipboard.writeText(prompt);
        copied = true;
      } catch (_) {
        // Fall through to browser and selection fallbacks.
      }
    }
    if (!copied && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(prompt);
        copied = true;
      } catch (_) {
        // Fall through to the selection-based fallback below.
      }
    }
    if (!copied) {
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      if (!copied) {
        textarea.setAttribute("aria-label", "已选中的提示词，请按 Ctrl+C 复制");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.opacity = "0.01";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        setStatus("warning", "提示词已选中", "当前 Photoshop 不开放系统剪贴板，请按 Ctrl+C 完成复制");
        return;
      }
      textarea.remove();
    }
    if (copied) setStatus("success", "提示词已复制", "已复制当前生成图保存的原始提示词");
  } catch (error) {
    setStatus("error", "复制失败", error.message || error);
  }
}

function renderTaskDrawer(result) {
  if (!result) return false;
  const archive = ensureResultTaskArchive(result) || {};
  const requested = result.requested || archive.requested || {};
  const modelName = archive.modelLabel || requested.modelLabel || getModelConfig(archive.model || requested.model).shortLabel;
  const resolution = archive.resolution || requested.resolution || "";
  const dimensions = Number(result.width) > 0 && Number(result.height) > 0
    ? `${result.width} × ${result.height}`
    : "--";
  elements.taskDrawerTitle.textContent = `生成图 ${result.sequence}`;
  elements.taskDrawerModel.textContent = `模型：${modelName || "--"}`;
  elements.taskDrawerSize.textContent = `尺寸：${resolution ? `${resolution} · ` : ""}${dimensions}`;
  elements.taskDrawerTime.textContent = `时间：${formatResultTime(result.createdAt) || "--"}`;
  elements.taskDrawerPrompt.textContent = String(result.prompt || archive.prompt || "未保存提示词");
  const archivedReferences = Array.isArray(archive.references) ? archive.references : [];
  const expectedReferenceCount = inferredTaskReferenceCount(result, archive);
  const availableReferenceCount = archivedReferences.slice(0, expectedReferenceCount).filter((reference) => Boolean(
    reference && (
      (!reference.released && reference.file) ||
      (hasPhotoshopDocument(reference.snapshot) && (() => {
        try {
          return Boolean(findOpenDocumentForSnapshot(reference.snapshot));
        } catch (_) {
          return false;
        }
      })())
    )
  )).length;
  elements.taskDrawerReuse.disabled = availableReferenceCount < expectedReferenceCount;
  elements.taskDrawerInsert.disabled = false;
  elements.taskDrawerInsert.textContent = elements.insert.textContent || "插入图层";
  return setImageSource(elements.taskDrawerImage, result);
}

function openTaskDrawer() {
  const result = getSelectedResult();
  if (!result || !renderTaskDrawer(result)) return;
  taskDrawerResultId = result.id;
  if (!elements.resultPreviewOverlay.classList.contains("is-hidden")) closeResultPreview();
  document.body.classList.add("is-task-drawer-open");
  elements.taskDrawerOverlay.classList.remove("is-drawer-hidden");
}

function closeTaskDrawer() {
  document.body.classList.remove("is-task-drawer-open");
  elements.taskDrawerOverlay.classList.add("is-drawer-hidden");
  elements.taskDrawerImage.removeAttribute("src");
  taskDrawerResultId = null;
  syncResultPreviewRetention();
}

function formatResultTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function renderSelectedResult() {
  resetResultStageView();
  const result = getSelectedResult();
  if (!result) {
    elements.resultImage.classList.add("is-hidden");
    elements.resultImage.removeAttribute("src");
    elements.resultEmpty.classList.remove("is-hidden");
    elements.insert.textContent = "插入图层";
    updateControls();
    return;
  }

  setImageSource(elements.resultImage, result);
  elements.resultImage.classList.remove("is-hidden");
  elements.resultEmpty.classList.add("is-hidden");
  if (canInsertResultIntoCurrentDocument(result)) {
    const supportsPrecisePlacement = hasPhotoshopTarget(result.snapshot);
    elements.insert.textContent = result.insertedAt
      ? (supportsPrecisePlacement && elements.precisionPlacement.checked ? "再次精确插入" : "再次插入")
      : "插入图层";
  } else {
    elements.insert.textContent = result.openedAt ? "再次在 PS 打开" : "在 PS 中打开";
  }
  updateControls();
}

function computeGenerationVisualProgress(job, now = Date.now()) {
  const requestedCount = Math.max(1, Number(job && job.requestedCount) || 1);
  const settledCount = Math.max(0, Math.min(requestedCount, Number(job && job.settledCount) || 0));
  const previous = Number(job.visualProgress) || 8;
  if (job.progressCompleting) {
    return Math.min(96, Math.max(8, previous));
  }
  if (["complete", "failed", "stopped"].includes(job.status)) {
    return 100;
  }
  if (settledCount >= requestedCount) {
    return Math.min(96, Math.max(8, previous));
  }

  const createdAt = job.createdAt instanceof Date
    ? job.createdAt.getTime()
    : new Date(job.createdAt || now).getTime();
  const elapsedSeconds = Math.max(0, (now - (Number.isFinite(createdAt) ? createdAt : now)) / 1000);
  const pendingEstimate = 8 + 88 * (1 - Math.exp(-elapsedSeconds / 55));
  const settledRatio = settledCount / requestedCount;
  const combinedEstimate = settledRatio * 100 + (1 - settledRatio) * pendingEstimate;
  return Math.min(96, Math.max(8, previous, combinedEstimate));
}

function generationProgressActivity(job) {
  if (job.status === "stopping") return "停止中";
  if (job.status === "recovering") return "从历史找回中";
  if (job.status === "complete") return "已完成";
  if (job.status === "stopped") return "已停止";
  if (job.status === "failed") return "已结束";
  return job.settledCount > 0 ? "继续生成中" : "生成中";
}

function generationPulsePosition(job, now = Date.now()) {
  const offset = (Number(job && job.sequence) || 0) * 3;
  const step = (Math.floor(now / GENERATION_PROGRESS_TICK_MS) + offset) % 20;
  return step <= 10 ? step * 10 : (20 - step) * 10;
}

function updateGenerationProgressVisuals() {
  if (!state.generationJobs.length) return;
  const now = Date.now();
  const items = elements.generationQueue
    ? Array.from(elements.generationQueue.children || [])
    : [];
  const historyItems = elements.resultHistory
    ? Array.from(elements.resultHistory.children || [])
    : [];
  state.generationJobs.forEach((job) => {
    const progress = computeGenerationVisualProgress(job, now);
    job.visualProgress = progress;
    const item = items.find((candidate) => (
      candidate.getAttribute &&
      candidate.getAttribute("data-generation-job-id") === job.id
    ));
    if (item) {
      const track = item.querySelector(".generation-job-progress");
      const fill = item.querySelector(".generation-job-progress-fill");
      if (track) {
        track.setAttribute("aria-valuenow", String(Math.round(progress)));
        track.setAttribute(
          "aria-valuetext",
          `${generationProgressActivity(job)}，已完成 ${job.completedCount} / ${job.requestedCount}`
        );
      }
      if (fill) {
        fill.style.width = `${Math.min(100, progress)}%`;
        fill.style.backgroundPosition = `${generationPulsePosition(job, now)}% 0`;
      }
    }

    const historyItem = historyItems.find((candidate) => (
      candidate.getAttribute &&
      candidate.getAttribute("data-generation-job-id") === job.id
    ));
    if (!historyItem) return;
    const historyTrack = historyItem.querySelector(".history-running-progress");
    const historyFill = historyItem.querySelector(".history-running-progress-fill");
    if (historyTrack) {
      historyTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
      historyTrack.setAttribute(
        "aria-valuetext",
        `${generationProgressActivity(job)}，已完成 ${job.completedCount} / ${job.requestedCount}`
      );
    }
    if (historyFill) {
      historyFill.style.width = `${Math.min(100, progress)}%`;
      historyFill.style.backgroundPosition = `${generationPulsePosition(job, now)}% 0`;
    }
    const mascot = historyItem.querySelector(".history-running-mascot");
    const mascotShell = historyItem.querySelector(".history-running-mascot-shell");
    const phase = (Math.floor(now / GENERATION_PROGRESS_TICK_MS) + (Number(job.sequence) || 0)) % 4;
    const positions = [
      { y: 2, rotation: -2, scale: 0.96 },
      { y: -2, rotation: 0, scale: 1 },
      { y: -6, rotation: 2, scale: 1.04 },
      { y: -1, rotation: 0, scale: 1 }
    ];
    const frame = positions[phase];
    if (mascot) {
      mascot.style.transform = `translateY(${frame.y}px) rotate(${frame.rotation}deg) scale(${frame.scale})`;
    }
    if (mascotShell) {
      mascotShell.style.transform = `scale(${phase % 2 === 0 ? 0.96 : 1})`;
      mascotShell.style.opacity = phase % 2 === 0 ? "0.82" : "1";
    }
  });
}

function syncGenerationProgressTimer() {
  if (state.generationJobs.length) {
    if (generationProgressTimer === null) {
      generationProgressTimer = setInterval(
        updateGenerationProgressVisuals,
        GENERATION_PROGRESS_TICK_MS
      );
    }
    return;
  }
  if (generationProgressTimer !== null) {
    clearInterval(generationProgressTimer);
    generationProgressTimer = null;
  }
}

function waitForGenerationProgressCompletion() {
  return new Promise((resolve) => {
    setTimeout(resolve, GENERATION_PROGRESS_COMPLETION_MS);
  });
}

function waitForGenerationProgressFrame() {
  return new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
}

function renderGenerationQueue() {
  if (elements.generationQueue) {
    while (elements.generationQueue.firstChild) {
      elements.generationQueue.removeChild(elements.generationQueue.firstChild);
    }
    elements.generationQueue.classList.add("is-hidden");
  }
  syncGenerationProgressTimer();
  renderResultHistory();
  updateGenerationProgressVisuals();
  renderTaskCenterSummary();
  updateControls();
}

function createRunningHistoryItem(job) {
  const item = document.createElement("div");
  item.className = "result-history-item is-running";
  item.setAttribute("data-generation-job-id", job.id);
  item.setAttribute("role", "status");
  const mascotShell = document.createElement("span");
  mascotShell.className = "history-running-mascot-shell";
  mascotShell.setAttribute("aria-hidden", "true");
  const mascot = document.createElement("img");
  mascot.className = "history-running-mascot";
  mascot.src = "assets/animal-island-ui/images/generation-loading.png";
  mascot.alt = "";
  mascot.draggable = false;
  mascotShell.appendChild(mascot);
  const number = document.createElement("span");
  number.className = "history-number";
  const label = document.createElement("span");
  label.className = "history-running-label";
  const progressTrack = document.createElement("span");
  progressTrack.className = "history-running-progress";
  progressTrack.setAttribute("role", "progressbar");
  progressTrack.setAttribute("aria-label", "生成进度");
  progressTrack.setAttribute("aria-valuemin", "0");
  progressTrack.setAttribute("aria-valuemax", "100");
  progressTrack.setAttribute("aria-valuenow", "8");
  const progressFill = document.createElement("span");
  progressFill.className = "history-running-progress-fill";
  progressTrack.appendChild(progressFill);
  item.appendChild(mascotShell);
  item.appendChild(number);
  item.appendChild(label);
  item.appendChild(progressTrack);
  return item;
}

function updateRunningHistoryItem(item, job) {
  item.title = `任务 ${job.sequence} · ${generationProgressActivity(job)} · ${truncatePromptLabel(job.prompt, 36)}`;
  const number = item.querySelector(".history-number");
  const label = item.querySelector(".history-running-label");
  if (number) number.textContent = String(job.sequence);
  if (label) label.textContent = `${job.completedCount || 0}/${job.requestedCount || 1}`;
}

function createHistoryTextAction(className, label, attribute, resultId, accessibleLabel) {
  // UXP native buttons flatten child labels and impose native text insets.
  // A focusable text control keeps both characters visible at this size.
  const control = document.createElement("span");
  control.className = `${className} history-text-action`;
  control.textContent = label;
  control.setAttribute("role", "button");
  control.setAttribute("tabindex", "0");
  control.setAttribute("aria-label", accessibleLabel);
  control.setAttribute(attribute, resultId);
  control.title = accessibleLabel;
  return control;
}

function createResultHistoryItem(result) {
  const item = document.createElement("div");
  item.className = "result-history-item";
  item.setAttribute("data-result-id", result.id);
  item.setAttribute("role", "button");
  item.setAttribute("tabindex", "0");
  item.addEventListener("click", (event) => {
    if (event.target.closest && event.target.closest(".history-remove, .history-text-action")) return;
    const wasSelected = item.classList.contains("is-selected");
    Array.from(elements.resultHistory.children || []).forEach((child) => {
      if (child.classList && child.classList.contains("result-history-item")) child.classList.remove("is-selected");
    });
    if (!wasSelected) item.classList.add("is-selected");
  });
  const image = document.createElement("img");
  image.alt = `生成历史 ${result.sequence}`;
  image.setAttribute("data-result-preview", result.id);
  image.setAttribute("draggable", "false");
  setImageSource(image, result);
  const number = document.createElement("span");
  number.className = "history-number";
  const resolution = document.createElement("span");
  resolution.className = "history-resolution";
  resolution.textContent = resultDimensionsLabel(result);
  const remove = document.createElement("span");
  remove.className = "history-remove";
  remove.textContent = "×";
  remove.setAttribute("data-result-delete", result.id);
  remove.setAttribute("role", "button");
  remove.setAttribute("tabindex", "0");
  item.appendChild(image);
  item.appendChild(number);
  item.appendChild(resolution);
  item.appendChild(remove);
  item.appendChild(createHistoryTextAction("history-copy-prompt", "复制", "data-result-copy-prompt", result.id, "复制提示词"));
  if (result.taskArchive && Array.isArray(result.taskArchive.references)) {
    item.appendChild(createHistoryTextAction("history-restore", "复用", "data-result-restore", result.id, "复用"));
  }
  item.appendChild(createHistoryTextAction("history-save", "保存", "data-result-save", result.id, "保存图片"));
  return item;
}

function createResultHistoryPlaceholder(index) {
  const item = document.createElement("div");
  item.className = "result-history-item is-placeholder";
  item.setAttribute("data-result-placeholder", String(index));
  item.setAttribute("aria-hidden", "true");
  return item;
}

function updateResultHistoryItem(item, result) {
  const selected = result.id === state.selectedResultId;
  item.classList.toggle("is-active", selected);
  item.classList.toggle("is-inserted", Boolean(result.insertedAt || result.openedAt));
  item.setAttribute("aria-label", `查看第 ${result.sequence} 张生成图`);
  item.title = `${formatResultTime(result.createdAt)} · ${truncatePromptLabel(result.prompt, 46)}`;
  const number = item.querySelector(".history-number");
  const image = item.querySelector("[data-result-preview]");
  const resolution = item.querySelector(".history-resolution");
  const remove = item.querySelector(".history-remove");
  const copyPrompt = item.querySelector(".history-copy-prompt");
  const restore = item.querySelector(".history-restore");
  if (number) number.textContent = String(result.sequence);
  if (image) setImageSource(image, result);
  if (resolution) resolution.textContent = resultDimensionsLabel(result);
  if (remove) remove.setAttribute("aria-label", `删除第 ${result.sequence} 张生成图`);
  if (copyPrompt) copyPrompt.setAttribute("aria-label", `复制第 ${result.sequence} 张生成图的提示词`);
  if (restore) restore.setAttribute("aria-label", `复用任务 ${result.taskArchive.sequence || result.sequence} 的参考图、提示词和尺寸`);
}

function resultDimensionsLabel(result) {
  if (!result) return "--";
  const width = Math.round(Number(result.width) || 0);
  const height = Math.round(Number(result.height) || 0);
  if (width > 0 && height > 0) return `${width}×${height}`;
  const requested = result.requested || {};
  return String(requested.resolution || result.resolution || "--");
}

function referenceDimensionsLabel(reference) {
  if (!reference) return "--";
  const snapshot = reference.snapshot || {};
  const width = Math.round(Number(snapshot.sourcePixelWidth) || Number(reference.bounds && reference.bounds.width) || 0);
  const height = Math.round(Number(snapshot.sourcePixelHeight) || Number(reference.bounds && reference.bounds.height) || 0);
  return width > 0 && height > 0 ? `${width}×${height}` : "--";
}

function renderResultHistory() {
  const hasRunningJobs = state.generationJobs.length > 0;
  const totalItems = state.results.length + state.generationJobs.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / RESULT_HISTORY_PAGE_SIZE));
  state.resultHistoryPageIndex = Math.max(
    0,
    Math.min(totalPages - 1, Number(state.resultHistoryPageIndex) || 0)
  );
  const pageStart = state.resultHistoryPageIndex * RESULT_HISTORY_PAGE_SIZE;
  // Running jobs occupy as many pages as needed before completed results.
  const visibleJobs = state.generationJobs.slice(pageStart, pageStart + RESULT_HISTORY_PAGE_SIZE);
  const resultStart = Math.max(0, pageStart - state.generationJobs.length);
  const visibleResults = state.results.slice(
    resultStart,
    resultStart + Math.max(0, RESULT_HISTORY_PAGE_SIZE - visibleJobs.length)
  );
  visibleResultPreviewIds = new Set(visibleResults.map((result) => result.id));
  const existingResults = new Map();
  const existingJobs = new Map();
  const existingPlaceholders = new Map();
  Array.from(elements.resultHistory.children || []).forEach((child) => {
    const resultId = child.getAttribute && child.getAttribute("data-result-id");
    const jobId = child.getAttribute && child.getAttribute("data-generation-job-id");
    const placeholderId = child.getAttribute && child.getAttribute("data-result-placeholder");
    if (resultId) existingResults.set(resultId, child);
    if (jobId) existingJobs.set(jobId, child);
    if (placeholderId) existingPlaceholders.set(placeholderId, child);
  });
  const desiredNodes = [];
  if (!state.results.length && !hasRunningJobs) {
    let empty = elements.resultHistory.querySelector(".result-history-empty");
    if (!empty) empty = document.createElement("span");
    empty.className = "result-history-empty";
    empty.textContent = "生成后的图片会保留在这里";
    desiredNodes.push(empty);
  } else {
    visibleJobs.forEach((job) => {
      const item = existingJobs.get(job.id) || createRunningHistoryItem(job);
      updateRunningHistoryItem(item, job);
      desiredNodes.push(item);
    });
    visibleResults.forEach((result) => {
      const item = existingResults.get(result.id) || createResultHistoryItem(result);
      updateResultHistoryItem(item, result);
      desiredNodes.push(item);
    });
    for (let index = desiredNodes.length; index < RESULT_HISTORY_PAGE_SIZE; index += 1) {
      desiredNodes.push(existingPlaceholders.get(String(index)) || createResultHistoryPlaceholder(index));
    }
  }

  const desiredSet = new Set(desiredNodes);
  Array.from(elements.resultHistory.children || []).forEach((child) => {
    if (!desiredSet.has(child)) elements.resultHistory.removeChild(child);
  });
  // Keep generation history isolated from the reference-image controls.
  // The reference add tile belongs to #referenceList and must never be
  // reparented into #resultHistory during a history refresh.
  const orderedNodes = desiredNodes;
  orderedNodes.forEach((node, index) => {
    const current = elements.resultHistory.children[index];
    if (current !== node) elements.resultHistory.insertBefore(node, current || null);
  });

  syncResultHistoryTileLayout();
  scheduleResultHistoryTileLayout();
  renderResultHistoryPagination(totalPages, totalItems);
  renderTaskCenterSummary();
  renderSelectedResult();
  syncResultPreviewRetention();
}

function renderResultHistoryPagination(totalPages, totalItems) {
  if (!elements.resultHistoryPagination) return;
  const previous = elements.resultHistoryPrevious;
  const next = elements.resultHistoryNext;
  const totalLabel = elements.resultHistoryTotal;
  const pageButtons = elements.resultHistoryPageButtons;
  elements.resultHistoryPagination.classList.toggle("is-hidden", totalPages <= 1 && totalItems === 0);
  if (previous) previous.disabled = state.resultHistoryPageIndex <= 0;
  if (next) next.disabled = state.resultHistoryPageIndex >= totalPages - 1;
  if (totalLabel) totalLabel.textContent = `共 ${state.results.length} / ${MAX_RESULTS} 张`;
  if (!pageButtons) return;
  while (pageButtons.firstChild) pageButtons.removeChild(pageButtons.firstChild);
  const currentPage = state.resultHistoryPageIndex + 1;
  const pageItems = [];
  if (totalPages <= 7) {
    for (let page = 1; page <= totalPages; page += 1) pageItems.push(page);
  } else {
    pageItems.push(1);
    if (currentPage <= 3) {
      for (let page = 2; page <= Math.min(totalPages - 1, currentPage + 1); page += 1) {
        pageItems.push(page);
      }
      if (currentPage + 1 < totalPages - 1) pageItems.push("…");
    } else {
      if (currentPage >= 4) pageItems.push("…");
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);
      for (let page = start; page <= end; page += 1) pageItems.push(page);
      if (end < totalPages - 1) pageItems.push("…");
    }
    pageItems.push(totalPages);
  }
  pageItems.forEach((page) => {
    if (page === "…") {
      const ellipsis = document.createElement("span");
      ellipsis.className = "result-history-ellipsis";
      ellipsis.textContent = "…";
      ellipsis.setAttribute("aria-hidden", "true");
      pageButtons.appendChild(ellipsis);
      return;
    }
    const button = document.createElement("span");
    button.className = "result-history-page-button";
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    const pageText = document.createElement("span");
    pageText.className = "result-history-page-label";
    pageText.textContent = String(page);
    button.appendChild(pageText);
    button.setAttribute("data-result-history-page", String(page - 1));
    button.setAttribute("aria-label", `第 ${page} 页`);
    if (page === currentPage) {
      button.classList.add("is-active");
      button.setAttribute("aria-current", "page");
    }
    pageButtons.appendChild(button);
  });
}

function setResultHistoryPage(pageIndex) {
  const totalItems = state.results.length + state.generationJobs.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / RESULT_HISTORY_PAGE_SIZE));
  const nextPage = Math.max(0, Math.min(totalPages - 1, Number(pageIndex) || 0));
  if (nextPage === state.resultHistoryPageIndex) return;
  state.resultHistoryPageIndex = nextPage;
  renderResultHistory();
}

function updateResultHistorySelection() {
  const items = Array.from(elements.resultHistory.children || []);
  items.forEach((item) => {
    const resultId = item.getAttribute && item.getAttribute("data-result-id");
    if (!resultId) return;
    const selected = resultId === state.selectedResultId;
    item.classList.toggle("is-active", selected);
  });
  renderTaskCenterSummary();
}

function selectResult(resultId) {
  const result = state.results.find((item) => item.id === resultId);
  if (!result) return;
  state.selectedResultId = resultId;
  state.selectionRevision += 1;
  updateResultHistorySelection();
  renderSelectedResult();
  const actionText = canInsertResultIntoCurrentDocument(result) ? "插入图层" : "在 PS 中打开";
  setStatus(
    state.running ? "working" : "idle",
    `已选择生成图 ${result.sequence}`,
    state.running ? `其他图片仍在并发生成；当前结果可以先${actionText}` : `可预览或点击“${actionText}”`
  );
  renderTaskCenterSummary();
}

function handleHistoryPreviewClick(resultId, event) {
  const now = Date.now();
  const isSecondClick = lastHistoryPreviewClickId === resultId && now - lastHistoryPreviewClickAt <= 550;
  lastHistoryPreviewClickId = resultId;
  lastHistoryPreviewClickAt = now;
  selectResult(resultId);
  if (!isSecondClick) return;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  lastHistoryPreviewClickId = "";
  lastHistoryPreviewClickAt = 0;
  openResultPreview();
}

function inferredTaskReferenceCount(result, taskArchive) {
  const prompt = [
    result && result.requestPrompt,
    taskArchive && taskArchive.requestPrompt,
    taskArchive && taskArchive.prompt,
    result && result.prompt
  ].map((value) => String(value || "")).filter(Boolean).join("\n");
  let count = Array.isArray(taskArchive && taskArchive.references)
    ? taskArchive.references.length
    : 0;
  const numericReferencePatterns = [
    /\[\s*\u9644\u56fe\s*(\d+)/gi,
    /@\s*\u56fe\u7247\s*(\d+)/gi,
    /\u56fe\u7247\s*(\d+)/gi
  ];
  numericReferencePatterns.forEach((pattern) => {
    let match = null;
    while ((match = pattern.exec(prompt))) count = Math.max(count, Number(match[1]) || 0);
  });
  for (let index = 1; index <= MAX_REFERENCES; index += 1) {
    const ordinal = formatReferenceOrdinal(index);
    if (
      prompt.includes(`图${ordinal}`) ||
      prompt.includes(`图片${ordinal}`) ||
      prompt.includes(`@图${ordinal}`) ||
      prompt.includes(`@图片${ordinal}`)
    ) count = Math.max(count, index);
  }
  const maximum = String(taskArchive && taskArchive.localEditMode || "") === "outfit"
    ? MAX_OUTFIT_REFERENCES
    : MAX_REFERENCES;
  return Math.max(1, Math.min(maximum, count));
}

function legacyReferenceCaptureInfo(file) {
  const name = String(file && file.name || "");
  const match = /^katu-reference-(\d+)-(\d+)\.(jpe?g|png|webp)$/i.exec(name);
  if (!match) return null;
  return {
    file,
    name,
    timestamp: Number(match[1]) || 0,
    sequence: Number(match[2]) || 0,
    sourceReferenceId: `ref-${match[1]}-${match[2]}`
  };
}

async function buildLegacyReferenceFromFile(info, snapshot, index) {
  const buffer = exactArrayBuffer(await info.file.read({ format: formats.binary }));
  const detected = detectImageType(buffer);
  const referenceSnapshot = snapshot || {
    id: `legacy-${info.timestamp}-${info.sequence}`,
    sourceReferenceId: info.sourceReferenceId,
    mode: "import",
    documentId: null,
    documentTitle: "",
    documentWidth: detected.width,
    documentHeight: detected.height,
    documentResolution: 72,
    documentMode: null,
    bounds: { left: 0, top: 0, right: detected.width, bottom: detected.height, width: detected.width, height: detected.height },
    editBounds: null,
    localEditMode: "",
    solid: true,
    mask: null,
    layerId: null,
    layerName: `旧任务参考图 ${index + 1}`,
    insertionAnchorLayerId: null,
    insertionAnchorLayerName: "",
    insertionAnchorParentId: null,
    capturedAt: new Date(info.timestamp || Date.now())
  };
  const reference = {
    id: String(referenceSnapshot.sourceReferenceId || info.sourceReferenceId),
    mode: String(referenceSnapshot.mode || "import"),
    file: info.file,
    mime: detected.mime,
    previewUrl: null,
    bounds: referenceSnapshot.bounds,
    snapshot: referenceSnapshot,
    layerName: String(referenceSnapshot.layerName || `旧任务参考图 ${index + 1}`),
    capturedAt: referenceSnapshot.capturedAt,
    inReferenceList: false,
    resultOwners: 0,
    released: false,
    legacyRecovered: true
  };
  await createReferencePreview(reference);
  return reference;
}

async function recoverLegacyTaskReferencesFromTemp(taskArchive, result, expectedCount) {
  const snapshot = result && result.snapshot;
  const primaryId = String(snapshot && snapshot.sourceReferenceId || "");
  if (!primaryId || expectedCount <= 0) return [];
  const temporaryFolder = await localFileSystem.getTemporaryFolder();
  const entries = await temporaryFolder.getEntries();
  const captures = Array.from(entries || []).map(legacyReferenceCaptureInfo).filter(Boolean);
  const primary = captures.find((capture) => capture.sourceReferenceId === primaryId);
  if (!primary) return [];

  const nearby = captures
    .filter((capture) => (
      Math.abs(primary.timestamp - capture.timestamp) <= 30 * 60 * 1000
    ))
    .sort((left, right) => left.timestamp - right.timestamp || left.sequence - right.sequence);
  const primaryIndex = nearby.findIndex((capture) => capture.sourceReferenceId === primaryId);
  const startIndex = Math.max(0, Math.min(primaryIndex, nearby.length - expectedCount));
  const ordered = nearby.slice(startIndex, startIndex + expectedCount);
  if (ordered.length < expectedCount) return [];

  const references = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const reference = await buildLegacyReferenceFromFile(
      ordered[index],
      ordered[index].sourceReferenceId === primaryId ? snapshot : null,
      index
    );
    if (String(taskArchive && taskArchive.localEditMode || "") === "outfit") {
      const garmentCount = outfitSlotLabels(taskArchive && taskArchive.outfitType).length;
      const backgroundIndex = garmentCount + 2;
      const legacyHasBackground = expectedCount > backgroundIndex;
      reference.outfitRole = index === 0
        ? "target"
        : (index === 1
          ? "face"
          : (legacyHasBackground && index === backgroundIndex
            ? "background"
            : (index === 2 ? "full-or-upper" : (index === 3 ? "pants" : "shoes"))));
      reference.outfitSlotIndex = index >= 2 && (!legacyHasBackground || index < backgroundIndex) ? index - 2 : -1;
    }
    references.push(reference);
  }
  taskArchive.references = references;
  taskArchive.reconstructed = false;
  taskArchive.legacyMigrated = true;
  return references;
}

async function recaptureTaskArchiveReferences(taskArchive, result, poolSwapped = false) {
  if (String(taskArchive && taskArchive.localEditMode || "") === "outfit" && !poolSwapped) {
    const references = await withOutfitReferencePool(() => recaptureTaskArchiveReferences(taskArchive, result, true));
    // The archive may still contain the old pool object after a successful
    // recapture. Remove the duplicate panel ownership before the caller puts
    // these references into the outfit workspace.
    references.forEach((reference) => {
      const index = state.outfitReferences.indexOf(reference);
      if (index >= 0) state.outfitReferences.splice(index, 1);
      reference.inReferenceList = false;
    });
    return references;
  }
  if (String(taskArchive && taskArchive.localEditMode || "") === "product" && !poolSwapped) {
    const references = await withProductReferencePool(() => recaptureTaskArchiveReferences(taskArchive, result, true));
    references.forEach((reference) => {
      const index = productReferencePool().indexOf(reference);
      if (index >= 0) productReferencePool().splice(index, 1);
      reference.inReferenceList = false;
    });
    return references;
  }
  const archivedReferences = Array.isArray(taskArchive && taskArchive.references)
    ? taskArchive.references
    : [];
  const expectedCount = inferredTaskReferenceCount(result, taskArchive);
  if (archivedReferences.length < expectedCount) {
    throw new Error(`旧历史只保存了 ${archivedReferences.length} 张素材信息，还缺少 ${expectedCount - archivedReferences.length} 张；请按原顺序重新添加后再复用`);
  }

  const previousReferences = state.references.splice(0);
  const previousTargetSnapshot = state.targetSnapshot;
  const capturedReferences = [];
  state.targetSnapshot = null;
  state.capturing = true;
  updateControls();

  try {
    for (const archivedReference of archivedReferences.slice(0, expectedCount)) {
      const snapshot = archivedReference && archivedReference.snapshot;
      if (hasPhotoshopDocument(snapshot)) {
        const mode = ["selection", "layer", "canvas"].includes(String(snapshot.mode || ""))
          ? String(snapshot.mode)
          : "canvas";
        const reference = await captureSource(mode, {
          batchManaged: true,
          silentStatus: true,
          sourceSnapshot: snapshot
        });
        if (!reference) throw new Error("Photoshop 没有返回原参考素材");
        reference.outfitRole = String(archivedReference.outfitRole || "");
        reference.outfitSlotIndex = archivedReference.outfitSlotIndex;
        reference.productRole = ["main", "scene"].includes(String(archivedReference.productRole || ""))
          ? String(archivedReference.productRole)
          : "";
        capturedReferences.push(reference);
      } else if (archivedReference && archivedReference.file && !archivedReference.released) {
        capturedReferences.push(archivedReference);
      } else {
        throw new Error("原任务包含无法读取的本地导入图片，请重新导入后再运行");
      }
    }

    const restoredReferenceSet = new Set(capturedReferences);
    for (const reference of previousReferences) {
      if (!restoredReferenceSet.has(reference)) await releaseReference(reference);
    }
    taskArchive.references = capturedReferences;
    taskArchive.historyOwners = 0;
    taskArchive.reconstructed = false;
    result.taskArchive = taskArchive;
    retainTaskArchive(taskArchive);
    await queuePersistHistoryState();
    return capturedReferences;
  } catch (error) {
    const failedReferences = state.references.splice(0);
    for (const reference of failedReferences) await releaseReference(reference);
    state.references.push(...previousReferences);
    state.targetSnapshot = previousTargetSnapshot;
    renderReferences();
    throw error;
  } finally {
    state.capturing = false;
    updateControls();
  }
}

async function fillHistoryTask(resultId) {
  if (state.preparingJob || state.capturing || state.inserting) {
    setStatus("warning", "当前操作尚未完成", "请稍候再复用历史任务");
    return;
  }
  const result = state.results.find((item) => item.id === resultId);
  const taskArchive = result ? ensureResultTaskArchive(result) : null;
  if (!result || !taskArchive || !Array.isArray(taskArchive.references)) {
    setStatus("error", "无法回溯生成任务", "该历史图没有保存可恢复的任务快照");
    return;
  }
  const outfitTask = String(taskArchive.localEditMode || "") === "outfit";
  const productTask = String(taskArchive.localEditMode || "") === "product";
  const expectedReferenceCount = inferredTaskReferenceCount(result, taskArchive);
  let references = taskArchive.references.slice(0, outfitTask ? MAX_OUTFIT_REFERENCES : MAX_REFERENCES);
  const referencesIncomplete = () => (
    references.length < expectedReferenceCount ||
    references.some((reference) => !reference || reference.released || !reference.file)
  );

  if (referencesIncomplete() && taskArchive.reconstructed && !outfitTask) {
    try {
      const recovered = await recoverLegacyTaskReferencesFromTemp(taskArchive, result, expectedReferenceCount);
      if (recovered.length) references = recovered;
    } catch (_) {
      // Continue with document recovery or the current reference strip.
    }
  }

  const refreshNamedLayers = references.some((reference) => Boolean(
    reference && reference.snapshot &&
    reference.snapshot.mode === "layer" &&
    String(reference.snapshot.layerName || "").trim() &&
    hasPhotoshopDocument(reference.snapshot)
  ));

  if (referencesIncomplete() || refreshNamedLayers) {
    setStatus("working", "正在从原 Photoshop 文档恢复任务", "图层参考会优先按完整图层名称重新读取，并保持原来的图片顺序");
    try {
      const recaptured = await recaptureTaskArchiveReferences(taskArchive, result);
      if (Array.isArray(recaptured) && recaptured.length) references = recaptured;
    } catch (error) {
      const availableReferences = references.filter((reference) => Boolean(reference && !reference.released && reference.file));
      if (availableReferences.length) {
        references = availableReferences;
        setStatus(
          "warning",
          "原任务参考图恢复不完整",
          error.message || `已保留 ${availableReferences.length} 张可用参考图，缺少的那张会单独提示`
        );
      } else {
        setStatus("error", "原任务参考图恢复失败", error.message || error);
        return;
      }
    }
  }

  references = references.filter((reference) => Boolean(reference && !reference.released && reference.file));
  if (!references.length) {
    setStatus("error", "无法复用历史任务", "参考图没有成功恢复");
    return;
  }

  if (Number(taskArchive.historyOwners || 0) <= 0) retainTaskArchive(taskArchive);
  await queuePersistHistoryState();

  const desiredReferences = new Set(references);
  const destinationPool = outfitTask
    ? outfitReferencePool()
    : (productTask ? productReferencePool() : state.references);
  const previousReferences = destinationPool.splice(0);
  for (const reference of previousReferences) {
    if (!desiredReferences.has(reference)) await releaseReference(reference);
  }
  references.forEach((reference) => {
    reference.inReferenceList = true;
  });
  if (outfitTask) {
    state.outfitReferences.push(...references);
    state.outfitTargetSnapshot = hasPhotoshopTarget(taskArchive.snapshot) ? taskArchive.snapshot : null;
  } else if (productTask) {
    state.productReferences.push(...references);
    state.productTargetSnapshot = hasPhotoshopTarget(taskArchive.snapshot) ? taskArchive.snapshot : null;
  } else {
    state.references.push(...references);
    state.targetSnapshot = hasPhotoshopTarget(taskArchive.snapshot) ? taskArchive.snapshot : null;
    keepTargetReferenceFirst();
  }

  const archivedModel = String(taskArchive.model || taskArchive.requested && taskArchive.requested.model || API_CONFIG.model);
  const modelOption = elements.modelChannel.querySelector(`option[value="${archivedModel}"]`);
  const modelChanged = Boolean(modelOption && elements.modelChannel.value !== archivedModel);
  if (modelOption) elements.modelChannel.value = archivedModel;

  if (
    taskArchive.aspectRatio &&
    elements.aspectRatio.querySelector(`option[value="${taskArchive.aspectRatio}"]`)
  ) {
    elements.aspectRatio.value = taskArchive.aspectRatio;
  }
  if (["1K", "1.5K", "2K", "4K"].includes(taskArchive.resolution)) {
    elements.resolution.value = taskArchive.resolution;
  }
  if ([1, 2, 3, 4].includes(Number(taskArchive.generationCount))) {
    elements.generationCount.value = String(taskArchive.generationCount);
  }
  if (modelChanged) {
    resetPricingStateForModel();
    loadCachedPricing();
  }
  syncModelCapabilities();

  const archivedPrompt = String(taskArchive.prompt || result.prompt || "").slice(0, 20000);
  const prompt = !outfitTask && !productTask
    ? remapPromptImageMentions(archivedPrompt, references, state.references)
    : archivedPrompt;
  if (!outfitTask && !productTask) {
    setPromptValue(prompt);
    setPromptSelection(prompt.length, prompt.length, false);
    if (taskArchive.promptOptimized) markPromptOptimized(prompt);
    else state.optimizedPromptValue = "";
  }
  if (outfitTask) {
    elements.outfitPrompt.value = String(taskArchive.outfitPrompt || DEFAULT_OUTFIT_STYLE_PROMPT).slice(0, 20000);
    elements.outfitExtraPrompt.value = String(taskArchive.outfitExtraPrompt || DEFAULT_OUTFIT_EXTRA_PROMPT).slice(0, 20000);
    setSelectedOutfitType(taskArchive.outfitType || taskArchive.snapshot && taskArchive.snapshot.outfitType);
    const roleReference = (role) => references.find((reference) => reference && reference.outfitRole === role) || null;
    const targetReference = roleReference("target") || references[0] || null;
    const faceReference = roleReference("face") || references[1] || null;
    const garmentIds = ["", "", ""];
    const archivedBackgroundId = String(
      taskArchive.outfitBackgroundReferenceId || taskArchive.snapshot && taskArchive.snapshot.outfitBackgroundReferenceId || ""
    );
    if (!roleReference("background") && archivedBackgroundId) {
      const archivedBackgroundReference = references.find((reference) => (
        reference && String(reference.id || "") === archivedBackgroundId
      ));
      if (archivedBackgroundReference) {
        archivedBackgroundReference.outfitRole = "background";
        archivedBackgroundReference.outfitSlotIndex = -1;
      }
    }
    const backgroundReference = roleReference("background") || null;
    if (backgroundReference) backgroundReference.outfitSlotIndex = -1;
    references.forEach((reference, position) => {
      if (!reference || reference === targetReference || reference === faceReference || reference === backgroundReference || reference.outfitRole === "background") return;
      const storedIndex = Number(reference.outfitSlotIndex);
      const fallbackIndex = Math.max(0, position - 2);
      const hasStoredSlot = reference.outfitSlotIndex !== null && reference.outfitSlotIndex !== undefined &&
        Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < 3;
      const slotIndex = hasStoredSlot
        ? storedIndex
        : fallbackIndex;
      if (slotIndex < 3 && !garmentIds[slotIndex]) garmentIds[slotIndex] = reference.id;
    });
    state.outfitTargetReferenceId = targetReference ? targetReference.id : null;
    state.outfitFaceReferenceId = faceReference ? faceReference.id : null;
    state.outfitBackgroundReferenceId = backgroundReference ? backgroundReference.id : null;
    state.outfitGarmentReferenceIds = normalizeOutfitGarmentReferenceIds(garmentIds);
  } else if (productTask) {
    const mainReference = references.find((reference) => reference && reference.productRole === "main") || references[0] || null;
    const sceneReference = references.find((reference) => reference && reference.productRole === "scene") ||
      references.find((reference) => reference && reference !== mainReference) || null;
    if (mainReference) mainReference.productRole = "main";
    if (sceneReference) sceneReference.productRole = "scene";
    state.productReferenceIds = {
      main: mainReference ? mainReference.id : "",
      scene: sceneReference ? sceneReference.id : ""
    };
    applyProductDraft(taskArchive.product || { extraPrompt: prompt });
    if (
      taskArchive.aspectRatio &&
      elements.productAspectRatio.querySelector(`option[value="${taskArchive.aspectRatio}"]`)
    ) {
      elements.productAspectRatio.value = taskArchive.aspectRatio;
    }
    if (["1K", "1.5K", "2K", "4K"].includes(taskArchive.resolution)) {
      elements.productResolution.value = taskArchive.resolution;
    }
    if ([1, 2, 3, 4].includes(Number(taskArchive.generationCount))) {
      elements.productGenerationCount.value = String(taskArchive.generationCount);
    }
  }
  state.selectedResultId = result.id;
  state.selectionRevision += 1;

  syncIslandSelects();
  renderReferences();
  renderProductWorkspace();
  renderResultHistory();
  elements.precisionPlacement.checked = outfitTask
    ? hasPhotoshopTarget(taskArchive.snapshot)
    : Boolean(taskArchive.precisionPlacement);
  syncOutfitControlsFromMain();
  showWorkspace("editor");
  updatePromptCount();
  updateResolvedSize();
  saveSettings();
  setStatus(
    state.running ? "working" : "success",
    `已复用任务 ${taskArchive.sequence}`,
    `已恢复 ${references.length} 张参考图、原提示词、${getSelectedModelConfig().shortLabel}、${taskArchive.resolution} 和 ${taskArchive.generationCount} 张生成数量`
  );
  if (modelChanged) refreshLivePricing("history-task").catch(() => {});
}

function promptReferenceMentionRanges(value) {
  const ranges = [];
  const matcher = /@(?:图片|图层|选区|全图|图)(?:[一二三四五六七八九十百零〇两\d]+)?/g;
  const text = String(value || "");
  let match = null;
  while ((match = matcher.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length, token: match[0] });
    if (!match[0].length) matcher.lastIndex += 1;
  }
  return ranges;
}

function normalizePromptSelectionAroundMentions(value, selection) {
  if (!selection) return null;
  let start = Math.max(0, Math.min(String(value || "").length, Number(selection.start) || 0));
  let end = Math.max(start, Math.min(String(value || "").length, Number(selection.end) || start));
  for (const range of promptReferenceMentionRanges(value)) {
    if (start === end && start > range.start && start < range.end) {
      start = range.end;
      end = range.end;
      break;
    }
    if (end > range.start && start < range.end) {
      start = Math.min(start, range.start);
      end = Math.max(end, range.end);
    }
  }
  return { start, end };
}

function insertReferenceMention(referenceId) {
  if (isPromptDisabled()) return;
  const index = state.references.findIndex((reference) => reference.id === referenceId);
  if (index < 0) return;
  const mention = `@图片${formatReferenceOrdinal(index + 1)}`;
  const value = getPromptValue();
  const selection = normalizePromptSelectionAroundMentions(
    value,
    pendingReferenceMentionSelection || getPromptSelection()
  );
  pendingReferenceMentionSelection = null;
  let start = Number.isInteger(selection.start) ? selection.start : value.length;
  let end = Number.isInteger(selection.end) ? selection.end : start;
  const leadingSpace = start > 0 && !/\s/.test(value.charAt(start - 1)) ? " " : "";
  const trailingSpace = end >= value.length || !/\s/.test(value.charAt(end)) ? " " : "";
  const insertion = `${leadingSpace}${mention}${trailingSpace}`;
  setPromptValue(`${value.slice(0, start)}${insertion}${value.slice(end)}`);
  const caret = start + insertion.length;
  setPromptSelection(caret, caret, false);
  updatePromptCount();
  setStatus(
    state.running ? "working" : "idle",
    `已加入 ${mention}`,
    state.running
      ? "当前并发任务继续运行；此编号用于下一次提交"
      : "提示词中的图片编号与当前参考图上传顺序一致"
  );
}

function parseReferenceOrdinal(value) {
  const token = String(value || "").trim();
  if (/^\d+$/.test(token)) {
    const numeric = Number(token);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
  }
  const numerals = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const ordinal = numerals.indexOf(token);
  return ordinal > 0 ? ordinal : 0;
}

function remapPromptImageMentions(value, previousReferences, nextReferences) {
  const source = String(value || "");
  if (!source || !Array.isArray(previousReferences) || !Array.isArray(nextReferences)) return source;
  const nextIndexes = new Map();
  nextReferences.forEach((reference, index) => {
    const id = String(reference && reference.id || "").trim();
    if (id) nextIndexes.set(id, index + 1);
  });
  let changed = false;
  const remapped = source.replace(/@(图片|图)(一|二|三|四|五|六|七|八|九|十|\d+)/g, (token, prefix, ordinalToken) => {
    const ordinal = parseReferenceOrdinal(ordinalToken);
    const reference = ordinal > 0 ? previousReferences[ordinal - 1] : null;
    const referenceId = String(reference && reference.id || "").trim();
    if (!referenceId) return token;
    const nextOrdinal = nextIndexes.get(referenceId);
    if (!nextOrdinal) {
      changed = true;
      return "";
    }
    const replacement = `@${prefix}${formatReferenceOrdinal(nextOrdinal)}`;
    if (replacement !== token) changed = true;
    return replacement;
  });
  return changed ? remapped : source;
}

function syncPromptImageMentions(previousReferences, nextReferences) {
  // Outfit and product helpers temporarily swap their own material arrays into
  // state.references. Their role-based prompts do not use the editor's
  // @图片N tokens, so those temporary mutations must not rewrite the editor.
  if (
    state.references === state.outfitReferences ||
    state.references === state.productReferences
  ) {
    return false;
  }
  if (!elements.prompt) return false;
  const value = getPromptValue();
  const remapped = remapPromptImageMentions(value, previousReferences, nextReferences);
  if (remapped === value) return false;
  setPromptValue(remapped);
  // The prompt no longer matches the optimizer snapshot after a reference
  // reorder/removal, so it must be optimized again before the next run.
  state.optimizedPromptValue = "";
  updatePromptCount();
  return true;
}

function promptMentionAtCaret() {
  const value = getPromptValue();
  const selection = readPromptSelection() || getPromptSelection();
  let caret = Math.max(0, Math.min(value.length, Number(selection && selection.start) || 0));
  let atIndex = value.lastIndexOf("@", caret - 1);
  if (promptMentionTriggerIndex !== null && Date.now() >= promptMentionTriggerExpiresAt) {
    promptMentionTriggerIndex = null;
    promptMentionTriggerExpiresAt = 0;
  }
  if (
    Number.isInteger(promptMentionTriggerIndex) &&
    value.charAt(promptMentionTriggerIndex) === "@" &&
    (atIndex < promptMentionTriggerIndex || caret <= promptMentionTriggerIndex)
  ) {
    atIndex = promptMentionTriggerIndex;
    caret = Math.max(caret, atIndex + 1);
  }
  if (atIndex < 0) return null;
  const query = value.slice(atIndex + 1, caret);
  if (/\s|@/.test(query)) return null;
  return { start: atIndex, end: caret, query: query.trim().toLowerCase() };
}

function hidePromptMentionMenu(clearTrigger = true) {
  promptMentionMatch = null;
  promptMentionActiveIndex = 0;
  if (clearTrigger) {
    promptMentionTriggerIndex = null;
    promptMentionTriggerExpiresAt = 0;
    promptMentionRetrySequence += 1;
  }
  elements.promptMentionMenu.classList.add("is-hidden");
  while (elements.promptMentionMenu.firstChild) {
    elements.promptMentionMenu.removeChild(elements.promptMentionMenu.firstChild);
  }
}

function schedulePromptMentionRetry() {
  const sequence = ++promptMentionRetrySequence;
  [30, 100, 250, 600, 1200, 2200, 3600].forEach((delay) => {
    setTimeout(() => {
      if (
        sequence !== promptMentionRetrySequence ||
        !promptHasFocus ||
        isPromptDisabled() ||
        !elements.promptMentionMenu.classList.contains("is-hidden")
      ) {
        return;
      }
      renderPromptMentionMenu();
    }, delay);
  });
}

function recordPromptMentionTrigger(index) {
  promptMentionTriggerIndex = Math.max(0, Number(index) || 0);
  promptMentionTriggerExpiresAt = Date.now() + 5000;
  schedulePromptMentionRetry();
}

function recordPromptMentionFromBeforeInput(event) {
  const data = String(event && event.data || "");
  const relativeIndex = data.lastIndexOf("@");
  if (relativeIndex < 0) return;
  recordPromptMentionTrigger(getPromptSelection().start + relativeIndex);
}

function recoverPromptMentionTriggerFromValue() {
  const value = getPromptValue();
  const latestAtIndex = value.lastIndexOf("@");
  const latestSuffix = latestAtIndex >= 0 ? value.slice(latestAtIndex + 1) : "";
  if (latestAtIndex >= 0 && !/\s|@/.test(latestSuffix)) {
    if (promptMentionTriggerIndex !== latestAtIndex) recordPromptMentionTrigger(latestAtIndex);
    return;
  }
  if (
    Number.isInteger(promptMentionTriggerIndex) &&
    value.charAt(promptMentionTriggerIndex) === "@"
  ) {
    return;
  }
  if (
    Number.isInteger(promptMentionTriggerIndex) &&
    Date.now() < promptMentionTriggerExpiresAt
  ) {
    return;
  }
  promptMentionTriggerIndex = null;
  promptMentionTriggerExpiresAt = 0;
  if (!value.includes("@")) return;
  const selection = readPromptSelection();
  let caret = Math.max(0, Math.min(value.length, Number(selection && selection.start) || 0));
  if (caret === 0 && value.length > 0) caret = value.length;
  const atIndex = value.lastIndexOf("@", caret - 1);
  if (atIndex < 0 || /\s|@/.test(value.slice(atIndex + 1, caret))) return;
  recordPromptMentionTrigger(atIndex);
}

function collapseDuplicatePromptMentionTrigger() {
  const value = getPromptValue();
  if (!/@[ \t]+@/.test(value)) return false;
  const selection = readPromptSelection() || lastPromptSelection || { start: value.length, end: value.length };
  let caret = Math.max(0, Math.min(value.length, Number(selection.end) || 0));
  if (caret === 0 && value.length) caret = value.length;
  const beforeCaret = value.slice(0, caret);
  const duplicate = /(^|\s)@[ \t]+@$/.exec(beforeCaret);
  if (!duplicate) return false;
  const triggerStart = duplicate.index + duplicate[1].length;
  const nextValue = `${value.slice(0, triggerStart)}@${value.slice(caret)}`;
  const nextCaret = triggerStart + 1;
  setPromptValue(nextValue);
  setPromptSelection(nextCaret, nextCaret, false);
  recordPromptMentionTrigger(triggerStart);
  updatePromptCount();
  return true;
}

function positionPromptMentionMenu(match) {
  if (!match || !elements.promptMentionMenu || !elements.prompt) return;
  elements.promptMentionMenu.style.left = "";
  elements.promptMentionMenu.style.top = "";
}

function promptMentionOptions() {
  return state.references.map((reference, index) => {
    const imageLabel = `图片${formatReferenceOrdinal(index + 1)}`;
    const sourceLabel = formatReferenceLabel(reference, index);
    const ordinal = formatReferenceOrdinal(index + 1);
    const aliases = [
      imageLabel,
      `图${ordinal}`,
      sourceLabel,
      `${formatReferenceType(reference.mode)}${ordinal}`
    ];
    return {
      mention: `@${imageLabel}`,
      label: imageLabel,
      previewSource: ENABLE_REFERENCE_PREVIEWS ? reference.previewUrl || null : null,
      search: aliases.join(" ").toLowerCase()
    };
  });
}

function renderPromptMentionMenu() {
  hidePromptMentionMenu();
  return;
  if (!promptHasFocus || isPromptDisabled()) {
    hidePromptMentionMenu();
    return;
  }
  collapseDuplicatePromptMentionTrigger();
  recoverPromptMentionTriggerFromValue();
  const match = promptMentionAtCaret();
  const options = match
    ? promptMentionOptions().filter((option) => !match.query || option.search.includes(match.query))
    : [];
  if (!match || !options.length) {
    hidePromptMentionMenu(false);
    return;
  }
  promptMentionMatch = match;
  promptMentionActiveIndex = Math.max(0, Math.min(promptMentionActiveIndex, options.length - 1));
  while (elements.promptMentionMenu.firstChild) {
    elements.promptMentionMenu.removeChild(elements.promptMentionMenu.firstChild);
  }
  options.forEach((option, index) => {
    const item = document.createElement("div");
    item.className = "prompt-mention-option";
    item.setAttribute("role", "option");
    item.setAttribute("data-prompt-mention", option.mention);
    item.setAttribute("aria-selected", index === promptMentionActiveIndex ? "true" : "false");
    item.classList.toggle("is-active", index === promptMentionActiveIndex);
    const thumbnail = document.createElement(option.previewSource ? "img" : "span");
    thumbnail.className = option.previewSource ? "prompt-mention-thumbnail" : "prompt-mention-thumbnail is-placeholder";
    if (option.previewSource) {
      thumbnail.src = option.previewSource;
      thumbnail.alt = "";
    }
    const label = document.createElement("span");
    label.className = "prompt-mention-label";
    label.textContent = option.label;
    item.appendChild(thumbnail);
    item.appendChild(label);
    elements.promptMentionMenu.appendChild(item);
  });
  positionPromptMentionMenu(match);
  elements.promptMentionMenu.classList.remove("is-hidden");
}

function acceptPromptMention(mention) {
  if (!promptMentionMatch || !mention) return false;
  const value = getPromptValue();
  const trailingSpace = promptMentionMatch.end >= value.length || !/\s/.test(value.charAt(promptMentionMatch.end)) ? " " : "";
  const insertion = `${mention}${trailingSpace}`;
  const start = promptMentionMatch.start;
  const end = promptMentionMatch.end;
  const caret = start + insertion.length;
  const nextValue = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  hidePromptMentionMenu();
  if (!startPromptContinuation(nextValue, caret)) {
    setPromptValue(nextValue);
    setPromptSelection(caret, caret, false);
  }
  updatePromptCount();
  return true;
}

function startPromptContinuation(value, caret) {
  const capture = elements.promptContinuationCapture;
  const visualCaret = elements.promptContinuationCaret;
  if (!elements.prompt || !capture || !visualCaret) return false;
  const nextValue = String(value || "").slice(0, 20000);
  const boundedCaret = Math.max(0, Math.min(nextValue.length, Number(caret) || 0));
  const token = ++promptContinuationSequence;
  promptContinuationState = null;
  promptContinuationFocused = false;
  freezePromptSelectionCapture();
  promptSelectionFreezeUntil = 0;
  promptPointerActive = false;
  promptHasFocus = false;
  try {
    capture.blur();
    elements.prompt.blur();
  } catch (_) {
    // The empty capture can still receive focus after the current click completes.
  }
  setPromptValue(nextValue);
  setPromptSelection(boundedCaret, boundedCaret);
  capture.maxLength = Math.max(0, 20000 - nextValue.length);
  capture.value = "";
  promptContinuationState = {
    token,
    before: nextValue.slice(0, boundedCaret),
    after: nextValue.slice(boundedCaret)
  };
  lastPromptSelection = { start: boundedCaret, end: boundedCaret };
  capture.classList.remove("is-hidden");
  visualCaret.classList.remove("is-hidden");
  startPromptContinuationBlink();
  positionPromptContinuationCaret();
  setTimeout(() => {
    if (!promptContinuationState || promptContinuationState.token !== token) return;
    try {
      capture.focus();
    } catch (_) {
      // The prompt remains visible even if an older host rejects focus.
    }
    try {
      capture.selectionStart = 0;
      capture.selectionEnd = 0;
    } catch (_) {
      // An empty capture naturally starts at position zero.
    }
    positionPromptContinuationCaret();
  }, 0);
  return true;
}

function syncPromptContinuation() {
  if (!promptContinuationState || !elements.promptContinuationCapture) return;
  const buffer = String(elements.promptContinuationCapture.value || "");
  const value = `${promptContinuationState.before}${buffer}${promptContinuationState.after}`.slice(0, 20000);
  setPromptValue(value);
  if (elements.promptContinuationCaret) {
    elements.promptContinuationCaret.classList.remove("is-caret-off");
  }
  const selection = readPromptSelection();
  if (selection) lastPromptSelection = selection;
  updatePromptCount();
  positionPromptContinuationCaret();
}

function positionPromptContinuationCaret() {
  if (!promptContinuationState || !elements.promptContinuationCapture || !elements.promptContinuationCaret) return;
  try {
    const selection = readPromptSelection() || lastPromptSelection;
    const caret = selection ? selection.end : promptContinuationState.before.length;
    const mirror = ensurePromptCaretMirror();
    const layout = updatePromptCaretMirrorLayout(mirror);
    const measured = measurePromptCaretPosition(mirror, getPromptValue(), caret, layout);
    const editorBounds = elements.prompt.getBoundingClientRect();
    const shellBounds = elements.prompt.parentNode.getBoundingClientRect();
    const left = Math.max(8, Math.min(editorBounds.width - 10, Number(measured && measured.x) || 8));
    const top = Math.max(6, Math.min(editorBounds.height - layout.lineHeight, Number(measured && measured.y) || 9));
    const shellLeft = editorBounds.left - shellBounds.left + left - (Number(elements.prompt.scrollLeft) || 0);
    const shellTop = editorBounds.top - shellBounds.top + top - (Number(elements.prompt.scrollTop) || 0);
    const leftValue = `${Math.round(shellLeft)}px`;
    const topValue = `${Math.round(shellTop)}px`;
    elements.promptContinuationCapture.style.left = leftValue;
    elements.promptContinuationCapture.style.top = topValue;
    elements.promptContinuationCapture.style.height = `${Math.max(14, Math.round(layout.lineHeight))}px`;
    elements.promptContinuationCaret.style.left = leftValue;
    elements.promptContinuationCaret.style.top = topValue;
    elements.promptContinuationCaret.style.height = `${Math.max(14, Math.round(layout.lineHeight))}px`;
  } catch (_) {
    elements.promptContinuationCapture.style.left = "12px";
    elements.promptContinuationCapture.style.top = "12px";
    elements.promptContinuationCaret.style.left = "12px";
    elements.promptContinuationCaret.style.top = "12px";
  }
}

function stopPromptContinuationBlink() {
  if (promptContinuationBlinkTimer !== null) {
    clearInterval(promptContinuationBlinkTimer);
    promptContinuationBlinkTimer = null;
  }
  if (elements.promptContinuationCaret) {
    elements.promptContinuationCaret.classList.remove("is-caret-off");
  }
}

function startPromptContinuationBlink() {
  stopPromptContinuationBlink();
  if (!promptContinuationState || !elements.promptContinuationCaret) return;
  promptContinuationBlinkTimer = setInterval(() => {
    if (!promptContinuationState || !promptContinuationFocused) {
      if (elements.promptContinuationCaret) {
        elements.promptContinuationCaret.classList.remove("is-caret-off");
      }
      return;
    }
    elements.promptContinuationCaret.classList.toggle("is-caret-off");
  }, 520);
}

function deactivatePromptContinuation() {
  if (!promptContinuationState) return;
  const selection = readPromptSelection();
  if (selection) lastPromptSelection = selection;
  promptContinuationSequence += 1;
  promptContinuationState = null;
  promptContinuationFocused = false;
  promptHasFocus = false;
  stopPromptContinuationBlink();
  if (elements.promptContinuationCapture) {
    try {
      elements.promptContinuationCapture.blur();
    } catch (_) {
      // The visible prompt already contains the committed continuation.
    }
    elements.promptContinuationCapture.value = "";
    elements.promptContinuationCapture.classList.add("is-hidden");
  }
  if (elements.promptContinuationCaret) elements.promptContinuationCaret.classList.add("is-hidden");
  hidePromptMentionMenu();
}

function movePromptMentionSelection(direction) {
  const buttons = Array.from(elements.promptMentionMenu.children || []);
  if (!buttons.length) return;
  promptMentionActiveIndex = (promptMentionActiveIndex + direction + buttons.length) % buttons.length;
  buttons.forEach((button, index) => {
    button.classList.toggle("is-active", index === promptMentionActiveIndex);
    button.setAttribute("aria-selected", index === promptMentionActiveIndex ? "true" : "false");
  });
}

async function removeResult(resultId) {
  if (state.running || state.capturing || state.inserting) return;
  const index = state.results.findIndex((result) => result.id === resultId);
  if (index < 0) return;
  const removed = state.results.splice(index, 1)[0];
  const removedSelected = state.selectedResultId === removed.id;
  await releaseResult(removed);
  if (removedSelected) {
    state.selectedResultId = state.results.length ? state.results[0].id : null;
  }
  state.resultHistoryPageIndex = Math.min(
    state.resultHistoryPageIndex,
    Math.max(0, Math.ceil((state.results.length + state.generationJobs.length) / RESULT_HISTORY_PAGE_SIZE) - 1)
  );
  await queuePersistHistoryState();
  renderResultHistory();
  setStatus("idle", "已删除历史图", state.results.length ? `还保留 ${state.results.length} 张` : "生成历史已清空");
}

function chooseReplacementTarget() {
  const replacement = state.references.find((reference) => reference.mode === "selection") || null;
  state.targetSnapshot = replacement ? replacement.snapshot : null;
  keepTargetReferenceFirst();
}

function referenceMutationBlocked() {
  return Boolean(state.preparingJob || state.capturing || state.inserting || state.promptOptimizing);
}

function keepTargetReferenceFirst() {
  const targetId = String(state.targetSnapshot && state.targetSnapshot.sourceReferenceId || "");
  if (!targetId || !Array.isArray(state.references) || state.references.length < 2) return false;
  const targetIndex = state.references.findIndex((reference) => String(reference && reference.id || "") === targetId);
  if (targetIndex <= 0) return false;
  const previousReferences = state.references.slice();
  const target = state.references.splice(targetIndex, 1)[0];
  state.references.unshift(target);
  syncPromptImageMentions(previousReferences, state.references);
  return true;
}

function referenceMatchesSnapshot(reference, snapshot) {
  return Boolean(
    reference && snapshot &&
    String(reference.id || "") &&
    String(reference.id || "") === String(snapshot.sourceReferenceId || "") &&
    reference.file && !reference.released
  );
}

function runReferenceMatchesSnapshot(references, snapshot) {
  return Array.isArray(references) && Boolean(
    snapshot && references.some((reference) => referenceMatchesSnapshot(reference, snapshot))
  );
}

async function restoreMissingEditorTargetReference() {
  const snapshot = state.targetSnapshot;
  if (!snapshot || runReferenceMatchesSnapshot(state.references, snapshot)) {
    keepTargetReferenceFirst();
    return { ok: true, restored: false };
  }

  const currentSelection = state.references.find((reference) => Boolean(
    reference && reference.mode === "selection" && reference.snapshot &&
    reference.file && !reference.released
  ));
  if (currentSelection) {
    // The user captured a newer edit area after the old target disappeared.
    // That visible selection is the real image one and must also own the mask.
    state.targetSnapshot = currentSelection.snapshot;
    keepTargetReferenceFirst();
    renderReferences();
    return { ok: true, restored: false, realigned: true };
  }

  // A stale target snapshot must never be paired with a newer auxiliary crop.
  // Re-capture the original Photoshop bounds when the source document is open.
  if (!hasPhotoshopDocument(snapshot)) {
    return {
      ok: false,
      message: "主参考图文件已不在当前参考图列表中，请重新添加主图后再生成"
    };
  }
  if (state.references.length >= MAX_REFERENCES) {
    return {
      ok: false,
      message: `主参考图文件已丢失，当前参考图已达到 ${MAX_REFERENCES} 张上限，请先删除一张辅助参考图`
    };
  }

  try {
    const mode = ["selection", "layer", "canvas"].includes(String(snapshot.mode || ""))
      ? String(snapshot.mode)
      : "canvas";
    const captured = await captureSource(mode, {
      sourceSnapshot: snapshot,
      assignAsTarget: false,
      silentStatus: true
    });
    if (!captured || !captured.file) {
      return { ok: false, message: "无法从原 Photoshop 文档重新获取主参考图" };
    }
    state.targetSnapshot = captured.snapshot;
    keepTargetReferenceFirst();
    renderReferences();
    return { ok: true, restored: true };
  } catch (error) {
    return {
      ok: false,
      message: String(error && error.message || error || "无法从原 Photoshop 文档重新获取主参考图")
    };
  }
}

function swapReferences(firstId, secondId) {
  if (referenceMutationBlocked() || firstId === secondId) return;
  const firstIndex = state.references.findIndex((reference) => reference.id === firstId);
  const secondIndex = state.references.findIndex((reference) => reference.id === secondId);
  if (firstIndex < 0 || secondIndex < 0) return;
  const previousReferences = state.references.slice();
  const temporary = state.references[firstIndex];
  state.references[firstIndex] = state.references[secondIndex];
  state.references[secondIndex] = temporary;
  syncPromptImageMentions(previousReferences, state.references);
  reorderReferenceNodes();
  updateResolvedSize();
  updateControls();
  setStatus("idle", "参考图顺序已交换", `图 ${firstIndex + 1} 与图 ${secondIndex + 1} 已交换`);
}

function reorderReferenceNodes() {
  const children = Array.from(elements.referenceList.children || []);
  const nodesById = new Map();
  children.forEach((child) => {
    const referenceId = child.getAttribute && child.getAttribute("data-reference-drag-id");
    if (referenceId) nodesById.set(referenceId, child);
  });

  const desiredNodes = [];
  state.references.forEach((reference, index) => {
    const node = nodesById.get(reference.id);
    if (!node) return;
    desiredNodes.push(node);
    const displayLabel = formatReferenceLabel(reference, index);
    const originalName = reference.originalName ? ` · ${reference.originalName}` : "";
    node.title = `${displayLabel}${originalName} · ${reference.bounds.width}×${reference.bounds.height} · 可拖动调整顺序`;
    node.classList.toggle(
      "is-target",
      Boolean(state.targetSnapshot && state.targetSnapshot.sourceReferenceId === reference.id)
    );
    node.setAttribute("draggable", "false");
    const image = node.querySelector(".reference-thumb-image");
    const number = node.querySelector(".reference-index");
    const type = node.querySelector(".reference-type");
    const dimensions = node.querySelector(".reference-dimensions");
    const remove = node.querySelector(".reference-remove");
    if (image) {
      image.alt = `参考图 ${index + 1}`;
      image.setAttribute("draggable", "false");
    }
    if (number) number.textContent = String(index + 1);
    if (type) type.textContent = displayLabel;
    if (dimensions) dimensions.textContent = referenceDimensionsLabel(reference);
    if (remove) remove.setAttribute("aria-label", `移除${displayLabel}`);
  });
  desiredNodes.forEach((node, index) => {
    const currentNode = elements.referenceList.children[index];
    if (currentNode !== node) {
      elements.referenceList.insertBefore(node, currentNode || elements.referenceEmptyHint);
    }
  });
  syncReferenceTileLayout();
  scheduleReferenceTileLayout();
}

async function removeReference(referenceId) {
  if (referenceMutationBlocked()) return;
  const index = state.references.findIndex((reference) => reference.id === referenceId);
  if (index < 0) return;
  const activeReferencePool = state.references;
  const previousReferences = activeReferencePool === state.references ? activeReferencePool.slice() : null;
  const removed = activeReferencePool.splice(index, 1)[0];
  if (previousReferences) syncPromptImageMentions(previousReferences, activeReferencePool);
  const productPoolActive = activeReferencePool === state.productReferences;
  if (productPoolActive) {
    if (state.productReferenceIds.main === removed.id) state.productReferenceIds.main = "";
    if (state.productReferenceIds.scene === removed.id) state.productReferenceIds.scene = "";
  }
  const removedTarget = state.targetSnapshot && state.targetSnapshot.sourceReferenceId === removed.id;
  if (state.outfitTargetReferenceId === removed.id) state.outfitTargetReferenceId = null;
  if (state.outfitFaceReferenceId === removed.id) state.outfitFaceReferenceId = null;
  if (state.outfitBackgroundReferenceId === removed.id) state.outfitBackgroundReferenceId = null;
  state.outfitGarmentReferenceIds = normalizeOutfitGarmentReferenceIds(
    (state.outfitGarmentReferenceIds || []).map((referenceId) => referenceId === removed.id ? "" : referenceId)
  );
  await releaseReference(removed);
  if (removedTarget) chooseReplacementTarget();
  renderReferences();
  if (productPoolActive) renderProductWorkspace();
  setStatus(
    "idle",
    "已移除参考图",
    state.references.length ? `当前还有 ${state.references.length} 张参考图` : "可重新获取选区或导入图片"
  );
}

async function clearAllReferences() {
  if (referenceMutationBlocked()) return;
  const activeReferencePool = state.references;
  const outfitPoolActive = activeReferencePool === state.outfitReferences;
  const productPoolActive = activeReferencePool === state.productReferences;
  const previous = activeReferencePool.splice(0);
  if (activeReferencePool === state.references) syncPromptImageMentions(previous, activeReferencePool);
  state.targetSnapshot = null;
  if (productPoolActive) {
    state.productReferenceIds = { main: "", scene: "" };
    state.productTargetSnapshot = null;
  } else if (outfitPoolActive) {
    state.outfitTargetReferenceId = null;
    state.outfitFaceReferenceId = null;
    state.outfitBackgroundReferenceId = null;
    state.outfitGarmentReferenceIds = ["", "", ""];
    state.outfitTargetSnapshot = null;
  }
  for (const reference of previous) await releaseReference(reference);
  renderReferences();
  if (productPoolActive) renderProductWorkspace();
  setStatus("idle", "已清空参考图", "生成结果仍保留；可重新获取选区或导入图片继续生成");
}

async function handleEditorClear() {
  if (referenceMutationBlocked() || state.generationJobs.length) return;
  await clearAllReferences();
  setPromptValue("");
  setPromptSelection(0, 0, false);
  markPromptOptimized("");
  hidePromptMentionMenu();
  updatePromptCount();
  setStatus("idle", "已清空提示词和参考图", "生成历史仍然保留");
}

function normalizeImagingBounds(bounds, width, height) {
  const left = Number(bounds && bounds.left) || 0;
  const top = Number(bounds && bounds.top) || 0;
  const right = bounds && Number.isFinite(Number(bounds.right)) ? Number(bounds.right) : left + width;
  const bottom = bounds && Number.isFinite(Number(bounds.bottom)) ? Number(bounds.bottom) : top + height;
  return { left, top, right, bottom };
}

function isUnsupportedDocumentMode(mode) {
  return [
    constants.DocumentMode.BITMAP,
    constants.DocumentMode.INDEXEDCOLOR,
    constants.DocumentMode.MULTICHANNEL,
    constants.DocumentMode.DUOTONE
  ].includes(mode);
}

async function savePixelCapture(document, layerId, bounds, inputFile) {
  const options = {
    documentID: document.id,
    componentSize: 8,
    // JPEG has no alpha channel. Photoshop mats transparent pixels on white
    // without creating or activating a temporary document.
    applyAlpha: true,
    colorSpace: "RGB",
    colorProfile: "sRGB IEC61966-2.1",
    sourceBounds: {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom
    }
  };
  if (layerId !== null && layerId !== undefined) options.layerID = Number(layerId);

  const captured = await imaging.getPixels(options);
  if (!captured || !captured.imageData) {
    throw new Error(layerId === null || layerId === undefined
      ? "当前区域没有可读取的像素"
      : "当前图层没有可读取的像素，请选择包含画面的图层");
  }

  try {
    const width = Math.round(Number(captured.imageData.width));
    const height = Math.round(Number(captured.imageData.height));
    if (!(width > 0) || !(height > 0)) {
      throw new Error(layerId === null || layerId === undefined
        ? "当前区域没有可读取的像素"
        : "当前图层没有可读取的像素，请选择包含画面的图层");
    }

    const encoded = await imaging.encodeImageData({
      imageData: captured.imageData,
      // UXP encodes this path as JPEG; use its highest-quality setting so
      // layer references do not become soft before they reach the model.
      compression: 1,
      base64: false
    });
    const jpegBytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded || []);
    if (!jpegBytes.byteLength) throw new Error("Photoshop 未能编码参考图");
    await inputFile.write(exactArrayBuffer(jpegBytes), { format: formats.binary });

    return normalizeImagingBounds(captured.sourceBounds, width, height);
  } finally {
    captured.imageData.dispose();
  }
}

async function saveSmartObjectOriginal(document, layer, inputFile) {
  if (!document || !layer || !inputFile) return null;
  // `placedLayerEditContents` opens a native Photoshop error dialog for ordinary
  // layers. Check the selected layer descriptor before issuing the command.
  try {
    await selectDocumentAndLayer(document.id, layer.id);
  } catch (_) {
    return null;
  }
  let isSmartObject = false;
  try {
    const [descriptor] = await batchPlayChecked([{
      _obj: "get",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      _options: { dialogOptions: "dontDisplay" }
    }]);
    isSmartObject = Boolean(descriptor && (descriptor.smartObject || descriptor.smartObjectMore));
  } catch (_) {}
  if (!isSmartObject) {
    try {
      const smartObjectKind = constants.LayerKind && constants.LayerKind.SMARTOBJECT;
      isSmartObject = smartObjectKind !== undefined
        ? layer.kind === smartObjectKind
        : String(layer.kind || "").toLowerCase().includes("smart");
    } catch (_) {}
  }
  if (!isSmartObject) return null;
  const documentIds = new Set(Array.from(app.documents || []).map((item) => Number(item.id)));
  let sourceDocument = null;
  let closeSourceDocument = false;
  try {
    await batchPlayChecked([{
      _obj: "placedLayerEditContents",
      _options: { dialogOptions: "dontDisplay" }
    }]);

    sourceDocument = Array.from(app.documents || []).find((item) => !documentIds.has(Number(item.id))) || app.activeDocument;
    if (!sourceDocument || Number(sourceDocument.id) === Number(document.id)) return null;
    closeSourceDocument = !documentIds.has(Number(sourceDocument.id));
    const width = Math.round(Number(sourceDocument.width));
    const height = Math.round(Number(sourceDocument.height));
    if (!(width > 0) || !(height > 0)) return null;
    await savePixelCapture(sourceDocument, null, { left: 0, top: 0, right: width, bottom: height }, inputFile);
    return { width, height };
  } catch (_) {
    return null;
  } finally {
    if (closeSourceDocument && sourceDocument && Number(sourceDocument.id) !== Number(document.id)) {
      try {
        if (typeof sourceDocument.closeWithoutSaving === "function") await sourceDocument.closeWithoutSaving();
      } catch (_) {
        // The temporary smart-object document may already be auto-closed.
      }
    }
    try { await selectDocument(document.id); } catch (_) {}
  }
}

function colorToHex(color) {
  if (!color) return "";
  const normalized = normalizeRgbColor(color);
  return `#${[normalized.r, normalized.g, normalized.b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

function readPhotoshopForegroundColor() {
  const solidColor = app.foregroundColor;
  const rgb = solidColor && solidColor.rgb;
  if (!rgb) throw new Error("无法读取 Photoshop 前景色");
  return normalizeRgbColor({ r: rgb.red, g: rgb.green, b: rgb.blue });
}

function renderColorReplacementControls() {
  const replacement = state.colorReplacement;
  const entries = [
    {
      slot: "source",
      button: elements.sampleSourceColor,
      swatch: elements.sourceColorSwatch,
      label: elements.sourceColorLabel,
      emptyLabel: "吸取原色",
      prefix: "原"
    },
    {
      slot: "target",
      button: elements.sampleTargetColor,
      swatch: elements.targetColorSwatch,
      label: elements.targetColorLabel,
      emptyLabel: "吸取目标色",
      prefix: "目标"
    }
  ];
  entries.forEach((entry) => {
    const color = replacement[entry.slot];
    const sampling = replacement.samplingSlot === entry.slot;
    entry.button.classList.toggle("is-sampling", sampling);
    entry.button.setAttribute("aria-pressed", sampling ? "true" : "false");
    entry.swatch.classList.toggle("has-color", Boolean(color));
    entry.swatch.style.backgroundColor = color ? colorToHex(color) : "";
    entry.label.textContent = sampling
      ? "用 PS 吸管点颜色"
      : (color ? `${entry.prefix} ${colorToHex(color)}` : entry.emptyLabel);
  });
  updateControls();
}

function stopColorSampling() {
  if (colorSamplingTimer !== null) {
    clearInterval(colorSamplingTimer);
    colorSamplingTimer = null;
  }
  state.colorReplacement.samplingSlot = null;
  colorSamplingInitialHex = "";
  colorSamplingStartedAt = 0;
  renderColorReplacementControls();
}

function commitSampledColor(slot, color) {
  const normalized = normalizeRgbColor(color);
  state.colorReplacement[slot] = normalized;
  if (slot === "source") {
    state.colorReplacement.sourceDocumentId = app.documents.length ? app.activeDocument.id : null;
  }
  stopColorSampling();
  setStatus(
    "success",
    slot === "source" ? "已吸取衣服原色" : "已吸取目标颜色",
    `${colorToHex(normalized)}${slot === "source" ? "；再吸取想换成的颜色" : "；框选衣服后点击“PS 换色”"}`
  );
}

function pollColorSampling() {
  const slot = state.colorReplacement.samplingSlot;
  if (!slot) return;
  if (Date.now() - colorSamplingStartedAt >= COLOR_SAMPLE_TIMEOUT_MS) {
    stopColorSampling();
    setStatus("warning", "取色等待已结束", "可重新点击取色按钮；也可以先用 PS 吸管选好前景色，再点两次按钮确认");
    return;
  }
  try {
    const color = readPhotoshopForegroundColor();
    if (colorToHex(color) !== colorSamplingInitialHex) commitSampledColor(slot, color);
  } catch (_) {
    // Photoshop may briefly withhold the foreground color while another modal tool is active.
  }
}

async function startColorSampling(slot) {
  if (state.colorReplacing || state.preparingJob || state.capturing || state.inserting) return;
  if (!app.documents.length) {
    setStatus("warning", "请先打开图片", "需要从 Photoshop 画面中吸取颜色");
    return;
  }
  if (state.colorReplacement.samplingSlot === slot) {
    try {
      commitSampledColor(slot, readPhotoshopForegroundColor());
    } catch (error) {
      setStatus("error", "无法读取颜色", error.message || error);
    }
    return;
  }

  if (colorSamplingTimer !== null) clearInterval(colorSamplingTimer);
  try {
    colorSamplingInitialHex = colorToHex(readPhotoshopForegroundColor());
  } catch (error) {
    setStatus("error", "无法读取颜色", error.message || error);
    return;
  }
  state.colorReplacement.samplingSlot = slot;
  colorSamplingStartedAt = Date.now();
  colorSamplingTimer = setInterval(pollColorSampling, COLOR_SAMPLE_POLL_MS);
  renderColorReplacementControls();
  let toolReady = false;
  try {
    await core.executeAsModal(async () => {
      await batchPlayChecked([{
        _obj: "select",
        _target: [{ _ref: "eyedropperTool" }],
        _options: { dialogOptions: "dontDisplay" }
      }]);
    }, { commandName: "切换到吸管工具" });
    toolReady = true;
  } catch (_) {
    // Older Photoshop builds can reject tool changes from a panel; the I key remains available.
  }
  setStatus(
    "working",
    slot === "source" ? "正在等待衣服原色" : "正在等待目标颜色",
    toolReady
      ? "已切换到 Photoshop 吸管工具，请在画面上点一下颜色；如果前景色已经选好，再点一次当前按钮即可确认"
      : "切回 Photoshop，按 I 使用吸管点一下颜色；如果前景色已经选好，再点一次当前按钮即可确认"
  );
}

function clearColorReplacement() {
  if (state.colorReplacing) return;
  if (colorSamplingTimer !== null) clearInterval(colorSamplingTimer);
  colorSamplingTimer = null;
  state.colorReplacement = {
    source: null,
    target: null,
    sourceDocumentId: null,
    samplingSlot: null
  };
  colorSamplingInitialHex = "";
  colorSamplingStartedAt = 0;
  renderColorReplacementControls();
  setStatus("idle", "换色颜色已清除", "重新吸取衣服原色和目标颜色即可");
}

async function applyLocalColorReplacement() {
  if (state.colorReplacing || state.preparingJob || state.capturing || state.inserting) return;
  const sourceColor = state.colorReplacement.source;
  const targetColor = state.colorReplacement.target;
  if (!sourceColor || !targetColor) {
    setStatus("warning", "还没有选好颜色", "请先吸取衣服原色和目标颜色");
    return;
  }
  if (colorToHex(sourceColor) === colorToHex(targetColor)) {
    setStatus("warning", "两个颜色相同", "请重新吸取一个不同的目标颜色");
    return;
  }

  stopColorSampling();
  const sourceDocument = findOpenDocument(state.colorReplacement.sourceDocumentId);
  if (!sourceDocument) {
    setStatus("warning", "原图片已经关闭", "请重新打开图片并吸取衣服原色");
    return;
  }

  state.colorReplacing = true;
  updateControls();
  setStatus("working", "正在 Photoshop 内换色", "只处理衣服选区，并在原图上方建立新图层");
  try {
    const summary = await core.executeAsModal(async (executionContext) => {
      let captured = null;
      let selectionObject = null;
      let outputImageData = null;
      let suspension = null;
      try {
        await selectDocument(sourceDocument.id);
        let rawBounds = null;
        try {
          rawBounds = sourceDocument.selection && sourceDocument.selection.bounds;
        } catch (_) {
          rawBounds = null;
        }
        if (!rawBounds) throw new Error("请先在 Photoshop 中框选需要换色的衣服区域");
        const bounds = clampBounds(rawBounds, sourceDocument.width, sourceDocument.height);
        if (!bounds) throw new Error("当前选区没有可处理的有效像素");
        const pixelCount = bounds.width * bounds.height;
        if (pixelCount > COLOR_REPLACE_MAX_PIXELS) {
          throw new Error("衣服选区过大，请把选区缩小后再换色");
        }

        executionContext.reportProgress({ value: 0.12, commandName: "正在读取衣服选区" });
        captured = await imaging.getPixels({
          documentID: sourceDocument.id,
          componentSize: 8,
          applyAlpha: true,
          colorSpace: "RGB",
          colorProfile: "sRGB IEC61966-2.1",
          sourceBounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom
          }
        });
        selectionObject = await imaging.getSelection({
          documentID: sourceDocument.id,
          sourceBounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom
          }
        });
        if (!captured || !captured.imageData || !selectionObject || !selectionObject.imageData) {
          throw new Error("Photoshop 未能读取当前衣服选区");
        }
        const width = Math.round(Number(captured.imageData.width));
        const height = Math.round(Number(captured.imageData.height));
        if (width !== bounds.width || height !== bounds.height ||
          Number(selectionObject.imageData.width) !== width || Number(selectionObject.imageData.height) !== height) {
          throw new Error("选区边界已变化，请重新框选后再试");
        }

        const rawPixels = await captured.imageData.getData({ chunky: true });
        const rawSelection = await selectionObject.imageData.getData({ chunky: true });
        const components = Math.round(Number(captured.imageData.components)) || Math.round(rawPixels.length / pixelCount);
        executionContext.reportProgress({ value: 0.36, commandName: "正在保留纹理和明暗" });
        const recolored = recolorSelectedPixels(
          rawPixels,
          rawSelection,
          width,
          height,
          components,
          sourceColor,
          targetColor,
          COLOR_REPLACE_TOLERANCE
        );
        const minimumMatch = Math.max(4, Math.round(pixelCount * 0.00005));
        if (recolored.matchedPixels < minimumMatch || recolored.strengthTotal < 2) {
          throw new Error("选区内没有找到足够的原色，请在衣服中间位置重新吸取一次原色");
        }

        outputImageData = await imaging.createImageDataFromBuffer(recolored.pixels, {
          width,
          height,
          components: 4,
          chunky: true,
          colorSpace: "RGB",
          colorProfile: "sRGB IEC61966-2.1"
        });
        suspension = await executionContext.hostControl.suspendHistory({
          documentID: sourceDocument.id,
          name: "衣服换色"
        });
        const anchorLayer = sourceDocument.activeLayers && sourceDocument.activeLayers.length
          ? sourceDocument.activeLayers[0]
          : null;
        const layerName = `衣服换色 ${colorToHex(sourceColor)} → ${colorToHex(targetColor)}`;
        const recolorLayer = await sourceDocument.createLayer(constants.LayerKind.NORMAL, { name: layerName });
        if (anchorLayer && Number(anchorLayer.id) !== Number(recolorLayer.id)) {
          try {
            await recolorLayer.move(anchorLayer, constants.ElementPlacement.PLACEBEFORE);
          } catch (_) {
            // Keeping the recolor layer at the document top is a safe fallback.
          }
        }
        await selectDocumentAndLayer(sourceDocument.id, recolorLayer.id);
        executionContext.reportProgress({ value: 0.72, commandName: "正在写入换色图层" });
        await imaging.putPixels({
          documentID: sourceDocument.id,
          layerID: recolorLayer.id,
          imageData: outputImageData,
          replace: true,
          targetBounds: { left: bounds.left, top: bounds.top },
          commandName: "写入衣服换色结果"
        });
        await selectDocumentAndLayer(sourceDocument.id, recolorLayer.id);
        await executionContext.hostControl.resumeHistory(suspension, true);
        suspension = null;
        executionContext.reportProgress({ value: 1, commandName: "衣服换色完成" });
        return {
          matchedPixels: recolored.matchedPixels,
          layerName,
          documentTitle: sourceDocument.title || sourceDocument.name || "当前文档"
        };
      } catch (error) {
        if (suspension) {
          try {
            await executionContext.hostControl.resumeHistory(suspension, false);
          } catch (_) {
            // The modal scope also rolls back an unresumed history suspension.
          }
        }
        throw error;
      } finally {
        if (outputImageData) outputImageData.dispose();
        if (selectionObject && selectionObject.imageData) selectionObject.imageData.dispose();
        if (captured && captured.imageData) captured.imageData.dispose();
      }
    }, { commandName: "衣服换色" });
    setStatus("success", "衣服换色完成", `已在“${summary.documentTitle}”中新建“${summary.layerName}”，原图层没有修改`);
  } catch (error) {
    setStatus("error", "衣服换色失败", error.message || error);
  } finally {
    state.colorReplacing = false;
    updateControls();
  }
}

function renderPaletteMatchControls() {
  const sample = state.paletteSample;
  const previewColor = sample && sample.stats && sample.stats.previewColor;
  elements.paletteSampleSwatch.classList.toggle("has-color", Boolean(previewColor));
  elements.paletteSampleSwatch.style.backgroundColor = previewColor ? colorToHex(previewColor) : "";
  elements.paletteSampleLabel.textContent = previewColor
    ? `参考 ${colorToHex(previewColor)}`
    : "① 获取参考衣服";
  updateControls();
}

function clearPaletteSample() {
  if (state.paletteProcessing) return;
  state.paletteSample = null;
  renderPaletteMatchControls();
  setStatus("idle", "参考衣服颜色已清除", "重新框选参考衣服，再点“获取参考衣服”即可");
}

async function capturePaletteSample() {
  if (state.paletteProcessing || state.preparingJob || state.capturing || state.inserting) return;
  if (!app.documents.length) {
    setStatus("warning", "请先打开图片", "需要先框选颜色作为参考的衣服");
    return;
  }
  const sourceDocument = app.activeDocument;
  state.paletteProcessing = true;
  updateControls();
  setStatus("working", "正在获取参考衣服颜色", "会读取选区里的高光、阴影和整体色调，不调用生成接口");
  try {
    const sample = await core.executeAsModal(async (executionContext) => {
      let captured = null;
      let selectionObject = null;
      try {
        await selectDocument(sourceDocument.id);
        let rawBounds = null;
        try {
          rawBounds = sourceDocument.selection && sourceDocument.selection.bounds;
        } catch (_) {
          rawBounds = null;
        }
        if (!rawBounds) throw new Error("请先在 Photoshop 中框选作为颜色参考的衣服");
        const bounds = clampBounds(rawBounds, sourceDocument.width, sourceDocument.height);
        if (!bounds) throw new Error("参考衣服选区没有有效像素");
        const pixelCount = bounds.width * bounds.height;
        if (pixelCount > PALETTE_MATCH_MAX_PIXELS) {
          throw new Error("参考衣服选区过大，请把选区缩小后再获取");
        }
        executionContext.reportProgress({ value: 0.18, commandName: "正在读取参考衣服" });
        captured = await imaging.getPixels({
          documentID: sourceDocument.id,
          componentSize: 8,
          applyAlpha: true,
          colorSpace: "RGB",
          colorProfile: "sRGB IEC61966-2.1",
          sourceBounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom
          }
        });
        selectionObject = await imaging.getSelection({
          documentID: sourceDocument.id,
          sourceBounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom
          }
        });
        if (!captured || !captured.imageData || !selectionObject || !selectionObject.imageData) {
          throw new Error("Photoshop 未能读取参考衣服选区");
        }
        const width = Math.round(Number(captured.imageData.width));
        const height = Math.round(Number(captured.imageData.height));
        if (width !== bounds.width || height !== bounds.height ||
          Number(selectionObject.imageData.width) !== width || Number(selectionObject.imageData.height) !== height) {
          throw new Error("参考选区边界已变化，请重新框选后再试");
        }
        const pixels = await captured.imageData.getData({ chunky: true });
        const selection = await selectionObject.imageData.getData({ chunky: true });
        const components = Math.round(Number(captured.imageData.components)) || Math.round(pixels.length / pixelCount);
        executionContext.reportProgress({ value: 0.58, commandName: "正在分析颜色层次" });
        const stats = analyzeColorRegion(pixels, selection, width, height, components, 80000);
        executionContext.reportProgress({ value: 1, commandName: "参考颜色已获取" });
        return {
          stats,
          documentId: sourceDocument.id,
          documentTitle: sourceDocument.title || sourceDocument.name || "当前文档",
          bounds,
          capturedAt: Date.now()
        };
      } finally {
        if (selectionObject && selectionObject.imageData) selectionObject.imageData.dispose();
        if (captured && captured.imageData) captured.imageData.dispose();
      }
    }, { commandName: "获取参考衣服颜色" });
    state.paletteSample = sample;
    renderPaletteMatchControls();
    setStatus(
      "success",
      "参考衣服颜色已获取",
      `${colorToHex(sample.stats.previewColor)}；现在框选需要换色的衣服，再点“匹配当前衣服”`
    );
  } catch (error) {
    setStatus("error", "获取参考衣服失败", error.message || error);
  } finally {
    state.paletteProcessing = false;
    updateControls();
  }
}

async function applyPaletteMatch() {
  if (state.paletteProcessing || state.preparingJob || state.capturing || state.inserting) return;
  const sample = state.paletteSample;
  if (!sample || !sample.stats) {
    setStatus("warning", "还没有参考衣服", "先框选颜色正确的衣服，再点“获取参考衣服”");
    return;
  }
  if (!app.documents.length) {
    setStatus("warning", "请先打开图片", "需要框选要换色的衣服");
    return;
  }
  const targetDocument = app.activeDocument;
  state.paletteProcessing = true;
  updateControls();
  setStatus("working", "正在匹配衣服颜色", "正在把参考衣服的高光、阴影和色调迁移到当前选区");
  try {
    const summary = await core.executeAsModal(async (executionContext) => {
      let captured = null;
      let selectionObject = null;
      let outputImageData = null;
      let suspension = null;
      try {
        await selectDocument(targetDocument.id);
        let rawBounds = null;
        try {
          rawBounds = targetDocument.selection && targetDocument.selection.bounds;
        } catch (_) {
          rawBounds = null;
        }
        if (!rawBounds) throw new Error("请先在 Photoshop 中框选需要换色的衣服");
        const bounds = clampBounds(rawBounds, targetDocument.width, targetDocument.height);
        if (!bounds) throw new Error("目标衣服选区没有有效像素");
        if (Number(sample.documentId) === Number(targetDocument.id) &&
          bounds.left === sample.bounds.left && bounds.top === sample.bounds.top &&
          bounds.right === sample.bounds.right && bounds.bottom === sample.bounds.bottom) {
          throw new Error("当前还是参考衣服选区，请先改选需要换色的另一件衣服");
        }
        const pixelCount = bounds.width * bounds.height;
        if (pixelCount > PALETTE_MATCH_MAX_PIXELS) {
          throw new Error("目标衣服选区过大，请把选区缩小后再匹配");
        }
        executionContext.reportProgress({ value: 0.12, commandName: "正在读取目标衣服" });
        captured = await imaging.getPixels({
          documentID: targetDocument.id,
          componentSize: 8,
          applyAlpha: true,
          colorSpace: "RGB",
          colorProfile: "sRGB IEC61966-2.1",
          sourceBounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom
          }
        });
        selectionObject = await imaging.getSelection({
          documentID: targetDocument.id,
          sourceBounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom
          }
        });
        if (!captured || !captured.imageData || !selectionObject || !selectionObject.imageData) {
          throw new Error("Photoshop 未能读取目标衣服选区");
        }
        const width = Math.round(Number(captured.imageData.width));
        const height = Math.round(Number(captured.imageData.height));
        if (width !== bounds.width || height !== bounds.height ||
          Number(selectionObject.imageData.width) !== width || Number(selectionObject.imageData.height) !== height) {
          throw new Error("目标选区边界已变化，请重新框选后再试");
        }
        const pixels = await captured.imageData.getData({ chunky: true });
        const selection = await selectionObject.imageData.getData({ chunky: true });
        const components = Math.round(Number(captured.imageData.components)) || Math.round(pixels.length / pixelCount);
        executionContext.reportProgress({ value: 0.34, commandName: "正在匹配高光和阴影" });
        const targetStats = analyzeColorRegion(pixels, selection, width, height, components, 80000);
        const transferred = transferColorRegion(
          pixels,
          selection,
          width,
          height,
          components,
          sample.stats,
          targetStats
        );
        if (transferred.affectedPixels < Math.max(4, Math.round(pixelCount * 0.00005))) {
          throw new Error("目标衣服选区中的有效像素太少");
        }
        outputImageData = await imaging.createImageDataFromBuffer(transferred.pixels, {
          width,
          height,
          components: 4,
          chunky: true,
          colorSpace: "RGB",
          colorProfile: "sRGB IEC61966-2.1"
        });
        suspension = await executionContext.hostControl.suspendHistory({
          documentID: targetDocument.id,
          name: "衣服区域颜色匹配"
        });
        const anchorLayer = targetDocument.activeLayers && targetDocument.activeLayers.length
          ? targetDocument.activeLayers[0]
          : null;
        const layerName = `衣服颜色匹配 ${colorToHex(sample.stats.previewColor)}`;
        const matchedLayer = await targetDocument.createLayer(constants.LayerKind.NORMAL, { name: layerName });
        if (anchorLayer && Number(anchorLayer.id) !== Number(matchedLayer.id)) {
          try {
            await matchedLayer.move(anchorLayer, constants.ElementPlacement.PLACEBEFORE);
          } catch (_) {
            // Keeping the result at the document top is a safe fallback.
          }
        }
        await selectDocumentAndLayer(targetDocument.id, matchedLayer.id);
        executionContext.reportProgress({ value: 0.78, commandName: "正在写入颜色匹配图层" });
        await imaging.putPixels({
          documentID: targetDocument.id,
          layerID: matchedLayer.id,
          imageData: outputImageData,
          replace: true,
          targetBounds: { left: bounds.left, top: bounds.top },
          commandName: "写入衣服颜色匹配结果"
        });
        await selectDocumentAndLayer(targetDocument.id, matchedLayer.id);
        await executionContext.hostControl.resumeHistory(suspension, true);
        suspension = null;
        executionContext.reportProgress({ value: 1, commandName: "衣服颜色匹配完成" });
        return {
          layerName,
          targetTitle: targetDocument.title || targetDocument.name || "当前文档"
        };
      } catch (error) {
        if (suspension) {
          try {
            await executionContext.hostControl.resumeHistory(suspension, false);
          } catch (_) {
            // The modal scope also rolls back an unresumed history suspension.
          }
        }
        throw error;
      } finally {
        if (outputImageData) outputImageData.dispose();
        if (selectionObject && selectionObject.imageData) selectionObject.imageData.dispose();
        if (captured && captured.imageData) captured.imageData.dispose();
      }
    }, { commandName: "衣服区域颜色匹配" });
    setStatus(
      "success",
      "衣服颜色已匹配",
      `已在“${summary.targetTitle}”中新建“${summary.layerName}”，原图层没有修改`
    );
  } catch (error) {
    setStatus("error", "衣服颜色匹配失败", error.message || error);
  } finally {
    state.paletteProcessing = false;
    updateControls();
  }
}

async function captureSource(mode, captureOptions) {
  const options = captureOptions || {};
  const batchManaged = Boolean(options.batchManaged);
  const silentStatus = Boolean(options.silentStatus);
  const sourceSnapshot = options.sourceSnapshot || null;
  if (state.preparingJob || (state.capturing && !batchManaged) || state.inserting) return null;
  if (state.references.length + 1 > MAX_REFERENCES) {
    setStatus("warning", "参考图已满", `最多只能添加 ${MAX_REFERENCES} 张参考图`);
    return null;
  }

  if (!batchManaged) {
    state.capturing = true;
    updateControls();
  }
  if (!silentStatus) {
    setStatus("working", `正在获取${formatReferenceType(mode)}`, "正在后台读取像素，不会切换 Photoshop 文档");
  }

  let inputFile = null;
  let snapshot = null;
  let layerName = "";

  try {
    const temporaryFolder = await localFileSystem.getTemporaryFolder();
    const captureId = `${Date.now()}-${state.referenceSequence + 1}`;
    inputFile = await temporaryFolder.createFile(`katu-reference-${captureId}.jpg`, { overwrite: true });

    await core.executeAsModal(async () => {
      if (!app.documents.length) throw new Error("请先在 Photoshop 中打开一张图片");
      const document = sourceSnapshot
        ? findOpenDocumentForSnapshot(sourceSnapshot)
        : app.activeDocument;
      if (!document) {
        throw new Error("没有找到生成时使用的 Photoshop 文档，请先打开原文档后再复用");
      }
      const documentWidth = Math.round(Number(document.width));
      const documentHeight = Math.round(Number(document.height));
      if (document.artboards && document.artboards.length) {
        throw new Error("当前版本暂不支持画板文档，请先在普通画布中使用");
      }
      if (isUnsupportedDocumentMode(document.mode)) {
        throw new Error("当前颜色模式不支持回填，请转换为 RGB、CMYK、灰度或 Lab");
      }

      let rawBounds = null;
      let layerId = null;
      let solid = true;
      let insertionAnchor = document.activeLayers && document.activeLayers.length
        ? document.activeLayers[0]
        : null;
      if (mode === "canvas") {
        rawBounds = sourceSnapshot && sourceSnapshot.bounds
          ? sourceSnapshot.bounds
          : { left: 0, top: 0, right: documentWidth, bottom: documentHeight };
      } else if (mode === "layer") {
        const selectedLayers = Array.from(document.activeLayers || []);
        let activeLayer = null;
        if (sourceSnapshot && (
          sourceSnapshot.layerId !== null && sourceSnapshot.layerId !== undefined ||
          String(sourceSnapshot.layerName || "").trim()
        )) {
          activeLayer = findLayerForSnapshot(document, sourceSnapshot);
          if (activeLayer) {
            rawBounds = activeLayer.boundsNoEffects || activeLayer.bounds;
            layerId = activeLayer.id;
            layerName = activeLayer.name || sourceSnapshot.layerName || "未命名图层";
            insertionAnchor = activeLayer;
          } else {
            throw new Error("原任务记录的图层已不存在，请确认原图层仍在当前 Photoshop 文档中");
          }
        } else if (options.layerId !== null && options.layerId !== undefined) {
          activeLayer = selectedLayers.find((layer) => Number(layer.id) === Number(options.layerId)) || null;
          if (!activeLayer) throw new Error("图层选择已经变化，请重新选择后再获取");
        } else {
          if (!selectedLayers.length) {
            throw new Error("没有检测到活动图层，请先在图层面板中选择一个或多个图层");
          }
          activeLayer = selectedLayers[0];
        }
        if (!sourceSnapshot) {
          rawBounds = activeLayer.boundsNoEffects || activeLayer.bounds;
          layerId = activeLayer.id;
          layerName = activeLayer.name || "未命名图层";
          insertionAnchor = activeLayer;
        }
      } else {
        rawBounds = sourceSnapshot
          ? (sourceSnapshot.editBounds || sourceSnapshot.bounds)
          : document.selection.bounds;
        if (!rawBounds) throw new Error("没有检测到选区，请先用选框或套索工具创建选区");
        solid = sourceSnapshot ? Boolean(sourceSnapshot.solid) : Boolean(document.selection.solid);
        if (sourceSnapshot) {
          insertionAnchor = findLayerById(document.layers, sourceSnapshot.insertionAnchorLayerId) || insertionAnchor;
        }
      }

      const insertionAnchorLayerId = insertionAnchor ? insertionAnchor.id : null;
      const insertionAnchorLayerName = insertionAnchor ? (insertionAnchor.name || "") : "";
      let insertionAnchorParentId = null;
      try {
        const parent = insertionAnchor && insertionAnchor.parent;
        if (parent && Number.isFinite(Number(parent.id)) && Number(parent.id) !== Number(document.id)) {
          insertionAnchorParentId = Number(parent.id);
        }
      } catch (_) {
        insertionAnchorParentId = null;
      }

      const bounds = clampBounds(rawBounds, documentWidth, documentHeight);
      if (!bounds) throw new Error(mode === "layer" ? "当前图层没有可获取的画布内像素" : "选区没有与画布相交的有效像素区域");
      const editBounds = mode === "selection" ? bounds : null;
      const captureBounds = sourceSnapshot && sourceSnapshot.bounds
        ? clampBounds(sourceSnapshot.bounds, documentWidth, documentHeight)
        : (mode === "selection"
          // The reference and the returned layer must use the selection
          // rectangle exactly; do not add surrounding context pixels.
          ? bounds
          : bounds);
      if (captureBounds.width * captureBounds.height > API_CONFIG.maxInputPixels) {
        throw new Error("参考区域过大，请缩小到约 4000 万像素以内再试");
      }

      let mask = null;
      if (mode === "selection") {
        if (sourceSnapshot && sourceSnapshot.mask && sourceSnapshot.mask.bytes) {
          const sourceBytes = sourceSnapshot.mask.bytes;
          const owned = new Uint8Array(sourceBytes.byteLength || sourceBytes.length || 0);
          owned.set(sourceBytes);
          mask = {
            bytes: owned,
            width: Number(sourceSnapshot.mask.width) || editBounds.width,
            height: Number(sourceSnapshot.mask.height) || editBounds.height,
            bounds: editBounds
          };
        } else {
          const maskObject = await imaging.getSelection({
            documentID: document.id,
            sourceBounds: {
              left: editBounds.left,
              top: editBounds.top,
              right: editBounds.right,
              bottom: editBounds.bottom
            }
          });
          try {
            const raw = await maskObject.imageData.getData({ chunky: true });
            const owned = new Uint8Array(raw.length);
            owned.set(raw);
            let fullyOpaque = owned.length > 0;
            for (let index = 0; index < owned.length; index += 1) {
              if (owned[index] !== 255) {
                fullyOpaque = false;
                break;
              }
            }
            solid = fullyOpaque;
            mask = {
              bytes: owned,
              width: maskObject.imageData.width,
              height: maskObject.imageData.height,
              // Keep the mask on the exact integer selection rectangle used
              // for the capture. Photoshop may report fractional source
              // bounds here, which otherwise shifts the returned mask.
              bounds: editBounds
            };
          } finally {
            maskObject.imageData.dispose();
          }
        }
      }

      let capturedBounds = captureBounds;
      let sourcePixelWidth = 0;
      let sourcePixelHeight = 0;
      if (mode === "layer") {
        const activeLayer = findLayerForSnapshot(document, {
          layerId,
          layerName
        }) || (document.activeLayers && document.activeLayers[0]);
        const smartOriginal = await saveSmartObjectOriginal(document, activeLayer, inputFile);
        if (smartOriginal) {
          sourcePixelWidth = smartOriginal.width;
          sourcePixelHeight = smartOriginal.height;
        } else {
          const actualBounds = await savePixelCapture(document, layerId, captureBounds, inputFile);
          capturedBounds = clampBounds(actualBounds, documentWidth, documentHeight) || captureBounds;
          sourcePixelWidth = Math.round(capturedBounds.width);
          sourcePixelHeight = Math.round(capturedBounds.height);
        }
        const nextLayerName = buildReferenceLayerName(state.references.length + 1);
        if (nextLayerName) {
          try {
            await renameLayerById(document, layerId, nextLayerName);
            layerName = nextLayerName;
          } catch (_) {
            layerName = String(layerName || nextLayerName);
          }
        }
      } else {
        // Selection/canvas captures must keep the requested source rectangle.
        // Photoshop may trim transparent or empty pixels from getPixels() when
        // applyAlpha is enabled; using that trimmed sourceBounds here would
        // desynchronise the generated layer from the saved selection mask.
        await savePixelCapture(document, null, captureBounds, inputFile);
      }
      const referenceId = `ref-${captureId}`;
      snapshot = {
        id: `${document.id}-${captureId}`,
        sourceReferenceId: referenceId,
        mode,
        documentId: document.id,
        documentTitle: document.title || document.name || "未命名文档",
        documentWidth,
        documentHeight,
        documentResolution: Number(document.resolution) || 72,
        documentMode: document.mode,
        bounds: capturedBounds,
        sourcePixelWidth,
        sourcePixelHeight,
        editBounds,
        localEditMode: mode === "selection"
          ? (LOCAL_EDIT_MODES.includes(String(sourceSnapshot && sourceSnapshot.localEditMode || ""))
            ? String(sourceSnapshot.localEditMode)
            : "general")
          : "",
        outfitType: sourceSnapshot && sourceSnapshot.localEditMode === "outfit"
          ? normalizeOutfitType(sourceSnapshot.outfitType)
          : "",
        solid,
        mask,
        layerId,
        layerName,
        insertionAnchorLayerId,
        insertionAnchorLayerName,
        insertionAnchorParentId,
        capturedAt: new Date()
      };
    }, { commandName: `获取 AI ${formatReferenceType(mode)}参考图` });

    const inputMetadata = await inputFile.getMetadata();
    const inputSize = Number(inputMetadata && inputMetadata.size);
    if (!(inputSize > 0)) throw new Error("获取到的参考图为空");
    if (inputSize > API_CONFIG.maxUploadBytes) {
      throw new Error("参考图导出后超过 64 MB，请缩小区域或简化画面后再试");
    }

    state.referenceSequence += 1;
    const reference = {
      id: snapshot.sourceReferenceId,
      mode,
      file: inputFile,
      mime: "image/jpeg",
      previewUrl: null,
      bounds: snapshot.bounds,
      snapshot,
      layerName,
      capturedAt: snapshot.capturedAt,
      inReferenceList: true,
      resultOwners: 0,
      released: false
    };
    await createReferencePreview(reference);

    state.references.push(reference);
    const targetReferencePresent = runReferenceMatchesSnapshot(state.references, state.targetSnapshot);
    const assignedAsTarget = mode === "selection" && options.assignAsTarget !== false && !targetReferencePresent;
    if (assignedAsTarget) {
      state.targetSnapshot = snapshot;
      elements.precisionPlacement.checked = true;
      keepTargetReferenceFirst();
    }
    renderReferences();

    const primaryReference = getPrimaryReference();
    const isPrimaryGenerationReference = !state.targetSnapshot && primaryReference && primaryReference.id === reference.id;
    const targetNote = mode === "selection"
      ? (assignedAsTarget
        ? "已设为回填目标；会带入周边衔接，插入时选区外保持原图"
        : "已追加为辅助选区；精确回填仍使用第一个选区")
      : (isPrimaryGenerationReference
        ? "已作为图一主参考图，可直接生成；未获取选区时不启用精确回填"
        : "已追加为辅助参考图；不会覆盖当前主图依据");
    const actionText = `已添加${formatReferenceLabel(reference, state.references.length - 1)}参考图`;
    if (!silentStatus) setStatus("success", actionText, targetNote);
    if (state.running) renderGenerationQueue();
    return reference;
  } catch (error) {
    await safeDelete(inputFile);
    if (!silentStatus) setStatus("error", `无法获取${formatReferenceType(mode)}`, error.message || error);
    if (state.running) renderGenerationQueue();
    throw error;
  } finally {
    if (!batchManaged) {
      state.capturing = false;
      updateControls();
    }
  }
}

async function captureSelectedLayers(options = {}) {
  if (state.preparingJob || state.capturing || state.inserting) return [];
  const requestedLimit = Math.max(1, Number(options.maxCount) || MAX_REFERENCES);
  const availableSlots = Math.min(MAX_REFERENCES - state.references.length, requestedLimit);
  if (availableSlots <= 0) {
    setStatus("warning", "参考图已满", `最多只能添加 ${MAX_REFERENCES} 张参考图`);
    return [];
  }
  if (!app.documents.length) {
    setStatus("error", "无法获取图层", "请先在 Photoshop 中打开一张图片");
    return [];
  }

  const document = app.activeDocument;
  const selectedLayers = Array.from(document.activeLayers || []).map((layer) => ({
    id: Number(layer.id),
    name: layer.name || "未命名图层"
  }));
  if (!selectedLayers.length) {
    setStatus("error", "无法获取图层", "请先在 Photoshop 图层面板中选择一个或多个图层");
    return [];
  }

  const layersToCapture = selectedLayers.slice(0, availableSlots);
  const limitedCount = selectedLayers.length - layersToCapture.length;
  const added = [];
  const failed = [];
  state.capturing = true;
  updateControls();
  setStatus(
    "working",
    `正在获取 ${layersToCapture.length} 个图层`,
    "会按 Photoshop 当前多选图层的顺序加入参考图区"
  );

  try {
    for (const layer of layersToCapture) {
      try {
        const reference = await captureSource("layer", {
          batchManaged: true,
          silentStatus: true,
          layerId: layer.id
        });
        if (reference) added.push(reference);
      } catch (error) {
        failed.push({ name: layer.name, message: String(error && error.message || error) });
      }
    }

    if (!added.length) {
      const firstFailure = failed[0] && failed[0].message;
      setStatus("error", "没有获取到可用图层", firstFailure || "所选图层没有可读取的画布内像素");
      return [];
    }

    const notes = [`已按顺序加入参考图区：${added.map((reference) => reference.layerName).join("、")}`];
    if (limitedCount) notes.push(`参考图上限为 ${MAX_REFERENCES} 张，另有 ${limitedCount} 个图层未获取`);
    if (failed.length) notes.push(`${failed.length} 个图层没有可读取像素，已跳过`);
    setStatus(
      failed.length || limitedCount ? "warning" : "success",
      `已获取 ${added.length} 个图层`,
      notes.join("；")
    );
    return added;
  } finally {
    state.capturing = false;
    updateControls();
    if (state.running) renderGenerationQueue();
  }
}

async function importReferenceImages(options = {}) {
  if (state.preparingJob || state.capturing || state.inserting) return [];
  const requestedLimit = Math.max(1, Number(options.maxCount) || MAX_REFERENCES);
  const availableSlots = Math.min(MAX_REFERENCES - state.references.length, requestedLimit);
  if (availableSlots <= 0) {
    setStatus("warning", "参考图已满", `最多只能添加 ${MAX_REFERENCES} 张参考图`);
    return [];
  }

  state.capturing = true;
  updateControls();
  setStatus("working", "请选择参考图片", "支持一次多选 PNG、JPEG 和 WebP 图片");

  try {
    const selected = await localFileSystem.getFileForOpening({
      allowMultiple: options.allowMultiple !== false,
      types: ["png", "jpg", "jpeg", "webp"]
    });
    const selectedFiles = Array.isArray(selected) ? selected : (selected ? [selected] : []);
    if (!selectedFiles.length) {
      setStatus("idle", "已取消导入", "没有添加新的参考图片");
      return [];
    }

    const filesToImport = selectedFiles.slice(0, availableSlots);
    const limitedCount = Math.max(0, selectedFiles.length - filesToImport.length);
    const temporaryFolder = await localFileSystem.getTemporaryFolder();
    const batchId = Date.now();
    const imported = [];
    const failures = [];

    for (let index = 0; index < filesToImport.length; index += 1) {
      const sourceFile = filesToImport[index];
      const originalName = String(sourceFile && sourceFile.name || `图片 ${index + 1}`);
      let copiedFile = null;
      try {
        let declaredSize = 0;
        try {
          const metadata = await sourceFile.getMetadata();
          declaredSize = Number(metadata && metadata.size) || 0;
        } catch (_) {
          declaredSize = 0;
        }
        if (declaredSize > API_CONFIG.maxUploadBytes) {
          throw new Error("文件超过 64 MB");
        }

        const sourceBytes = await sourceFile.read({ format: formats.binary });
        const sourceBuffer = exactArrayBuffer(sourceBytes);
        if (!sourceBuffer.byteLength) throw new Error("图片文件为空");
        if (sourceBuffer.byteLength > API_CONFIG.maxUploadBytes) {
          throw new Error("文件超过 64 MB");
        }
        const detected = detectImageType(sourceBuffer);
        if (detected.width * detected.height > API_CONFIG.maxInputPixels) {
          throw new Error("图片超过约 4000 万像素");
        }

        const referenceId = `ref-import-${batchId}-${index + 1}-${state.referenceSequence + 1}`;
        copiedFile = await temporaryFolder.createFile(
          `katu-import-${batchId}-${index + 1}.${detected.extension}`,
          { overwrite: true }
        );
        await copiedFile.write(sourceBuffer, { format: formats.binary });

        const capturedAt = new Date();
        const bounds = {
          left: 0,
          top: 0,
          right: detected.width,
          bottom: detected.height,
          width: detected.width,
          height: detected.height
        };
        const snapshot = {
          id: `import-${referenceId}`,
          sourceReferenceId: referenceId,
          mode: "import",
          documentId: null,
          documentTitle: originalName,
          documentWidth: detected.width,
          documentHeight: detected.height,
          documentResolution: 72,
          documentMode: null,
          bounds,
          solid: true,
          mask: null,
          layerId: null,
          layerName: originalName,
          insertionAnchorLayerId: null,
          insertionAnchorLayerName: "",
          insertionAnchorParentId: null,
          capturedAt
        };
        const reference = {
          id: referenceId,
          mode: "import",
          file: copiedFile,
          mime: detected.mime,
          previewUrl: null,
          bounds,
          snapshot,
          layerName: originalName,
          originalName,
          capturedAt,
          inReferenceList: true,
          resultOwners: 0,
          released: false
        };
        await createReferencePreview(reference);
        state.referenceSequence += 1;
        state.references.push(reference);
        imported.push(reference);
        copiedFile = null;
      } catch (error) {
        await safeDelete(copiedFile);
        failures.push(`${originalName}：${sanitizeMessage(error.message || error)}`);
      }
    }

    renderReferences();
    if (!imported.length) {
      setStatus("error", "未能导入图片", failures[0] || "请选择有效的 PNG、JPEG 或 WebP 图片");
      return [];
    }

    const notes = [];
    if (limitedCount) notes.push(`参考图上限为 ${MAX_REFERENCES} 张，另有 ${limitedCount} 张未导入`);
    if (failures.length) notes.push(`${failures.length} 张无效或读取失败`);
    notes.push(
      state.targetSnapshot
        ? "已加入参考图队列，仍按当前选区精确回填"
        : "面板中的图一会作为主参考图，可直接运行；生成后可插入当前 Photoshop 文档"
    );
    setStatus(
      failures.length || limitedCount ? "warning" : "success",
      `已导入 ${imported.length} 张参考图片`,
      notes.join("；")
    );
    return imported;
  } finally {
    state.capturing = false;
    updateControls();
  }
}

function responseContentLength(response) {
  const raw = response.headers.get("content-length");
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function removePendingNetworkRequest(entry) {
  const index = pendingNetworkRequests.indexOf(entry);
  if (index >= 0) pendingNetworkRequests.splice(index, 1);
}

function cancelPendingNetworkRequests() {
  const pending = pendingNetworkRequests.splice(0);
  pending.forEach((entry) => {
    if (!entry || entry.cancelled) return;
    entry.cancelled = true;
    if (typeof entry.cleanup === "function") entry.cleanup();
    const error = new Error("插件已关闭");
    error.name = "AbortError";
    entry.reject(error);
  });
}

function releaseNetworkRequestSlot() {
  activeNetworkRequests = Math.max(0, activeNetworkRequests - 1);
  while (pendingNetworkRequests.length && activeNetworkRequests < API_CONFIG.maxConcurrentRequests) {
    const next = pendingNetworkRequests.shift();
    if (!next || next.cancelled || next.signal && next.signal.aborted) continue;
    activeNetworkRequests += 1;
    next.cleanup();
    next.resolve(releaseNetworkRequestSlot);
  }
}

function acquireNetworkRequestSlot(signal) {
  if (signal && signal.aborted) {
    const error = new Error("任务已取消");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  if (activeNetworkRequests < API_CONFIG.maxConcurrentRequests) {
    activeNetworkRequests += 1;
    return Promise.resolve(releaseNetworkRequestSlot);
  }
  return new Promise((resolve, reject) => {
    const entry = {
      signal,
      cancelled: false,
      resolve,
      reject,
      cleanup: () => {
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", abortWait);
        }
      }
    };
    const abortWait = () => {
      if (entry.cancelled) return;
      entry.cancelled = true;
      removePendingNetworkRequest(entry);
      entry.cleanup();
      const error = new Error("任务已取消");
      error.name = "AbortError";
      reject(error);
    };
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", abortWait);
    }
    pendingNetworkRequests.push(entry);
  });
}

async function limitedFetch(url, options = {}) {
  const release = await acquireNetworkRequestSlot(options && options.signal);
  try {
    return await fetch(url, options);
  } finally {
    release();
  }
}

async function withRequestTimeout(parentSignal, timeoutMs, request) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  let timeoutHandle = null;
  let timedOut = false;
  if (parentSignal && parentSignal.aborted) {
    abortFromParent();
  } else if (parentSignal && typeof parentSignal.addEventListener === "function") {
    parentSignal.addEventListener("abort", abortFromParent);
  }
  timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (timedOut && !(parentSignal && parentSignal.aborted)) {
      const timeoutError = new Error("网络请求超时");
      timeoutError.name = "RequestTimeoutError";
      timeoutError.requestTimedOut = true;
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (parentSignal && typeof parentSignal.removeEventListener === "function") {
      parentSignal.removeEventListener("abort", abortFromParent);
    }
  }
}

function absoluteKatuUrl(value, fallback) {
  const fallbackText = String(fallback || "").trim();
  const text = String(value || fallbackText).trim();
  let fallbackUrl = null;
  let url = null;
  try {
    fallbackUrl = new URL(fallbackText);
    url = /^https:\/\//i.test(text)
      ? new URL(text)
      : text.startsWith("/")
        ? new URL(text, fallbackUrl.origin)
        : fallbackUrl;
  } catch (_) {
    throw new Error("Async task returned an invalid status URL");
  }

  const trustedHosts = new Set(["www.katuai.cn"]);
  if (
    fallbackUrl.protocol !== "https:" ||
    !trustedHosts.has(fallbackUrl.hostname.toLowerCase()) ||
    fallbackUrl.port ||
    url.protocol !== "https:" ||
    !trustedHosts.has(url.hostname.toLowerCase()) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("Async task returned an untrusted status URL");
  }
  return url.href;
}

function responseChunk(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("接口返回了无法读取的数据块");
}

async function readBoundedResponse(response, maxBytes, label) {
  const declaredLength = responseContentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new Error(`${label}超过插件的安全上限`);
  }

  const body = response && response.body;
  if (body && typeof body.getReader === "function") {
    let reader = null;
    try {
      reader = body.getReader();
      const chunks = [];
      let totalBytes = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = responseChunk(result.value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          try { await reader.cancel(); } catch (_) {}
          throw new Error(`${label}超过插件的安全上限`);
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      chunks.forEach((chunk) => {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      });
      return bytes.buffer;
    } finally {
      if (reader && typeof reader.releaseLock === "function") {
        try { reader.releaseLock(); } catch (_) {}
      }
    }
  }

  // Older UXP runtimes may not expose a ReadableStream body. Keep their
  // existing compatibility path while modern hosts stop oversized streams early.
  const buffer = exactArrayBuffer(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error(`${label}超过插件的安全上限`);
  return buffer;
}

function httpErrorMessage(status, payload, retryAfter) {
  const fallbackMap = {
    400: "请求参数不正确",
    401: "API Key 无效或已失效",
    403: "当前 API Key 没有调用权限",
    413: "参考图过大，服务端拒绝接收",
    429: retryAfter ? `请求过于频繁，请在 ${retryAfter} 后重试` : "请求过于频繁，请稍后重试",
    502: "生成服务网关错误（HTTP 502）",
    503: "生成服务暂时不可用（HTTP 503）",
    504: "接口网关超时（HTTP 504）"
  };
  const fallback = fallbackMap[status] || (status >= 500 ? "生成服务暂时不可用" : `接口请求失败（HTTP ${status}）`);
  return extractErrorMessage(payload, fallback);
}

function createHttpResponseError(status, payload, retryAfter) {
  const error = new Error(httpErrorMessage(status, payload, retryAfter));
  error.httpStatus = Number(status) || 0;
  error.serverResponseReceived = true;
  error.responseReceived = false;
  error.billingUncertain = error.httpStatus >= 500;
  return error;
}

async function readImageResponse(response) {
  const buffer = await readBoundedResponse(response, API_CONFIG.maxImageBytes, "返回图片");
  if (!buffer.byteLength) throw new Error("接口返回了空图片");
  const type = detectImageType(buffer);
  if (type.width * type.height > API_CONFIG.maxOutputPixels) {
    throw new Error("返回图片像素过大，已拒绝交给 Photoshop 解码");
  }
  return { buffer, type, count: 1 };
}

function extractAsyncTaskInfo(payload) {
  if (!payload || typeof payload !== "object") return null;
  const sources = [payload, payload.data, payload.result, payload.task].filter(
    (value) => value && typeof value === "object" && !Array.isArray(value)
  );
  let parentId = "";
  let statusUrl = "";
  let status = "queued";
  let taskIds = [];
  for (const source of sources) {
    parentId = parentId || String(source.id || source.task_id || source.taskId || source.request_id || "").trim();
    statusUrl = statusUrl || String(source.status_url || source.statusUrl || source.url || "").trim();
    status = String(source.status || source.state || status).trim() || status;
    if (Array.isArray(source.task_ids)) taskIds.push(...source.task_ids);
    if (Array.isArray(source.taskIds)) taskIds.push(...source.taskIds);
  }
  const arraySources = [payload.data, payload.tasks, payload.results].filter(Array.isArray);
  arraySources.forEach((items) => {
    items.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const taskId = String(item.task_id || item.taskId || item.id || "").trim();
      if (taskId) taskIds.push(taskId);
    });
  });
  taskIds = Array.from(new Set(taskIds.map((value) => String(value || "").trim()).filter(Boolean)));
  if (!parentId && !taskIds.length) return null;
  return { id: parentId || taskIds[0], parentId, statusUrl, status, taskIds };
}

function asyncTaskStatus(payload) {
  if (!payload || typeof payload !== "object") return "";
  const values = [payload.status_label, payload.task_status_label, payload.status, payload.state, payload.task_status];
  if (payload.data && !Array.isArray(payload.data)) {
    values.push(
      payload.data.status_label,
      payload.data.task_status_label,
      payload.data.status,
      payload.data.state,
      payload.data.task_status
    );
  }
  if (Array.isArray(payload.data)) {
    payload.data.forEach((item) => {
      if (!item || typeof item !== "object") return;
      values.push(
        item.status_label,
        item.task_status_label,
        item.status,
        item.state,
        item.result && item.result.status_label,
        item.result && item.result.status,
        item.result && item.result.state
      );
    });
  }
  const numericStatuses = { "-1": "failed", "0": "queued", "1": "running", "2": "succeeded", "3": "failed", "4": "cancelled" };
  return values.map((value) => {
    const normalized = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
    return numericStatuses[normalized] || normalized;
  }).find(Boolean) || "";
}

function asyncTaskTerminal(status) {
  return ["succeeded", "success", "completed", "complete", "partially_succeeded", "failed", "error", "cancelled", "canceled", "stopped", "rejected"].includes(String(status || "").toLowerCase());
}

function asyncTaskFailureStatus(status) {
  return ["failed", "error", "cancelled", "canceled", "stopped", "rejected"].includes(String(status || "").toLowerCase());
}

function extractAsyncImageCandidates(payload) {
  const candidates = [];
  const seenValues = new Set();
  const visited = new Set();

  const addCandidate = (kind, value, contentType, taskId) => {
    const normalized = String(value || "").trim();
    if (!normalized) return;
    const normalizedTaskId = String(taskId || "").trim();
    const key = `${normalizedTaskId}:${kind}:${normalized}`;
    if (seenValues.has(key)) return;
    seenValues.add(key);
    candidates.push({
      kind,
      value: normalized,
      contentType: String(contentType || ""),
      taskId: normalizedTaskId
    });
  };

  const visit = (value, imageContext = false, depth = 0, taskId = "") => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, imageContext, depth + 1, taskId));
      return;
    }
    if (typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    const currentTaskId = String(value.task_id || value.taskId || taskId || "").trim();
    const contentType = value.mime_type || value.mimeType || value.content_type || value.contentType || "";
    const base64 = value.b64_json || value.base64 || value.image_base64;
    if (typeof base64 === "string") addCandidate("base64", base64, contentType, currentTaskId);
    if (imageContext && typeof value.url === "string") addCandidate("url", value.url, contentType, currentTaskId);

    const inlineData = value.inlineData || value.inline_data;
    if (inlineData && typeof inlineData === "object") {
      addCandidate(
        "base64",
        inlineData.data || inlineData.b64_json || inlineData.base64,
        inlineData.mimeType || inlineData.mime_type || inlineData.contentType || inlineData.content_type,
        currentTaskId
      );
    }
    const fileData = value.fileData || value.file_data;
    if (fileData && typeof fileData === "object") {
      addCandidate(
        "url",
        fileData.fileUri || fileData.file_uri || fileData.url,
        fileData.mimeType || fileData.mime_type || fileData.contentType || fileData.content_type,
        currentTaskId
      );
    }

    ["data", "images", "image", "result", "response", "output", "output_image", "candidates", "content", "parts"].forEach((key) => {
      if (value[key]) visit(
        value[key],
        imageContext || ["data", "images", "image", "result", "output", "output_image", "candidates", "parts"].includes(key),
        depth + 1,
        currentTaskId
      );
    });
  };

  visit(payload);
  return candidates;
}

async function asyncCandidatesToImages(candidates, apiKey, signal, taskId) {
  const images = [];
  const errors = [];
  for (const candidate of candidates) {
    try {
      let image = null;
      if (candidate.kind === "url") {
        image = await historyCandidateToImage(candidate, apiKey, signal);
      } else {
        const buffer = base64ToArrayBuffer(candidate.value, API_CONFIG.maxImageBytes);
        const type = detectImageType(buffer);
        if (type.width * type.height > API_CONFIG.maxOutputPixels) {
          throw new Error("返回图片超过插件支持的最大像素数");
        }
        image = { buffer, type };
      }
      image.asyncTaskId = String(candidate.taskId || taskId || "");
      images.push(image);
    } catch (error) {
      if (signal && signal.aborted || error && Number(error.httpStatus) === 401) throw error;
      errors.push(error);
    }
  }
  images.forEach((image) => {
    image.count = images.length;
  });
  return { images, errors };
}

function usableImagesFromCandidateBatch(batch, fallbackMessage) {
  const images = Array.isArray(batch && batch.images) ? batch.images : [];
  if (images.length) return images;
  const errors = Array.isArray(batch && batch.errors) ? batch.errors : [];
  throw errors[0] || new Error(fallbackMessage || "响应中没有可用的生成图片");
}

function asyncTaskDescriptors(taskInfo) {
  if (!taskInfo || typeof taskInfo !== "object") return [];
  const explicitParentId = String(taskInfo.parentId || "").trim();
  const fallbackId = String(taskInfo.id || "").trim();
  const taskIds = Array.isArray(taskInfo.taskIds)
    ? Array.from(new Set(taskInfo.taskIds.map((value) => String(value || "").trim()).filter(Boolean)))
    : [];
  const parentId = explicitParentId || fallbackId;
  const hasParentTask = Boolean(parentId && (explicitParentId || taskInfo.statusUrl || !taskIds.length));
  const descriptors = [];
  if (hasParentTask) {
    descriptors.push({
      id: parentId,
      statusUrl: String(taskInfo.statusUrl || ""),
      childIds: taskIds.filter((id) => id !== parentId)
    });
    // Aggregate responses can expose one parent ID and one ID per generated
    // image. Child endpoints may be the only place that contains the image.
    taskIds.forEach((id) => {
      if (id !== parentId) descriptors.push({ id, statusUrl: "", childIds: [] });
    });
    return descriptors;
  }
  return taskIds.map((id) => ({ id, statusUrl: "", childIds: [] }));
}

async function pollSingleOpenAiImageTask({ apiKey, taskId, statusUrl, signal, onTaskUpdated }) {
  const endpoint = String(statusUrl || `${API_CONFIG.taskEndpoint}/${encodeURIComponent(taskId)}`);
  const startedAt = Date.now();
  let lastPayload = null;
  while (Date.now() - startedAt <= API_CONFIG.asyncPollTimeoutMs) {
    if (signal && signal.aborted) {
      const error = new Error("任务已取消");
      error.name = "AbortError";
      throw error;
    }
    let response = null;
    let rawBuffer = null;
    try {
      ({ response, rawBuffer } = await withRequestTimeout(signal, ASYNC_TASK_REQUEST_TIMEOUT_MS, async (requestSignal) => {
        const requestResponse = await limitedFetch(
          absoluteKatuUrl(endpoint, `${API_CONFIG.taskEndpoint}/${encodeURIComponent(taskId)}`),
          {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
            credentials: "omit",
            redirect: "error",
            signal: requestSignal
          }
        );
        return {
          response: requestResponse,
          rawBuffer: await readBoundedResponse(requestResponse, API_CONFIG.maxJsonBytes, "异步任务响应")
        };
      }));
    } catch (error) {
      if (error && error.requestTimedOut && !(signal && signal.aborted)) {
        await waitForAsyncPoll(signal);
        continue;
      }
      throw error;
    }
    let payload = null;
    try {
      payload = JSON.parse(utf8BytesToString(new Uint8Array(rawBuffer)) || "null");
    } catch (_) {
      throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
    }
    if (!response.ok) throw createHttpResponseError(response.status, payload, response.headers.get("retry-after"));
    lastPayload = payload;
    const status = asyncTaskStatus(payload);
    if (typeof onTaskUpdated === "function") await onTaskUpdated({
      id: taskId,
      status,
      statusUrl: endpoint,
      pollElapsedMs: Date.now() - startedAt,
      payload
    });
    const asyncCandidates = extractAsyncImageCandidates(payload);
    let imageReadError = null;
    if (asyncCandidates.length) {
      const batch = await asyncCandidatesToImages(asyncCandidates, apiKey, signal, taskId);
      if (batch.images.length) {
        return {
          images: batch.images,
          partialErrors: batch.errors
        };
      }
      imageReadError = batch.errors[0] || null;
    }
    const candidate = extractHistoryImageCandidate(payload) || extractImageCandidate(payload);
    if (candidate) {
      try {
        if (candidate.kind === "url") {
          const image = await historyCandidateToImage(candidate, apiKey, signal);
          image.asyncTaskId = taskId;
          return { images: [image] };
        }
        const buffer = base64ToArrayBuffer(candidate.value, API_CONFIG.maxImageBytes);
        const type = detectImageType(buffer);
        if (type.width * type.height > API_CONFIG.maxOutputPixels) throw new Error("返回图片像素过大，已拒绝交给 Photoshop 解码");
        return { images: [{ buffer, type, count: candidate.count, asyncTaskId: taskId }] };
      } catch (error) {
        if (signal && signal.aborted || error && Number(error.httpStatus) === 401) throw error;
        imageReadError = imageReadError || error;
      }
    }
    if (asyncTaskFailureStatus(status)) {
      const terminalError = new Error(extractErrorMessage(payload, `异步任务 ${taskId} 未返回图片`));
      terminalError.taskId = taskId;
      terminalError.terminalTaskFailure = true;
      if (imageReadError) terminalError.cause = imageReadError;
      throw terminalError;
    }
    await waitForAsyncPoll(signal);
  }
  const timeoutError = new Error(`异步任务 ${taskId} 查询超过 5 分钟；可稍后从生成历史继续找回`);
  timeoutError.name = "AsyncTaskTimeoutError";
  timeoutError.taskId = taskId;
  timeoutError.lastPayload = lastPayload;
  timeoutError.billingUncertain = true;
  throw timeoutError;
}

async function pollOpenAiImageTask({ apiKey, taskInfo, signal, onTaskUpdated }) {
  const descriptors = asyncTaskDescriptors(taskInfo);
  if (!descriptors.length) throw new Error("异步接口没有返回任务 ID");
  const settled = await Promise.allSettled(descriptors.map((descriptor) => (
    pollSingleOpenAiImageTask({
      apiKey,
      taskId: descriptor.id,
      statusUrl: descriptor.statusUrl,
      signal,
      onTaskUpdated
    })
  )));
  const images = [];
  const errors = [];
  const fingerprints = new Set();
  settled.forEach((outcome) => {
    if (outcome.status === "fulfilled") {
      const returned = Array.isArray(outcome.value && outcome.value.images)
        ? outcome.value.images
        : [outcome.value];
      returned.forEach((image) => {
        if (!image || !image.buffer) return;
        const fingerprint = imageBufferFingerprint(image.buffer);
        if (fingerprint && fingerprints.has(fingerprint)) return;
        if (fingerprint) fingerprints.add(fingerprint);
        images.push(image);
      });
      if (Array.isArray(outcome.value && outcome.value.partialErrors)) {
        errors.push(...outcome.value.partialErrors);
      }
    } else {
      errors.push(outcome.reason);
    }
  });
  if (images.length) {
    images.forEach((image) => { image.count = images.length; });
    return { images, partialErrors: errors };
  }
  throw errors[0] || new Error("异步任务未返回可用图片");
}

function waitForAsyncPoll(signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const abort = () => {
      if (timer !== null) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", abort);
      const error = new Error("任务已取消");
      error.name = "AbortError";
      reject(error);
    };
    if (signal && signal.aborted) return abort();
    if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", abort);
    timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", abort);
      resolve();
    }, API_CONFIG.asyncPollIntervalMs);
  });
}

async function performOpenAiImageEditRequest({
  apiKey,
  model,
  prompt,
  size,
  aspectRatio,
  resolution,
  imageFiles,
  signal,
  useResolutionLabel = false,
  asyncMode = true,
  onTaskSubmitted,
  onTaskUpdated
}) {
  const form = new FormData();
  form.append("model", model || API_CONFIG.model);
  form.append("prompt", prompt);
  form.append("size", useResolutionLabel ? String(resolution || size) : size);
  if (useResolutionLabel && aspectRatio) form.append("aspect_ratio", String(aspectRatio));
  form.append("response_format", API_CONFIG.responseFormat);
  if (!Array.isArray(imageFiles) || !imageFiles.length) throw new Error("没有可上传的参考图");
  imageFiles.forEach((imageFile, index) => {
    form.append("image", imageFile, imageFile.name || `reference-${index + 1}.png`);
  });

  const requestHeaders = {
    Authorization: `Bearer ${apiKey}`
  };
  if (asyncMode) requestHeaders.Prefer = "respond-async";
  const response = await limitedFetch(API_CONFIG.endpoint, {
    method: "POST",
    headers: requestHeaders,
    credentials: "omit",
    redirect: "error",
    body: form,
    signal
  });
  let imagePayloadReceived = false;

  try {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (response.ok && contentType.startsWith("image/")) {
      imagePayloadReceived = true;
      return await readImageResponse(response);
    }

    let rawBuffer = null;
    try {
      rawBuffer = await readBoundedResponse(response, API_CONFIG.maxJsonBytes, "接口响应");
    } catch (error) {
      if (!response.ok) {
        throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
      }
      throw error;
    }
    let raw = utf8BytesToString(new Uint8Array(rawBuffer));
    rawBuffer = null;
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (_) {
      if (!response.ok) {
        throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
      }
      throw new Error("接口返回了无法解析的内容");
    }
    raw = null;

    if (!response.ok) {
      throw createHttpResponseError(response.status, payload, response.headers.get("retry-after"));
    }

    const directCandidates = historyRecordImageCandidates(payload);
    if (!directCandidates.length && asyncMode) {
      const taskInfo = extractAsyncTaskInfo(payload);
      if (taskInfo && taskInfo.id) {
        if (typeof onTaskSubmitted === "function") await onTaskSubmitted(taskInfo);
        return await pollOpenAiImageTask({
          apiKey,
          taskInfo,
          signal,
          onTaskUpdated
        });
      }
    }
    if (!directCandidates.length) throw new Error(extractErrorMessage(payload, "响应中没有找到生成图片"));
    imagePayloadReceived = true;
    const batch = await asyncCandidatesToImages(directCandidates, apiKey, signal, "");
    const images = usableImagesFromCandidateBatch(batch, "响应中没有可用的生成图片");
    payload = null;
    return images.length === 1 && !batch.errors.length
      ? images[0]
      : { images, partialErrors: batch.errors };
  } catch (error) {
    if (error && typeof error === "object") {
      const taskError = error.name === "AsyncTaskTimeoutError" || Boolean(error.taskId);
      error.serverResponseReceived = true;
      error.responseReceived = Boolean(error.responseReceived || imagePayloadReceived || taskError);
      if (!error.httpStatus && !response.ok) error.httpStatus = response.status;
      if (response.status >= 500 || taskError) error.billingUncertain = true;
    }
    throw error;
  }
}

function isUnsupportedImageDimensionsError(error) {
  if (!error || Number(error.httpStatus) !== 400) return false;
  return /不支持的图片尺寸|unsupported\s+image\s+dimensions/i.test(String(error.message || error));
}

async function requestOpenAiImageEdit(options) {
  try {
    return await performOpenAiImageEditRequest(options);
  } catch (error) {
    const resolution = String(options && options.resolution || "");
    const aspectRatio = String(options && options.aspectRatio || "");
    if (
      !isUnsupportedImageDimensionsError(error) ||
      !["1K", "1.5K", "2K", "4K"].includes(resolution) ||
      !/^\d+:\d+$/.test(aspectRatio) ||
      (options && options.signal && options.signal.aborted)
    ) {
      throw error;
    }

    try {
      const image = await performOpenAiImageEditRequest({
        ...options,
        useResolutionLabel: true
      });
      image.compatibilitySizeFallback = true;
      return image;
    } catch (retryError) {
      if (retryError && typeof retryError === "object") {
        retryError.compatibilitySizeFallbackAttempted = true;
        if (isUnsupportedImageDimensionsError(retryError)) {
          retryError.message = String(retryError.message || retryError) +
            `；已同时尝试 ${resolution} + ${aspectRatio} 兼容规格`;
        }
      }
      throw retryError;
    }
  }
}

function promptOptimizationInstruction(originalPrompt) {
  return [
    "你是即梦图像生成与 Photoshop 图像编辑提示词优化助手。",
    "请在不改变用户原意的前提下，把原始提示词整理成明确、自然、可直接用于图生图或局部编辑的中文提示词。",
    "先写清任务目标和参考图分工，再补充主体、动作、构图、镜头、材质、光影、色彩、背景与画面质感；只补充有助于执行的细节。",
    "必须原样保留所有以 @ 开头的图片、选区、图层编号，例如 @图片一、@选区一、@图层一。",
    "涉及换装、商品图或多张参考图时，要逐一说明每张参考图提供什么信息，不得混淆主体图与风格图。",
    "涉及局部修改时，要明确只修改指定区域，边缘自然衔接，未指定区域、人物身份、商品结构、Logo、文字、构图和画布保持不变。",
    "不要增加用户没有要求的新主体、文字、标志或画面元素。",
    "使用正向、可执行的描述，避免重复堆词、空泛形容词、参数权重和互相矛盾的要求。",
    "不要写尺寸、分辨率、模型名、费用、分析过程或解释。",
    "只能返回一段优化后的提示词文字，不要返回图片、标题、引号、列表说明或代码块。",
    "",
    `用户原始提示词：${originalPrompt}`
  ].join("\n");
}

function assertPromptReferencesPreserved(originalPrompt, optimizedPrompt) {
  const expected = promptReferenceMentions(originalPrompt);
  const actual = promptReferenceMentions(optimizedPrompt);
  const remaining = new Map();
  actual.forEach((mention) => remaining.set(mention, (remaining.get(mention) || 0) + 1));
  const missing = [];
  for (const mention of expected) {
    const count = remaining.get(mention) || 0;
    if (count > 0) remaining.set(mention, count - 1);
    else missing.push(mention);
  }
  if (missing.length) {
    throw new Error(`优化结果漏掉了 ${Array.from(new Set(missing)).join("、")}，原提示词已保留`);
  }
}

async function requestPromptOptimization({
  apiKey,
  prompt,
  signal,
  maxOutputTokens,
  allowIncompleteForConnectionTest = false
}) {
  const model = API_CONFIG.promptOptimizerModel;
  const response = await limitedFetch(
    API_CONFIG.promptOptimizerEndpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      credentials: "omit",
      redirect: "error",
      body: JSON.stringify({
        model,
        input: promptOptimizationInstruction(prompt),
        max_output_tokens: Math.max(32, Math.min(
          API_CONFIG.promptOptimizerMaxOutputTokens,
          Number(maxOutputTokens) || API_CONFIG.promptOptimizerMaxOutputTokens
        )),
        stream: false
      }),
      signal
    }
  );

  let rawBuffer = null;
  try {
    rawBuffer = await readBoundedResponse(response, API_CONFIG.maxPromptResponseBytes, "提示词优化响应");
  } catch (error) {
    if (!response.ok) {
      throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
    }
    throw error;
  }

  let payload = null;
  try {
    payload = JSON.parse(utf8BytesToString(new Uint8Array(rawBuffer)) || "null");
  } catch (_) {
    if (!response.ok) {
      throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
    }
    throw new Error("提示词优化接口返回了无法解析的内容");
  }
  if (!response.ok) {
    throw createHttpResponseError(response.status, payload, response.headers.get("retry-after"));
  }

  const responseStatus = String(payload && payload.status || "").trim().toLowerCase();
  if (responseStatus && responseStatus !== "completed") {
    const incompleteReason = String(
      payload && payload.incomplete_details && payload.incomplete_details.reason || ""
    ).trim();
    if (responseStatus === "incomplete") {
      const reasonText = ["max_output_tokens", "length"].includes(incompleteReason)
        ? "返回内容超过文字长度限制"
        : (incompleteReason ? `原因：${incompleteReason}` : "返回内容不完整");
      if (
        allowIncompleteForConnectionTest &&
        ["max_output_tokens", "length"].includes(incompleteReason)
      ) {
        const partialText = cleanOptimizedPrompt(extractTextCandidate(payload));
        if (partialText) return partialText;
      }
      throw new Error(`提示词优化没有完整完成（${reasonText}），原提示词已保留`);
    }
    throw new Error(extractErrorMessage(payload, `提示词优化状态异常：${responseStatus}`));
  }

  const optimized = cleanOptimizedPrompt(extractTextCandidate(payload));
  if (!optimized) throw new Error(extractErrorMessage(payload, "模型没有返回优化后的提示词"));
  if (optimized.length > 20000) throw new Error("优化后的提示词超过 20000 字，请缩短原提示词后重试");
  assertPromptReferencesPreserved(prompt, optimized);
  return optimized;
}

async function handleOptimizePrompt(options = {}) {
  const continueToRun = Boolean(options.continueToRun);
  const continueRunOptions = options.continueRunOptions && typeof options.continueRunOptions === "object"
    ? options.continueRunOptions
    : null;
  if (state.promptOptimizing) {
    if (promptOptimizationController && !promptOptimizationController.signal.aborted) {
      promptOptimizationController.abort();
      setStatus("working", "正在停止提示词优化", "原提示词不会被替换");
    }
    return;
  }
  if (state.preparingJob || state.capturing || state.inserting || state.loadingPersistentHistory || state.paletteProcessing || state.installingUpdate) return;

  if (promptContinuationState) {
    syncPromptContinuation();
    deactivatePromptContinuation();
  }
  const originalPrompt = getPromptValue().trim();
  if (!originalPrompt) {
    setStatus("warning", "没有可优化的提示词", "先输入需要修改的内容，再点击“优化提示词”");
    return;
  }
  if (isPromptAlreadyOptimized(originalPrompt)) {
    setStatus(
      "idle",
      "当前提示词已经优化",
      continueToRun ? "内容没有修改，将直接开始生成" : "修改提示词后才会再次优化"
    );
    if (continueToRun) await handleRun({
      ...(continueRunOptions || {}),
      skipPromptOptimization: true,
      promptOverride: originalPrompt,
      archivePromptOverride: originalPrompt
    });
    return;
  }
  if (!state.arkApiKey) {
    state.resumePromptOptimizationAfterKey = true;
    state.resumePromptOptimizationToRun = continueToRun;
    setStatus("warning", "需要方舟 API Key", "已打开设置页；保存后会继续优化，只返回提示词文字");
    showWorkspace("settings");
    return;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_CONFIG.promptOptimizerTimeoutMs);
  promptOptimizationController = controller;
  state.promptOptimizing = true;
  let optimizationSucceeded = false;
  let optimizedPrompt = "";
  updateControls();
  setStatus("working", "正在优化提示词", "调用方舟 ark-code-latest，只请求文字；完成后会覆盖输入框旧提示词");

  try {
    const optimized = await requestPromptOptimization({
      apiKey: state.arkApiKey,
      prompt: originalPrompt,
      signal: controller.signal
    });
    if (controller.signal.aborted) return;
    try {
      elements.prompt.blur();
    } catch (_) {
      // The value can still be replaced when the host does not expose blur.
    }
    setPromptValue(optimized);
    markPromptOptimized(optimized);
    setPromptSelection(optimized.length, optimized.length, false);
    updatePromptCount();
    optimizedPrompt = optimized;
    optimizationSucceeded = true;
    setStatus("success", "提示词已优化", "已保留原有图片、选区和图层编号；可继续修改后再运行");
  } catch (error) {
    if (isAbortError(error)) {
      setStatus(
        timedOut ? "warning" : "idle",
        timedOut ? "提示词优化超时" : "已停止提示词优化",
        "原提示词没有被替换"
      );
    } else {
      const httpStatus = Number(error && error.httpStatus);
      if (httpStatus === 401) {
        await clearStoredArkApiKey();
        syncSettingsWorkspace();
      }
      const failureDetail = httpStatus === 403
        ? "方舟已拒绝访问，请检查模型权限；刚切换路由时可等待 3–5 分钟后重试。已保存密钥不会被删除"
        : sanitizeMessage(error.message || error);
      setStatus("warning", "提示词优化失败", `${failureDetail}；原提示词没有被替换`);
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (promptOptimizationController === controller) promptOptimizationController = null;
    state.promptOptimizing = false;
    updateControls();
    if (optimizationSucceeded && continueToRun) await handleRun({
      ...(continueRunOptions || {}),
      skipPromptOptimization: true,
      promptOverride: optimizedPrompt,
      archivePromptOverride: optimizedPrompt
    });
  }
}

function volcResultImageUrl(value) {
  const text = String(value || "").trim();
  let url = null;
  try {
    url = new URL(text);
  } catch (_) {
    throw new Error("火山方舟返回了无效的图片地址");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== VOLC_RESULT_IMAGE_HOST ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("火山方舟返回了不受信任的图片地址");
  }
  return url.href;
}

async function volcReferenceImageDataUrl(file) {
  if (!file) return null;
  const sourceBytes = await file.read({ format: formats.binary });
  const sourceBuffer = exactArrayBuffer(sourceBytes);
  if (!sourceBuffer.byteLength) throw new Error("参考图文件为空");
  if (sourceBuffer.byteLength > API_CONFIG.maxUploadBytes) {
    throw new Error("参考图超过 64 MB");
  }
  const detected = detectImageType(sourceBuffer);
  if (detected.width * detected.height > API_CONFIG.maxInputPixels) {
    throw new Error("参考图超过约 4000 万像素");
  }
  return `data:${detected.mime};base64,${arrayBufferToBase64(sourceBuffer)}`;
}

async function downloadVolcResultImage(url, signal) {
  const safeUrl = volcResultImageUrl(url);
  return await withRequestTimeout(signal, HISTORY_REQUEST_TIMEOUT_MS, async (requestSignal) => {
    const response = await limitedFetch(safeUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      signal: requestSignal
    });
    if (!response.ok) {
      throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
    }
    return await readImageResponse(response);
  });
}

async function performVolcImageGenerationRequest({
  apiKey,
  model,
  prompt,
  size,
  resolution,
  aspectRatio,
  imageFiles,
  signal
}) {
  const images = [];
  if (Array.isArray(imageFiles)) {
    for (let index = 0; index < imageFiles.length; index += 1) {
      const dataUrl = await volcReferenceImageDataUrl(imageFiles[index]);
      if (dataUrl) images.push(dataUrl);
    }
  }
  const requestBody = {
    model: model || "gpt-image-2.5-sunburst",
    prompt,
    response_format: "url",
    size: String(resolution || size || "2K"),
    stream: false,
    watermark: true
  };
  const volcRatio = String(aspectRatio || "auto");
  if (volcRatio && volcRatio !== "auto") requestBody.aspect_ratio = volcRatio;
  if (images.length === 1) requestBody.image = images[0];
  else if (images.length > 1) requestBody.image = images;

  const response = await limitedFetch(API_CONFIG.volcImageEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    credentials: "omit",
    redirect: "error",
    body: JSON.stringify(requestBody),
    signal
  });

  let rawBuffer = null;
  try {
    rawBuffer = await readBoundedResponse(response, API_CONFIG.maxJsonBytes, "火山方舟响应");
  } catch (error) {
    if (!response.ok) throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
    throw error;
  }
  let raw = utf8BytesToString(new Uint8Array(rawBuffer));
  rawBuffer = null;
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (_) {
    if (!response.ok) throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
    throw new Error("火山方舟返回了无法解析的内容");
  }
  raw = null;
  if (!response.ok) throw createHttpResponseError(response.status, payload, response.headers.get("retry-after"));

  const data = Array.isArray(payload && payload.data) ? payload.data : [];
  const first = data.find((item) => item && typeof item === "object") || null;
  const imageUrl = String(first && (first.url || first.image_url || first.imageUrl) || "").trim();
  const b64Json = String(first && first.b64_json || "").trim();
  if (/^data:/i.test(imageUrl)) {
    const comma = imageUrl.indexOf(",");
    if (comma < 0) throw new Error("火山方舟返回了无效的图片地址");
    const buffer = base64ToArrayBuffer(imageUrl.slice(comma + 1).trim());
    const type = detectImageType(buffer);
    if (type.width * type.height > API_CONFIG.maxOutputPixels) {
      throw new Error("返回图片像素过大，已拒绝交给 Photoshop 解码");
    }
    return { buffer, type, count: 1 };
  }
  if (b64Json) {
    const buffer = base64ToArrayBuffer(b64Json);
    const type = detectImageType(buffer);
    if (type.width * type.height > API_CONFIG.maxOutputPixels) {
      throw new Error("返回图片像素过大，已拒绝交给 Photoshop 解码");
    }
    return { buffer, type, count: 1 };
  }
  if (!imageUrl) throw new Error(extractErrorMessage(payload, "火山方舟响应中没有找到生成图片"));
  return await downloadVolcResultImage(imageUrl, signal);
}

async function requestImageEdit(options) {
  if (isVolcModel(options && options.model)) return await performVolcImageGenerationRequest(options);
  return await requestOpenAiImageEdit(options);
}

function normalizeHistoryMatchText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function historyModelMatches(expected, actual) {
  const actualToken = normalizeModelIdentifier(actual);
  if (!actualToken) return true;
  const config = getModelConfig(expected);
  return [config.apiModel, config.pricingModel].concat(config.aliases || [])
    .some((alias) => normalizeModelIdentifier(alias) === actualToken);
}

function imageBufferFingerprint(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer || 0);
  let hash = 2166136261;
  const stride = Math.max(1, Math.floor(bytes.length / 8192));
  for (let index = 0; index < bytes.length; index += stride) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  if (bytes.length) {
    hash ^= bytes[bytes.length - 1];
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${bytes.length}:${hash.toString(16).padStart(8, "0")}`;
}

async function fetchGenerationHistory(apiKey, parentSignal) {
  const controller = new AbortController();
  const abortHistory = () => controller.abort();
  let timeoutHandle = null;
  if (parentSignal && parentSignal.aborted) abortHistory();
  else if (parentSignal && typeof parentSignal.addEventListener === "function") {
    parentSignal.addEventListener("abort", abortHistory);
  }
  timeoutHandle = setTimeout(abortHistory, HISTORY_REQUEST_TIMEOUT_MS);

  try {
    const records = [];
    const seen = new Set();
    let lastPayload = null;
    for (let page = 1; page <= API_CONFIG.maxHistoryPages; page += 1) {
      const response = await limitedFetch(
        `${API_CONFIG.historyEndpoint}?page=${page}&page_size=${API_CONFIG.historyPageSize}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
          credentials: "omit",
          redirect: "error",
          signal: controller.signal
        }
      );
      const rawBuffer = await readBoundedResponse(response, API_CONFIG.maxJsonBytes, "历史接口响应");
      const raw = utf8BytesToString(new Uint8Array(rawBuffer));
      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch (_) {
        if (!response.ok) throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
        throw new Error("历史接口返回了无法解析的内容");
      }
      if (!response.ok) throw createHttpResponseError(response.status, payload, response.headers.get("retry-after"));
      lastPayload = payload;
      const pageRecords = extractHistoryRecords(payload);
      for (const record of pageRecords) {
        const key = historyRecordKey(record) || `page:${page}:${records.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(record);
      }
      const totalPages = Math.max(0, Number(payload && (payload.total_pages || payload.totalPages)) || 0);
      const hasMore = payload && (payload.has_more === true || payload.hasMore === true);
      if (!pageRecords.length || (totalPages && page >= totalPages) || (!hasMore && pageRecords.length < API_CONFIG.historyPageSize)) break;
    }
    return {
      object: "list",
      data: records,
      pagesFetched: Math.min(API_CONFIG.maxHistoryPages, Math.max(1, Number(lastPayload && (lastPayload.page || lastPayload.current_page)) || 1)),
      api_key: lastPayload && (lastPayload.api_key || lastPayload.apiKey) || null
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (parentSignal && typeof parentSignal.removeEventListener === "function") {
      parentSignal.removeEventListener("abort", abortHistory);
    }
  }
}

function historyRecordMatchScore(record, job) {
  const key = historyRecordKey(record);
  if (key && job.historyBaselineKeys && job.historyBaselineKeys.has(key)) return -Infinity;
  const metadata = historyRecordMetadata(record);
  const pendingTask = pendingTaskForJob(job);
  const asyncEntries = Array.isArray(job.asyncTasks)
    ? job.asyncTasks
    : (Array.isArray(pendingTask && pendingTask.asyncTasks) ? pendingTask.asyncTasks : []);
  const asyncIds = new Set(asyncEntries
    .flatMap((entry) => [entry && entry.id].concat(entry && entry.taskIds || []))
    .filter(Boolean)
    .map(String));
  const metadataIds = (Array.isArray(metadata.ids) ? metadata.ids : [metadata.id])
    .map(String)
    .filter(Boolean);
  const exactAsyncIdMatch = metadataIds.some((id) => asyncIds.has(id));
  if (asyncIds.size && metadataIds.length) {
    if (!exactAsyncIdMatch) return -Infinity;
  }
  const candidate = extractHistoryImageCandidate(record);
  if (!candidate) return -Infinity;

  const status = normalizeHistoryMatchText(metadata.status).toLowerCase();
  if (/fail|error|cancel|失败|取消/.test(status)) return -Infinity;

  const expectedPrompt = normalizeHistoryMatchText(job.requestPrompt || job.prompt);
  const actualPrompt = normalizeHistoryMatchText(metadata.prompt);
  if (!exactAsyncIdMatch && actualPrompt && expectedPrompt && actualPrompt !== expectedPrompt) return -Infinity;

  const expectedModel = normalizeHistoryMatchText(
    job.model || job.requested && job.requested.model || API_CONFIG.model
  ).toLowerCase();
  const actualModel = normalizeHistoryMatchText(metadata.model).toLowerCase();
  const matchingModel = historyModelMatches(expectedModel, actualModel);
  if (!exactAsyncIdMatch && actualModel && !matchingModel) return -Infinity;

  const actualSize = normalizeHistoryMatchText(metadata.size).toUpperCase();
  const expectedSizes = new Set([
    normalizeHistoryMatchText(job.requested && job.requested.size).toUpperCase(),
    normalizeHistoryMatchText(job.resolution).toUpperCase()
  ].filter(Boolean));
  if (!exactAsyncIdMatch && actualSize && expectedSizes.size && !expectedSizes.has(actualSize)) return -Infinity;

  const createdAt = Number(metadata.createdAt) || 0;
  const jobCreatedAt = job.createdAt instanceof Date ? job.createdAt.getTime() : Number(job.createdAt) || 0;
  if (!exactAsyncIdMatch && createdAt && jobCreatedAt && createdAt < jobCreatedAt - 120000) return -Infinity;
  if (!exactAsyncIdMatch && createdAt && jobCreatedAt && createdAt > jobCreatedAt + HISTORY_RECORD_MATCH_MAX_LAG_MS) return -Infinity;

  if (!exactAsyncIdMatch && !actualPrompt) {
    const hasSafeFallback = Boolean(key && createdAt && (actualModel || actualSize));
    if (!hasSafeFallback) return -Infinity;
  }

  let score = 0;
  if (exactAsyncIdMatch) score += 1000;
  if (actualPrompt && actualPrompt === expectedPrompt) score += 100;
  if (actualModel && matchingModel) score += 20;
  if (actualSize && expectedSizes.has(actualSize)) score += 20;
  if (createdAt && jobCreatedAt) {
    score += Math.max(0, 20 - Math.abs(createdAt - jobCreatedAt) / 30000);
  }
  if (key) score += 5;
  return score;
}

function matchingHistoryRecords(payload, job) {
  return extractHistoryRecords(payload)
    .map((record) => ({
      record,
      key: historyRecordKey(record),
      score: historyRecordMatchScore(record, job),
      createdAt: Number(historyRecordMetadata(record).createdAt) || 0
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score || right.createdAt - left.createdAt);
}

function historyRecordImageCandidates(record) {
  const candidates = [];
  const seen = new Set();
  for (const candidate of extractHistoryImageCandidates(record).concat(extractAsyncImageCandidates(record))) {
    if (!candidate || !candidate.kind || !candidate.value) continue;
    const key = `${candidate.kind}:${String(candidate.value).trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates.map((candidate) => Object.assign({}, candidate, { count: candidates.length }));
}

function historyRecordCandidateKey(recordKey, candidate, index) {
  const base = String(recordKey || "");
  if (!base) return "";
  const value = String(candidate && candidate.value || "");
  let hash = 2166136261;
  const stride = Math.max(1, Math.floor(value.length / 2048));
  for (let offset = 0; offset < value.length; offset += stride) {
    hash ^= value.charCodeAt(offset);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${base}#image:${Number(index) + 1}:${hash.toString(16).padStart(8, "0")}`;
}

function historyRecordBaseKey(value) {
  return String(value || "").replace(/#image:\d+:[0-9a-f]+$/i, "");
}

function asyncTaskIdsForEntry(entry) {
  if (!entry || typeof entry !== "object") return [];
  return Array.from(new Set(
    [entry.id].concat(entry.taskIds || []).map((value) => String(value || "").trim()).filter(Boolean)
  ));
}

function historyKeysForAsyncEntry(entry) {
  return asyncTaskIdsForEntry(entry).map((id) => `id:${id}`);
}

function historyRecordMatchesAsyncEntry(item, entry) {
  if (!item || !entry) return false;
  const key = historyRecordBaseKey(item.key);
  const entryIds = new Set(asyncTaskIdsForEntry(entry));
  const metadata = historyRecordMetadata(item.record);
  const metadataIds = Array.isArray(metadata.ids) ? metadata.ids : [metadata.id].filter(Boolean);
  if (metadataIds.some((id) => entryIds.has(String(id)))) return true;
  if (!key) return false;
  return historyKeysForAsyncEntry(entry).includes(key);
}

function pendingAsyncEntryForHistoryRecord(item, task) {
  const entries = Array.isArray(task && task.asyncTasks) ? task.asyncTasks : [];
  return entries.find((entry) => (
    entry && !entry.resolved && !entry.failed && historyRecordMatchesAsyncEntry(item, entry)
  )) || null;
}

function historyRecordAliasKeys(value, asyncEntries) {
  const rawKey = String(value || "");
  const baseKey = historyRecordBaseKey(rawKey);
  const keys = new Set([rawKey, baseKey].filter(Boolean));
  const entries = Array.isArray(asyncEntries) ? asyncEntries : [];
  entries.forEach((entry) => {
    const entryKeys = historyKeysForAsyncEntry(entry);
    if (!baseKey || !entryKeys.includes(baseKey)) return;
    entryKeys.forEach((key) => keys.add(key));
  });
  return Array.from(keys);
}

function resultMatchesAsyncEntry(result, entry) {
  const key = historyRecordBaseKey(result && result.historyRecordKey);
  return Boolean(key && historyKeysForAsyncEntry(entry).includes(key));
}

function usedHistoryRecordKeys(results, recoveredKeys, asyncEntries = []) {
  const keys = new Set();
  const values = (Array.isArray(results) ? results : [])
    .map((result) => String(result && result.historyRecordKey || ""))
    .filter(Boolean)
    .concat(Array.from(recoveredKeys || []).map(String).filter(Boolean));
  values.forEach((value) => {
    historyRecordAliasKeys(value, asyncEntries).forEach((key) => keys.add(key));
  });
  return keys;
}

function historyImageUrl(value) {
  const text = String(value || "").trim();
  if (text.startsWith("/")) return `https://www.katuai.cn${text}`;
  if (/^https:\/\/www\.katuai\.cn(?:\/|$)/i.test(text)) return text;
  if (/^https:\/\/cdn\.katuai\.cn(?:\/|$)/i.test(text)) return text;
  if (/^https:\/\/cdn\.lingdong5\.com(?:\/|$)/i.test(text)) return text;
  throw new Error("历史记录返回了不受信任的图片地址");
}

function historyImageRequestHeaders(url, apiKey) {
  return /^https:\/\/www\.katuai\.cn(?:\/|$)/i.test(String(url || ""))
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
}

async function historyCandidateToImage(candidate, apiKey, signal, depth = 0) {
  if (depth > 2) throw new Error("历史图片地址跳转次数过多");
  if (!candidate || !candidate.value) throw new Error("历史记录中没有生成图片");
  if (candidate.kind === "base64") {
    const buffer = base64ToArrayBuffer(candidate.value, API_CONFIG.maxImageBytes);
    const type = detectImageType(buffer);
    if (type.width * type.height > API_CONFIG.maxOutputPixels) {
      throw new Error("历史图片像素过大，已拒绝交给 Photoshop 解码");
    }
    return { buffer, type, count: Number(candidate.count) || 1 };
  }
  if (candidate.kind !== "url") throw new Error("历史记录中的图片格式无法识别");

  const controller = new AbortController();
  const abortDownload = () => controller.abort();
  let timeoutHandle = null;
  if (signal && signal.aborted) abortDownload();
  else if (signal && typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", abortDownload);
  }
  timeoutHandle = setTimeout(abortDownload, HISTORY_REQUEST_TIMEOUT_MS);
  try {
    const trustedUrl = historyImageUrl(candidate.value);
    const response = await limitedFetch(trustedUrl, {
      method: "GET",
      headers: historyImageRequestHeaders(trustedUrl, apiKey),
      credentials: "omit",
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) {
      throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("json")) {
      const rawBuffer = await readBoundedResponse(response, API_CONFIG.maxJsonBytes, "历史图片响应");
      const payload = JSON.parse(utf8BytesToString(new Uint8Array(rawBuffer)) || "null");
      const nestedCandidate = extractHistoryImageCandidate(payload) || extractImageCandidate(payload);
      if (!nestedCandidate || nestedCandidate.value === candidate.value) {
        throw new Error("历史图片接口没有返回可读取的图片");
      }
      return await historyCandidateToImage(nestedCandidate, apiKey, signal, depth + 1);
    }
    return await readImageResponse(response);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (signal && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", abortDownload);
    }
  }
}

async function fetchAsyncTaskPayload(apiKey, asyncEntry, signal) {
  const taskId = String(asyncEntry && (asyncEntry.queryTaskId || asyncEntry.id) || "").trim();
  if (!taskId) return null;
  const useStoredStatusUrl = !asyncEntry.queryTaskId || taskId === String(asyncEntry.id || "");
  const endpoint = String(
    useStoredStatusUrl && asyncEntry.statusUrl || `${API_CONFIG.taskEndpoint}/${encodeURIComponent(taskId)}`
  );
  const { response, rawBuffer } = await withRequestTimeout(
    signal,
    ASYNC_TASK_REQUEST_TIMEOUT_MS,
    async (requestSignal) => {
      const requestResponse = await limitedFetch(
        absoluteKatuUrl(endpoint, `${API_CONFIG.taskEndpoint}/${encodeURIComponent(taskId)}`),
        {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
          credentials: "omit",
          redirect: "error",
          signal: requestSignal
        }
      );
      return {
        response: requestResponse,
        rawBuffer: await readBoundedResponse(requestResponse, API_CONFIG.maxJsonBytes, "异步任务响应")
      };
    }
  );
  let payload = null;
  try {
    payload = JSON.parse(utf8BytesToString(new Uint8Array(rawBuffer)) || "null");
  } catch (_) {
    throw createHttpResponseError(response.status, null, response.headers.get("retry-after"));
  }
  if (!response.ok) throw createHttpResponseError(response.status, payload, response.headers.get("retry-after"));
  return payload;
}

async function recoverPendingTaskById(task, apiKey, signal) {
  const recovered = [];
  const entries = Array.isArray(task && task.asyncTasks) ? task.asyncTasks : [];
  for (const entry of entries) {
    if (!entry || !entry.id || entry.resolved || entry.failed || signal && signal.aborted) continue;
    const queryIds = asyncTaskIdsForEntry(entry);
    let explicitFailureCount = 0;
    const recoveredFingerprints = new Set();
    for (const queryTaskId of queryIds) {
      if (signal && signal.aborted) break;
      try {
        const payload = await fetchAsyncTaskPayload(apiKey, { ...entry, queryTaskId }, signal);
        entry.lastCheckedAt = Date.now();
        entry.status = asyncTaskStatus(payload) || entry.status || "running";
        const asyncCandidates = extractAsyncImageCandidates(payload);
        const candidates = asyncCandidates.length
          ? asyncCandidates
          : [extractHistoryImageCandidate(payload) || extractImageCandidate(payload)].filter(Boolean);
        if (candidates.length) {
          let images = [];
          if (asyncCandidates.length) {
            const batch = await asyncCandidatesToImages(asyncCandidates, apiKey, signal, queryTaskId);
            images = usableImagesFromCandidateBatch(batch, `异步任务 ${queryTaskId} 返回的图片均无法读取`);
          } else {
            images = [await historyCandidateToImage(candidates[0], apiKey, signal)];
          }
          for (const image of images) {
            image.asyncTaskId = image.asyncTaskId || queryTaskId;
            const fingerprint = imageBufferFingerprint(image.buffer);
            const alreadyStoredForTask = state.results.some((result) => (
              resultMatchesAsyncEntry(result, entry) &&
              String(result.imageFingerprint || "") === fingerprint
            ));
            if (!alreadyStoredForTask && !recoveredFingerprints.has(fingerprint)) {
              recoveredFingerprints.add(fingerprint);
              recovered.push({ image, fingerprint, entry, payload, taskId: image.asyncTaskId || queryTaskId });
            }
          }
        } else if (asyncTaskFailureStatus(entry.status)) {
          explicitFailureCount += 1;
        }
      } catch (error) {
        if (isAbortError(error) && signal && signal.aborted) throw error;
        if (error && Number(error.httpStatus) === 401) throw error;
      }
    }
    if (!recovered.some((item) => item.entry === entry) && queryIds.length && explicitFailureCount === queryIds.length) {
      entry.failed = true;
      entry.status = "failed";
      task.knownFailedCount = Math.max(
        Number(task.knownFailedCount) || 0,
        new Set(entries.filter((item) => item && item.failed && !item.resolved).map((item) => Number(item.requestIndex) || 0)).size
      );
    }
  }
  return recovered;
}

function waitForHistoryPoll(signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const abortWait = () => {
      if (timer !== null) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortWait);
      }
      const error = new Error("任务已取消");
      error.name = "AbortError";
      reject(error);
    };
    if (signal && signal.aborted) {
      abortWait();
      return;
    }
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", abortWait);
    }
    timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortWait);
      }
      resolve();
    }, HISTORY_RECOVERY_POLL_MS);
  });
}

function historyRecoverableOutcome(outcome) {
  if (outcome && outcome.volc) return false;
  if (!outcome || outcome.ok || outcome.skipped || !outcome.requestSubmitted) return false;
  if (isAbortError(outcome.error) && !outcome.timedOut) return false;
  if (outcome.terminalTaskFailure) return false;
  const status = Number(outcome.error && outcome.error.httpStatus) || 0;
  if (outcome.hasPersistedAsyncTaskId && status !== 401) return true;
  return outcome.timedOut || status >= 500 || status === 0;
}

function serverMayStillCompleteOutcome(outcome) {
  if (outcome && outcome.volc) return false;
  if (!outcome || outcome.ok || !outcome.requestSubmitted) return false;
  if (outcome.terminalTaskFailure) return false;
  if (outcome.hasPersistedAsyncTaskId) return true;
  if (outcome.timedOut || isAbortError(outcome.error)) return true;
  const status = Number(outcome.error && outcome.error.httpStatus) || 0;
  return status >= 500 || status === 0;
}

async function storeResult(image, snapshot, requested, prompt, options = {}) {
  const historyFolder = await getPersistentHistoryFolder();
  let file = null;
  let result = null;
  try {
    const fileTag = String(options.fileTag || state.resultSequence + 1).replace(/[^A-Za-z0-9_-]/g, "");
    const storageFileName = `result-${Date.now()}-${state.resultSequence + 1}-${fileTag}.${image.type.extension}`;
    file = await historyFolder.createFile(
      storageFileName,
      { overwrite: true }
    );
    await file.write(image.buffer, { format: formats.binary });
    state.resultSequence += 1;
    result = {
      id: `result-${Date.now()}-${state.resultSequence}`,
      sequence: state.resultSequence,
      file,
      storageFileName,
      previewUrl: null,
      mime: image.type.mime,
      extension: image.type.extension,
      byteLength: image.buffer.byteLength,
      width: image.type.width,
      height: image.type.height,
      count: image.count || 1,
      snapshot,
      maskFile: null,
      maskFileName: "",
      requested,
      prompt: String(prompt || "").trim(),
      requestPrompt: String(options.requestPrompt || prompt || "").trim().slice(0, 20000),
      taskArchive: options.taskArchive || null,
      imageFingerprint: String(options.imageFingerprint || imageBufferFingerprint(image.buffer)),
      recoveredFromHistory: Boolean(options.recoveredFromHistory),
      historyRecordKey: String(options.historyRecordKey || ""),
      sourceJobId: String(options.sourceJobId || ""),
      createdAt: options.createdAt ? new Date(options.createdAt) : new Date(),
      insertedAt: null,
      precisePlacement: null,
      openedAt: null,
      openedFiles: [],
      persistent: true,
      released: false
    };

    await createResultPreview(result, image.buffer);
    await ensureSnapshotMaskStored(result, "result");
    retainTaskArchive(result.taskArchive);
    state.results.unshift(result);
    state.results.sort((left, right) => (
      new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()
    ));
    if (options.selectResult !== false) {
      state.selectedResultId = result.id;
    }
    while (state.results.length > MAX_RESULTS) {
      let expiredIndex = state.results.length - 1;
      while (expiredIndex >= 0 && state.results[expiredIndex].id === state.selectedResultId) {
        expiredIndex -= 1;
      }
      if (expiredIndex < 0) break;
      const expired = state.results.splice(expiredIndex, 1)[0];
      await releaseResult(expired);
    }
    await queuePersistHistoryState();
    renderResultHistory();
    return result;
  } catch (error) {
    if (result) {
      revokeResultPreview(result);
      await safeDelete(result.maskFile);
    }
    await safeDelete(file);
    throw error;
  }
}

function pendingOutstandingTasks() {
  const activeIds = new Set(state.generationJobs.map((job) => job.id));
  return state.pendingHistoryTasks.filter((task) => (
    !activeIds.has(task.id) && pendingHistoryOutstandingCount(task) > 0
  ));
}

function pendingTasksForStartupRecovery() {
  return pendingOutstandingTasks().filter((task) => (
    (!task.apiKeyFingerprint || !state.apiKey || task.apiKeyFingerprint === apiKeyFingerprint(state.apiKey)) &&
    !task.autoRecoveryExhausted &&
    pendingRecoveryElapsedMs(task) < HISTORY_RECOVERY_TIMEOUT_MS
  ));
}

async function recoverPendingHistoryTasksOnStartup() {
  if (state.recoveringPendingHistory || !state.apiKey) return;
  if (!pendingTasksForStartupRecovery().length) return;

  const currentKeyFingerprint = apiKeyFingerprint(state.apiKey);
  const accountMismatches = pendingOutstandingTasks().filter((task) => (
    task.apiKeyFingerprint && task.apiKeyFingerprint !== currentKeyFingerprint
  ));
  if (accountMismatches.length) {
    setStatus(
      "warning",
      "有其他 API Key 的未完成任务",
      `已保留 ${accountMismatches.length} 个任务记录；切回原 API Key 后才会继续查询，避免串到其他账户`
    );
  }

  const controller = new AbortController();
  pendingHistoryRecoveryController = controller;
  state.pendingHistoryRecoveryStopRequested = false;
  state.recoveringPendingHistory = true;
  updateControls();
  const recoveryStartedAt = Date.now();
  const startupTasks = pendingTasksForStartupRecovery();
  startupTasks.forEach((task) => {
    task.autoRecoveryStartedAt = recoveryStartedAt;
  });
  await queuePersistHistoryState();
  const deadline = Math.max(recoveryStartedAt, ...startupTasks.map((task) => (
    recoveryStartedAt + Math.max(0, HISTORY_RECOVERY_TIMEOUT_MS - pendingRecoveryElapsedMs({
      ...task,
      autoRecoveryStartedAt: 0
    }))
  )));
  let recoveredCount = 0;
  let lastError = null;
  let invalidKey = false;
  setStatus(
    "working",
    "正在找回上次未显示的图片",
    "只查询最近 3 天的生成历史，不会重新发送生成请求"
  );

  try {
    while (!controller.signal.aborted && Date.now() < deadline) {
      const tasks = pendingTasksForStartupRecovery().filter((task) => (
        !task.apiKeyFingerprint || task.apiKeyFingerprint === currentKeyFingerprint
      ));
      if (!tasks.length) break;
      try {
        const recoveredHistoryKeys = [];
        state.pendingHistoryTasks.forEach((task) => {
          recoveredHistoryKeys.push(...Array.from(task.recoveredHistoryKeys || []));
        });
        const allPendingAsyncEntries = state.pendingHistoryTasks.flatMap((task) => (
          Array.isArray(task.asyncTasks) ? task.asyncTasks : []
        ));
        const usedHistoryKeys = usedHistoryRecordKeys(
          state.results,
          recoveredHistoryKeys,
          allPendingAsyncEntries
        );
        const usedFingerprints = new Set(state.results.map((result) => result.imageFingerprint).filter(Boolean));

        for (const task of tasks) {
          const byId = await recoverPendingTaskById(task, state.apiKey, controller.signal);
          const recoveredEntries = new Set();
          for (const recovered of byId) {
            const result = await storeResult(
              recovered.image,
              task.snapshot,
              task.requested,
              task.prompt,
              {
                fileTag: `${task.sequence}-startup-task-${Number(recovered.entry.requestIndex) + 1}`,
                selectResult: !getSelectedResult(),
                taskArchive: task.taskArchive,
                requestPrompt: task.requestPrompt || task.prompt,
                imageFingerprint: recovered.fingerprint,
                recoveredFromHistory: true,
                historyRecordKey: `id:${recovered.taskId || recovered.entry.id}`,
                sourceJobId: task.id,
                createdAt: Date.now()
              }
            );
            recoveredEntries.add(recovered.entry);
            if (!state.selectedResultId) state.selectedResultId = result.id;
            recoveredCount += 1;
          }
          recoveredEntries.forEach((entry) => {
            entry.resolved = true;
            entry.failed = false;
            entry.status = "succeeded";
            entry.lastCheckedAt = Date.now();
            task.resolvedCount = Math.min(task.requestedCount, Number(task.resolvedCount || 0) + 1);
          });
          if (pendingHistoryOutstandingCount(task) <= 0) {
            await removePendingHistoryTask(task);
          }
        }
        await queuePersistHistoryState();

        const tasksNeedingHistory = tasks.filter((task) => pendingHistoryOutstandingCount(task) > 0);
        const payload = tasksNeedingHistory.length
          ? await fetchGenerationHistory(state.apiKey, controller.signal)
          : { data: [] };

        for (const task of tasksNeedingHistory) {
          let outstanding = pendingHistoryOutstandingCount(task);
          if (!outstanding) continue;
          const matches = matchingHistoryRecords(payload, task);
          for (const item of matches) {
            if (!outstanding || controller.signal.aborted) break;
            if (item.key && usedHistoryKeys.has(item.key)) continue;
            const matchingEntry = pendingAsyncEntryForHistoryRecord(item, task);
            const hasTrackedOutstandingEntries = (task.asyncTasks || []).some((entry) => (
              entry && !entry.resolved && !entry.failed && asyncTaskIdsForEntry(entry).length > 0
            ));
            if (!matchingEntry && hasTrackedOutstandingEntries) continue;
            const candidates = historyRecordImageCandidates(item.record);
            if (!candidates.length) continue;
            const metadata = historyRecordMetadata(item.record);
            let candidateError = null;
            let acceptedCount = 0;
            for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
              const candidate = candidates[candidateIndex];
              try {
                const image = await historyCandidateToImage(candidate, state.apiKey, controller.signal);
                const fingerprint = imageBufferFingerprint(image.buffer);
                const candidateHistoryKey = historyRecordCandidateKey(item.key, candidate, candidateIndex);
                const alreadyStoredForHistoryCandidate = state.results.some((result) => (
                  String(result.historyRecordKey || "") === candidateHistoryKey
                ));
                if (alreadyStoredForHistoryCandidate) continue;
                const result = await storeResult(
                  image,
                  task.snapshot,
                  task.requested,
                  task.prompt,
                  {
                    fileTag: `${task.sequence}-startup-history-${task.resolvedCount + 1}-${candidateIndex + 1}`,
                    selectResult: !getSelectedResult(),
                    taskArchive: task.taskArchive,
                    requestPrompt: task.requestPrompt || task.prompt,
                    imageFingerprint: fingerprint,
                    recoveredFromHistory: true,
                    historyRecordKey: candidateHistoryKey,
                    sourceJobId: task.id,
                    createdAt: Number(metadata.createdAt) || Date.now()
                  }
                );
                usedFingerprints.add(fingerprint);
                if (!state.selectedResultId) state.selectedResultId = result.id;
                recoveredCount += 1;
                acceptedCount += 1;
              } catch (error) {
                if (isAbortError(error) && controller.signal.aborted) throw error;
                if (error && error.httpStatus === 401) throw error;
                candidateError = candidateError || error;
              }
            }
            if (!acceptedCount) {
              if (candidateError) {
                lastError = candidateError;
              } else if (item.key) {
                historyRecordAliasKeys(item.key, matchingEntry ? [matchingEntry] : task.asyncTasks)
                  .forEach((key) => usedHistoryKeys.add(key));
              }
              continue;
            }
            try {
              if (matchingEntry) {
                matchingEntry.resolved = true;
                matchingEntry.failed = false;
                matchingEntry.status = "succeeded";
                matchingEntry.lastCheckedAt = Date.now();
              }
              task.resolvedCount = Math.min(task.requestedCount, Number(task.resolvedCount || 0) + 1);
              if (item.key) {
                task.recoveredHistoryKeys.add(String(item.key));
                historyRecordAliasKeys(item.key, matchingEntry ? [matchingEntry] : task.asyncTasks)
                  .forEach((key) => usedHistoryKeys.add(key));
              }
              outstanding = pendingHistoryOutstandingCount(task);
              await queuePersistHistoryState();
              setStatus(
                "working",
                `已找回 ${recoveredCount} 张上次未显示的图片`,
                outstanding ? `任务 ${task.sequence} 还有 ${outstanding} 张继续查询` : `任务 ${task.sequence} 已找齐`
              );
            } catch (error) {
              if (isAbortError(error) && controller.signal.aborted) throw error;
              if (error && error.httpStatus === 401) throw error;
              lastError = error;
            }
          }
          if (pendingHistoryOutstandingCount(task) <= 0) {
            await removePendingHistoryTask(task);
          }
        }
      } catch (error) {
        if (isAbortError(error) && controller.signal.aborted) break;
        lastError = error;
        if (error && error.httpStatus === 401) {
          invalidKey = true;
          await clearStoredApiKeyIfFingerprintMatches(currentKeyFingerprint);
          break;
        }
      }

      const remainingTasks = pendingTasksForStartupRecovery();
      if (!remainingTasks.length || controller.signal.aborted || Date.now() >= deadline) break;
      const remainingImages = remainingTasks.reduce(
        (total, task) => total + pendingHistoryOutstandingCount(task),
        0
      );
      setStatus(
        "working",
        "正在继续查询上次的生成任务",
        `还有 ${remainingImages} 张暂未出现；10 秒后继续查询，不会重新生成`
      );
      try {
        await waitForHistoryPoll(controller.signal);
      } catch (error) {
        if (isAbortError(error) && controller.signal.aborted) break;
        throw error;
      }
    }
  } finally {
    const recoveryStoppedAt = Date.now();
    startupTasks.forEach((task) => finishPendingRecoverySession(task, recoveryStoppedAt));
    await queuePersistHistoryState();
    if (pendingHistoryRecoveryController === controller) pendingHistoryRecoveryController = null;
    state.recoveringPendingHistory = false;
    updateControls();
  }

  const remainingTasks = pendingOutstandingTasks();
  const now = Date.now();
  const exhaustedTasks = remainingTasks.filter((task) => pendingRecoveryElapsedMs(task, now) >= HISTORY_RECOVERY_TIMEOUT_MS);
  const recoveryTimedOut = Boolean(!controller.signal.aborted && !invalidKey && exhaustedTasks.length);
  if (exhaustedTasks.length) {
    exhaustedTasks.forEach((task) => {
      task.autoRecoveryExhausted = true;
    });
    await queuePersistHistoryState();
  }
  const remainingImages = remainingTasks.reduce(
    (total, task) => total + pendingHistoryOutstandingCount(task),
    0
  );
  const stoppedByUser = state.pendingHistoryRecoveryStopRequested;
  state.pendingHistoryRecoveryStopRequested = false;
  if (stoppedByUser) {
    setStatus(
      "warning",
      "已停止查询上次的生成任务",
      remainingImages
        ? `还有 ${remainingImages} 张待找回，记录已经保留；下次打开插件会继续查询`
        : "已找到的图片仍保留在生成历史中"
    );
  } else if (invalidKey) {
    setStatus("error", "API Key 已失效", "旧密钥已清除；重新输入后会继续查询未显示的图片");
  } else if (!remainingImages) {
    setStatus(
      "success",
      recoveredCount ? `已找回 ${recoveredCount} 张历史图片` : "上次的生成任务已核对完成",
      recoveredCount ? "图片已放回生成历史，可直接查看或插入" : "没有需要继续找回的图片"
    );
  } else if (recoveryTimedOut) {
    setStatus(
      "warning",
      `还有 ${remainingImages} 张暂未找到，自动查询已结束`,
      "本次最多自动查询 5 分钟；任务记录已保留，下次打开 Photoshop 会重新查询"
    );
  } else {
    const errorNote = lastError ? `；最后一次提示：${sanitizeMessage(lastError.message || lastError)}` : "";
    setStatus(
      "warning",
      `还有 ${remainingImages} 张暂未找到`,
      `任务记录已经保存，下次打开 Photoshop 会继续查询${errorNote}`
    );
  }
}

async function batchPlayChecked(descriptors) {
  const results = await action.batchPlay(descriptors, {});
  for (const result of results) {
    if (result && String(result._obj).toLowerCase() === "error") {
      throw new Error(result.message || "Photoshop 操作失败");
    }
  }
  return results;
}

async function selectDocument(documentId) {
  await batchPlayChecked([
    {
      _obj: "select",
      _target: [{ _ref: "document", _id: documentId }]
    }
  ]);
}

async function selectDocumentAndLayer(documentId, layerId) {
  await batchPlayChecked([
    {
      _obj: "select",
      _target: [{ _ref: "document", _id: documentId }]
    },
    {
      _obj: "select",
      _target: [{ _ref: "layer", _id: layerId }],
      makeVisible: false
    }
  ]);
}

async function selectLayerMask(documentId, layerId) {
  await selectDocumentAndLayer(documentId, layerId);
  await batchPlayChecked([
    {
      _obj: "select",
      _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }],
      makeVisible: false,
      _options: { dialogOptions: "dontDisplay" }
    }
  ]);
}

async function createHideAllLayerMask() {
  await batchPlayChecked([
    {
      _obj: "make",
      new: { _class: "channel" },
      at: { _ref: "channel", _enum: "channel", _value: "mask" },
      using: { _enum: "userMaskEnabled", _value: "hideAll" }
    }
  ]);
}

async function convertActiveLayerToSmartObject() {
  await batchPlayChecked([
    {
      _obj: "newPlacedLayer",
      _options: { dialogOptions: "dontDisplay" }
    }
  ]);
}

function findOpenDocument(documentId) {
  for (let index = 0; index < app.documents.length; index += 1) {
    const document = app.documents[index];
    if (document.id === documentId) return document;
  }
  return null;
}

function documentMatchesSnapshot(document, snapshot) {
  if (!document || !snapshot) return false;
  const title = String(document.title || document.name || "").trim();
  const expectedTitle = String(snapshot.documentTitle || "").trim();
  return Boolean(expectedTitle) && title === expectedTitle &&
    Math.round(Number(document.width)) === Math.round(Number(snapshot.documentWidth)) &&
    Math.round(Number(document.height)) === Math.round(Number(snapshot.documentHeight)) &&
    String(document.mode) === String(snapshot.documentMode) &&
    Math.abs((Number(document.resolution) || 72) - (Number(snapshot.documentResolution) || 72)) <= 0.01;
}

function findOpenDocumentForSnapshot(snapshot) {
  const byId = findOpenDocument(snapshot && snapshot.documentId);
  if (byId && documentMatchesSnapshot(byId, snapshot)) return byId;
  const matches = [];
  for (let index = 0; index < app.documents.length; index += 1) {
    const document = app.documents[index];
    if (documentMatchesSnapshot(document, snapshot)) matches.push(document);
  }
  if (matches.length > 1) {
    throw new Error("找到多个同名、同尺寸的 Photoshop 文档，请只保留原文档后再插入");
  }
  if (!matches.length) return null;
  snapshot.documentId = matches[0].id;
  return matches[0];
}

function findLayerById(layers, layerId) {
  if (!layers || layerId === null || layerId === undefined) return null;
  const wanted = Number(layerId);
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    if (Number(layer.id) === wanted) return layer;
    let children = null;
    try {
      children = layer.layers;
    } catch (_) {
      children = null;
    }
    if (children && children.length) {
      const nested = findLayerById(children, wanted);
      if (nested) return nested;
    }
  }
  return null;
}

function buildGeneratedGroupName(result) {
  const taskSequence = result && result.taskArchive && result.taskArchive.sequence;
  const taskId = String(result && (result.sourceJobId || result.taskArchive && result.taskArchive.id) || "");
  const shortId = taskId ? taskId.replace(/^job-/, "").slice(-8) : formatLayerTimestamp(result && result.createdAt);
  return `即杏智绘｜任务${taskSequence || shortId}`;
}

function findGeneratedTaskGroup(document, result) {
  const name = buildGeneratedGroupName(result);
  const matches = findLayersByName(document && document.layers, name, []);
  return matches.find((layer) => {
    try { return Boolean(layer.layers); } catch (_) { return false; }
  }) || null;
}

async function ensureGeneratedTaskGroup(document, result) {
  let group = findGeneratedTaskGroup(document, result);
  if (!group) {
    try {
      group = await document.createLayerGroup({ name: buildGeneratedGroupName(result) });
    } catch (_) {
      return null;
    }
  }
  return group;
}

async function moveInsertedLayerIntoTaskGroup(document, insertedLayer, result) {
  if (!document || !insertedLayer || !result) return null;
  const group = await ensureGeneratedTaskGroup(document, result);
  if (!group) return null;
  try {
    await insertedLayer.move(group, constants.ElementPlacement.PLACEINSIDE);
    const firstLayer = group.layers && group.layers.length ? group.layers[0] : null;
    if (firstLayer && Number(firstLayer.id) !== Number(insertedLayer.id)) {
      await insertedLayer.move(firstLayer, constants.ElementPlacement.PLACEBEFORE);
    }
    if (!group.layers || !group.layers.length || Number(group.layers[0].id) !== Number(insertedLayer.id)) {
      return null;
    }
    return group;
  } catch (_) {
    return null;
  }
}

async function moveLayerToDocumentTop(document, layer) {
  if (!document || !layer) return false;
  const isAtTop = () => {
    try {
      return Boolean(document.layers && document.layers.length) &&
        Number(document.layers[0].id) === Number(layer.id);
    } catch (_) {
      return false;
    }
  };
  if (isAtTop()) return true;
  try {
    const currentTopLayer = document.layers && document.layers.length ? document.layers[0] : null;
    if (currentTopLayer && Number(currentTopLayer.id) !== Number(layer.id)) {
      await layer.move(currentTopLayer, constants.ElementPlacement.PLACEBEFORE);
    } else {
      await layer.bringToFront();
    }
  } catch (_) {
    try {
      await layer.bringToFront();
    } catch (_) {
      return false;
    }
  }
  return isAtTop();
}

function findLayersByName(layers, layerName, matches = []) {
  if (!layers) return matches;
  const wanted = String(layerName || "").trim();
  if (!wanted) return matches;
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    if (String(layer && layer.name || "").trim() === wanted) matches.push(layer);
    let children = null;
    try {
      children = layer.layers;
    } catch (_) {
      children = null;
    }
    if (children && children.length) findLayersByName(children, wanted, matches);
  }
  return matches;
}

function findLayerForSnapshot(document, snapshot) {
  if (!document || !snapshot) return null;
  const layerName = String(snapshot.layerName || "").trim();
  if (layerName) {
    const nameMatches = findLayersByName(document.layers, layerName);
    if (nameMatches.length === 1) return nameMatches[0];
    if (nameMatches.length > 1) {
      const idMatch = nameMatches.find((layer) => Number(layer.id) === Number(snapshot.layerId));
      if (idMatch) return idMatch;
      throw new Error(`文档中有多个同名图层“${layerName}”，请保留一个或重命名后再复用`);
    }
    throw new Error(`原文档中找不到图层“${layerName}”，请确认图层未被改名或删除`);
  }
  return findLayerById(document.layers, snapshot.layerId);
}

function formatLayerTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    String(safe.getMonth() + 1).padStart(2, "0"),
    String(safe.getDate()).padStart(2, "0"),
    "-",
    String(safe.getHours()).padStart(2, "0"),
    String(safe.getMinutes()).padStart(2, "0"),
    String(safe.getSeconds()).padStart(2, "0")
  ].join("");
}

function buildGeneratedLayerName(result) {
  const compact = String(result && result.prompt || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const summary = Array.from(compact || "局部生成").slice(0, 18).join("");
  const resolution = result && result.requested && result.requested.resolution
    ? result.requested.resolution
    : "AI";
  return `AI｜${summary}｜${resolution}｜${formatLayerTimestamp(result && result.createdAt)}`;
}

function numericLayerBounds(bounds) {
  return {
    left: Number(bounds.left) || 0,
    top: Number(bounds.top) || 0,
    right: Number(bounds.right) || 0,
    bottom: Number(bounds.bottom) || 0
  };
}

async function alignLayerToBoundsExactly(document, layer, targetBounds) {
  if (!document || !layer || !targetBounds) return { x: 0, y: 0 };
  let currentLayer = layer;
  const targetWidth = Number(targetBounds.right) - Number(targetBounds.left);
  const targetHeight = Number(targetBounds.bottom) - Number(targetBounds.top);
  if (!(targetWidth > 0) || !(targetHeight > 0)) {
    throw new Error("精确放回的目标区域尺寸无效");
  }

  // A duplicated smart object keeps the generated image's pixel dimensions.
  // Resize it to the saved selection bounds before aligning its top-left edge.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    currentLayer = findLayerById(document.layers, layer.id) || currentLayer;
    // Smart-object `boundsNoEffects` can describe the embedded source rather
    // than the layer's actual transformed rectangle. Use the live layer bounds
    // that Photoshop shows with the transform handles.
    const currentBounds = numericLayerBounds(currentLayer.bounds);
    const currentWidth = currentBounds.right - currentBounds.left;
    const currentHeight = currentBounds.bottom - currentBounds.top;
    if (!(currentWidth > 0) || !(currentHeight > 0)) {
      throw new Error("生成图层尺寸无效，无法精确放回");
    }
    const widthError = currentWidth - targetWidth;
    const heightError = currentHeight - targetHeight;
    if (Math.abs(widthError) <= 0.5 && Math.abs(heightError) <= 0.5) break;
    if (typeof currentLayer.scale !== "function") {
      throw new Error("当前 Photoshop 版本不支持生成图层精确缩放");
    }
    await currentLayer.scale(
      targetWidth / currentWidth * 100,
      targetHeight / currentHeight * 100,
      constants.AnchorPosition.TOPLEFT
    );
    await selectDocumentAndLayer(document.id, currentLayer.id);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    currentLayer = findLayerById(document.layers, layer.id) || currentLayer;
    const currentBounds = numericLayerBounds(currentLayer.bounds);
    const remaining = computeTopLeftAlignmentOffset(currentBounds, targetBounds);
    if (Math.abs(remaining.x) <= 0.01 && Math.abs(remaining.y) <= 0.01) break;
    await currentLayer.translate(remaining.x, remaining.y);
    await selectDocumentAndLayer(document.id, currentLayer.id);
  }

  currentLayer = findLayerById(document.layers, layer.id) || currentLayer;
  const finalBounds = numericLayerBounds(currentLayer.bounds);
  const offset = computeTopLeftAlignmentOffset(finalBounds, targetBounds);
  const widthError = (finalBounds.right - finalBounds.left) - targetWidth;
  const heightError = (finalBounds.bottom - finalBounds.top) - targetHeight;
  if (
    Math.abs(offset.x) > 1 || Math.abs(offset.y) > 1 ||
    Math.abs(widthError) > 1 || Math.abs(heightError) > 1
  ) {
    throw new Error("生成图未能精确匹配原选区，请重试插入");
  }
  return {
    ...offset,
    widthError,
    heightError,
    bounds: finalBounds
  };
}

async function clearActivePixelSelection(document) {
  if (!document || !document.selection || !document.selection.bounds) return false;
  await document.selection.deselect();
  return true;
}

function prepareLocalEditMask(snapshot) {
  if (!snapshot || !snapshot.mask || !snapshot.mask.bytes) {
    return { bytes: null, featherRadius: 0 };
  }
  const source = snapshot.mask.bytes;
  const width = Math.round(Number(snapshot.mask.width));
  const height = Math.round(Number(snapshot.mask.height));
  const pixelCount = width * height;
  if (
    !snapshot.editBounds || width <= 0 || height <= 0 ||
    source.length < pixelCount || pixelCount > 12 * 1024 * 1024
  ) {
    return { bytes: source, featherRadius: 0 };
  }

  const configuredRadius = elements.maskFeatherEnabled.checked ? maskFeatherRadius() : 0;
  const featherRadius = Math.min(configuredRadius, Math.floor(Math.min(width, height) / 2));
  if (featherRadius <= 0) return { bytes: source, featherRadius: 0 };
  const limit = featherRadius + 1;
  const distance = new Uint16Array(pixelCount);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      if (!source[index]) continue;
      distance[index] = Math.min(limit, x + 1, y + 1, width - x, height - y);
    }
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      if (!distance[index]) continue;
      let value = distance[index];
      if (x > 0 && distance[index - 1] + 1 < value) value = distance[index - 1] + 1;
      if (y > 0 && distance[index - width] + 1 < value) value = distance[index - width] + 1;
      distance[index] = Math.min(limit, value);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = row + x;
      if (!distance[index]) continue;
      let value = distance[index];
      if (x + 1 < width && distance[index + 1] + 1 < value) value = distance[index + 1] + 1;
      if (y + 1 < height && distance[index + width] + 1 < value) value = distance[index + width] + 1;
      distance[index] = Math.min(limit, value);
    }
  }

  const output = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    if (!source[index]) continue;
    const ramp = Math.min(1, distance[index] / limit);
    output[index] = Math.min(source[index], Math.round(255 * ramp));
  }
  return { bytes: output, featherRadius };
}

function resizeGrayscaleMask(bytes, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const srcWidth = Math.round(Number(sourceWidth));
  const srcHeight = Math.round(Number(sourceHeight));
  const dstWidth = Math.round(Number(targetWidth));
  const dstHeight = Math.round(Number(targetHeight));
  if (
    srcWidth === dstWidth && srcHeight === dstHeight &&
    source.length >= dstWidth * dstHeight
  ) return source;
  if (
    srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0 ||
    source.length < srcWidth * srcHeight
  ) return null;
  const output = new Uint8Array(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y += 1) {
    const sourceY = Math.min(srcHeight - 1, Math.floor((y + 0.5) * srcHeight / dstHeight));
    const sourceRow = sourceY * srcWidth;
    const targetRow = y * dstWidth;
    for (let x = 0; x < dstWidth; x += 1) {
      const sourceX = Math.min(srcWidth - 1, Math.floor((x + 0.5) * srcWidth / dstWidth));
      output[targetRow + x] = source[sourceRow + sourceX];
    }
  }
  return output;
}

async function createInsertionSourceFile(result) {
  if (!result || result.released || !result.file) throw new Error("生成结果原始文件已不可用");
  const storedBytes = await result.file.read({ format: formats.binary });
  const storedBuffer = exactArrayBuffer(storedBytes);
  if (!storedBuffer.byteLength || (
    Number(result.byteLength) > 0 && storedBuffer.byteLength !== Number(result.byteLength)
  )) {
    throw new Error("生成结果原始文件大小校验失败，请重新生成");
  }

  const detected = detectImageType(storedBuffer);
  if (
    detected.mime !== result.mime ||
    (Number(result.width) > 0 && detected.width !== Number(result.width)) ||
    (Number(result.height) > 0 && detected.height !== Number(result.height))
  ) {
    throw new Error("生成结果原始文件内容校验失败，请重新生成");
  }

  const temporaryFolder = await localFileSystem.getTemporaryFolder();
  let insertionFile = null;
  try {
    insertionFile = await temporaryFolder.createFile(
      `katu-insert-${result.id}-${Date.now()}.${detected.extension}`,
      { overwrite: true }
    );
    await insertionFile.write(storedBuffer, { format: formats.binary });
    return insertionFile;
  } catch (error) {
    await safeDelete(insertionFile);
    throw error;
  }
}

async function openResultInPhotoshop(result) {
  const openingFile = await createInsertionSourceFile(result);
  try {
    let openedDocument = null;
    await core.executeAsModal(async () => {
      openedDocument = await app.open(openingFile);
    }, { commandName: "在 Photoshop 中打开 AI 生成原图" });
    if (!Array.isArray(result.openedFiles)) result.openedFiles = [];
    result.openedFiles.push(openingFile);
    return openedDocument;
  } catch (error) {
    await safeDelete(openingFile);
    throw error;
  }
}

async function insertResult(result, precisePlacement) {
  if (!result || !result.snapshot) throw new Error("没有可插入的生成结果");
  const snapshot = result.snapshot;
  let precise = precisePlacement !== false;
  const archivedReferences = Array.isArray(result.taskArchive && result.taskArchive.references)
    ? result.taskArchive.references
    : [];
  const archivedTargetReference = archivedReferences.find((reference) => {
    const referenceSnapshot = reference && reference.snapshot;
    return referenceSnapshot && referenceSnapshot.mode === "selection" && (
      !snapshot.sourceReferenceId ||
      String(referenceSnapshot.sourceReferenceId || "") === String(snapshot.sourceReferenceId)
    );
  }) || archivedReferences.find((reference) => (
    reference && reference.snapshot && reference.snapshot.mode === "selection"
  ));
  const archivedTargetSnapshot = archivedTargetReference && archivedTargetReference.snapshot;
  const activeTargetSnapshot = state.targetSnapshot && hasPhotoshopTarget(state.targetSnapshot) && (
    Number(state.targetSnapshot.documentId) === Number(snapshot.documentId) &&
    String(snapshot.sourceReferenceId || "") !== "" &&
    String(state.targetSnapshot.sourceReferenceId || "") === String(snapshot.sourceReferenceId || "")
  ) ? state.targetSnapshot : null;
  const preciseBounds = precise
    ? (
      storageBounds(activeTargetSnapshot && activeTargetSnapshot.editBounds) ||
      storageBounds(activeTargetSnapshot && activeTargetSnapshot.bounds) ||
      storageBounds(archivedTargetSnapshot && archivedTargetSnapshot.editBounds) ||
      storageBounds(archivedTargetSnapshot && archivedTargetSnapshot.bounds) ||
      storageBounds(snapshot.editBounds) ||
      storageBounds(snapshot.mask && snapshot.mask.bounds) ||
      storageBounds(snapshot.bounds)
    )
    : storageBounds(snapshot.bounds);
  let targetDocument = findOpenDocumentForSnapshot(snapshot);
  let usedCurrentDocumentFallback = false;
  if (!targetDocument) {
    if (!app.documents.length) throw new Error("没有找到生成时的 Photoshop 文档，也没有可插入的当前文档");
    if (precise && hasPhotoshopTarget(snapshot)) {
      throw new Error("没有找到生成时的原 Photoshop 文档；请先打开原文档，或关闭精确放回后插入当前文档");
    }
    targetDocument = app.activeDocument;
    usedCurrentDocumentFallback = true;
    precise = false;
  }
  if (!usedCurrentDocumentFallback && (
    Math.round(Number(targetDocument.width)) !== snapshot.documentWidth ||
    Math.round(Number(targetDocument.height)) !== snapshot.documentHeight
  )) {
    throw new Error("原文档画布尺寸已改变，请重新获取参考图后生成");
  }
  if (!usedCurrentDocumentFallback && targetDocument.mode !== snapshot.documentMode) {
    throw new Error("原文档颜色模式已改变，请重新获取参考图后生成");
  }
  if (!usedCurrentDocumentFallback && Math.abs((Number(targetDocument.resolution) || 72) - snapshot.documentResolution) > 0.01) {
    throw new Error("原文档分辨率已改变，请重新获取参考图后生成");
  }
  if (precise && snapshot.maskUnavailable) {
    throw new Error("这张历史图保存的原选区蒙版已缺失，无法安全地精确回填；可关闭精确放回后插入");
  }

  let insertedLayerId = null;
  let placedAtTop = false;
  let maskCreated = false;
  let maskFocused = false;
  let selectionCleared = false;
  let featherRadius = 0;
  const insertionFile = await createInsertionSourceFile(result);
  try {
    await core.executeAsModal(async (executionContext) => {
      let suspension = null;
      let generatedDocument = null;
      let generatedSourceLayer = null;
      let maskImageData = null;
      try {
      executionContext.reportProgress({ value: 0.12, commandName: "正在解码生成图片" });
      generatedDocument = await app.open(insertionFile);
      await executionContext.hostControl.registerAutoCloseDocument(generatedDocument.id);
      if (!generatedDocument.layers.length) throw new Error("生成图片中没有可用图层");
      generatedSourceLayer = generatedDocument.layers[0];

      await selectDocumentAndLayer(generatedDocument.id, generatedSourceLayer.id);
      await convertActiveLayerToSmartObject();
      generatedSourceLayer = generatedDocument.layers[0];
      if (!generatedSourceLayer) throw new Error("无法建立保留原始清晰度的智能对象");

      if (precise) {
        const targetWidth = preciseBounds.width;
        const targetHeight = preciseBounds.height;
        const crop = computeCoverCrop(
          generatedDocument.width,
          generatedDocument.height,
          targetWidth,
          targetHeight
        );
        if (
          crop.left !== 0 || crop.top !== 0 ||
          crop.right !== Math.round(Number(generatedDocument.width)) ||
          crop.bottom !== Math.round(Number(generatedDocument.height))
        ) {
          await generatedDocument.crop({
            left: crop.left,
            top: crop.top,
            right: crop.right,
            bottom: crop.bottom
          });
        }
      }
      executionContext.reportProgress({
        value: 0.48,
        commandName: precise ? "正在精确适配原选区" : "正在准备智能对象图层"
      });

      suspension = await executionContext.hostControl.suspendHistory({
        documentID: targetDocument.id,
        name: precise ? "AI 局部生成（精确回填）" : "AI 图生图插入"
      });

      let insertedLayer = null;
      if (precise) {
        await selectDocument(targetDocument.id);
        selectionCleared = await clearActivePixelSelection(targetDocument);
        await selectDocumentAndLayer(generatedDocument.id, generatedSourceLayer.id);
        insertedLayer = await generatedSourceLayer.duplicate(targetDocument);
        insertedLayer.name = buildGeneratedLayerName(result);
        insertedLayerId = insertedLayer.id;
        await selectDocumentAndLayer(targetDocument.id, insertedLayer.id);
        await alignLayerToBoundsExactly(targetDocument, insertedLayer, preciseBounds);
        await selectDocumentAndLayer(targetDocument.id, insertedLayer.id);
      } else {
        await selectDocumentAndLayer(generatedDocument.id, generatedSourceLayer.id);
        insertedLayer = await generatedSourceLayer.duplicate(targetDocument);
        insertedLayer.name = buildGeneratedLayerName(result);
        insertedLayerId = insertedLayer.id;
        await selectDocumentAndLayer(targetDocument.id, insertedLayer.id);
        const copiedBounds = numericLayerBounds(insertedLayer.boundsNoEffects);
        const targetCenterX = usedCurrentDocumentFallback
          ? Number(targetDocument.width) / 2
          : (snapshot.bounds.left + snapshot.bounds.right) / 2;
        const targetCenterY = usedCurrentDocumentFallback
          ? Number(targetDocument.height) / 2
          : (snapshot.bounds.top + snapshot.bounds.bottom) / 2;
        const copiedCenterX = (copiedBounds.left + copiedBounds.right) / 2;
        const copiedCenterY = (copiedBounds.top + copiedBounds.bottom) / 2;
        await insertedLayer.translate(targetCenterX - copiedCenterX, targetCenterY - copiedCenterY);
      }

      if (precise) {
        executionContext.reportProgress({
          value: 0.72,
          commandName: snapshot.mask ? "正在还原选区羽化蒙版" : "正在创建可编辑图层蒙版"
        });
        await selectDocumentAndLayer(targetDocument.id, insertedLayer.id);
        await createHideAllLayerMask();
        maskCreated = true;
        const maskWidth = Math.round(preciseBounds.width);
        const maskHeight = Math.round(preciseBounds.height);
        const maskBounds = preciseBounds;
        const preparedMask = snapshot.mask
          ? prepareLocalEditMask(snapshot)
          : { bytes: new Uint8Array(maskWidth * maskHeight).fill(255), featherRadius: 0 };
        const maskBytes = snapshot.mask
          ? resizeGrayscaleMask(
            preparedMask.bytes,
            snapshot.mask.width,
            snapshot.mask.height,
            maskWidth,
            maskHeight
          )
          : preparedMask.bytes;
        if (!maskBounds || maskWidth <= 0 || maskHeight <= 0 ||
          !maskBytes || maskBytes.length < maskWidth * maskHeight) {
          throw new Error("原选区蒙版尺寸无效，请重新获取选区后生成");
        }
        featherRadius = preparedMask.featherRadius;
        maskImageData = await imaging.createImageDataFromBuffer(maskBytes, {
          width: maskWidth,
          height: maskHeight,
          components: 1,
          chunky: false,
          colorSpace: "Grayscale",
          colorProfile: "Gray Gamma 2.2"
        });
        await imaging.putLayerMask({
          documentID: targetDocument.id,
          layerID: insertedLayer.id,
          kind: "user",
          imageData: maskImageData,
          replace: false,
          targetBounds: {
            left: maskBounds.left,
            top: maskBounds.top
          },
          commandName: "以蒙版还原原选区"
        });
      }

      placedAtTop = await moveLayerToDocumentTop(targetDocument, insertedLayer);
      if (!placedAtTop) throw new Error("无法将生成图层放到文档最上方");

      if (executionContext.isCancelled) throw new Error("插入操作已取消");
      await selectDocumentAndLayer(targetDocument.id, insertedLayer.id);
      executionContext.reportProgress({ value: 1, commandName: "插入完成" });
      await executionContext.hostControl.resumeHistory(suspension, true);
      suspension = null;
      if (maskCreated) {
        try {
          await selectLayerMask(targetDocument.id, insertedLayer.id);
          maskFocused = true;
        } catch (_) {
          try {
            await selectDocumentAndLayer(targetDocument.id, insertedLayer.id);
          } catch (_) {
            // The layer is already inserted; thumbnail focus is non-critical.
          }
        }
      }
      } catch (error) {
        if (suspension) {
          try {
            await executionContext.hostControl.resumeHistory(suspension, false);
          } catch (_) {
            // A thrown modal scope also rolls back an unresumed suspension.
          }
        }
        throw error;
      } finally {
        if (maskImageData) maskImageData.dispose();
        // generatedDocument is registered for automatic close at modal exit.
      }
    }, { commandName: "插入 AI 生成原图" });
  } finally {
    await safeDelete(insertionFile);
  }

  return {
    insertedLayerId,
    placedAtTop,
    maskCreated,
    maskFocused,
    selectionCleared,
    featherRadius,
    precisePlacement: precise,
    targetBounds: precise ? preciseBounds : null,
    usedCurrentDocumentFallback,
    preservedResolution: true,
    taskGroupName: ""
  };
}

function isAbortError(error) {
  return error && (error.name === "AbortError" || /aborted|取消/i.test(String(error.message || error)));
}

async function runGenerationJob(job) {
  let returnedMultiple = false;
  let unexpectedError = null;
  let recoverySummary = { attempted: 0, recovered: 0, lastError: null };
  const completedAction = hasPhotoshopDocument(job.snapshot) || hasCurrentPhotoshopDocument()
    ? "插入"
    : "在 Photoshop 中打开";

  const acceptGeneratedImage = async (image, index, options = {}) => {
    const fingerprint = imageBufferFingerprint(image.buffer);
    const pendingTask = pendingTaskForJob(job);
    const pendingEntry = pendingAsyncTaskEntry(pendingTask, index);
    const asyncTaskId = String(image.asyncTaskId || options.asyncTaskId || "").trim();
    const taskHistoryKey = historyRecordBaseKey(
      options.historyRecordKey || (asyncTaskId ? `id:${asyncTaskId}` : "")
    );
    const alreadyStoredForTask = Boolean(
      (pendingEntry || taskHistoryKey) && state.results.some((result) => {
        const sameTask = pendingEntry
          ? resultMatchesAsyncEntry(result, pendingEntry)
          : historyRecordBaseKey(result.historyRecordKey) === taskHistoryKey;
        // One async task can contain more than one image. Only suppress the
        // exact image already persisted, never the whole task.
        return sameTask && String(result.imageFingerprint || "") === fingerprint;
      })
    );
    const alreadyStoredWithoutTask = !taskHistoryKey && (
      job.imageFingerprints.has(fingerprint) || state.results.some(
        (result) => result.imageFingerprint === fingerprint
      )
    );
    if (options.recoveredFromHistory && (alreadyStoredForTask || alreadyStoredWithoutTask)) return null;
    const historyCandidateIndex = Math.max(0, Number(options.historyCandidateIndex) || 0);
    const result = await storeResult(
      image,
      job.snapshot,
      job.requested,
      job.prompt,
      {
        fileTag: options.recoveredFromHistory
          ? String(job.sequence) + "-history-" + String(index + 1) + "-" + String(historyCandidateIndex + 1)
          : String(job.sequence) + "-" + String(index + 1),
        selectResult: false,
        taskArchive: job.taskArchive,
        requestPrompt: job.requestPrompt || job.prompt,
        imageFingerprint: fingerprint,
        recoveredFromHistory: Boolean(options.recoveredFromHistory),
        historyRecordKey: options.historyRecordKey || (
          asyncTaskId || pendingEntry && pendingEntry.id
            ? `id:${asyncTaskId || pendingEntry.id}`
            : ""
        ),
        sourceJobId: job.id
      }
    );
    job.imageFingerprints.add(fingerprint);
    if (!(job.completedRequestIndexes instanceof Set)) job.completedRequestIndexes = new Set();
    const firstForRequest = !job.completedRequestIndexes.has(index);
    const firstCompleted = job.completedCount === 0;
    if (firstForRequest) {
      job.completedRequestIndexes.add(index);
      job.completedCount += 1;
    }
    if (options.recoveredFromHistory) {
      job.recoveredCount += 1;
      if (firstForRequest) job.failedCount = Math.max(0, job.failedCount - 1);
    }
    if (result.count > 1) returnedMultiple = true;
    const shouldAutoSelect = !getSelectedResult() || (
      job.autoSelect && state.selectionRevision === job.selectionRevisionAtStart
    );
    if (firstCompleted && shouldAutoSelect) {
      state.selectedResultId = result.id;
      state.selectionRevision += 1;
      renderResultHistory();
    }
    renderGenerationQueue();
    return result;
  };

  const runConcurrentRequest = async (index) => {
    const requestIsVolc = isVolcModel(job.model);
    const requestController = new AbortController();
    let timeoutHandle = null;
    let timedOut = false;
    let requestSubmitted = false;
    let responseReceived = false;
    const abortRequest = () => requestController.abort();
    job.requestControllers.push(requestController);

    if (job.controller.signal.aborted) {
      abortRequest();
    } else if (typeof job.controller.signal.addEventListener === "function") {
      job.controller.signal.addEventListener("abort", abortRequest);
    }

    try {
      if (job.controller.signal.aborted) {
        const stopped = new Error("任务已取消");
        stopped.name = "AbortError";
        throw stopped;
      }
      if (!requestIsVolc) {
        const pendingSaved = await markPendingRequestSubmitted(job);
        if (!pendingSaved) {
          throw new Error("无法保存本次待找回记录；为避免断线后丢失结果，生成请求未发送");
        }
        if (job.controller.signal.aborted || requestController.signal.aborted) {
          await unmarkPendingRequestSubmitted(job);
          const stopped = new Error("任务已取消");
          stopped.name = "AbortError";
          throw stopped;
        }
      } else if (job.controller.signal.aborted || requestController.signal.aborted) {
        const stopped = new Error("任务已取消");
        stopped.name = "AbortError";
        throw stopped;
      }
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        requestController.abort();
      }, Math.max(API_CONFIG.timeoutMs, API_CONFIG.asyncPollTimeoutMs + 30 * 1000));
      requestSubmitted = true;
      const response = await requestImageEdit({
        apiKey: job.apiKey,
        model: job.model,
        prompt: job.requestPrompt || job.prompt,
        size: job.requested.size,
        aspectRatio: job.requested.ratio,
        resolution: job.requested.resolution,
        imageFiles: job.imageFiles,
        signal: requestController.signal,
        ...(requestIsVolc ? {} : {
          onTaskSubmitted: async (taskInfo) => {
            const saved = await markPendingAsyncTaskSubmitted(job, index, taskInfo);
            if (!saved) throw new Error("异步任务 ID 无法保存；已停止本地查询，请稍后从 API 历史核对结果");
          },
          onTaskUpdated: async (update) => {
            await updatePendingAsyncTask(job, index, update);
          }
        })
      });
      responseReceived = true;
      if (job.controller.signal.aborted) {
        const stopped = new Error("任务已取消");
        stopped.name = "AbortError";
        throw stopped;
      }

      const images = Array.isArray(response && response.images) ? response.images : [response];
      const results = [];
      for (const image of images) {
        if (!image || !image.buffer) continue;
        const result = await acceptGeneratedImage(image, index);
        if (result) results.push(result);
      }
      if (!results.length) throw new Error("Async task did not return a usable image");
      const pendingEntry = pendingAsyncTaskEntry(pendingTaskForJob(job), index);
      const resolvedHistoryKey = results[0].historyRecordKey || "";
      await markPendingRequestResolved(
        job,
        resolvedHistoryKey,
        index,
        response && response.taskId || pendingEntry && pendingEntry.id || ""
      );
      return {
        ok: true,
        index,
        result: results[0],
        results,
        partialErrors: Array.isArray(response && response.partialErrors) ? response.partialErrors : []
      };
    } catch (error) {
      job.failedCount += 1;
      if (error && error.httpStatus === 401) {
        job.currentKeyCleared = await clearStoredGenerationKeyForJob(job) || Boolean(job.currentKeyCleared);
      }
      const pendingEntry = pendingAsyncTaskEntry(pendingTaskForJob(job), index);
      const outcome = {
        ok: false,
        volc: requestIsVolc,
        index,
        error,
        timedOut,
        requestSubmitted,
        responseReceived: responseReceived || Boolean(error && error.responseReceived),
        hasPersistedAsyncTaskId: asyncTaskIdsForEntry(pendingEntry).length > 0,
        terminalTaskFailure: Boolean(error && error.terminalTaskFailure)
      };
      if (requestSubmitted && !serverMayStillCompleteOutcome(outcome)) {
        await markPendingRequestKnownFailed(job, index);
      }
      return outcome;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (typeof job.controller.signal.removeEventListener === "function") {
        job.controller.signal.removeEventListener("abort", abortRequest);
      }
      const requestIndex = job.requestControllers.indexOf(requestController);
      if (requestIndex >= 0) job.requestControllers.splice(requestIndex, 1);
      job.settledCount += 1;
      renderGenerationQueue();
      const remaining = job.requestedCount - job.settledCount;
      if (remaining > 0 && !state.inserting) {
        const readyNote = job.completedCount > 0
          ? "已完成 " + job.completedCount + " 张，可先选择并" + completedAction + "；"
          : "";
        const failedNote = job.failedCount > 0 ? "失败 " + job.failedCount + " 张；" : "";
        setStatus(
          "working",
          "任务 " + job.sequence + " 并发生成中 " + job.settledCount + " / " + job.requestedCount,
          readyNote + failedNote + "还有 " + remaining + " 张处理中"
        );
      }
    }
  };

  const recoverFromHistory = async (recoverableOutcomes) => {
    const pending = recoverableOutcomes.slice();
    const pendingTask = pendingTaskForJob(job);
    const usedHistoryKeys = usedHistoryRecordKeys(
      state.results,
      pendingTask && pendingTask.recoveredHistoryKeys,
      pendingTask && pendingTask.asyncTasks
    );
    if (pendingTask && !Number(pendingTask.autoRecoveryStartedAt)) {
      pendingTask.autoRecoveryStartedAt = Date.now();
      await queuePersistHistoryState();
    }
    const deadline = pendingTask && Number(pendingTask.autoRecoveryStartedAt)
      ? Number(pendingTask.autoRecoveryStartedAt) + Math.max(
        0,
        HISTORY_RECOVERY_TIMEOUT_MS - Math.max(0, Number(pendingTask.recoveryElapsedMs) || 0)
      )
      : Date.now() + HISTORY_RECOVERY_TIMEOUT_MS;
    let lastError = null;
    job.status = "recovering";
    renderGenerationQueue();
    updateControls();
    setStatus(
      "warning",
      "任务 " + job.sequence + " 连接已断开，正在找回",
      "生成请求不会重发；正在从最近 3 天的 API 历史中查找已生成图片"
    );

    while (pending.length && !job.controller.signal.aborted && Date.now() < deadline) {
      try {
        if (pendingTask) {
          const directRecovered = await recoverPendingTaskById(pendingTask, job.apiKey, job.controller.signal);
          const recoveredByRequest = new Map();
          for (const recovered of directRecovered) {
            const requestIndex = Math.max(0, Number(recovered.entry && recovered.entry.requestIndex) || 0);
            if (!recoveredByRequest.has(requestIndex)) recoveredByRequest.set(requestIndex, []);
            recoveredByRequest.get(requestIndex).push(recovered);
          }
          for (const [requestIndex, recoveredItems] of recoveredByRequest) {
            const matchingOutcomeIndex = pending.findIndex((candidateOutcome) => candidateOutcome.index === requestIndex);
            if (matchingOutcomeIndex < 0) continue;
            const outcome = pending[matchingOutcomeIndex];
            const results = [];
            let resolvedHistoryKey = "";
            let resolvedTaskId = "";
            for (const recovered of recoveredItems) {
              const taskId = recovered.taskId || recovered.entry.id;
              const historyKey = `id:${taskId}`;
              const result = await acceptGeneratedImage(recovered.image, outcome.index, {
                recoveredFromHistory: true,
                historyRecordKey: historyKey,
                asyncTaskId: taskId
              });
              if (!result) continue;
              results.push(result);
              resolvedHistoryKey = resolvedHistoryKey || historyKey;
              resolvedTaskId = resolvedTaskId || taskId;
              usedHistoryKeys.add(historyKey);
            }
            if (!results.length) continue;
            await markPendingRequestResolved(job, resolvedHistoryKey, outcome.index, resolvedTaskId);
            pending.splice(matchingOutcomeIndex, 1);
            outcome.ok = true;
            outcome.recovered = true;
            outcome.result = results[0];
            outcome.results = results;
            outcome.historyRecordKey = resolvedHistoryKey;
          }
          await updatePendingHistoryTask(job);
          if (!pending.length) break;
        }
        const payload = await fetchGenerationHistory(job.apiKey, job.controller.signal);
        const matches = matchingHistoryRecords(payload, job);
        for (const item of matches) {
          if (!pending.length) break;
          if (item.key && usedHistoryKeys.has(item.key)) continue;
          const candidates = historyRecordImageCandidates(item.record);
          if (!candidates.length) continue;
          let matchingOutcomeIndex = pending.findIndex((candidateOutcome) => {
            const entry = pendingAsyncTaskEntry(pendingTask, candidateOutcome.index);
            return entry && historyRecordMatchesAsyncEntry(item, entry);
          });
          if (matchingOutcomeIndex < 0) {
            const anyTrackedIds = pending.some((candidateOutcome) => {
              const entry = pendingAsyncTaskEntry(pendingTask, candidateOutcome.index);
              return asyncTaskIdsForEntry(entry).length > 0;
            });
            if (!anyTrackedIds && pending.length === 1) matchingOutcomeIndex = 0;
          }
          if (matchingOutcomeIndex < 0) continue;
          const outcome = pending[matchingOutcomeIndex];
          const results = [];
          let candidateError = null;
          for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
            const candidate = candidates[candidateIndex];
            try {
              const image = await historyCandidateToImage(candidate, job.apiKey, job.controller.signal);
              const result = await acceptGeneratedImage(image, outcome.index, {
                recoveredFromHistory: true,
                historyRecordKey: historyRecordCandidateKey(item.key, candidate, candidateIndex),
                historyCandidateIndex: candidateIndex,
                resolvePendingRequest: false
              });
              if (result) results.push(result);
            } catch (error) {
              if (isAbortError(error) && job.controller.signal.aborted) throw error;
              if (error && error.httpStatus === 401) throw error;
              candidateError = candidateError || error;
            }
          }
          if (!results.length) {
            if (candidateError) {
              lastError = candidateError;
            } else if (item.key) {
              const entry = pendingAsyncTaskEntry(pendingTask, outcome.index);
              historyRecordAliasKeys(item.key, entry ? [entry] : pendingTask && pendingTask.asyncTasks)
                .forEach((key) => usedHistoryKeys.add(key));
            }
            continue;
          }
          try {
            await markPendingRequestResolved(job, item.key || "", outcome.index, "");
            pending.splice(matchingOutcomeIndex, 1);
            outcome.ok = true;
            outcome.recovered = true;
            outcome.result = results[0] || null;
            outcome.results = results;
            outcome.historyRecordKey = item.key;
            if (item.key) usedHistoryKeys.add(item.key);
            setStatus(
              "working",
              "任务 " + job.sequence + " 已从历史找回 " + job.recoveredCount + " 张",
              pending.length ? "还有 " + pending.length + " 张继续查询中；不会重新发送生成请求" : "正在整理找回的图片"
            );
          } catch (error) {
            if (isAbortError(error) && job.controller.signal.aborted) throw error;
            if (error && error.httpStatus === 401) throw error;
            lastError = error;
          }
        }
      } catch (error) {
        if (isAbortError(error) && job.controller.signal.aborted) throw error;
        lastError = error;
        if (error && error.httpStatus === 401) {
          job.currentKeyCleared = await clearStoredGenerationKeyForJob(job) || Boolean(job.currentKeyCleared);
          break;
        }
      }

      if (pending.length && !job.controller.signal.aborted && Date.now() < deadline) {
        setStatus(
          "working",
          "任务 " + job.sequence + " 正在查询生成历史",
          "暂时还没找到全部图片；10 秒后继续查询，不会重新扣费生成"
        );
        await waitForHistoryPoll(job.controller.signal);
      }
    }

    if (pending.length && !job.controller.signal.aborted && Date.now() >= deadline && pendingTask) {
      pendingTask.autoRecoveryExhausted = true;
    }
    if (pendingTask) {
      finishPendingRecoverySession(pendingTask);
      await queuePersistHistoryState();
    }
    return {
      attempted: recoverableOutcomes.length,
      recovered: job.recoveredCount,
      lastError
    };
  };

  let outcomes = [];
  try {
    try {
      if (isVolcModel(job.model)) {
        job.historyBaselineKeys = new Set();
      } else {
        const baselinePayload = await fetchGenerationHistory(job.apiKey, job.controller.signal);
        job.historyBaselineKeys = new Set(
          extractHistoryRecords(baselinePayload).map(historyRecordKey).filter(Boolean)
        );
        await updatePendingHistoryTask(job);
      }
    } catch (error) {
      job.historyBaselineError = error;
    }

    outcomes = await Promise.all(
      Array.from(
        { length: job.requestedCount },
        (_, index) => runConcurrentRequest(index)
      )
    );

    const recoverableOutcomes = outcomes.filter(historyRecoverableOutcome);
    if (recoverableOutcomes.length && !job.controller.signal.aborted) {
      recoverySummary = await recoverFromHistory(recoverableOutcomes);
    }
  } catch (error) {
    if (!(isAbortError(error) && job.controller.signal.aborted)) {
      unexpectedError = error;
      job.controller.abort();
      job.requestControllers.forEach((requestController) => requestController.abort());
    }
  }

  const stopped = job.controller.signal.aborted;
  const failures = outcomes.filter((outcome) => !outcome.ok);
  const firstFailure = failures.length ? failures[0] : null;
  const unresolvedHistory = failures.filter(historyRecoverableOutcome);
  let statusKind = "success";
  let statusTitle = "任务 " + job.sequence + " 已完成";
  let statusDetail = hasPhotoshopDocument(job.snapshot) || hasCurrentPhotoshopDocument()
    ? "点击生成历史选择图片，再点击“插入图层”"
    : "点击生成历史选择图片，再点击“在 PS 中打开”";

  if (unexpectedError) {
    statusKind = job.completedCount > 0 ? "warning" : "error";
    statusTitle = job.completedCount > 0
      ? "任务 " + job.sequence + " 已保留 " + job.completedCount + " 张"
      : "任务 " + job.sequence + " 运行异常";
    statusDetail = unexpectedError.message || unexpectedError;
  } else if (stopped) {
    statusKind = "warning";
    statusTitle = "任务 " + job.sequence + " 已停止，保留 " + job.completedCount + " 张";
    statusDetail = job.completedCount > 0
      ? "已完成的图片仍可在历史中选择并" + completedAction
      : "已经提交的请求不保证能在服务端取消或退费";
  } else if (job.completedCount >= job.requestedCount) {
    statusKind = "success";
    statusTitle = recoverySummary.recovered > 0
      ? "任务 " + job.sequence + " 已完成，历史找回 " + recoverySummary.recovered + " 张"
      : "任务 " + job.sequence + " 已并发生成 " + job.completedCount + " 张";
    statusDetail = (returnedMultiple ? "接口个别响应包含多张，已全部保留；" : "") +
      (recoverySummary.recovered > 0 ? "断线结果已找回，没有重新生成；" : "") + "结果已进入生成历史";
  } else if (job.completedCount > 0) {
    statusKind = "warning";
    statusTitle = "任务 " + job.sequence + " 已生成 " + job.completedCount + " / " + job.requestedCount + " 张";
    statusDetail = unresolvedHistory.length
      ? "还有 " + unresolvedHistory.length + " 张暂未从历史找到；插件没有重新生成，请稍后到 API 历史中查看。已找回或成功的图片仍可" + completedAction
      : (firstFailure && firstFailure.error ? firstFailure.error.message || firstFailure.error : "部分请求未完成") + "；成功结果仍可选择并" + completedAction;
  } else if (firstFailure && firstFailure.error && firstFailure.error.httpStatus === 401) {
    statusKind = "error";
    statusTitle = "API Key 无效";
    statusDetail = job.currentKeyCleared
      ? "本机保存的无效密钥已清除；下次运行会重新要求输入"
      : "该任务使用的旧密钥无效；当前已保存的密钥未改动";
  } else if (unresolvedHistory.length) {
    statusKind = "warning";
    statusTitle = "任务 " + job.sequence + " 暂未从历史找到结果";
    statusDetail = "生成请求没有重发，也不会再次扣费生成。服务端可能仍在处理，请稍后查询最近 3 天的 API 历史" +
      (recoverySummary.lastError ? "；最后一次查询提示：" + String(recoverySummary.lastError.message || recoverySummary.lastError) : "");
  } else if (firstFailure && Number(firstFailure.error && firstFailure.error.httpStatus) === 400) {
    statusKind = "error";
    statusTitle = "请求参数不支持";
    statusDetail = String(firstFailure.error.message || firstFailure.error) + "；本次请求没有生成图片，请更换尺寸或模型后再试";
  } else if (firstFailure && firstFailure.responseReceived) {
    statusKind = "warning";
    statusTitle = "图片已返回，但本地处理失败";
    statusDetail = String(firstFailure.error.message || firstFailure.error) + "；请勿立即重复付费生成";
  } else {
    statusKind = "error";
    statusTitle = "任务 " + job.sequence + " 生成失败";
    statusDetail = firstFailure && firstFailure.error ? String(firstFailure.error.message || firstFailure.error) : "接口请求未完成";
  }

  if (isVolcModel(job.model)) {
    statusDetail = String(statusDetail) + `；GPT 2.5 价格以咖图实时价格为准，本次预计 ${formatYuan(job.estimatedCost)}，费用以火山方舟账单为准`;
  } else if (job.priceUnverified) {
    statusDetail = String(statusDetail) + "；本次实时价格未确认，实际费用请以服务端账单为准";
  }

  job.status = stopped ? "stopped" : (job.completedCount > 0 ? "complete" : "failed");
  job.progressCompleting = true;
  job.visualProgress = Math.min(96, Math.max(8, Number(job.visualProgress) || 8));
  renderGenerationQueue();
  await waitForGenerationProgressFrame();
  job.progressCompleting = false;
  job.visualProgress = 100;
  updateGenerationProgressVisuals();
  await waitForGenerationProgressCompletion();
  try {
    await releaseGenerationJobReferences(job);
  } catch (error) {
    statusKind = "warning";
    statusDetail = String(statusDetail) + "；临时参考图稍后由宿主释放";
  }

  const pendingTask = pendingTaskForJob(job);
  if (pendingTask) {
    if (pendingHistoryOutstandingCount(pendingTask) > 0) {
      await updatePendingHistoryTask(job);
    } else {
      await removePendingHistoryTask(pendingTask);
      job.pendingHistoryTask = null;
    }
  }

  const jobIndex = state.generationJobs.indexOf(job);
  if (jobIndex >= 0) state.generationJobs.splice(jobIndex, 1);
  state.running = state.generationJobs.length > 0;
  renderGenerationQueue();
  if (!state.inserting) setStatus(statusKind, statusTitle, statusDetail);
  updateControls();
}

async function handleRun(options = {}) {
  const guardAlreadyHeld = Boolean(options._submissionGuardAcquired);
  if (!guardAlreadyHeld) {
    if (state.runSubmissionPending) return;
    state.runSubmissionPending = true;
    updateControls();
  }
  try {
    return await handleRunInternal(options);
  } finally {
    if (!guardAlreadyHeld) {
      state.runSubmissionPending = false;
      updateControls();
    }
  }
}

async function handleRunInternal(options = {}) {
  const skipPromptOptimization = Boolean(options.skipPromptOptimization);
  const modelOutfitEnabled = Boolean(options.forceModelOutfit);
  const referencesOverride = Array.isArray(options.referencesOverride) ? options.referencesOverride.filter(Boolean) : null;
  const snapshotOverride = options.snapshotOverride && options.snapshotOverride.bounds ? options.snapshotOverride : null;
  const requestedLocalEditMode = String(options.localEditMode || "");
  const productDraftSnapshot = requestedLocalEditMode === "product"
    ? normalizeProductDraft(options.productDraft || readProductDraft())
    : null;
  const outfitType = normalizeOutfitType(options.outfitType);
  const outfitPromptSnapshot = modelOutfitEnabled
    ? (String(options.outfitPromptOverride || "").trim() || DEFAULT_OUTFIT_STYLE_PROMPT)
    : "";
  const outfitExtraPromptSnapshot = modelOutfitEnabled
    ? (String(options.outfitExtraPromptOverride || "").trim() || DEFAULT_OUTFIT_EXTRA_PROMPT)
    : "";
  if (state.preparingJob || state.capturing || state.inserting || state.promptOptimizing) return;
  if (state.generationJobs.length >= MAX_ACTIVE_JOBS) {
    setStatus("warning", "并发任务已满", "最多同时保留 " + MAX_ACTIVE_JOBS + " 个生成任务");
    return;
  }

  const hasPromptOverride = Object.prototype.hasOwnProperty.call(options, "promptOverride");
  let prompt = modelOutfitEnabled
    ? outfitPromptSnapshot
    : String(hasPromptOverride ? options.promptOverride : getPromptValue()).trim();
  if (!prompt) {
    setStatus("error", "缺少提示词", "请描述你希望如何修改当前参考图");
    elements.prompt.focus();
    return;
  }
  if (!modelOutfitEnabled && !(referencesOverride ? referencesOverride.length : state.references.length)) {
    setStatus("error", "没有参考图", "请获取 Photoshop 选区、图层或全图，或点击“＋”导入本机图片");
    return;
  }
  if (!modelOutfitEnabled && !referencesOverride) {
    const targetRestore = await restoreMissingEditorTargetReference();
    if (!targetRestore.ok) {
      setStatus("error", "主参考图与上传列表不一致", targetRestore.message);
      return;
    }
  }
  const outfitTarget = modelOutfitEnabled ? outfitTargetReference() : null;
  const sourceSnapshot = modelOutfitEnabled
    ? (outfitTarget && outfitTarget.snapshot || null)
    : (snapshotOverride || getGenerationSnapshot());
  if (!sourceSnapshot) {
    setStatus(
      "error",
      modelOutfitEnabled ? "缺少模特姿势图" : "缺少主参考图",
      modelOutfitEnabled ? "请从选区、图层或本地添加一张模特姿势图" : "请重新获取或导入一张有效参考图"
    );
    return;
  }
  let references = modelOutfitEnabled ? [] : (referencesOverride || state.references.slice());
  if (
    !modelOutfitEnabled &&
    hasPhotoshopTarget(sourceSnapshot) &&
    !runReferenceMatchesSnapshot(references, sourceSnapshot)
  ) {
    setStatus(
      "error",
      "主参考图与上传列表不一致",
      "本次生成已停止，避免把辅助选区当成图一上传；请重新获取主参考图后再运行"
    );
    return;
  }
  let outfitGarmentsForRun = [];
  if (modelOutfitEnabled) {
    if (!outfitTarget) {
      setStatus("error", "缺少模特姿势图", "请从选区、图层或本地添加一张模特姿势图");
      return;
    }
    const faceReference = outfitFaceReference();
    if (!faceReference) {
      setStatus("error", "缺少模特人脸图", "请从选区、图层或本地添加一张清晰人脸照片");
      return;
    }
    const requiredGarments = outfitSlotLabels(outfitType).length;
    const garmentSlots = outfitGarmentSlotReferences();
    outfitGarmentsForRun = Array.from({ length: requiredGarments }, (_, index) => (
      isUsableOutfitGarmentReference(garmentSlots[index]) ? garmentSlots[index] : null
    ));
    const missingGarmentIndexes = outfitGarmentsForRun
      .map((reference, index) => reference ? -1 : index)
      .filter((index) => index >= 0);
    if (missingGarmentIndexes.length) {
      const requiredLabels = outfitSlotLabels(outfitType);
      setStatus(
        "error",
        "服饰参考图不完整",
        `请补充：${missingGarmentIndexes.map((index) => requiredLabels[index]).join("、")}`
      );
      return;
    }
    const backgroundReference = outfitBackgroundReference();
    references = [outfitTarget, faceReference, ...outfitGarmentsForRun, backgroundReference].filter(Boolean);
    elements.precisionPlacement.checked = hasPhotoshopTarget(sourceSnapshot);
    if (elements.aspectRatio.value !== "auto") {
      elements.aspectRatio.value = "auto";
      syncIslandSelects();
      updateResolvedSize();
    }
  }
  const snapshot = {
    ...sourceSnapshot,
    localEditMode: modelOutfitEnabled ? "outfit" : (requestedLocalEditMode || "general"),
    outfitType: modelOutfitEnabled ? outfitType : "",
    outfitFaceReferenceId: modelOutfitEnabled ? String(state.outfitFaceReferenceId || "") : "",
    outfitBackgroundReferenceId: modelOutfitEnabled ? String(state.outfitBackgroundReferenceId || "") : "",
    outfitGarmentReferenceIds: modelOutfitEnabled
      ? outfitGarmentsForRun.map((reference) => reference.id)
      : [],
    outfitPrompt: modelOutfitEnabled ? outfitPromptSnapshot : "",
    outfitExtraPrompt: modelOutfitEnabled ? outfitExtraPromptSnapshot : "",
    product: requestedLocalEditMode === "product" ? productDraftSnapshot : null
  };
  const requestPrompt = String(snapshot.localEditMode || "") === "product"
    ? prompt
    : buildLocalEditPrompt(prompt, snapshot, references);
  const archivePrompt = String(options.archivePromptOverride || prompt).slice(0, 20000);
  const runModelConfig = getSelectedModelConfig();
  const runIsVolc = isVolcModel(runModelConfig.apiModel);
  if (runIsVolc ? !state.volcImageApiKey : !state.apiKey) {
    state.resumeRunOptions = (modelOutfitEnabled || referencesOverride || snapshotOverride) ? {
      forceModelOutfit: modelOutfitEnabled,
      skipPromptOptimization: true,
      promptOverride: String(hasPromptOverride ? options.promptOverride : prompt),
      archivePromptOverride: archivePrompt,
      outfitType,
      outfitPromptOverride: outfitPromptSnapshot,
      outfitExtraPromptOverride: outfitExtraPromptSnapshot,
      referencesOverride,
      snapshotOverride,
      localEditMode: requestedLocalEditMode,
      productDraft: productDraftSnapshot,
      controlOverrides: normalizeRunControlOverrides(options.controlOverrides)
    } : null;
    setStatus(
      "warning",
      runIsVolc ? "需要火山生成密钥" : "需要 API Key",
      runIsVolc ? "请在弹出的本地密钥窗口中填写火山方舟生成 API Key（ark-...）" : "请在弹出的本地密钥窗口中填写一次"
    );
    showKeyDialog(true, runIsVolc ? "volc" : "katu");
    return;
  }
  state.resumeRunOptions = null;

  state.preparingJob = true;
  updateControls();
  const modelConfig = runModelConfig;
  let preparedJob = null;
  setStatus(
    "working",
    runIsVolc ? "正在建立火山生成任务" : "正在核对实时价格",
    runIsVolc
      ? `${modelConfig.shortLabel} · ${elements.resolution.value} × ${getGenerationCount()} 张；GPT 2.5 价格以咖图实时价格为准 ${formatYuan(volcFixedPrice(elements.resolution.value))}/张`
      : `${modelConfig.shortLabel} · ${elements.resolution.value} × ${getGenerationCount()} 张；核对完成前不会发送付费请求`
  );
  try {
    const priceCheck = await verifyLivePricingBeforeRun();
    if (!priceCheck.ok) {
      setStatus("warning", priceCheck.title, priceCheck.detail);
      return;
    }
    const checkedEstimate = normalizePriceValue(priceCheck.estimatedCost);
    const allowance = budgetAllowance(checkedEstimate);
    if (!allowance.ok) {
      if (allowance.priceUnknown) {
        setStatus(
          "warning",
          "无法确认本次价格",
          `已设置每日费用保护上限 ${formatYuan(allowance.limit)}，价格未确认时不会发送付费请求`
        );
        return;
      }
      setStatus(
        "warning",
        "已达到每日费用保护上限",
        `今日已记录 ${formatYuan(allowance.spent)}，本次预计 ${formatYuan(allowance.cost)}，每日上限 ${formatYuan(allowance.limit)}；本次未发送付费请求`
      );
      return;
    }
    const priceSummary = checkedEstimate === null
      ? "当前价格无法查询"
      : `预计 ${formatYuan(checkedEstimate)}${priceCheck.priceUnverified ? "（未核实）" : ""}`;
    setStatus(
      runIsVolc ? "working" : (priceCheck.priceUnverified ? "warning" : "working"),
      runIsVolc ? "正在建立火山生成任务" : (priceCheck.priceUnverified ? "实时价格未确认，已按二次点击继续" : "正在建立生成任务"),
      runIsVolc
        ? `${priceCheck.size} × ${getGenerationCount()} 张，预计 ${formatYuan(priceCheck.estimatedCost)}，直连火山方舟；${snapshot.mode === "import" ? "正在保存主导入图和参考图" : "正在保存本次选区和参考图"}`
        : `${priceCheck.size} × ${getGenerationCount()} 张，${priceSummary}；${snapshot.mode === "import" ? "正在保存主导入图和参考图" : "正在保存本次选区和参考图"}`
    );
    const requestedCount = getGenerationCount();
    const requested = resolveModelOutputSize(
      elements.aspectRatio.value,
      elements.resolution.value,
      snapshot.bounds.width,
      snapshot.bounds.height,
      modelConfig
    );
    requested.model = modelConfig.apiModel;
    requested.modelLabel = modelConfig.shortLabel;
    let totalUploadBytes = 0;
    for (const reference of references) {
      const metadata = await reference.file.getMetadata();
      totalUploadBytes += Number(metadata.size) || 0;
    }
    if (totalUploadBytes > API_CONFIG.maxUploadBytes) {
      throw new Error("全部参考图合计超过 64 MB，请删除部分参考图或缩小获取区域");
    }

    saveSettings();
    state.generationJobSequence += 1;
    const jobId = "job-" + Date.now() + "-" + state.generationJobSequence;
    const jobCreatedAt = new Date();
    const job = {
      id: jobId,
      sequence: state.generationJobSequence,
      prompt: archivePrompt,
      requestPrompt,
      model: modelConfig.apiModel,
      modelLabel: modelConfig.shortLabel,
      snapshot,
      references,
      imageFiles: references.map((reference) => reference.file),
      apiKey: runIsVolc ? state.volcImageApiKey : state.apiKey,
      requested,
      requestedCount,
      aspectRatio: elements.aspectRatio.value,
      resolution: elements.resolution.value,
      precisionPlacement: modelOutfitEnabled ? true : elements.precisionPlacement.checked,
      localEditMode: snapshot.localEditMode || "general",
      unitPrice: priceCheck.unitPrice,
      estimatedCost: priceCheck.estimatedCost,
      priceUnverified: Boolean(priceCheck.priceUnverified),
      priceWarning: String(priceCheck.priceWarning || ""),
      completedCount: 0,
      failedCount: 0,
      settledCount: 0,
      recoveredCount: 0,
      historyBaselineKeys: new Set(),
      historyBaselineError: null,
      imageFingerprints: new Set(),
      completedRequestIndexes: new Set(),
      status: "running",
      controller: new AbortController(),
      requestControllers: [],
      autoSelect: state.generationJobs.length === 0,
      selectionRevisionAtStart: state.selectionRevision,
      visualProgress: 8,
      progressCompleting: false,
      createdAt: jobCreatedAt
    };
    preparedJob = job;
    job.taskArchive = {
      id: jobId,
      sequence: job.sequence,
      prompt: archivePrompt,
      promptOptimized: !modelOutfitEnabled && requestedLocalEditMode !== "product" && isPromptAlreadyOptimized(archivePrompt),
      model: job.model,
      modelLabel: job.modelLabel,
      snapshot,
      references: references.slice(),
      requested,
      generationCount: requestedCount,
      aspectRatio: job.aspectRatio,
      resolution: job.resolution,
      precisionPlacement: job.precisionPlacement,
      localEditMode: job.localEditMode,
      outfitType: job.localEditMode === "outfit" ? outfitType : "",
      outfitBackgroundReferenceId: job.localEditMode === "outfit" ? String(state.outfitBackgroundReferenceId || "") : "",
      outfitPrompt: job.localEditMode === "outfit" ? outfitPromptSnapshot : "",
      outfitExtraPrompt: job.localEditMode === "outfit" ? outfitExtraPromptSnapshot : "",
      product: job.localEditMode === "product" ? productDraftSnapshot : null,
      createdAt: jobCreatedAt,
      historyOwners: 0
    };
    if (!runIsVolc) await registerPendingHistoryTask(job);
    if (!job.priceUnverified) {
      commitBudgetEstimate(job.estimatedCost);
      job.budgetRecorded = true;
    }
    retainGenerationJobReferences(job);
    job.generationReferencesRetained = true;
    state.generationJobs.push(job);
    state.resultHistoryPageIndex = 0;
    state.running = true;
    renderGenerationQueue();
    setStatus(
      runIsVolc ? "working" : (job.priceUnverified ? "warning" : "working"),
      runIsVolc ? "任务 " + job.sequence + " 已进入火山并发生成区" : ("任务 " + job.sequence + (job.priceUnverified ? " 已开始（价格未确认）" : " 已进入并发生成区")),
      runIsVolc
        ? `${job.modelLabel} · ${priceCheck.size} × ${requestedCount} 张，预计 ${formatYuan(priceCheck.estimatedCost)}；可继续提交下一张图`
        : `${job.modelLabel} · ${priceCheck.size} × ${requestedCount} 张，${priceSummary}；可继续提交下一张图；断线时会自动查询历史，不会重发生成请求`
    );
    runGenerationJob(job).catch(async (error) => {
      job.controller.abort();
      job.requestControllers.forEach((requestController) => requestController.abort());
      try {
        await releaseGenerationJobReferences(job);
      } catch (_) {
        // Host cleanup will release any remaining temporary reference.
      }
      const pendingTask = pendingTaskForJob(job);
      if (pendingTask) {
        if (pendingHistoryOutstandingCount(pendingTask) > 0) await updatePendingHistoryTask(job);
        else await removePendingHistoryTask(pendingTask);
      }
      const jobIndex = state.generationJobs.indexOf(job);
      if (jobIndex >= 0) state.generationJobs.splice(jobIndex, 1);
      state.running = state.generationJobs.length > 0;
      renderGenerationQueue();
      setStatus("error", "并发任务异常结束", error.message || error);
      updateControls();
    });
    preparedJob = null;
  } catch (error) {
    if (preparedJob) {
      const jobIndex = state.generationJobs.indexOf(preparedJob);
      if (jobIndex >= 0) state.generationJobs.splice(jobIndex, 1);
      if (preparedJob.generationReferencesRetained) {
        try {
          await releaseGenerationJobReferences(preparedJob);
        } catch (_) {
          // References still shown in the panel remain owned by the panel.
        }
      }
      const pendingTask = pendingTaskForJob(preparedJob);
      if (pendingTask && pendingHistoryOutstandingCount(pendingTask) <= 0) {
        await removePendingHistoryTask(pendingTask);
      }
    }
    setStatus("error", "无法建立生成任务", error.message || error);
  } finally {
    state.preparingJob = false;
    updateControls();
  }
}

function handleStop() {
  const stopGeneration = state.generationJobs.some((job) => !job.controller.signal.aborted);
  const stopHistory = Boolean(
    state.recoveringPendingHistory && pendingHistoryRecoveryController &&
    !pendingHistoryRecoveryController.signal.aborted
  );
  if (!stopGeneration && !stopHistory) return;
  if (stopHistory) {
    state.pendingHistoryRecoveryStopRequested = true;
    pendingHistoryRecoveryController.abort();
  }
  setStatus(
    "warning",
    stopGeneration && stopHistory
      ? "正在停止生成和历史查询"
      : (stopHistory ? "正在停止历史查询" : "正在停止并发任务"),
    stopHistory
      ? "未找回的任务记录会保留；下次打开插件还会继续查询"
      : "正在取消所有未完成的客户端请求"
  );
  state.generationJobs.forEach((job) => {
    job.status = "stopping";
    job.requestControllers.forEach((requestController) => requestController.abort());
    job.controller.abort();
  });
  renderGenerationQueue();
  updateControls();
}

async function handleInsert() {
  const result = getSelectedResult();
  if (!result || state.inserting || state.capturing) return;
  const generationInProgress = state.running;
  state.inserting = true;
  updateControls();
  if (!canInsertResultIntoCurrentDocument(result)) {
    setStatus(
      "working",
      "正在 Photoshop 中打开生成图",
      generationInProgress ? "其他图片会继续并发生成" : "将生成好的原图打开为新的 Photoshop 文档"
    );
    try {
      await openResultInPhotoshop(result);
      result.openedAt = new Date();
      await queuePersistHistoryState();
      renderResultHistory();
      setStatus(
        state.running ? "working" : "success",
        state.running ? "生成图已打开，其他图片仍在生成" : "生成图已在 Photoshop 中打开",
        "打开的是接口返回的原始生成图，不会使用或覆盖当前 Photoshop 图层"
      );
    } catch (error) {
      setStatus("error", "打开生成图失败", error.message || error);
    } finally {
      state.inserting = false;
      updateControls();
    }
    return;
  }
  const supportsPrecisePlacement = hasPhotoshopTarget(result.snapshot);
  const precise = supportsPrecisePlacement && elements.precisionPlacement.checked;
  setStatus(
    "working",
    "正在插入图层",
    generationInProgress
      ? "其他图片会继续并发生成；当前选中结果正在插入"
      : (precise ? "将精确适配并放回生成时保存的原选区" : "将按生成尺寸居中放到目标区域")
  );
  try {
    const inserted = await insertResult(result, precise);
    result.insertedAt = new Date();
    result.precisePlacement = inserted.precisePlacement;
    await queuePersistHistoryState();
    renderResultHistory();
    const placementNote = inserted.usedCurrentDocumentFallback
      ? "原文档未打开，已居中插入当前文档并放在图层最上方"
      : "已放在文档图层最上方";
    const maskNote = inserted.precisePlacement
      ? `${inserted.selectionCleared ? "活动选区已取消，图片未被裁切；" : ""}${inserted.preservedResolution ? "已用智能对象保留生成图清晰度；" : ""}${inserted.featherRadius ? `边缘已向内柔化 ${inserted.featherRadius}px；` : ""}${inserted.maskFocused ? "蒙版已选中，可直接细修" : "已创建可编辑蒙版"}`
      : "";
    const targetSizeNote = inserted.precisePlacement && inserted.targetBounds
      ? `目标区域 ${Math.round(inserted.targetBounds.width)}×${Math.round(inserted.targetBounds.height)}；`
      : "";
    const smartObjectNote = !inserted.precisePlacement && inserted.preservedResolution
      ? "已用智能对象保留生成图清晰度"
      : "";
    setStatus(
      state.running ? "working" : "success",
      state.running ? "图层已插入，其他图片仍在生成" : "图层已插入",
      inserted.precisePlacement
        ? `已精确放回原选区；${targetSizeNote}${placementNote}；${maskNote}`
        : `已按生成尺寸居中插入；${placementNote}${smartObjectNote ? `；${smartObjectNote}` : ""}`
    );
  } catch (error) {
    setStatus("error", "插入失败", error.message || error);
  } finally {
    state.inserting = false;
    updateControls();
  }
}

function handlePromptKeydown(event) {
  promptHasFocus = true;
  hidePromptMentionMenu();
  if (event.isComposing) return;
  const mentionMenuOpen = !elements.promptMentionMenu.classList.contains("is-hidden");
  if (mentionMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    movePromptMentionSelection(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (mentionMenuOpen && (event.key === "Enter" || event.key === "Tab")) {
    const buttons = Array.from(elements.promptMentionMenu.children || []);
    const active = buttons[promptMentionActiveIndex];
    if (active) {
      event.preventDefault();
      acceptPromptMention(active.getAttribute("data-prompt-mention"));
      return;
    }
  }
  if (mentionMenuOpen && event.key === "Escape") {
    event.preventDefault();
    hidePromptMentionMenu();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    handleRun();
  }
}

function bindPromptContinuationEvents() {
  const capture = elements.promptContinuationCapture;
  if (!capture) return;
  capture.addEventListener("focus", () => {
    if (!promptContinuationState) return;
    promptContinuationFocused = true;
    promptHasFocus = true;
    startPromptContinuationBlink();
    positionPromptContinuationCaret();
    renderPromptMentionMenu();
  });
  capture.addEventListener("blur", () => {
    const token = promptContinuationState && promptContinuationState.token;
    promptContinuationFocused = false;
    setTimeout(() => {
      if (
        promptContinuationState &&
        promptContinuationState.token === token &&
        !promptContinuationFocused
      ) {
        deactivatePromptContinuation();
      }
    }, 80);
  });
  capture.addEventListener("beforeinput", (event) => {
    promptHasFocus = true;
    hidePromptMentionMenu();
  });
  capture.addEventListener("input", () => {
    promptHasFocus = true;
    syncPromptContinuation();
    promptMentionActiveIndex = 0;
    hidePromptMentionMenu();
  });
  capture.addEventListener("select", () => {
    const selection = rememberPromptSelection();
    if (selection) lastPromptSelection = selection;
    positionPromptContinuationCaret();
  });
  capture.addEventListener("keyup", () => {
    rememberPromptSelection();
    positionPromptContinuationCaret();
    renderPromptMentionMenu();
  });
  capture.addEventListener("change", syncPromptContinuation);
  capture.addEventListener("keydown", handlePromptKeydown);
}

function bindPromptEditorEvents(editor = elements.prompt) {
  if (!editor || boundPromptEditors.has(editor)) return;
  boundPromptEditors.add(editor);
  editor.addEventListener("focus", () => {
    if (editor !== elements.prompt) return;
    promptHasFocus = true;
    schedulePromptSelectionCapture(true);
    if (Date.now() >= promptSelectionFreezeUntil) renderPromptMentionMenu();
  });
  editor.addEventListener("blur", () => {
    if (editor !== elements.prompt) return;
    promptSelectionFreezeUntil = 0;
    promptHasFocus = false;
    promptPointerActive = false;
    freezePromptSelectionCapture();
    setTimeout(() => {
      if (!promptHasFocus) hidePromptMentionMenu();
    }, 140);
  });
  editor.addEventListener("mousedown", () => {
    if (editor !== elements.prompt) return;
    if (promptContinuationState) deactivatePromptContinuation();
    promptSelectionFreezeUntil = 0;
    freezePromptSelectionCapture();
    promptPointerActive = true;
  });
  editor.addEventListener("mouseup", (event) => {
    if (editor !== elements.prompt) return;
    rememberPromptPointerSelection(event);
    promptPointerActive = false;
  });
  editor.addEventListener("click", (event) => {
    if (editor !== elements.prompt) return;
    renderPromptMentionMenu();
  });
  editor.addEventListener("select", () => {
    if (editor !== elements.prompt) return;
    if (
      Date.now() < promptSelectionFreezeUntil &&
      lastPromptSelection &&
      lastPromptSelection.start === lastPromptSelection.end
    ) {
      const caret = lastPromptSelection.start;
      const liveSelection = readPromptSelection();
      if (!liveSelection || liveSelection.start !== caret || liveSelection.end !== caret) {
        setTimeout(() => setPromptSelection(caret, caret), 0);
      }
      return;
    }
    const selection = rememberPromptSelection();
    if (selection) promptSelectionFreezeUntil = Date.now() + 350;
  });
  editor.addEventListener("keyup", () => {
    if (editor !== elements.prompt) return;
    promptSelectionFreezeUntil = 0;
    rememberPromptSelection();
    renderPromptMentionMenu();
  });
  editor.addEventListener("beforeinput", (event) => {
    if (editor !== elements.prompt) return;
    promptHasFocus = true;
    recordPromptMentionFromBeforeInput(event);
  });
  editor.addEventListener("input", () => {
    if (editor !== elements.prompt) return;
    promptHasFocus = true;
    promptSelectionFreezeUntil = 0;
    rememberPromptSelection();
    recoverPromptMentionTriggerFromValue();
    updatePromptCount();
    promptMentionActiveIndex = 0;
    renderPromptMentionMenu();
    schedulePromptMentionRetry();
  });
  editor.addEventListener("change", () => {
    if (editor !== elements.prompt) return;
    promptSelectionFreezeUntil = 0;
    rememberPromptSelection();
    updatePromptCount();
  });
  editor.addEventListener("scroll", () => {
    if (editor === elements.prompt && promptContinuationState) positionPromptContinuationCaret();
  });
  editor.addEventListener("keydown", (event) => {
    if (editor !== elements.prompt) return;
    handlePromptKeydown(event);
  });
}

function bindUxpCheckboxToggle(container, input) {
  if (!container || !input) return;
  const syncState = () => {
    container.setAttribute("aria-checked", input.checked ? "true" : "false");
  };
  const toggle = (event) => {
    if (event && event.target === input) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (input.disabled) return;
    input.checked = !input.checked;
    syncState();
    input.dispatchEvent(new Event("change"));
  };
  container.addEventListener("mousedown", (event) => {
    if (event.target !== input) event.preventDefault();
  });
  container.addEventListener("click", toggle);
  container.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    toggle(event);
  });
  input.addEventListener("change", syncState);
  syncState();
}

function bindEvents() {
  bindUxpCheckboxToggle(elements.precisionPlacementToggle, elements.precisionPlacement);
  bindUxpCheckboxToggle(elements.maskFeatherControl, elements.maskFeatherEnabled);

  let draggedReferenceId = null;
  let suppressReferenceMention = false;
  let pointerDraggedReferenceId = null;
  let pointerDragStartX = 0;
  let pointerDragStartY = 0;
  let pointerDragMoved = false;
  const clearReferenceDragStyles = () => {
    const children = elements.referenceList.children || [];
    for (let index = 0; index < children.length; index += 1) {
      children[index].classList.remove("is-dragging", "is-drop-target");
    }
  };
  const clearReferenceDropStyles = () => {
    const children = elements.referenceList.children || [];
    for (let index = 0; index < children.length; index += 1) {
      children[index].classList.remove("is-drop-target");
    }
  };

  const capture = (mode) => async () => {
    try {
      await captureSource(mode);
    } catch (_) {
      // captureSource already reports a concise error.
    }
  };

  elements.statusClose.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  elements.statusClose.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideStatus();
  });
  elements.statusClose.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    hideStatus();
  });
  if (elements.pluginVersion) {
    elements.pluginVersion.addEventListener("click", (event) => {
      event.stopPropagation();
      if (elements.pluginVersion.getAttribute("aria-disabled") === "true") return;
      handleUpdateControlActivation().catch((error) => {
        if (state.installingUpdate) setStatus("error", "无法启动更新", error.message || error);
      });
    });
    elements.pluginVersion.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      elements.pluginVersion.click();
    });
  }
  const openReferenceMenuFromTile = (event) => {
    if (elements.referenceAdd && elements.referenceAdd.disabled) return;
    if (elements.referenceSourceMenu.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    closeOutfitMaterialMenus();
    openReferenceSourceMenu();
  };
  // Events from the button bubble to this wrapper, so one listener is enough.
  elements.referenceAddWrap.addEventListener("click", (event) => {
    if (elements.referenceQuickActions && elements.referenceQuickActions.contains(event.target)) return;
    openReferenceMenuFromTile(event);
  });
  // UXP can omit mousedown/click for this native-looking button after a
  // repaint. Capture pointerdown on the stable wrapper so the add menu still
  // opens; clicks inside the already-open menu must continue to its actions.
  elements.referenceAddWrap.addEventListener("pointerdown", (event) => {
    if (elements.referenceQuickActions && elements.referenceQuickActions.contains(event.target)) return;
    if (elements.referenceSourceMenu.contains(event.target)) return;
    openReferenceMenuFromTile(event);
  }, true);
  const openReferenceMenuFromButton = (event) => {
    if (elements.referenceAdd && elements.referenceAdd.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    closeOutfitMaterialMenus();
    openReferenceSourceMenu();
  };
  elements.referenceAdd.addEventListener("mousedown", openReferenceMenuFromButton);
  elements.referenceAdd.addEventListener("click", openReferenceMenuFromButton);
  // Capture clicks on the visible empty tile even when UXP has temporarily
  // disabled or failed to paint the underlying add button.
  elements.referenceStrip.addEventListener("click", (event) => {
    // The real add button and the recovery button already have their own
    // handlers. Do not toggle the menu a second time during capture.
    if (elements.referenceAddWrap.contains(event.target) ||
      event.target === document.getElementById("referenceFallbackAdd")) return;
    if (elements.referenceSourceMenu.contains(event.target)) return;
    const addBounds = elements.referenceAddWrap.getBoundingClientRect();
    const inAddBounds = Number(event.clientX) >= Number(addBounds.left) &&
      Number(event.clientX) <= Number(addBounds.right) &&
      Number(event.clientY) >= Number(addBounds.top) &&
      Number(event.clientY) <= Number(addBounds.bottom);
    if (inAddBounds && !(elements.referenceAdd && elements.referenceAdd.disabled)) {
      event.preventDefault();
      event.stopPropagation();
      openReferenceSourceMenu();
    }
  }, true);
  const bindReferenceSourceAction = (button, action) => {
    let lastTriggeredAt = 0;
    const invoke = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      if (now - lastTriggeredAt < 350) return;
      lastTriggeredAt = now;
      closeReferenceSourceMenu();
      Promise.resolve(action()).catch((error) => {
        setStatus("error", "参考图操作失败", error && (error.message || error));
      });
    };
    button.addEventListener("mousedown", invoke);
    button.addEventListener("click", invoke);
  };
  bindReferenceSourceAction(elements.referenceFromSelection, () => capture("selection")());
  bindReferenceSourceAction(elements.referenceFromLayer, () => captureSelectedLayers());
  bindReferenceSourceAction(elements.referenceFromLocal, () => importReferenceImages());
  elements.referenceQuickLayer.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    captureSelectedLayers().catch((error) => {
      setStatus("error", "无法获取图层", error.message || error);
    });
  });
  elements.referenceQuickSelection.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    capture("selection")();
  });
  elements.referenceQuickClear.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearAllReferences().catch((error) => {
      setStatus("error", "无法清空参考图", error.message || error);
    });
  });
  const closeReferenceMenuOnOutsidePress = (event) => {
    if (elements.referenceSourceMenu.classList.contains("is-menu-hidden")) return;
    // The opening click can be retargeted by UXP after the add tile repaints.
    // Ignore only that very short window; later presses outside must dismiss.
    if (Date.now() - referenceMenuOpenedAt < 80) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const insideAdd = elements.referenceAddWrap.contains(event.target) || path.includes(elements.referenceAddWrap);
    const insideMenu = elements.referenceSourceMenu.contains(event.target) || path.includes(elements.referenceSourceMenu);
    if (!insideAdd && !insideMenu) closeReferenceSourceMenu();
  };
  document.addEventListener("mousedown", closeReferenceMenuOnOutsidePress, true);
  document.addEventListener("pointerdown", closeReferenceMenuOnOutsidePress, true);
  document.addEventListener("click", closeReferenceMenuOnOutsidePress);
  // UXP may retarget document-level pointer events while the add tile repaints.
  // The prompt is a stable editor surface, so close the menu directly when it
  // receives focus or a pointer press.
  const closeReferenceMenuFromPrompt = () => {
    if (!elements.referenceSourceMenu.classList.contains("is-menu-hidden")) closeReferenceSourceMenu();
  };
  if (elements.prompt) {
    elements.prompt.addEventListener("pointerdown", closeReferenceMenuFromPrompt, true);
    elements.prompt.addEventListener("mousedown", closeReferenceMenuFromPrompt, true);
    elements.prompt.addEventListener("focusin", closeReferenceMenuFromPrompt, true);
  }
  document.addEventListener("keydown", (event) => {
    const key = String(event.key || "").toLowerCase();
    if (key === "escape" || key === "esc") {
      if (elements.styleLibraryDetailOverlay &&
        !elements.styleLibraryDetailOverlay.classList.contains("is-hidden")) {
        event.preventDefault();
        event.stopPropagation();
        closeStyleLibraryDetail();
        return;
      }
      closeReferenceSourceMenu();
      closeOutfitMaterialMenus();
      if (state.activeWorkspace === "library") showWorkspace("editor");
    }
  });
  elements.referenceList.addEventListener("mousedown", () => {
    freezePromptSelectionCapture();
    const selection = getPromptSelection();
    pendingReferenceMentionSelection = { start: selection.start, end: selection.end };
  });
  elements.referenceList.addEventListener("mousedown", (event) => {
    if (referenceMutationBlocked() || state.references.length < 2) return;
    let target = event.target;
    while (target && target !== elements.referenceList) {
      if (target.getAttribute && target.getAttribute("data-reference-id")) return;
      const referenceId = target.getAttribute && target.getAttribute("data-reference-drag-id");
      if (referenceId) {
        pointerDraggedReferenceId = referenceId;
        pointerDragStartX = Number(event.clientX) || 0;
        pointerDragStartY = Number(event.clientY) || 0;
        pointerDragMoved = false;
        return;
      }
      target = target.parentNode;
    }
  });
  elements.referenceList.addEventListener("mousemove", (event) => {
    if (!pointerDraggedReferenceId) return;
    const distanceX = Math.abs((Number(event.clientX) || 0) - pointerDragStartX);
    const distanceY = Math.abs((Number(event.clientY) || 0) - pointerDragStartY);
    if (!pointerDragMoved && Math.max(distanceX, distanceY) < 6) return;
    pointerDragMoved = true;
    suppressReferenceMention = true;
    clearReferenceDropStyles();
    const source = elements.referenceList.querySelector(`[data-reference-drag-id="${pointerDraggedReferenceId}"]`);
    if (source) source.classList.add("is-dragging");
    let target = event.target;
    while (target && target !== elements.referenceList) {
      const referenceId = target.getAttribute && target.getAttribute("data-reference-drag-id");
      if (referenceId && referenceId !== pointerDraggedReferenceId) {
        target.classList.add("is-drop-target");
        break;
      }
      target = target.parentNode;
    }
  });
  elements.referenceList.addEventListener("mouseup", (event) => {
    if (!pointerDraggedReferenceId) return;
    const sourceId = pointerDraggedReferenceId;
    pointerDraggedReferenceId = null;
    let target = event.target;
    let targetId = "";
    while (target && target !== elements.referenceList) {
      targetId = target.getAttribute && target.getAttribute("data-reference-drag-id") || "";
      if (targetId) break;
      target = target.parentNode;
    }
    if (pointerDragMoved && targetId && targetId !== sourceId) {
      swapReferences(sourceId, targetId);
    }
    pointerDragMoved = false;
    clearReferenceDragStyles();
    setTimeout(() => {
      suppressReferenceMention = false;
    }, 0);
  });
  document.addEventListener("mouseup", (event) => {
    if (!pointerDraggedReferenceId || elements.referenceList.contains(event.target)) return;
    pointerDraggedReferenceId = null;
    pointerDragMoved = false;
    clearReferenceDragStyles();
    setTimeout(() => {
      suppressReferenceMention = false;
    }, 0);
  });
  elements.referenceList.addEventListener("click", (event) => {
    if (event.target === elements.referenceList) {
      const bounds = elements.referenceList.getBoundingClientRect();
      const addBounds = elements.referenceAddWrap.getBoundingClientRect();
      const inAddBounds = Number(event.clientX) >= Number(addBounds.left) &&
        Number(event.clientX) <= Number(addBounds.right) &&
        Number(event.clientY) >= Number(addBounds.top) &&
        Number(event.clientY) <= Number(addBounds.bottom);
      if (inAddBounds && Number(event.clientX) >= Number(bounds.left)) {
        event.preventDefault();
        event.stopPropagation();
        openReferenceSourceMenu();
        return;
      }
    }
    let target = event.target;
    while (target && target !== elements.referenceList) {
      const referenceId = target.getAttribute && target.getAttribute("data-reference-id");
      if (referenceId) {
        event.preventDefault();
        event.stopPropagation();
        removeReference(referenceId).catch((error) => {
          setStatus("error", "无法删除参考图", error.message || error);
        });
        return;
      }
      const promptReferenceId = target.getAttribute && target.getAttribute("data-reference-prompt-id");
      if (promptReferenceId) {
        const bounds = target.getBoundingClientRect();
        const inRemoveCorner = Number(event.clientX) >= Number(bounds.right) - 32 &&
          Number(event.clientY) <= Number(bounds.top) + 32;
        if (inRemoveCorner) {
          event.preventDefault();
          event.stopPropagation();
          removeReference(promptReferenceId).catch((error) => {
            setStatus("error", "无法删除参考图", error.message || error);
          });
          return;
        }
        if (suppressReferenceMention) {
          suppressReferenceMention = false;
          return;
        }
        event.preventDefault();
        return;
      }
      target = target.parentNode;
    }
  });
  elements.referenceList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const referenceId = event.target && event.target.getAttribute
      ? event.target.getAttribute("data-reference-id")
      : null;
    if (!referenceId) return;
    event.preventDefault();
    event.stopPropagation();
    removeReference(referenceId).catch((error) => {
      setStatus("error", "无法删除参考图", error.message || error);
    });
  });

  elements.referenceList.addEventListener("dragstart", (event) => {
    if (referenceMutationBlocked()) {
      event.preventDefault();
      return;
    }
    let target = event.target;
    while (target && target !== elements.referenceList) {
      const referenceId = target.getAttribute && target.getAttribute("data-reference-drag-id");
      if (referenceId) {
        draggedReferenceId = referenceId;
        suppressReferenceMention = true;
        target.classList.add("is-dragging");
        try {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", referenceId);
        } catch (_) {
          // UXP can expose drag events without the full browser DataTransfer API.
        }
        return;
      }
      target = target.parentNode;
    }
  });
  elements.referenceList.addEventListener("dragover", (event) => {
    if (!draggedReferenceId) return;
    let target = event.target;
    while (target && target !== elements.referenceList) {
      const referenceId = target.getAttribute && target.getAttribute("data-reference-drag-id");
      if (referenceId && referenceId !== draggedReferenceId) {
        event.preventDefault();
        clearReferenceDropStyles();
        target.classList.add("is-drop-target");
        return;
      }
      target = target.parentNode;
    }
  });
  elements.referenceList.addEventListener("drop", (event) => {
    if (!draggedReferenceId) return;
    let target = event.target;
    while (target && target !== elements.referenceList) {
      const referenceId = target.getAttribute && target.getAttribute("data-reference-drag-id");
      if (referenceId) {
        event.preventDefault();
        swapReferences(draggedReferenceId, referenceId);
        break;
      }
      target = target.parentNode;
    }
    draggedReferenceId = null;
    clearReferenceDragStyles();
  });
  elements.referenceList.addEventListener("dragend", () => {
    draggedReferenceId = null;
    clearReferenceDragStyles();
    setTimeout(() => {
      suppressReferenceMention = false;
    }, 0);
  });

  bindPromptEditorEvents(elements.prompt);
  bindPromptContinuationEvents();
  document.addEventListener("selectionchange", () => {
    if (promptHasFocus || promptPointerActive) schedulePromptSelectionCapture();
  });
  elements.promptMentionMenu.addEventListener("mousedown", (event) => {
    event.preventDefault();
    freezePromptSelectionCapture();
  });
  elements.promptMentionMenu.addEventListener("click", (event) => {
    let target = event.target;
    while (target && target !== elements.promptMentionMenu) {
      const mention = target.getAttribute && target.getAttribute("data-prompt-mention");
      if (mention) {
        event.preventDefault();
        acceptPromptMention(mention);
        return;
      }
      target = target.parentNode;
    }
  });
  elements.promptLibrary.addEventListener("change", applyPromptLibrarySelection);
  if (elements.styleLibraryOpen) elements.styleLibraryOpen.addEventListener("click", () => showWorkspace("library"));
  if (elements.styleLibraryClose) elements.styleLibraryClose.addEventListener("click", () => showWorkspace("editor"));
  if (elements.styleLibrarySearch) elements.styleLibrarySearch.addEventListener("input", () => {
    if (styleLibrarySearchTimer !== null) clearTimeout(styleLibrarySearchTimer);
    styleLibrarySearchTimer = setTimeout(() => {
      styleLibrarySearchTimer = null;
      styleLibraryPageIndex = 0;
      renderStyleLibrary();
    }, 180);
  });
  if (elements.styleLibraryCategory) elements.styleLibraryCategory.addEventListener("change", () => {
    styleLibraryPageIndex = 0;
    renderStyleLibrary();
  });
  if (elements.styleLibraryPrevious) elements.styleLibraryPrevious.addEventListener("click", () => {
    if (styleLibraryPageIndex <= 0) return;
    styleLibraryPageIndex -= 1;
    renderStyleLibrary();
  });
  if (elements.styleLibraryNext) elements.styleLibraryNext.addEventListener("click", () => {
    const pageCount = Math.max(1, Math.ceil(matchingStyleLibraryTemplates().length / STYLE_LIBRARY_PAGE_SIZE));
    if (styleLibraryPageIndex >= pageCount - 1) return;
    styleLibraryPageIndex += 1;
    renderStyleLibrary();
  });
  if (elements.styleLibraryPage) elements.styleLibraryPage.addEventListener("click", (event) => {
    let target = event.target;
    while (target && target !== elements.styleLibraryPage) {
      const page = target.getAttribute && target.getAttribute("data-style-library-page");
      if (page !== null && page !== undefined) {
        styleLibraryPageIndex = Number(page) || 0;
        renderStyleLibrary();
        return;
      }
      target = target.parentNode;
    }
  });
  if (elements.styleLibraryPage) elements.styleLibraryPage.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    const target = event.target;
    const page = target && target.getAttribute && target.getAttribute("data-style-library-page");
    if (page === null || page === undefined) return;
    event.preventDefault();
    styleLibraryPageIndex = Number(page) || 0;
    renderStyleLibrary();
  });
  if (elements.styleLibraryList) {
    elements.styleLibraryList.addEventListener("click", (event) => {
      let target = event.target;
      while (target && target !== elements.styleLibraryList) {
        const id = target.getAttribute && target.getAttribute("data-style-template-id");
        if (id) {
          openStyleLibraryDetail(id);
          return;
        }
        target = target.parentNode;
      }
    });
    elements.styleLibraryList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      let target = event.target;
      while (target && target !== elements.styleLibraryList) {
        const id = target.getAttribute && target.getAttribute("data-style-template-id");
        if (id) {
          event.preventDefault();
          openStyleLibraryDetail(id);
          return;
        }
        target = target.parentNode;
      }
    });
  }
  if (elements.styleLibraryDetailClose) elements.styleLibraryDetailClose.addEventListener("click", closeStyleLibraryDetail);
  if (elements.styleLibraryDetailOverlay) elements.styleLibraryDetailOverlay.addEventListener("click", (event) => {
    if (event.target === elements.styleLibraryDetailOverlay) closeStyleLibraryDetail();
  });
  if (elements.styleLibraryDetailOverlay) elements.styleLibraryDetailOverlay.addEventListener("keydown", (event) => {
    const key = String(event.key || "").toLowerCase();
    if (key !== "escape" && key !== "esc") return;
    event.preventDefault();
    event.stopPropagation();
    closeStyleLibraryDetail();
  });
  if (elements.styleLibraryDetailApply) elements.styleLibraryDetailApply.addEventListener("click", () => {
    if (styleLibraryDetailTemplateId) applyStyleLibraryTemplate(styleLibraryDetailTemplateId);
    closeStyleLibraryDetail();
  });
  elements.editorWorkspaceTab.addEventListener("click", () => showWorkspace("editor"));
  elements.outfitWorkspaceTab.addEventListener("click", () => {
    showWorkspace("editor");
  });
  if (elements.settingsWorkspaceTab) {
    elements.settingsWorkspaceTab.addEventListener("click", () => {
      state.activeSettingsSection = "keys";
      showWorkspace("settings");
      showSettingsSection("keys");
    });
  }
  elements.creativeOutfitTab.addEventListener("click", () => showCreativeTool("outfit"));
  elements.creativeProductTab.addEventListener("click", () => showCreativeTool("product"));
  elements.creativePendingTabOne.addEventListener("click", () => showCreativeTool("pending-one"));
  elements.creativePendingTabTwo.addEventListener("click", () => showCreativeTool("pending-two"));
  elements.brandSettingsOpen.addEventListener("click", () => {
    if (elements.pluginVersion && elements.pluginVersion.getAttribute("aria-disabled") === "true") return;
    handleUpdateControlActivation().catch((error) => {
      if (state.installingUpdate) setStatus("error", "无法启动更新", error.message || error);
    });
  });
  elements.brandSettingsOpen.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    elements.brandSettingsOpen.click();
  });
  elements.settingsSaveApiKey.addEventListener("click", () => {
    saveSettingsApiKey().catch((error) => setStatus("error", "无法保存 API Key", error.message || error));
  });
  elements.settingsTestApi.addEventListener("click", () => {
    testSettingsApiConnection().catch((error) => setStatus("error", "API 连接测试失败", error.message || error));
  });
  elements.settingsSaveDefaults.addEventListener("click", saveDefaultGenerationSettings);
  elements.settingsRunSelfCheck.addEventListener("click", () => {
    runPluginSelfCheck().catch((error) => setStatus("error", "插件自检失败", error.message || error));
  });
  elements.settingsSaveBudget.addEventListener("click", () => {
    try { saveDailyBudgetSetting(); } catch (error) { setStatus("error", "无法保存费用设置", error.message || error); }
  });
  [elements.settingsKeysTab, elements.settingsDefaultsTab, elements.settingsCostTab].forEach((tab) => {
    if (!tab) return;
    tab.addEventListener("click", () => showSettingsSection(tab.getAttribute("data-settings-section-tab")));
  });
  elements.settingsResetBudget.addEventListener("click", resetDailyBudgetSpend);
  [
    [elements.settingsSaveApiKey, "primary"],
    [elements.settingsTestApi, "secondary"],
    [elements.settingsSaveDefaults, "primary"],
    [elements.settingsCheckUpdate, "secondary"],
    [elements.settingsRunSelfCheck, "success"],
    [elements.settingsSaveBudget, "primary"],
    [elements.settingsResetBudget, "secondary"]
  ].forEach(([button, tone]) => styleActionButton(button, tone));
  elements.settingsCheckUpdate.addEventListener("click", () => {
    handleUpdateControlActivation().catch((error) => {
      if (state.installingUpdate) setStatus("error", "无法启动更新", error.message || error);
    });
  });
  elements.settingsBack.addEventListener("click", () => {
    showWorkspace("editor");
  });
  const productSource = (role, source) => () => {
    captureProductReference(role, source).catch((error) => setStatus("error", "无法添加商品素材", error.message || error));
  };
  elements.productMainReferenceAdd.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); toggleProductReferenceMenu("main"); });
  elements.productSceneReferenceAdd.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); toggleProductReferenceMenu("scene"); });
  elements.productMainFromSelection.addEventListener("click", productSource("main", "selection"));
  elements.productMainFromLayer.addEventListener("click", productSource("main", "layer"));
  elements.productMainFromLocal.addEventListener("click", productSource("main", "local"));
  elements.productSceneFromSelection.addEventListener("click", productSource("scene", "selection"));
  elements.productSceneFromLayer.addEventListener("click", productSource("scene", "layer"));
  elements.productSceneFromLocal.addEventListener("click", productSource("scene", "local"));
  elements.productMainReferenceRemove.addEventListener("click", () => removeProductReference("main").catch((error) => setStatus("error", "无法移除商品主体", error.message || error)));
  elements.productSceneReferenceRemove.addEventListener("click", () => removeProductReference("scene").catch((error) => setStatus("error", "无法移除场景参考", error.message || error)));
  elements.productTypeGroup.addEventListener("click", (event) => {
    let target = event.target;
    while (target && target !== elements.productTypeGroup) {
      const type = target.getAttribute && target.getAttribute("data-product-type");
      if (type) {
        if (target.disabled) return;
        setSelectedProductType(type);
        saveSettings();
        return;
      }
      target = target.parentNode;
    }
  });
  elements.productCategory.addEventListener("input", saveSettings);
  elements.productPlatform.addEventListener("change", () => { saveSettings(); syncIslandSelects(); });
  elements.productRetention.addEventListener("input", saveSettings);
  elements.productBackgroundDescription.addEventListener("input", saveSettings);
  elements.productComposition.addEventListener("change", () => { saveSettings(); syncIslandSelects(); });
  elements.productProtectBrand.addEventListener("click", () => {
    if (elements.productProtectBrand.disabled) return;
    setProductBrandProtected(!productBrandProtected());
    saveSettings();
  });
  elements.productExtraPrompt.addEventListener("input", saveSettings);
  elements.productAspectRatio.addEventListener("change", () => {
    saveSettings();
    syncIslandSelects();
    updateResolvedSize();
    renderBudgetSummary();
  });
  elements.productResolution.addEventListener("change", () => {
    saveSettings();
    syncIslandSelects();
    updateResolvedSize();
    renderBudgetSummary();
  });
  elements.productGenerationCount.addEventListener("change", () => {
    saveSettings();
    syncIslandSelects();
    updateResolvedSize();
    renderBudgetSummary();
  });
  elements.productRun.addEventListener("click", () => handleProductRun().catch((error) => setStatus("error", "商品图任务未启动", error.message || error)));
  document.addEventListener("click", (event) => {
    const inProductTile = elements.productMainReferenceTile.contains(event.target) || elements.productSceneReferenceTile.contains(event.target);
    if (!inProductTile) closeProductReferenceMenus();
  });
  elements.outfitCaptureTarget.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleOutfitMaterialMenu(elements.outfitTargetAddWrap);
  });
  elements.outfitAddTargetSelection.addEventListener("click", () => {
    closeOutfitMaterialMenu(elements.outfitTargetAddWrap);
    captureOutfitTarget("selection").catch((error) => setStatus("error", "无法获取模特姿势选区", error.message || error));
  });
  elements.outfitAddTargetLayer.addEventListener("click", () => {
    closeOutfitMaterialMenu(elements.outfitTargetAddWrap);
    captureOutfitTarget("layer").catch((error) => setStatus("error", "无法获取模特姿势图层", error.message || error));
  });
  elements.outfitAddTargetLocal.addEventListener("click", () => {
    closeOutfitMaterialMenu(elements.outfitTargetAddWrap);
    captureOutfitTarget("local").catch((error) => setStatus("error", "无法导入模特姿势图", error.message || error));
  });
  elements.outfitClearTarget.addEventListener("click", () => {
    closeOutfitMaterialMenu(elements.outfitTargetAddWrap);
    clearOutfitTarget().catch((error) => setStatus("error", "无法清除模特姿势图", error.message || error));
  });
  elements.outfitFaceAdd.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleOutfitMaterialMenu(elements.outfitFaceAddWrap);
  });
  elements.outfitAddFaceSelection.addEventListener("click", () => {
    closeOutfitMaterialMenu(elements.outfitFaceAddWrap);
    addOutfitFace("selection").catch((error) => setStatus("error", "无法获取模特人脸选区", error.message || error));
  });
  elements.outfitAddFaceLocal.addEventListener("click", () => {
    closeOutfitMaterialMenu(elements.outfitFaceAddWrap);
    addOutfitFace("local").catch((error) => setStatus("error", "无法导入模特人脸图", error.message || error));
  });
  elements.outfitAddFaceLayer.addEventListener("click", () => {
    closeOutfitMaterialMenu(elements.outfitFaceAddWrap);
    addOutfitFace("layer").catch((error) => setStatus("error", "无法获取模特人脸图层", error.message || error));
  });
  elements.outfitClearFace.addEventListener("click", () => {
    closeOutfitMaterialMenu(elements.outfitFaceAddWrap);
    clearOutfitFace().catch((error) => setStatus("error", "无法清除模特人脸图", error.message || error));
  });
  if (elements.outfitBackgroundAdd && elements.outfitBackgroundAddWrap) {
    elements.outfitBackgroundAdd.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleOutfitMaterialMenu(elements.outfitBackgroundAddWrap);
    });
  }
  if (elements.outfitAddBackgroundSelection) {
    elements.outfitAddBackgroundSelection.addEventListener("click", () => {
      closeOutfitMaterialMenu(elements.outfitBackgroundAddWrap);
      addOutfitBackground("selection").catch((error) => setStatus("error", "无法获取场景背景选区", error.message || error));
    });
  }
  if (elements.outfitAddBackgroundLayer) {
    elements.outfitAddBackgroundLayer.addEventListener("click", () => {
      closeOutfitMaterialMenu(elements.outfitBackgroundAddWrap);
      addOutfitBackground("layer").catch((error) => setStatus("error", "无法获取场景背景图层", error.message || error));
    });
  }
  if (elements.outfitAddBackgroundLocal) {
    elements.outfitAddBackgroundLocal.addEventListener("click", () => {
      closeOutfitMaterialMenu(elements.outfitBackgroundAddWrap);
      addOutfitBackground("local").catch((error) => setStatus("error", "无法导入场景背景图", error.message || error));
    });
  }
  if (elements.outfitClearBackground) {
    elements.outfitClearBackground.addEventListener("click", () => {
      closeOutfitMaterialMenu(elements.outfitBackgroundAddWrap);
      clearOutfitBackground().catch((error) => setStatus("error", "无法清除场景背景图", error.message || error));
    });
  }
  document.querySelectorAll('[role="radio"][data-outfit-mode]').forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return;
      handleOutfitTypeChange(button.getAttribute("data-outfit-mode"))
        .then(saveSettings)
        .catch((error) => setStatus("error", "无法切换服饰参考方式", error.message || error));
    });
  });
  elements.outfitGarmentList.addEventListener("click", (event) => {
    let target = event.target;
    while (target && target !== elements.outfitGarmentList) {
      const menuIndex = target.getAttribute && target.getAttribute("data-outfit-garment-menu");
      const selectionIndex = target.getAttribute && target.getAttribute("data-outfit-garment-selection");
      const localIndex = target.getAttribute && target.getAttribute("data-outfit-garment-local");
      const layerIndex = target.getAttribute && target.getAttribute("data-outfit-garment-layer");
      const removeIndex = target.getAttribute && target.getAttribute("data-outfit-garment-remove");
      if (menuIndex !== null && menuIndex !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        toggleOutfitMaterialMenu(byId(`outfitGarmentSlotPreview${menuIndex}`));
        return;
      }
      if (selectionIndex !== null && selectionIndex !== undefined) {
        closeOutfitMaterialMenu(byId(`outfitGarmentSlotPreview${selectionIndex}`));
        setOutfitGarmentSlot(selectionIndex, "selection").catch((error) => setStatus("error", "无法获取服饰选区", error.message || error));
        return;
      }
      if (localIndex !== null && localIndex !== undefined) {
        closeOutfitMaterialMenu(byId(`outfitGarmentSlotPreview${localIndex}`));
        setOutfitGarmentSlot(localIndex, "local").catch((error) => setStatus("error", "无法导入服饰参考图", error.message || error));
        return;
      }
      if (layerIndex !== null && layerIndex !== undefined) {
        closeOutfitMaterialMenu(byId(`outfitGarmentSlotPreview${layerIndex}`));
        setOutfitGarmentSlot(layerIndex, "layer").catch((error) => setStatus("error", "无法获取服饰图层", error.message || error));
        return;
      }
      if (removeIndex !== null && removeIndex !== undefined) {
        closeOutfitMaterialMenu(byId(`outfitGarmentSlotPreview${removeIndex}`));
        removeOutfitGarmentSlot(removeIndex).catch((error) => setStatus("error", "无法移除服饰参考图", error.message || error));
        return;
      }
      target = target.parentNode;
    }
  });
  document.addEventListener("click", (event) => {
    const insideOutfitTile = Array.from(document.querySelectorAll(".outfit-material-tile") || [])
      .some((tile) => tile.contains(event.target));
    if (!insideOutfitTile) closeOutfitMaterialMenus();
  });
  elements.outfitRun.addEventListener("click", () => {
    handleOutfitRun().catch((error) => setStatus("error", "模特换装无法运行", error.message || error));
  });
  elements.outfitPrompt.addEventListener("input", saveSettings);
  elements.outfitExtraPrompt.addEventListener("input", saveSettings);
  elements.maskFeatherEnabled.addEventListener("change", saveSettings);
  elements.settingsMaskFeatherRadius.addEventListener("change", () => {
    syncMaskFeatherSetting();
    saveSettings();
  });
  elements.outfitStop.addEventListener("click", handleStop);
  elements.outfitInsert.addEventListener("click", handleInsert);
  elements.favoritePrompt.addEventListener("click", toggleFavoritePrompt);
  elements.modelChannel.addEventListener("change", () => {
    resetPricingStateForModel();
    syncModelCapabilities();
    loadCachedPricing();
    updateResolvedSize();
    saveSettings();
    const model = getSelectedModelConfig();
    if (modelProvider(model) === "volc") {
      setStatus("success", `已切换到 ${model.shortLabel}`, "GPT 2.5 通过咖图异步图像接口生成；支持异步任务查询");
      return;
    }
    setStatus("working", `正在刷新 ${model.shortLabel} 价格`, "价格确认完成前仍可编辑参考图和提示词");
    refreshLivePricing("model-change").then((result) => {
      if (!result || result.stale || selectedApiModel() !== model.apiModel) return;
      if (result.ok) {
        setStatus("success", `已切换到 ${model.shortLabel}`, "运行时会使用该渠道，并按该模型的实时价格核对");
      } else {
        setStatus("warning", `${model.shortLabel} 价格暂时无法查询`, "仍可在运行时按二次确认继续生成");
      }
    }).catch(() => {});
  });
  elements.outfitModelChannel.addEventListener("change", () => {
    elements.modelChannel.value = elements.outfitModelChannel.value;
    resetPricingStateForModel();
    syncModelCapabilities();
    syncOutfitControlsFromMain();
    loadCachedPricing();
    updateResolvedSize();
    saveSettings();
    const model = getSelectedModelConfig();
    if (modelProvider(model) === "volc") {
      setStatus("success", `已切换到 ${model.shortLabel}`, "GPT 2.5 通过咖图异步图像接口生成；支持异步任务查询");
      return;
    }
    setStatus("working", `正在刷新 ${model.shortLabel} 价格`, "换装素材和补充要求仍可继续编辑");
    refreshLivePricing("outfit-model-change").then((result) => {
      if (!result || result.stale || selectedApiModel() !== model.apiModel) return;
      setStatus(
        result.ok ? "success" : "warning",
        result.ok ? `已切换到 ${model.shortLabel}` : `${model.shortLabel} 价格暂时无法查询`,
        result.ok ? "换装运行时会使用该渠道" : "仍可在运行时按二次确认继续生成"
      );
    }).catch(() => {});
  });
  elements.aspectRatio.addEventListener("change", () => {
    if (elements.aspectRatio.value === "auto" && modelProvider(getSelectedModelConfig()) !== "volc") {
      elements.resolution.value = "1K";
    }
    updateResolvedSize();
    saveSettings();
  });
  elements.resolution.addEventListener("change", () => {
    updateResolvedSize();
    saveSettings();
  });
  elements.generationCount.addEventListener("change", () => {
    updateResolvedSize();
    saveSettings();
  });
  elements.outfitResolution.addEventListener("change", () => {
    elements.resolution.value = elements.outfitResolution.value;
    updateResolvedSize();
    saveSettings();
  });
  elements.outfitGenerationCount.addEventListener("change", () => {
    elements.generationCount.value = elements.outfitGenerationCount.value;
    updateResolvedSize();
    saveSettings();
  });
  elements.precisionPlacement.addEventListener("change", () => {
    renderSelectedResult();
    saveSettings();
  });
  elements.run.addEventListener("click", handleRun);
  if (elements.stop) elements.stop.addEventListener("click", handleStop);
  elements.editorClear.addEventListener("click", () => {
    handleEditorClear().catch((error) => {
      setStatus("error", "清空失败", error && (error.message || error));
    });
  });
  elements.insert.addEventListener("click", handleInsert);
  elements.resultStage.addEventListener("wheel", handleResultStageWheel);
  elements.resultStage.addEventListener("mousewheel", handleResultStageWheel);
  elements.resultStage.addEventListener("mousedown", beginResultStagePan);
  elements.resultImage.addEventListener("click", handleResultStageClick);
  elements.resultImage.addEventListener("dblclick", (event) => {
    event.preventDefault();
    openResultPreview();
  });
  elements.resultImage.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openResultPreview();
  });
  elements.resultPreviewImage.addEventListener("load", handleResultPreviewImageLoad);
  elements.resultPreviewClose.addEventListener("click", closeResultPreview);
  if (elements.resultPreviewSave) elements.resultPreviewSave.addEventListener("click", () => { saveResultPreviewToLocal().catch((error) => setStatus("error", "保存失败", error.message || error)); });
  if (elements.resultPreviewCopyPrompt) elements.resultPreviewCopyPrompt.addEventListener("click", () => { copyResultPromptToClipboard().catch((error) => setStatus("error", "复制失败", error.message || error)); });
  elements.resultPreviewOverlay.addEventListener("click", (event) => {
    if (event.target === elements.resultPreviewOverlay) closeResultPreview();
  });
  bindResultPreviewWheelCapture("wheel");
  bindResultPreviewWheelCapture("mousewheel");
  bindResultPreviewWheelCapture("DOMMouseScroll");
  elements.resultPreviewViewport.addEventListener("mouseenter", focusResultPreviewViewport);
  elements.resultPreviewViewport.addEventListener("mousedown", beginResultPreviewPan);
  document.addEventListener("mousemove", moveResultStagePan);
  document.addEventListener("mouseup", endResultStagePan);
  document.addEventListener("mousemove", moveResultPreviewPan);
  document.addEventListener("mouseup", endResultPreviewPan);
  document.addEventListener("keydown", (event) => {
    if (!elements.taskDrawerOverlay.classList.contains("is-drawer-hidden")) {
      if (event.key === "Escape") closeTaskDrawer();
      return;
    }
    if (elements.resultPreviewOverlay.classList.contains("is-hidden")) return;
    if (event.key === "Escape") closeResultPreview();
    else if (event.key === "+" || event.key === "=") setResultPreviewZoom(resultPreviewZoom + 0.25);
    else if (event.key === "-") setResultPreviewZoom(resultPreviewZoom - 0.25);
  });
  elements.taskDrawerClose.addEventListener("click", closeTaskDrawer);
  elements.taskDrawerOverlay.addEventListener("click", (event) => {
    if (event.target === elements.taskDrawerOverlay) closeTaskDrawer();
  });
  elements.taskDrawerReuse.addEventListener("click", () => {
    const result = state.results.find((item) => item.id === taskDrawerResultId) || getSelectedResult();
    if (!result) return;
    closeTaskDrawer();
    fillHistoryTask(result.id).catch((error) => {
      setStatus("error", "无法复用历史任务", error.message || error);
    });
  });
  elements.taskDrawerInsert.addEventListener("click", () => {
    closeTaskDrawer();
    handleInsert();
  });
  elements.resultHistory.addEventListener("click", (event) => {
    let target = event.target;
    while (target && target !== elements.resultHistory) {
      const restoreId = target.getAttribute && target.getAttribute("data-result-restore");
      if (restoreId) {
        event.preventDefault();
        event.stopPropagation();
        fillHistoryTask(restoreId).catch((error) => {
          setStatus("error", "无法复用历史任务", error.message || error);
        });
        return;
      }
      const copyPromptId = target.getAttribute && target.getAttribute("data-result-copy-prompt");
      if (copyPromptId) {
        event.preventDefault();
        event.stopPropagation();
        copyResultPromptToClipboard(copyPromptId);
        return;
      }
      const saveId = target.getAttribute && target.getAttribute("data-result-save");
      if (saveId) {
        event.preventDefault();
        event.stopPropagation();
        state.selectedResultId = saveId;
        saveResultPreviewToLocal().catch((error) => setStatus("error", "保存失败", error.message || error));
        return;
      }
      const deleteId = target.getAttribute && target.getAttribute("data-result-delete");
      if (deleteId) {
        event.preventDefault();
        event.stopPropagation();
        removeResult(deleteId).catch((error) => {
          setStatus("error", "无法删除历史图", error.message || error);
        });
        return;
      }
      const previewId = target.getAttribute && target.getAttribute("data-result-preview");
      if (previewId) {
        handleHistoryPreviewClick(previewId, event);
        return;
      }
      const resultId = target.getAttribute && target.getAttribute("data-result-id");
      if (resultId) {
        handleHistoryPreviewClick(resultId, event);
        return;
      }
      target = target.parentNode;
    }
  });
  elements.resultHistory.addEventListener("dblclick", (event) => {
    const previewId = event.target && event.target.getAttribute
      ? event.target.getAttribute("data-result-preview")
      : null;
    if (!previewId) return;
    event.preventDefault();
    event.stopPropagation();
    lastHistoryPreviewClickId = "";
    lastHistoryPreviewClickAt = 0;
    selectResult(previewId);
    openResultPreview();
  });
  elements.resultHistory.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target && event.target.classList && event.target.classList.contains("history-text-action")) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) event.target.click();
      return;
    }
    const restoreId = event.target && event.target.getAttribute
      ? event.target.getAttribute("data-result-restore")
      : null;
    if (restoreId) {
      event.preventDefault();
      event.stopPropagation();
      fillHistoryTask(restoreId).catch((error) => {
        setStatus("error", "无法复用历史任务", error.message || error);
      });
      return;
    }
    const copyPromptId = event.target && event.target.getAttribute
      ? event.target.getAttribute("data-result-copy-prompt")
      : null;
    if (copyPromptId) {
      event.preventDefault();
      event.stopPropagation();
      copyResultPromptToClipboard(copyPromptId);
      return;
    }
    const deleteId = event.target && event.target.getAttribute
      ? event.target.getAttribute("data-result-delete")
      : null;
    if (deleteId) {
      event.preventDefault();
      event.stopPropagation();
      removeResult(deleteId).catch((error) => {
        setStatus("error", "无法删除历史图", error.message || error);
      });
      return;
    }
    const resultId = event.target && event.target.getAttribute
      ? event.target.getAttribute("data-result-id")
      : null;
    if (resultId) {
      event.preventDefault();
      selectResult(resultId);
      openResultPreview();
    }
  });
  if (elements.resultHistoryPrevious) {
    elements.resultHistoryPrevious.addEventListener("click", () => {
      setResultHistoryPage(state.resultHistoryPageIndex - 1);
    });
  }
  if (elements.resultHistoryNext) {
    elements.resultHistoryNext.addEventListener("click", () => {
      setResultHistoryPage(state.resultHistoryPageIndex + 1);
    });
  }
  if (elements.resultHistoryPageButtons) {
    elements.resultHistoryPageButtons.addEventListener("click", (event) => {
      let target = event.target;
      while (target && target !== elements.resultHistoryPageButtons) {
        const page = target.getAttribute && target.getAttribute("data-result-history-page");
        if (page !== null && page !== undefined) {
          event.preventDefault();
          setResultHistoryPage(Number(page) || 0);
          return;
        }
        target = target.parentNode;
      }
    });
    elements.resultHistoryPageButtons.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      let target = event.target;
      while (target && target !== elements.resultHistoryPageButtons) {
        const page = target.getAttribute && target.getAttribute("data-result-history-page");
        if (page !== null && page !== undefined) {
          event.preventDefault();
          setResultHistoryPage(Number(page) || 0);
          return;
        }
        target = target.parentNode;
      }
    });
  }

  elements.cancelKey.addEventListener("click", () => {
    state.resumeAfterKey = false;
    state.resumeRunOptions = null;
    state.resumePromptOptimizationAfterKey = false;
    state.resumePromptOptimizationToRun = false;
    hideKeyDialog();
    setStatus("idle", "已取消密钥输入", "没有发送接口请求");
  });
  elements.saveKey.addEventListener("click", async () => {
    const key = getKeyInputValue();
    if (!key) {
      elements.keyError.textContent = "请输入 API Key";
      elements.keyInput.focus();
      return;
    }
    elements.saveKey.disabled = true;
    elements.cancelKey.disabled = true;
    const savedProvider = state.pendingKeyProvider;
    try {
      if (savedProvider === "volc") {
        if (!/^ark-[A-Za-z0-9_-]+$/i.test(key)) throw new Error("火山方舟生成 API Key 格式不正确");
        await saveVolcImageApiKey(key);
      } else {
        await saveApiKey(key);
      }
      state.pendingHistoryTasks.forEach((task) => {
        task.autoRecoveryExhausted = false;
        task.autoRecoveryStartedAt = 0;
        task.recoveryElapsedMs = 0;
      });
      await queuePersistHistoryState();
      const resume = state.resumeAfterKey;
      const resumeRunOptions = state.resumeRunOptions;
      const resumePromptOptimization = state.resumePromptOptimizationAfterKey;
      const resumePromptOptimizationToRun = state.resumePromptOptimizationToRun;
      state.resumeAfterKey = false;
      state.resumeRunOptions = null;
      state.resumePromptOptimizationAfterKey = false;
      state.resumePromptOptimizationToRun = false;
      hideKeyDialog();
      setStatus(
        "success",
        savedProvider === "volc" ? "火山生成密钥已安全保存" : "API Key 已安全保存",
        resume ? "正在继续刚才的生成任务" : (resumePromptOptimization ? "正在继续优化提示词" : "可以开始运行")
      );
      if (resume) await handleRunWithControlOverrides(resumeRunOptions || {});
      else if (resumePromptOptimization) await handleOptimizePrompt({ continueToRun: resumePromptOptimizationToRun });
      if (pendingTasksForStartupRecovery().length && !state.recoveringPendingHistory) {
        recoverPendingHistoryTasksOnStartup().catch((error) => {
          if (!isAbortError(error)) setStatus("warning", "历史任务查询已暂停", error.message || error);
        });
      }
    } catch (error) {
      elements.keyError.textContent = sanitizeMessage(error.message || error);
    } finally {
      elements.saveKey.disabled = false;
      elements.cancelKey.disabled = false;
    }
  });
  elements.keyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      elements.saveKey.click();
    }
    if (event.key === "Escape") elements.cancelKey.click();
  });

  window.addEventListener("focus", () => {
    if (Date.now() - Number(state.pricing.fetchedAt || 0) >= PRICING_REFRESH_MS / 2) {
      refreshLivePricing("focus").catch(() => {});
    }
  });
  window.addEventListener("resize", () => {
    scheduleReferenceTileLayout();
    scheduleResultHistoryTileLayout();
  });
  window.addEventListener("resize", scheduleNotificationLayout);
  window.addEventListener("scroll", () => {
    scheduleNotificationLayout();
  });

  window.addEventListener("unload", () => {
    pluginDestroyed = true;
    if (styleLibraryUpdater) styleLibraryUpdater.dispose();
    cancelPendingNetworkRequests();
    if (pricingRefreshTimer !== null) clearInterval(pricingRefreshTimer);
    pricingRefreshTimer = null;
    if (promptSelectionCaptureTimer !== null) clearTimeout(promptSelectionCaptureTimer);
    promptSelectionCaptureTimer = null;
    stopPromptContinuationBlink();
    if (referenceLayoutTimer !== null) clearTimeout(referenceLayoutTimer);
    referenceLayoutTimer = null;
    if (resultHistoryLayoutTimer !== null) clearTimeout(resultHistoryLayoutTimer);
    resultHistoryLayoutTimer = null;
    if (notificationLayoutTimer !== null) clearTimeout(notificationLayoutTimer);
    notificationLayoutTimer = null;
    if (generationProgressTimer !== null) clearInterval(generationProgressTimer);
    generationProgressTimer = null;
    if (statusHideTimer !== null) clearTimeout(statusHideTimer);
    statusHideTimer = null;
    if (styleLibrarySearchTimer !== null) clearTimeout(styleLibrarySearchTimer);
    styleLibrarySearchTimer = null;
    if (resultPreviewWheelTimer !== null) clearTimeout(resultPreviewWheelTimer);
    resultPreviewWheelTimer = null;
    if (colorSamplingTimer !== null) clearInterval(colorSamplingTimer);
    colorSamplingTimer = null;
    resultPreviewPendingWheel = null;
    if (pendingHistoryRecoveryController) pendingHistoryRecoveryController.abort();
    if (promptOptimizationController) promptOptimizationController.abort();
    state.generationJobs.forEach((job) => {
      job.requestControllers.forEach((requestController) => requestController.abort());
      job.controller.abort();
    });
    state.references.forEach(revokeReferencePreview);
    outfitReferencePool().forEach(revokeReferencePreview);
    productReferencePool().forEach(revokeReferencePreview);
    state.results.forEach(revokeResultPreview);
  });
}

async function initialize() {
  cacheElements();
  // Build library categories before constructing the custom select control.
  initializeStyleLibraryCategories();
  initializeIslandSelects();
  loadSettings();
  loadBudgetState();
  loadCachedPricing();
  loadUpdateCheckCache();
  bindEvents();
  syncOutfitControlsFromMain();
  showWorkspace("editor");
  updatePromptCount();
  renderReferences();
  renderProductWorkspace();
  renderBudgetSummary();
  renderResultHistory();
  renderGenerationQueue();
  syncNotificationLayout();
  updateControls();
  await loadPersistentHistoryState();
  await loadApiKey();
  await loadArkApiKey();
  await loadVolcImageApiKey();
  startPricingAutoRefresh();
  refreshLivePricing("startup").catch(() => {});
  if (state.historyPersistenceError) {
    setStatus("warning", "本地生成历史读取不完整", state.historyPersistenceError);
  } else if (state.results.length) {
    setStatus("success", `已恢复 ${state.results.length} 张生成历史`, "可直接查看；重新打开原 Photoshop 文档后也能继续插入");
  } else {
    setStatus("idle", "准备就绪", "可获取 Photoshop 选区、图层或全图，也可点击“＋”导入图片");
  }
  if (pendingTasksForStartupRecovery().length) {
    if (state.apiKey) {
      recoverPendingHistoryTasksOnStartup().catch((error) => {
        if (!isAbortError(error)) setStatus("warning", "历史任务查询已暂停", error.message || error);
      });
    } else {
      setStatus("warning", "有上次未显示的生成图片", "下次输入 API Key 后会自动查询历史，不会重新生成");
    }
  }
  if (state.updateAvailable) {
    setTimeout(() => {
      showUpdateAvailableNotice("cache");
    }, 900);
  }
  const updateCheckDue = Date.now() - state.updateLastCheckedAt >= UPDATE_CONFIG.automaticCheckIntervalMs;
  if (updateCheckDue) {
    setTimeout(() => {
      checkForPluginUpdate(false).catch(() => {});
    }, 2500);
  }
}

initialize().catch((error) => {
  if (elements.status) setStatus("error", "插件初始化失败", error.message || error);
});
