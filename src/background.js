import {
  RuleValidationError,
  collectRegexFiltersForValidation,
  compileDynamicRules,
  createDefaultState,
  normalizeState
} from "./core.js";

const STORAGE_KEY = "state";
let mutationQueue = Promise.resolve();

function enqueueMutation(operation) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.catch(() => undefined);
  return result;
}

async function readState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) {
    return createDefaultState();
  }
  return normalizeState(stored[STORAGE_KEY]);
}

async function replaceDynamicRules(state) {
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = compileDynamicRules(state);
  for (const regex of collectRegexFiltersForValidation(state)) {
    const support = await chrome.declarativeNetRequest.isRegexSupported({
      regex,
      isCaseSensitive: false
    });
    if (!support.isSupported) {
      const reason = support.reason ? `：${support.reason}` : "";
      throw new RuleValidationError(`Chrome 不支持该正则表达式${reason}`, "sitePatterns");
    }
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: current.map((rule) => rule.id),
    addRules
  });
  return addRules.length;
}

async function commitState(candidate) {
  const nextState = normalizeState(candidate);
  const previousState = await readState();
  const dynamicRuleCount = await replaceDynamicRules(nextState);

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: nextState });
  } catch (error) {
    await replaceDynamicRules(previousState).catch(() => undefined);
    throw error;
  }

  return { state: nextState, dynamicRuleCount };
}

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = stored[STORAGE_KEY]
    ? normalizeState(stored[STORAGE_KEY])
    : createDefaultState();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  await replaceDynamicRules(state);
}

function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : "未知错误",
    field: typeof error?.field === "string" ? error.field : ""
  };
}

chrome.runtime.onInstalled.addListener(() => {
  enqueueMutation(initialize).catch((error) => console.error("Initialization failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  enqueueMutation(initialize).catch((error) => console.error("Startup sync failed", error));
});

chrome.permissions.onAdded.addListener(() => {
  enqueueMutation(async () => replaceDynamicRules(await readState())).catch((error) =>
    console.error("Permission sync failed", error)
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "GET_STATE") {
    mutationQueue
      .then(async () => {
        const state = await readState();
        const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
        return { state, dynamicRuleCount: dynamicRules.length };
      })
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "SAVE_STATE") {
    enqueueMutation(() => commitState(message.state))
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  return false;
});
