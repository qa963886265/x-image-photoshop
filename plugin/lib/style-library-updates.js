"use strict";

// Only data from these existing library sources is accepted. Manifest paths and
// source names never determine network destinations or executable UI content.
const SOURCE_IDS = [
  "freestylefly-gpt-image-2", "youmind-gpt-image-2", "davidwu-gpt-image2-prompts",
  "awesome-gpt-image", "awesome-gpt4o-image-prompts", "banana-prompt-quicker",
  "youmind-nano-banana-pro"
];
const BASE_URL = "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/";
const MANIFEST_URL = BASE_URL + "manifest.json";
const MAX_TEMPLATES = 20000;
const THROTTLE_MS = 5 * 60 * 1000;
const COVER_HOSTS = ["raw.githubusercontent.com", "cms-assets.youmind.com"];
const HASH_PATTERN = /^[a-f0-9]{64}$/i;

// Small dependency-free SHA-256 implementation for UXP adapters. The adapter
// should hash the response bytes before JSON parsing and reject when the
// resulting lowercase hex does not equal expectedHash.
function sha256Hex(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : Array.isArray(input) ? Uint8Array.from(input) : null;
  if (!bytes) throw new TypeError("sha256Hex expects bytes");
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
    0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
    0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
    0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bitLength = bytes.length * 8;
  const total = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(total);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  padded[total - 8] = high >>> 24; padded[total - 7] = high >>> 16;
  padded[total - 6] = high >>> 8; padded[total - 5] = high;
  padded[total - 4] = low >>> 24; padded[total - 3] = low >>> 16;
  padded[total - 2] = low >>> 8; padded[total - 1] = low;
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const p = offset + i * 4;
      w[i] = (padded[p] << 24) | (padded[p + 1] << 16) | (padded[p + 2] << 8) | padded[p + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, q] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (q + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      q = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + q) >>> 0;
  }
  return h.map(value => value.toString(16).padStart(8, "0")).join("");
}

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error("Invalid library text");
  }
  return value.trim();
}

