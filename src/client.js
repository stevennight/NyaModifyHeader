import { compileDynamicRules, normalizeState } from "./core.js";

export const SITE_ORIGINS = Object.freeze(["http://*/*", "https://*/*"]);
export const IS_EXTENSION = Boolean(globalThis.chrome?.runtime?.id);

let demoHasSiteAccess = new URLSearchParams(window.location.search).get("permission") !== "missing";
let demoState = normalizeState({
  schemaVersion: 3,
  globalEnabled: true,
  nextRuleId: 4,
  rules: [
    {
      id: 1,
      enabled: true,
      name: "本地 API 调试",
      headerChanges: [
        { direction: "request", operation: "set", header: "X-Debug-Mode", value: "1" },
        { direction: "request", operation: "set", header: "X-Client-Name", value: "nya" }
      ],
      matchType: "wildcard",
      sitePatterns: ["http://localhost:*/*", "https://dev.example.com/*"],
      excludedSitePatterns: [],
      resourceTypes: ["xmlhttprequest"],
      priority: 10
    },
    {
      id: 2,
      enabled: true,
      name: "允许读取版本号",
      headerChanges: [
        { direction: "response", operation: "set", header: "Access-Control-Allow-Origin", value: "https://app.example.com" },
        { direction: "response", operation: "set", header: "Access-Control-Allow-Credentials", value: "true" },
        { direction: "response", operation: "set", header: "Access-Control-Expose-Headers", value: "X-App-Version" }
      ],
      matchType: "wildcard",
      sitePatterns: ["https://api.example.com/*"],
      excludedSitePatterns: ["https://api.example.com/private/*"],
      resourceTypes: ["xmlhttprequest"],
      priority: 5
    },
    {
      id: 3,
      enabled: false,
      name: "隐藏服务器标识",
      headerChanges: [
        { direction: "response", operation: "remove", header: "Server", value: "" }
      ],
      matchType: "regex",
      sitePatterns: [],
      excludedSitePatterns: [],
      resourceTypes: [],
      priority: 1
    }
  ]
});

function clone(value) {
  return structuredClone(value);
}

async function sendExtensionMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    const error = new Error(response?.error?.message || "扩展后台没有响应");
    error.field = response?.error?.field || "";
    throw error;
  }
  return response;
}

export async function loadState() {
  if (IS_EXTENSION) {
    return sendExtensionMessage({ type: "GET_STATE" });
  }
  return {
    state: clone(demoState),
    dynamicRuleCount: compileDynamicRules(demoState).length
  };
}

export async function saveState(candidate) {
  if (IS_EXTENSION) {
    return sendExtensionMessage({ type: "SAVE_STATE", state: candidate });
  }
  demoState = normalizeState(candidate);
  return {
    state: clone(demoState),
    dynamicRuleCount: compileDynamicRules(demoState).length
  };
}

export async function containsSiteAccess() {
  if (!IS_EXTENSION) {
    return demoHasSiteAccess;
  }
  return chrome.permissions.contains({ origins: SITE_ORIGINS });
}

export async function requestSiteAccess() {
  if (!IS_EXTENSION) {
    demoHasSiteAccess = true;
    return true;
  }
  return chrome.permissions.request({ origins: SITE_ORIGINS });
}

export async function revokeSiteAccess() {
  if (!IS_EXTENSION) {
    demoHasSiteAccess = false;
    return true;
  }
  return chrome.permissions.remove({ origins: SITE_ORIGINS });
}

export async function getCurrentTabInfo() {
  if (!IS_EXTENSION) {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("site") || "https://api.example.com/dashboard";
    return { title: new URL(url).hostname, url };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return {
    title: tab?.title || "当前页面",
    url: tab?.url || ""
  };
}

export async function openManager({ ruleId = null, initialPattern = "" } = {}) {
  const params = new URLSearchParams();
  if (ruleId !== null) {
    params.set("rule", String(ruleId));
  }
  if (initialPattern) {
    params.set("new", initialPattern);
  }

  if (IS_EXTENSION) {
    if (!params.size) {
      await chrome.runtime.openOptionsPage();
    } else {
      const suffix = params.size ? `?${params}` : "";
      await chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html${suffix}`) });
    }
    window.close();
    return;
  }
  window.location.href = `manager.html${params.size ? `?${params}` : ""}`;
}
