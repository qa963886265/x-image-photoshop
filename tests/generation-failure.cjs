const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plugin = path.join(__dirname, '..', 'plugin');
const main = fs.readFileSync(path.join(plugin, 'main-v1.7.77.js'), 'utf8');
const utils = require(path.join(plugin, 'lib/utils.js'));
const { API_CONFIG, MODEL_CONFIGS } = require(path.join(plugin, 'lib/constants.js'));
const providerReason = '生图失败，请稍后重试或更换生图模型（原因: 所有通道尝试失败）';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
let checks = 0;
function passed(label) { checks++; console.log('PASS: ' + label); }
function productionFunction(name) {
  const start = main.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert(start >= 0, `Missing production function ${name}`);
  const tail = main.slice(start);
  const next = tail.slice(1).search(/\n(?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function install(ctx, names) { vm.runInContext(names.map(productionFunction).join('\n'), ctx); }
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {status, headers: {'content-type': 'application/json'}});
}
function options() {
  const requested = utils.resolveOutputSize('3:4', '2K', 300, 400);
  assert.equal(requested.size, '1536x2048');
  return {
    apiKey: 'mock-key-for-offline-test', model: 'gpt-image-2.5-sunburst',
    prompt: '将图一细节修改成图二，保持图一构图及光影。',
    size: requested.size, aspectRatio: '3:4', resolution: '2K',
    imageFiles: [new File([png], 'reference-1.png', {type: 'image/png'}), new File([png], 'reference-2.png', {type: 'image/png'})],
    signal: new AbortController().signal
  };
}
function requestContext(route) {
  const calls = [];
  let now = 1000;
  const ctx = vm.createContext({
    ...utils, URL, Uint8Array, ArrayBuffer, AbortController, FormData, Set, Map,
    Date: class extends Date { static now() { return now; } },
    API_CONFIG: {...API_CONFIG, asyncPollTimeoutMs: 20}, MODEL_CONFIGS, ASYNC_TASK_REQUEST_TIMEOUT_MS: 20,
    limitedFetch: async (url, init) => { calls.push({url, init}); return route(url, init, calls.length); },
    readBoundedResponse: async response => response.arrayBuffer(),
    withRequestTimeout: async (signal, timeout, callback) => callback(signal),
    waitForAsyncPoll: async () => { now += 25; },
  });
  install(ctx, [
    'normalizeModelIdentifier', 'getModelConfig', 'getSelectedModelConfig', 'modelProvider', 'isVolcModel', 'historyModelMatches',
    'httpErrorMessage', 'createHttpResponseError', 'readImageResponse', 'absoluteKatuUrl',
    'extractAsyncTaskInfo', 'asyncTaskStatus', 'asyncTaskTerminal', 'asyncTaskFailureStatus',
    'extractAsyncImageCandidates', 'asyncCandidatesToImages', 'usableImagesFromCandidateBatch',
    'asyncTaskDescriptors', 'pollSingleOpenAiImageTask', 'pollOpenAiImageTask',
    'historyRecordImageCandidates', 'imageBufferFingerprint',
    'performOpenAiImageEditRequest', 'isUnsupportedImageDimensionsError', 'requestOpenAiImageEdit', 'requestImageEdit',
    'isAbortError', 'historyRecoverableOutcome', 'serverMayStillCompleteOutcome',
  ]);
  return {ctx, calls};
}
async function rejected(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail('Expected rejection');
}
function outcome(error) {
  return {ok: false, requestSubmitted: true, hasPersistedAsyncTaskId: true, error,
    responseReceived: !!error.responseReceived, terminalTaskFailure: !!error.terminalTaskFailure};
}

async function checkRequests() {
  const terminal = requestContext((url, init) => init.method === 'POST'
    ? jsonResponse({id: 'task-terminal', status: 'queued'}, 202)
    : jsonResponse({id: 'task-terminal', status: 'failed', error: {message: providerReason}}));
  let submitted = 0, updated = 0;
  const error = await rejected(terminal.ctx.requestImageEdit({...options(),
    onTaskSubmitted: () => { submitted++; }, onTaskUpdated: () => { updated++; }}));
  assert.equal(error.message, providerReason);
  assert.equal(error.terminalTaskFailure, true);
  assert.equal(error.serverResponseReceived, true);
  assert.equal(error.responseReceived, false);
  assert.equal(!!error.billingUncertain, false);
  assert.equal(terminal.ctx.historyRecoverableOutcome(outcome(error)), false);
  assert.equal(terminal.ctx.serverMayStillCompleteOutcome(outcome(error)), false);
  assert.equal(submitted, 1); assert.equal(updated, 1);
  assert.equal(terminal.calls.length, 2);
  const post = terminal.calls.find(call => call.init.method === 'POST');
  assert.equal(post.init.body.get('model'), 'gpt-image-2.5-sunburst');
  assert.equal(post.init.body.get('size'), '1536x2048');
  assert.equal(post.init.body.getAll('image').length, 2);
  assert.equal(post.init.headers.Prefer, 'respond-async');
  passed('HTTP 202 then provider failure preserves reason, never claims an image, never retries; 2K 3:4 sunburst and both references remain correct');

  const pending = requestContext((url, init) => init.method === 'POST'
    ? jsonResponse({id: 'task-pending', status: 'queued'}, 202)
    : jsonResponse({id: 'task-pending', status: 'running'}));
  const timeout = await rejected(pending.ctx.requestImageEdit(options()));
  assert.equal(timeout.name, 'AsyncTaskTimeoutError');
  assert.equal(timeout.taskId, 'task-pending');
  assert.equal(timeout.responseReceived, false);
  assert.equal(timeout.billingUncertain, true);
  assert.equal(pending.ctx.historyRecoverableOutcome(outcome(timeout)), true);
  assert.equal(pending.ctx.serverMayStillCompleteOutcome(outcome(timeout)), true);
  assert.equal(pending.calls.filter(call => call.init.method === 'POST').length, 1);
  passed('Unfinished task timeout remains eligible for history recovery and never claims image delivery');

  const invalidImage = requestContext(() => new Response(new Uint8Array([1,2,3,4]), {headers: {'content-type': 'image/png'}}));
  const decodeError = await rejected(invalidImage.ctx.requestImageEdit(options()));
  assert.equal(decodeError.responseReceived, true);
  assert.equal(!!decodeError.terminalTaskFailure, false);
  assert.equal(invalidImage.calls.length, 1);
  passed('Actual image response with decode failure retains the distinct image-received marker');

  const staleMarker = requestContext(() => jsonResponse({id: 'task-stale'}, 202));
  staleMarker.ctx.pollOpenAiImageTask = async () => {
    throw Object.assign(new Error(providerReason), {taskId: 'task-stale', terminalTaskFailure: true, responseReceived: true});
  };
  const stale = await rejected(staleMarker.ctx.requestImageEdit(options()));
  assert.equal(stale.responseReceived, false);
  passed('Explicit terminal failure overrides an accidental stale image-received marker');
}

async function checkAggregation() {
  for (const scenario of ['all-failed', 'child-pending', 'partial-image']) {
    const {ctx, calls} = requestContext((url, init) => {
      if (init.method === 'POST') return jsonResponse({id: 'parent', task_ids: ['child'], status: 'queued'}, 202);
      if (url.endsWith('/parent')) return jsonResponse({status: 'failed', error: {message: providerReason}});
      if (scenario === 'all-failed') return jsonResponse({status: 'failed', error: {message: '子任务失败'}});
      if (scenario === 'child-pending') return jsonResponse({status: 'running'});
      return jsonResponse({status: 'succeeded', data: [{b64_json: png.toString('base64')}]});
    });
    if (scenario === 'partial-image') {
      const result = await ctx.requestImageEdit(options());
      assert.equal(result.images.length, 1);
      assert.equal(result.images[0].type.width, 1);
      assert.equal(result.images[0].asyncTaskId, 'child');
      assert.equal(result.partialErrors.length, 1);
      assert.equal(result.partialErrors[0].terminalTaskFailure, true);
    } else {
      const error = await rejected(ctx.requestImageEdit(options()));
      assert.equal(!!error.terminalTaskFailure, scenario === 'all-failed');
      assert.equal(ctx.historyRecoverableOutcome(outcome(error)), scenario === 'child-pending');
      assert.equal(error.responseReceived, false);
      if (scenario === 'child-pending') assert.equal(error.taskId, 'child');
    }
    assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
    passed('Real parent/child polling: ' + scenario);
  }
}

async function checkFlareModel() {
  const flare = MODEL_CONFIGS['gpt-image-2.5-flare'];
  for (const resolution of ['1K', '2K', '4K']) {
    const {ctx, calls} = requestContext((url, init) => init.method === 'POST'
      ? jsonResponse({id: 'flare-' + resolution, status: 'queued'}, 202)
      : jsonResponse({status: 'succeeded', data: [{b64_json: png.toString('base64')}]}));
    assert.equal(ctx.getModelConfig('Image-2.5 Flare').apiModel, flare.apiModel);
    assert.equal(ctx.getModelConfig('GPT 2.5').apiModel, 'gpt-image-2.5-sunburst');
    assert.equal(ctx.historyModelMatches(flare.apiModel, 'gpt-image-2.5-sunburst'), false);
    assert.equal(ctx.historyModelMatches(flare.apiModel, 'Image-2.5 Flare'), true);
    const expected = utils.resolveOutputSize('3:4', resolution, 300, 400);
    const result = await ctx.requestImageEdit({...options(), model: flare.apiModel, resolution, size: expected.size});
    const posts = calls.filter(call => call.init.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, API_CONFIG.endpoint);
    assert.equal(posts[0].init.body.get('model'), 'gpt-image-2.5-flare');
    assert.equal(posts[0].init.body.get('size'), expected.size);
    assert.equal(posts[0].init.body.getAll('image').length, 2);
    assert.equal(result.images[0].asyncTaskId, 'flare-' + resolution);
  }
  const pricing = {data: [
    {model_name: 'gpt-image-2.5-sunburst', api_price: {'1K': {enable: true, price: 0.02}, '2K': {enable: true, price: 0.18}, '4K': {enable: true, price: 0.19}}},
    {model_name: 'gpt-image-2.5-flare', api_price: {'1K': {enable: true, price: 0.03}, '2K': {enable: true, price: 0.18}, '4K': {enable: true, price: 0.19}}}
  ]};
  const snapshot = utils.extractPricingSnapshot(pricing, flare.pricingModel, flare.supportedSizes);
  assert.equal(snapshot.matchedModel, 'gpt-image-2.5-flare');
  assert.deepEqual(snapshot.prices, {'1K': 0.03, '2K': 0.18, '4K': 0.19});
  assert.equal(utils.extractPricingSnapshot(pricing, 'gpt-image-2.5-sunburst', ['1K']).prices['1K'], 0.02);
  passed('Flare uses its own model, async route, pixel sizes and price for all three resolutions; Sunburst history stays separate');
}

async function checkGenerationJob() {
  const {ctx, calls} = requestContext((url, init) => init.method === 'POST'
    ? jsonResponse({id: 'task-full-job', status: 'queued'}, 202)
    : jsonResponse({id: 'task-full-job', status: 'failed', error: {message: providerReason}}));
  const statuses = [];
  let baselineReads = 0, historyRecoveryReads = 0, knownFailedCalls = 0, removed = 0, persisted = 0;
  const pending = {id: 'job-1', requestedCount: 1, submittedCount: 0, resolvedCount: 0, knownFailedCount: 0, asyncTasks: []};
  const job = {
    id: 'job-1', sequence: 1, apiKey: options().apiKey, model: options().model,
    prompt: options().prompt, requested: {size: '1536x2048', ratio: '3:4', resolution: '2K'},
    requestedCount: 1, imageFiles: options().imageFiles, pendingHistoryTask: pending,
    controller: new AbortController(), requestControllers: [], completedCount: 0, failedCount: 0,
    settledCount: 0, recoveredCount: 0, snapshot: {}, imageFingerprints: new Set()
  };
  Object.assign(ctx, {
    state: {pendingHistoryTasks: [pending], generationJobs: [job], results: [], inserting: false},
    hasPhotoshopDocument: () => true, hasCurrentPhotoshopDocument: () => true,
    setTimeout: () => 1, clearTimeout: () => {},
    setStatus: (...values) => statuses.push(values),
    renderGenerationQueue: () => {}, updateControls: () => {},
    fetchGenerationHistory: async () => { baselineReads++; return {data: []}; },
    recoverPendingTaskById: async () => { historyRecoveryReads++; assert.fail('Explicit terminal failure must never enter history recovery'); },
    usedHistoryRecordKeys: () => { historyRecoveryReads++; assert.fail('Explicit terminal failure must not start recovery'); },
    updatePendingHistoryTask: async () => { persisted++; return true; },
    removePendingHistoryTask: async () => { removed++; },
    waitForGenerationProgressFrame: async () => {}, updateGenerationProgressVisuals: () => {},
    waitForGenerationProgressCompletion: async () => {}, releaseGenerationJobReferences: async () => {},
  });
  install(ctx, [
    'pendingTaskForJob', 'pendingAsyncTaskEntry', 'pendingHistoryOutstandingCount', 'asyncTaskIdsForEntry',
    'markPendingRequestSubmitted', 'unmarkPendingRequestSubmitted', 'markPendingAsyncTaskSubmitted',
    'updatePendingAsyncTask', 'markPendingRequestKnownFailed', 'runGenerationJob'
  ]);
  const originalMark = ctx.markPendingRequestKnownFailed;
  ctx.markPendingRequestKnownFailed = async (...args) => { knownFailedCalls++; return originalMark(...args); };
  await ctx.runGenerationJob(job);
  assert.equal(job.failedCount, 1); assert.equal(job.completedCount, 0); assert.equal(job.settledCount, 1);
  assert.equal(job.status, 'failed'); assert.equal(job.controller.signal.aborted, false);
  assert.equal(knownFailedCalls, 1); assert.equal(pending.knownFailedCount, 1);
  assert.equal(pending.asyncTasks.length, 1); assert.equal(pending.asyncTasks[0].failed, true);
  assert.equal(pending.asyncTasks[0].id, 'task-full-job');
  assert.equal(ctx.pendingHistoryOutstandingCount(pending), 0);
  assert.equal(baselineReads, 1); assert.equal(historyRecoveryReads, 0);
  assert.equal(removed, 1); assert.equal(job.pendingHistoryTask, null);
  assert(persisted >= 3, 'Submission, task ID and known failure must be persisted');
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(job.requestControllers.length, 0); assert.equal(ctx.state.generationJobs.length, 0);
  assert.deepEqual(statuses.at(-1), ['error', '生成服务未能完成任务', providerReason + '；费用及退款以服务端账单为准']);
  passed('Entire generation flow persists known failure exactly once, skips recovery/resubmission, removes completed tracking and shows correct provider-failure title');
}

function checkStatusTooltip() {
  function element() { return {dataset: {}, classList: {add() {}, remove() {}}, textContent: ''}; }
  const elements = {status: element(), statusIcon: element(), statusTitle: element(), statusDetail: element(), notificationLayer: element()};
  const ctx = vm.createContext({elements, pluginDestroyed: false, statusHideTimer: null,
    syncNotificationLayout() {}, sanitizeMessage: String, setTimeout: () => 1, clearTimeout() {}, STATUS_HIDE_DELAY_MS: 10000});
  install(ctx, ['setStatus']);
  const detail = providerReason + '；费用及退款以服务端账单为准';
  ctx.setStatus('error', '生成服务未能完成任务', detail);
  assert.equal(elements.status.title, '生成服务未能完成任务：' + detail);
  ctx.setStatus('success', '已完成', '');
  assert.equal(elements.status.title, '已完成');
  assert.equal(elements.status.dataset.kind, 'success');
  passed('Notification tooltip exposes the full failure reason and clears stale text on subsequent notices');
}

(async () => {
  await checkRequests();
  await checkAggregation();
  await checkFlareModel();
  await checkGenerationJob();
  checkStatusTooltip();
  console.log(`All ${checks} focused generation failure checks passed; all network and host effects were mocked.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