function optionalText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function httpsUrl(value, cover) {
  if (typeof value !== "string" || value.length > 4096) return "";
  const text = value.trim();
  // UXP versions do not all expose the browser URL constructor. Disallow
  // credentials, whitespace, ports, escapes in the authority and non-HTTPS.
  const match = /^https:\/\/([a-z0-9.-]+)(?:[/?#][^\s]*)?$/i.exec(text);
  if (!match || (cover && COVER_HOSTS.indexOf(match[1].toLowerCase()) < 0)) return "";
  return text;
}

function createStyleLibraryUpdater(options) {
  const bundled = object(options.bundled) ? options.bundled : {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const categories = (Array.isArray(bundled.categories) ? bundled.categories : [])
    .filter(category => object(category) && SOURCE_IDS.indexOf(category.value) >= 0);
  const names = Object.create(null);
  SOURCE_IDS.forEach(id => {
    const category = categories.find(item => item.value === id);
    const title = category && category.title;
    names[id] = optionalText(typeof title === "string" ? title : title && (title.zh || title.en), 200) || id;
  });

  function normalizeTemplate(value, sourceId) {
    if (!object(value) || value.sourceId !== sourceId) throw new Error("Invalid template source");
    const id = requiredText(value.id, 200);
    if (id.indexOf(sourceId + ":") !== 0 || id.length <= sourceId.length + 1) {
      throw new Error("Invalid template id");
    }
    if (!Array.isArray(value.tags) || value.tags.length > 64 ||
        value.tags.some(tag => typeof tag !== "string" || tag.length > 200)) {
      throw new Error("Invalid template tags");
    }
    return {
      id: id,
      category: sourceId,
      sourceId: sourceId,
      sourceTitle: names[sourceId],
      title: requiredText(value.title, 1000),
      prompt: requiredText(value.prompt, 200000),
      description: optionalText(value.description, 20000),
      coverUrl: httpsUrl(value.coverUrl, true),
      tags: value.tags.map(tag => tag.trim()).filter(Boolean),
      author: optionalText(value.author, 500),
      sourceUrl: httpsUrl(value.sourceUrl, false),
      imageModel: optionalText(value.imageModel, 200)
    };
  }

  function normalizeTemplates(value, sourceId, expectedCount) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_TEMPLATES ||
        (expectedCount !== undefined && value.length !== expectedCount)) {
      throw new Error("Invalid source count");
    }
    const seen = new Set();
    return value.map(raw => {
      const item = normalizeTemplate(raw, sourceId);
      if (seen.has(item.id)) throw new Error("Duplicate template id");
      seen.add(item.id);
      return item;
    });
  }

  // A source may publish a rotating selection. Keep previous entries by ID,
  // while applying edits to known entries and showing additions first.
  function mergeTemplates(previous, incoming) {
    const oldIds = new Set(previous.map(item => item.id));
    const incomingById = new Map(incoming.map(item => [item.id, item]));
    return incoming.filter(item => !oldIds.has(item.id)).concat(
      previous.map(item => incomingById.get(item.id) || item)
    );
  }

  const sources = Object.create(null);
  SOURCE_IDS.forEach(id => { sources[id] = { hash: "", templates: [], verifiedCount: 0 }; });
  const localTemplates = Array.isArray(bundled.templates) ? bundled.templates : [];
  localTemplates.slice(0, MAX_TEMPLATES).forEach(raw => {
    if (!raw || !sources[raw.sourceId]) return;
    try {
      const item = normalizeTemplate(raw, raw.sourceId);
      if (!sources[item.sourceId].templates.some(previous => previous.id === item.id)) {
        sources[item.sourceId].templates.push(item);
      }
    } catch (_) { /* Invalid bundled rows do not hide the rest of the library. */ }
  });

  let disposed = false;
  let loadPromise = null;
  let refreshPromise = null;
  let lastAttempt = null;
  let checkedAt = 0;
  let generatedAt = "";
  let cacheError = false;
  let currentStatus = status("ready");
  let controller = null;

  function allTemplates() {
    return SOURCE_IDS.reduce((all, id) => all.concat(sources[id].templates), []);
  }

  function status(phase, extra) {
    return Object.assign({
      phase: phase,
      added: 0,
      updated: 0,
      checkedAt: checkedAt,
      generatedAt: generatedAt,
      failedSources: [],
      cacheError: cacheError
    }, extra || {});
  }

  function publishStatus(next) {
    currentStatus = next;
    if (!disposed && typeof options.onStatus === "function") {
      try { options.onStatus(Object.assign({}, next, { failedSources: next.failedSources.slice() })); } catch (_) {}
    }
    return next;
  }

  function publishLibrary() {
    if (!disposed && typeof options.onLibrary === "function") {
      const library = Object.assign({}, bundled, {
        categories: categories,
        templates: allTemplates(),
        updatedAt: generatedAt
      });
      try { options.onLibrary(library); } catch (_) {}
    }
  }

  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async function () {
      if (disposed) return currentStatus;
      publishStatus(status("loading"));
      try {
        const cache = typeof options.readCache === "function" ? await options.readCache() : null;
        if (disposed) return currentStatus;
        if (cache !== null && cache !== undefined) {
          if (!object(cache) || cache.schemaVersion !== 1 || !object(cache.sources) ||
              !Number.isFinite(cache.checkedAt) || cache.checkedAt < 0 || cache.checkedAt > now() + THROTTLE_MS ||
              typeof cache.generatedAt !== "string" || (cache.generatedAt && !Number.isFinite(Date.parse(cache.generatedAt)))) {
            throw new Error("Invalid library cache");
          }
          const keys = Object.keys(cache.sources);
          if (!keys.length || keys.length > SOURCE_IDS.length) throw new Error("Invalid cached sources");
          let accepted = 0;
          keys.forEach(id => {
            if (SOURCE_IDS.indexOf(id) < 0) { cacheError = true; return; }
            try {
              const source = cache.sources[id];
              if (!object(source) || typeof source.hash !== "string" || !HASH_PATTERN.test(source.hash)) {
                throw new Error("Invalid cached hash");
              }
              const templates = normalizeTemplates(source.templates, id);
              const merged = mergeTemplates(sources[id].templates, templates);
              if (allTemplates().length - sources[id].templates.length + merged.length > MAX_TEMPLATES) {
                throw new Error("Cache too large");
              }
              sources[id] = { hash: source.hash.toLowerCase(), templates: merged, verifiedCount: templates.length };
              accepted += 1;
            } catch (_) { cacheError = true; }
          });
          if (accepted) {
            checkedAt = cache.checkedAt;
            generatedAt = cache.generatedAt;
          }
        }
      } catch (_) { if (!disposed) cacheError = true; }
      if (!disposed) {
        publishLibrary();
        return publishStatus(status("ready"));
      }
      return currentStatus;
    })();
    return loadPromise;
  }

  function manifestSources(manifest) {
    if (!object(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources) ||
        !manifest.sources.length || manifest.sources.length > 32 ||
        !Number.isInteger(manifest.total) || manifest.total < 1 || manifest.total > MAX_TEMPLATES ||
        typeof manifest.generatedAt !== "string" || !Number.isFinite(Date.parse(manifest.generatedAt))) {
      throw new Error("Invalid library manifest");
    }
    const entries = Object.create(null);
    const invalid = new Set();
    let total = 0;
    manifest.sources.forEach(entry => {
      if (!object(entry) || SOURCE_IDS.indexOf(entry.id) < 0) return;
      const id = entry.id;
      if (entries[id] || invalid.has(id) || !Number.isInteger(entry.count) || entry.count < 1 ||
          entry.count > MAX_TEMPLATES || typeof entry.sha256 !== "string" || !HASH_PATTERN.test(entry.sha256)) {
        invalid.add(id);
        delete entries[id];
        return;
      }
      entries[id] = { count: entry.count, hash: entry.sha256.toLowerCase() };
      total += entry.count;
    });
    if (total > MAX_TEMPLATES) throw new Error("Library manifest too large");
    return entries;
  }

  function cacheSnapshot() {
    const cachedSources = {};
    SOURCE_IDS.forEach(id => {
      if (sources[id].hash && sources[id].templates.length) {
        cachedSources[id] = { hash: sources[id].hash, templates: sources[id].templates };
      }
    });
    return { schemaVersion: 1, checkedAt: checkedAt, generatedAt: generatedAt, sources: cachedSources };
  }

  function refresh(settings) {
    if (refreshPromise) return refreshPromise;
    if (disposed) return Promise.resolve(currentStatus);
    const force = Boolean(settings && settings.force);
    refreshPromise = (async function () {
      await load();
      if (disposed) return currentStatus;
      const attemptTime = now();
      if (!force && lastAttempt !== null && attemptTime - lastAttempt < THROTTLE_MS) return currentStatus;
      lastAttempt = attemptTime;
      controller = typeof AbortController === "function" ? new AbortController() : null;
      const signal = controller ? controller.signal : undefined;
      publishStatus(status("checking"));
      const before = new Map(allTemplates().map(item => [item.id, JSON.stringify(item)]));
      const failures = [];
      let validSources = 0;
      try {
        const manifest = await options.requestJson(MANIFEST_URL, 256 * 1024, signal);
        if (disposed) return currentStatus;
        const entries = manifestSources(manifest);
        let cursor = 0;
        async function worker() {
          while (!disposed && cursor < SOURCE_IDS.length) {
            const id = SOURCE_IDS[cursor++];
            const entry = entries[id];
            if (!entry) { failures.push(id); continue; }
            // A truncated cache must not gain a trusted version merely by
            // carrying the same hash as today's manifest.
            if (sources[id].hash === entry.hash && sources[id].verifiedCount >= entry.count) {
              validSources += 1;
              continue;
            }
            try {
              const data = await options.requestJson(BASE_URL + "sources/" + id + ".json", 8 * 1024 * 1024, signal, entry.hash);
              if (disposed) return;
              const incoming = normalizeTemplates(data, id, entry.count);
              const merged = mergeTemplates(sources[id].templates, incoming);
              if (allTemplates().length - sources[id].templates.length + merged.length > MAX_TEMPLATES) {
                throw new Error("Library too large");
              }
              sources[id] = { hash: entry.hash, templates: merged, verifiedCount: incoming.length };
              validSources += 1;
            } catch (_) { if (!disposed) failures.push(id); }
          }
        }
        await Promise.all([worker(), worker()]);
        if (disposed) return currentStatus;
        checkedAt = attemptTime;
        if (validSources) generatedAt = manifest.generatedAt;
        let added = 0;
        let updated = 0;
        allTemplates().forEach(item => {
          if (!before.has(item.id)) added += 1;
          else if (before.get(item.id) !== JSON.stringify(item)) updated += 1;
        });
        const snapshot = cacheSnapshot();
        if (!disposed && validSources && Object.keys(snapshot.sources).length && typeof options.writeCache === "function") {
          try {
            // The optional signal lets the storage adapter guard a pending
            // write too; disposal already prevents starting further writes.
            await options.writeCache(snapshot, signal);
            if (!disposed) cacheError = false;
          } catch (_) { if (!disposed) cacheError = true; }
        }
        if (disposed) return currentStatus;
        if (added || updated) publishLibrary();
        const phase = failures.length ? (validSources ? "partial" : "offline") : "ready";
        return publishStatus(status(phase, { added: added, updated: updated, failedSources: failures }));
      } catch (_) {
        if (disposed) return currentStatus;
        checkedAt = attemptTime;
        return publishStatus(status("offline", { failedSources: SOURCE_IDS.slice() }));
      } finally { controller = null; }
    })().catch(function () {
      return disposed ? currentStatus : publishStatus(status("offline", { failedSources: SOURCE_IDS.slice() }));
    }).finally(function () { refreshPromise = null; });
    return refreshPromise;
  }

  function dispose() {
    disposed = true;
    if (controller) {
      try { controller.abort(); } catch (_) {}
    }
  }

  return { load: load, refresh: refresh, dispose: dispose };
}

module.exports = { createStyleLibraryUpdater: createStyleLibraryUpdater, sha256Hex: sha256Hex };
