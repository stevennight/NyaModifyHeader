import {
  isSupportedPageUrl,
  patternForUrl,
  ruleMatchesUrl,
  summarizeRuleSites
} from "./core.js";
import {
  containsSiteAccess,
  getCurrentTabInfo,
  loadState,
  openManager,
  requestSiteAccess,
  saveState
} from "./client.js";

const operationLabels = Object.freeze({ set: "设置", append: "追加", remove: "移除" });
const elements = Object.fromEntries([
  "siteName",
  "siteStatus",
  "globalToggle",
  "openManagerButton",
  "pausedBanner",
  "permissionBanner",
  "grantAccessButton",
  "unsupportedBanner",
  "matchedCount",
  "rulesList",
  "emptyState",
  "emptyTitle",
  "emptyText",
  "newSiteRuleButton",
  "manageAllButton",
  "toast"
].map((id) => [id, document.getElementById(id)]));

let state;
let currentTab = { title: "当前页面", url: "" };
let hasSiteAccess = false;
let toastTimer = 0;

function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function createIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

function showToast(message, { error = false } = {}) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 2500);
}

function currentSiteLabel() {
  try {
    return new URL(currentTab.url).host;
  } catch {
    return currentTab.title || "当前页面";
  }
}

function matchingRules() {
  if (!isSupportedPageUrl(currentTab.url)) return [];
  return state.rules.filter((rule) => ruleMatchesUrl(rule, currentTab.url));
}

function createRuleRow(rule) {
  const row = createElement("article", `rule-row${rule.enabled ? "" : " disabled"}`);
  const primaryHeader = rule.headerChanges[0]?.header || "响应覆盖";
  const displayName = rule.name || primaryHeader;
  const switchLabel = createElement("label", "switch-control rule-toggle");
  switchLabel.title = rule.enabled ? "停用规则" : "启用规则";
  const switchText = createElement("span", "sr-only", `${rule.enabled ? "停用" : "启用"}${displayName}`);
  const switchInput = document.createElement("input");
  switchInput.type = "checkbox";
  switchInput.checked = rule.enabled;
  switchInput.setAttribute("role", "switch");
  switchInput.dataset.ruleId = String(rule.id);
  const switchTrack = createElement("span", "switch-track");
  switchTrack.setAttribute("aria-hidden", "true");
  switchLabel.append(switchText, switchInput, switchTrack);

  const content = createElement("div", "rule-content");
  const title = createElement("span", "rule-title", displayName);
  const summary = createElement("span", "rule-summary");
  const directions = new Set(rule.headerChanges.map((change) => change.direction));
  const direction = createElement(
    "span",
    `direction${directions.size === 1 && directions.has("response") ? " response" : ""}`,
    !rule.headerChanges.length ? "响应" : directions.size === 1 ? (directions.has("request") ? "请求" : "响应") : "多项"
  );
  const firstChange = rule.headerChanges[0];
  const responseSummary = [
    rule.responseStatus === null ? "" : `HTTP ${rule.responseStatus}`,
    rule.responseBody === null ? "" : "响应 Body"
  ].filter(Boolean).join(" + ");
  const changeSummary = firstChange
    ? `${operationLabels[firstChange.operation]} ${firstChange.header}`
      + (rule.headerChanges.length > 1 ? ` 等 ${rule.headerChanges.length} 项` : "")
    : responseSummary || "无修改";
  summary.append(direction, document.createTextNode(changeSummary));
  const sites = createElement("span", "rule-sites", summarizeRuleSites(rule));
  content.append(title, summary, sites);

  const openButton = createElement("button", "icon-button");
  openButton.type = "button";
  openButton.dataset.openRule = String(rule.id);
  openButton.setAttribute("aria-label", `在管理页打开：${displayName}`);
  openButton.title = "在管理页编辑";
  openButton.append(createIcon("external-link"));
  row.append(switchLabel, content, openButton);
  return row;
}

function render() {
  const supported = isSupportedPageUrl(currentTab.url);
  const rules = matchingRules();
  elements.siteName.textContent = supported ? currentSiteLabel() : "当前页面不可修改";
  elements.siteStatus.textContent = supported ? `${rules.length} 条相关规则` : "Chrome 受保护页面";
  elements.globalToggle.checked = state.globalEnabled;
  elements.globalToggle.disabled = false;
  elements.pausedBanner.hidden = state.globalEnabled;
  elements.permissionBanner.hidden = hasSiteAccess || !supported;
  elements.unsupportedBanner.hidden = supported;
  elements.newSiteRuleButton.disabled = !supported;
  elements.matchedCount.textContent = `${rules.length} 条`;
  elements.rulesList.replaceChildren(...rules.map(createRuleRow));
  elements.rulesList.hidden = rules.length === 0;
  elements.emptyState.hidden = rules.length > 0;

  if (!supported) {
    elements.emptyTitle.textContent = "此页面没有可用规则";
    elements.emptyText.textContent = "请在普通 HTTP/HTTPS 页面打开扩展。";
  } else if (!rules.length) {
    elements.emptyTitle.textContent = "当前网站没有相关规则";
    elements.emptyText.textContent = "这里只显示网址模式匹配当前页面的规则。";
  }
}

async function persist(candidate, message) {
  const response = await saveState(candidate);
  state = response.state;
  render();
  showToast(message);
}

async function toggleRule(ruleId, enabled) {
  const candidate = structuredClone(state);
  const rule = candidate.rules.find((item) => item.id === ruleId);
  if (!rule) return;
  rule.enabled = enabled;
  try {
    await persist(candidate, enabled ? "规则已启用" : "规则已停用");
  } catch (error) {
    render();
    showToast(error.message || "规则更新失败", { error: true });
  }
}

function bindEvents() {
  elements.openManagerButton.addEventListener("click", () => openManager());
  elements.manageAllButton.addEventListener("click", () => openManager());
  elements.newSiteRuleButton.addEventListener("click", () =>
    openManager({ initialPattern: patternForUrl(currentTab.url) })
  );
  elements.grantAccessButton.addEventListener("click", async () => {
    try {
      const granted = await requestSiteAccess();
      hasSiteAccess = granted && await containsSiteAccess();
      render();
      showToast(granted ? "网站权限已授予" : "未授予网站权限", { error: !granted });
    } catch (error) {
      showToast(error.message || "无法申请网站权限", { error: true });
    }
  });
  elements.globalToggle.addEventListener("change", async () => {
    const candidate = structuredClone(state);
    candidate.globalEnabled = elements.globalToggle.checked;
    try {
      await persist(candidate, candidate.globalEnabled ? "全部规则已启用" : "全部规则已暂停");
    } catch (error) {
      render();
      showToast(error.message || "总开关更新失败", { error: true });
    }
  });
  elements.rulesList.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-rule-id]");
    if (input) toggleRule(Number(input.dataset.ruleId), input.checked);
  });
  elements.rulesList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-open-rule]");
    if (button) openManager({ ruleId: Number(button.dataset.openRule) });
  });
}

async function initialize() {
  bindEvents();
  try {
    const [stateResponse, permission, tab] = await Promise.all([
      loadState(),
      containsSiteAccess(),
      getCurrentTabInfo()
    ]);
    state = stateResponse.state;
    hasSiteAccess = permission;
    currentTab = tab;
    render();
  } catch (error) {
    elements.siteName.textContent = "扩展初始化失败";
    elements.siteStatus.textContent = error.message || "无法读取规则";
    elements.globalToggle.disabled = true;
    showToast(error.message || "扩展初始化失败", { error: true });
  }
}

initialize();
