import {
  MAX_IMPORT_BYTES,
  MAX_RULES,
  RuleValidationError,
  createBlankRule,
  exportState,
  formatSitePatternSpec,
  importState,
  normalizeState,
  summarizeRuleSites
} from "./core.js";
import {
  containsSiteAccess,
  loadState,
  requestSiteAccess,
  revokeSiteAccess,
  saveState
} from "./client.js";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "host",
  "origin",
  "referer",
  "content-security-policy",
  "access-control-allow-origin",
  "access-control-allow-credentials"
]);
const operationLabels = Object.freeze({ set: "设置", append: "追加", remove: "移除" });

const elements = Object.fromEntries([
  "permissionButton", "importButton", "exportButton", "globalToggle", "pausedBanner",
  "listPanel", "ruleCount", "addRuleButton", "searchInput", "rulesList", "listEmpty",
  "listEmptyTitle", "listEmptyText", "editorEmpty", "editorView", "editorTitle",
  "editorSubtitle", "mobileBackButton", "editorDeleteButton", "ruleForm", "formError",
  "ruleName", "headerChangesList", "addHeaderChangeButton", "headerChangesCount", "sensitiveWarning",
  "responseStatus", "responseBodyEnabled", "responseBody",
  "matchDnrLabel", "matchTypeHelp", "sitePatterns", "patternCount",
  "excludedSitePatterns", "allResources", "resourceTypeGrid", "allRequestMethods", "requestMethodGrid", "priority", "ruleEnabled",
  "cancelEditButton", "saveRuleButton", "deleteDialog", "deleteDialogText", "importDialog",
  "importForm", "importSummary", "importFileInput", "toast"
].map((id) => [id, document.getElementById(id)]));

let state;
let hasSiteAccess = false;
let currentFilter = "all";
let editingRuleId = null;
let selectedRuleId = null;
let pendingDeleteId = null;
let pendingImportState = null;
let dirty = false;
let suppressDirty = false;
let toastTimer = 0;
let previousMatchType = "wildcard";

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

function clone(value) {
  return structuredClone(value);
}

function showToast(message, { error = false } = {}) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 2800);
}

function setRadioValue(name, value) {
  const input = elements.ruleForm.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function getRadioValue(name) {
  return elements.ruleForm.querySelector(`input[name="${name}"]:checked`)?.value || "";
}

function patternLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function ruleMatchesSearch(rule, query) {
  if (!query) return true;
  return [
    rule.name,
    ...rule.headerChanges.flatMap((change) => [change.header, operationLabels[change.operation]]),
    rule.responseStatus === null ? "" : String(rule.responseStatus),
    rule.responseBody ?? "",
    ...(rule.requestMethods ?? []),
    ...rule.sitePatterns.map((pattern, index) =>
      formatSitePatternSpec(pattern, rule.sitePatternMethods?.[index])
    ),
    ...rule.excludedSitePatterns
  ].join(" ").toLocaleLowerCase().includes(query);
}

function createRuleRow(rule) {
  const row = createElement(
    "article",
    `rule-row${rule.enabled ? "" : " disabled"}${rule.id === selectedRuleId ? " active" : ""}`
  );
  row.dataset.ruleId = String(rule.id);

  const switchLabel = createElement("label", "switch-control rule-toggle");
  switchLabel.title = rule.enabled ? "停用规则" : "启用规则";
  const primaryHeader = rule.headerChanges[0]?.header || "响应覆盖";
  const displayName = rule.name || primaryHeader;
  const switchText = createElement("span", "sr-only", `${rule.enabled ? "停用" : "启用"}${displayName}`);
  const switchInput = document.createElement("input");
  switchInput.type = "checkbox";
  switchInput.checked = rule.enabled;
  switchInput.setAttribute("role", "switch");
  switchInput.dataset.action = "toggle";
  switchInput.dataset.ruleId = String(rule.id);
  const switchTrack = createElement("span", "switch-track");
  switchTrack.setAttribute("aria-hidden", "true");
  switchLabel.append(switchText, switchInput, switchTrack);

  const main = createElement("button", "rule-main");
  main.type = "button";
  main.dataset.action = "edit";
  main.dataset.ruleId = String(rule.id);
  main.setAttribute("aria-label", `编辑规则：${displayName}`);
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
  const requestMethods = rule.requestMethods ?? [];
  const methodSummary = requestMethods.length ? ` · ${requestMethods.join("/")}` : "";
  const changeSummary = firstChange
    ? `${operationLabels[firstChange.operation]} ${firstChange.header}`
      + (rule.headerChanges.length > 1 ? ` 等 ${rule.headerChanges.length} 项` : "")
    : responseSummary || "无修改";
  summary.append(direction, document.createTextNode(`${changeSummary}${methodSummary}`));
  const sites = createElement("span", "rule-sites", summarizeRuleSites(rule));
  main.append(title, summary, sites);

  const duplicate = createElement("button", "icon-button");
  duplicate.type = "button";
  duplicate.dataset.action = "duplicate";
  duplicate.dataset.ruleId = String(rule.id);
  duplicate.setAttribute("aria-label", `复制规则：${displayName}`);
  duplicate.title = "复制规则";
  duplicate.append(createIcon("copy"));

  const remove = createElement("button", "icon-button danger");
  remove.type = "button";
  remove.dataset.action = "delete";
  remove.dataset.ruleId = String(rule.id);
  remove.setAttribute("aria-label", `删除规则：${displayName}`);
  remove.title = "删除规则";
  remove.append(createIcon("trash"));
  row.append(switchLabel, main, duplicate, remove);
  return row;
}

function renderList() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase();
  const filtered = state.rules.filter((rule) => {
    const directionMatches = currentFilter === "all"
      || rule.headerChanges.some((change) => change.direction === currentFilter);
    return directionMatches && ruleMatchesSearch(rule, query);
  });
  elements.ruleCount.textContent = `${state.rules.length} 条规则`;
  elements.rulesList.replaceChildren(...filtered.map(createRuleRow));
  elements.rulesList.hidden = filtered.length === 0;
  elements.listEmpty.hidden = filtered.length > 0;
  if (!state.rules.length) {
    elements.listEmptyTitle.textContent = "还没有规则";
    elements.listEmptyText.textContent = "新建一条规则开始配置。";
  } else if (!filtered.length) {
    elements.listEmptyTitle.textContent = "没有匹配的规则";
    elements.listEmptyText.textContent = "调整搜索词或筛选条件。";
  }
}

function renderPermission() {
  const label = elements.permissionButton.querySelector("span");
  label.textContent = hasSiteAccess ? "网站权限已授权" : "授权网站权限";
  elements.permissionButton.classList.toggle("primary", !hasSiteAccess);
  elements.permissionButton.classList.toggle("secondary", hasSiteAccess);
  elements.permissionButton.title = hasSiteAccess ? "点击可撤销 HTTP/HTTPS 网站权限" : "允许规则作用于 HTTP/HTTPS 网站";
}

function render() {
  elements.globalToggle.checked = state.globalEnabled;
  elements.globalToggle.disabled = false;
  elements.pausedBanner.hidden = state.globalEnabled;
  renderPermission();
  renderList();
}

async function persist(candidate, message = "") {
  const response = await saveState(candidate);
  state = response.state;
  if (selectedRuleId !== null && !state.rules.some((rule) => rule.id === selectedRuleId)) {
    closeEditor({ force: true });
  }
  render();
  if (message) showToast(message);
  return response;
}

function clearFormErrors() {
  elements.formError.hidden = true;
  elements.formError.textContent = "";
  for (const error of elements.ruleForm.querySelectorAll(".field-error")) {
    error.textContent = "";
    error.closest(".field-group")?.classList.remove("has-error");
  }
  for (const row of elements.headerChangesList.querySelectorAll(".header-change-row")) {
    row.classList.remove("has-error");
  }
}

function showFormError(error) {
  clearFormErrors();
  const field = typeof error?.field === "string" ? error.field : "";
  const fieldError = field ? elements.ruleForm.querySelector(`[data-error-for="${CSS.escape(field)}"]`) : null;
  if (fieldError) {
    fieldError.textContent = error.message;
    fieldError.closest(".field-group")?.classList.add("has-error");
    if (field === "headerChanges") {
      elements.headerChangesList.firstElementChild?.classList.add("has-error");
    }
    const input = field === "headerChanges"
      ? elements.headerChangesList.querySelector(".change-header")
      : elements.ruleForm.querySelector(`[name="${CSS.escape(field)}"]`);
    input?.focus();
    return;
  }
  elements.formError.textContent = error?.message || "无法保存规则";
  elements.formError.hidden = false;
  elements.formError.scrollIntoView({ block: "nearest" });
}

function updateSensitiveWarning() {
  const hasSensitiveHeader = [...elements.headerChangesList.querySelectorAll(".change-header")]
    .some((input) => SENSITIVE_HEADERS.has(input.value.trim().toLocaleLowerCase()));
  elements.sensitiveWarning.hidden = !hasSensitiveHeader;
}

function createSelect(options, value, className, ariaLabel) {
  const select = document.createElement("select");
  select.className = className;
  select.setAttribute("aria-label", ariaLabel);
  for (const [optionValue, label] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    option.selected = optionValue === value;
    select.append(option);
  }
  return select;
}

function syncHeaderChangeRow(row) {
  const remove = row.querySelector(".change-operation").value === "remove";
  const value = row.querySelector(".change-value");
  value.disabled = remove;
  if (remove) value.value = "";
  value.placeholder = remove ? "移除无需填写值" : "Header 值";
  row.classList.toggle("is-remove", remove);
}

function syncResponseOverrideFields() {
  elements.responseBody.disabled = !elements.responseBodyEnabled.checked;
}

function createHeaderChangeRow(change, index, total) {
  const row = createElement("div", "header-change-row");
  row.dataset.changeIndex = String(index);
  const indexLabel = createElement("span", "change-index", String(index + 1));
  indexLabel.setAttribute("aria-hidden", "true");
  const direction = createSelect(
    [["request", "请求头"], ["response", "响应头"]],
    change.direction,
    "change-direction",
    `第 ${index + 1} 项修改对象`
  );
  const operation = createSelect(
    [["set", "设置"], ["append", "追加"], ["remove", "移除"]],
    change.operation,
    "change-operation",
    `第 ${index + 1} 项操作`
  );
  const header = document.createElement("input");
  header.type = "text";
  header.className = "change-header";
  header.maxLength = 256;
  header.value = change.header;
  header.placeholder = "Header 名称";
  header.spellcheck = false;
  header.setAttribute("aria-label", `第 ${index + 1} 项 Header 名称`);
  const value = document.createElement("input");
  value.type = "text";
  value.className = "change-value";
  value.maxLength = 8192;
  value.value = change.value;
  value.spellcheck = false;
  value.setAttribute("aria-label", `第 ${index + 1} 项 Header 值`);
  const removeButton = createElement("button", "icon-button danger change-remove");
  removeButton.type = "button";
  removeButton.dataset.removeChange = "true";
  removeButton.setAttribute("aria-label", `删除第 ${index + 1} 项 Header 修改`);
  removeButton.title = total === 1 ? "至少保留一项 Header 修改" : "删除此 Header 修改";
  removeButton.disabled = total === 1;
  removeButton.append(createIcon("trash"));
  row.append(indexLabel, direction, operation, header, value, removeButton);
  syncHeaderChangeRow(row);
  return row;
}

function collectDraftHeaderChanges() {
  return [...elements.headerChangesList.querySelectorAll(".header-change-row")].map((row) => ({
    direction: row.querySelector(".change-direction").value,
    operation: row.querySelector(".change-operation").value,
    header: row.querySelector(".change-header").value,
    value: row.querySelector(".change-value").value
  }));
}

function renderHeaderChanges(changes) {
  elements.headerChangesList.replaceChildren(
    ...changes.map((change, index) => createHeaderChangeRow(change, index, changes.length))
  );
  elements.headerChangesCount.textContent = `${changes.length} 项`;
  updateSensitiveWarning();
}

function addHeaderChange() {
  const changes = collectDraftHeaderChanges();
  if (changes.length >= 20) {
    showToast("每条规则最多支持 20 项 Header 修改", { error: true });
    return;
  }
  changes.push({ direction: "request", operation: "set", header: "", value: "" });
  renderHeaderChanges(changes);
  elements.headerChangesList.lastElementChild?.querySelector(".change-header")?.focus();
  dirty = true;
}

function updatePatternCount() {
  const count = patternLines(elements.sitePatterns.value).length;
  elements.patternCount.textContent = count ? `${count} 个模式` : "0 个模式 · 所有网站";
}

function updateMatchTypeHelp() {
  const matchType = getRadioValue("matchType");
  if (matchType === "regex") {
    elements.matchTypeHelp.textContent = "每行一个 Chrome RE2 正则表达式；不支持前后查找和反向引用。";
  } else if (matchType === "dnr") {
    elements.matchTypeHelp.textContent = "这是从 v1 迁移的 Chrome DNR urlFilter。建议改为通配符或正则。";
  } else {
    elements.matchTypeHelp.replaceChildren(
      document.createTextNode("使用 "),
      Object.assign(document.createElement("code"), { textContent: "*" }),
      document.createTextNode(" 匹配任意字符，例如 "),
      Object.assign(document.createElement("code"), { textContent: "*://*.example.com/*" }),
      document.createTextNode("。")
    );
  }
}

function updateResourceFields({ selectDefault = false } = {}) {
  const inputs = [...elements.resourceTypeGrid.querySelectorAll("input")];
  if (!elements.allResources.checked && selectDefault && !inputs.some((input) => input.checked)) {
    const xhr = inputs.find((input) => input.value === "xmlhttprequest");
    if (xhr) xhr.checked = true;
  }
  for (const input of inputs) {
    if (elements.allResources.checked) input.checked = false;
    input.disabled = elements.allResources.checked;
  }
  elements.resourceTypeGrid.classList.toggle("disabled", elements.allResources.checked);
}

function updateRequestMethodFields() {
  const inputs = [...elements.requestMethodGrid.querySelectorAll("input")];
  if (!elements.allRequestMethods.checked && !inputs.some((input) => input.checked)) {
    elements.allRequestMethods.checked = true;
  }
  for (const input of inputs) {
    if (elements.allRequestMethods.checked) input.checked = false;
    input.disabled = elements.allRequestMethods.checked;
  }
  elements.requestMethodGrid.classList.toggle("disabled", elements.allRequestMethods.checked);
}

function convertLegacyPattern(pattern) {
  const prefixMatch = pattern.match(/^(\[[^\]]+\]\s+)(.+)$/);
  const prefix = prefixMatch?.[1] || "";
  const rawPattern = prefixMatch?.[2] || pattern;
  const match = rawPattern.match(/^\|\|([^/^]+)(?:\/.*)?$/);
  return match ? `${prefix}*://*.${match[1]}/*` : pattern;
}

function handleMatchTypeChange() {
  const next = getRadioValue("matchType");
  if (previousMatchType === "dnr" && next === "wildcard") {
    elements.sitePatterns.value = patternLines(elements.sitePatterns.value).map(convertLegacyPattern).join("\n");
    elements.excludedSitePatterns.value = patternLines(elements.excludedSitePatterns.value).map(convertLegacyPattern).join("\n");
  }
  previousMatchType = next;
  updateMatchTypeHelp();
  updatePatternCount();
}

function fillEditor(rule) {
  suppressDirty = true;
  clearFormErrors();
  elements.ruleName.value = rule.name;
  renderHeaderChanges(rule.headerChanges);
  elements.responseStatus.value = rule.responseStatus === null ? "" : String(rule.responseStatus);
  elements.responseBodyEnabled.checked = rule.responseBody !== null;
  elements.responseBody.value = rule.responseBody ?? "";
  syncResponseOverrideFields();
  const legacy = rule.matchType === "dnr";
  const legacyInput = document.getElementById("matchDnr");
  legacyInput.hidden = !legacy;
  legacyInput.disabled = !legacy;
  elements.matchDnrLabel.hidden = !legacy;
  elements.matchDnrLabel.closest(".match-control").classList.toggle("legacy-visible", legacy);
  setRadioValue("matchType", rule.matchType);
  previousMatchType = rule.matchType;
  elements.sitePatterns.value = rule.sitePatterns.map((pattern, index) =>
    formatSitePatternSpec(pattern, rule.sitePatternMethods?.[index])
  ).join("\n");
  elements.excludedSitePatterns.value = rule.excludedSitePatterns.join("\n");
  elements.priority.value = String(rule.priority);
  elements.ruleEnabled.checked = rule.enabled;

  const resourceInputs = [...elements.resourceTypeGrid.querySelectorAll("input")];
  elements.allResources.checked = rule.resourceTypes.length === 0;
  for (const input of resourceInputs) input.checked = rule.resourceTypes.includes(input.value);
  const requestMethodInputs = [...elements.requestMethodGrid.querySelectorAll("input")];
  const requestMethods = rule.requestMethods ?? [];
  elements.allRequestMethods.checked = requestMethods.length === 0;
  for (const input of requestMethodInputs) input.checked = requestMethods.includes(input.value);
  const advanced = elements.ruleForm.querySelector(".advanced-panel");
  advanced.open = Boolean(
    rule.excludedSitePatterns.length
      || rule.resourceTypes.length
      || (rule.requestMethods ?? []).length
      || rule.priority !== 1
      || rule.responseStatus !== null
      || rule.responseBody !== null
  );
  updatePatternCount();
  updateMatchTypeHelp();
  updateResourceFields();
  updateRequestMethodFields();
  dirty = false;
  suppressDirty = false;
}

function updateEditorSubtitle(rule) {
  const rangeLabel = rule.sitePatterns.length ? `${rule.sitePatterns.length} 个网址模式` : "所有网站";
  const typeLabel = rule.matchType === "regex" ? "正则" : rule.matchType === "dnr" ? "旧版 DNR" : "通配符";
  const overrideLabel = [
    rule.responseStatus === null ? "" : `HTTP ${rule.responseStatus}`,
    rule.responseBody === null ? "" : "响应 Body"
  ].filter(Boolean).join(" + ");
  const changeLabel = rule.headerChanges.length
    ? `${rule.headerChanges.length} 项 Header 修改`
    : overrideLabel || "无 Header 修改";
  const requestMethods = rule.requestMethods ?? [];
  const methodLabel = requestMethods.length ? ` · ${requestMethods.join("/")}` : "";
  elements.editorSubtitle.textContent = `${changeLabel}${methodLabel} · ${rangeLabel} · ${typeLabel}`;
}

function confirmDiscard() {
  return !dirty || window.confirm("放弃未保存的更改？");
}

function openEditor(ruleId = null, initialPattern = "") {
  if (!confirmDiscard()) return;
  const existing = ruleId === null ? null : state.rules.find((rule) => rule.id === ruleId);
  if (ruleId !== null && !existing) {
    showToast("找不到这条规则", { error: true });
    return;
  }
  editingRuleId = ruleId;
  selectedRuleId = ruleId;
  const rule = existing ? clone(existing) : createBlankRule(state.nextRuleId, initialPattern);
  elements.editorTitle.textContent = existing ? "编辑规则" : "新建规则";
  elements.editorSubtitle.textContent = existing
    ? ""
    : "一条规则可以包含多项 Header 修改";
  if (existing) updateEditorSubtitle(rule);
  elements.editorDeleteButton.hidden = !existing;
  fillEditor(rule);
  elements.editorEmpty.hidden = true;
  elements.editorView.hidden = false;
  document.body.classList.add("editing");
  renderList();
  elements.ruleForm.scrollTop = 0;
  elements.editorTitle.focus();
}

function closeEditor({ force = false } = {}) {
  if (!force && !confirmDiscard()) return;
  editingRuleId = null;
  selectedRuleId = null;
  dirty = false;
  elements.editorView.hidden = true;
  elements.editorEmpty.hidden = false;
  document.body.classList.remove("editing");
  renderList();
}

function readEditorRule() {
  const resourceTypes = elements.allResources.checked
    ? []
    : [...elements.resourceTypeGrid.querySelectorAll("input:checked")].map((input) => input.value);
  const requestMethods = elements.allRequestMethods.checked
    ? []
    : [...elements.requestMethodGrid.querySelectorAll("input:checked")].map((input) => input.value);
  return {
    id: editingRuleId ?? state.nextRuleId,
    enabled: elements.ruleEnabled.checked,
    name: elements.ruleName.value,
    headerChanges: collectDraftHeaderChanges(),
    responseStatus: elements.responseStatus.value === "" ? null : Number(elements.responseStatus.value),
    responseBody: elements.responseBodyEnabled.checked ? elements.responseBody.value : null,
    matchType: getRadioValue("matchType"),
    sitePatterns: patternLines(elements.sitePatterns.value),
    excludedSitePatterns: patternLines(elements.excludedSitePatterns.value),
    resourceTypes,
    requestMethods,
    priority: Number(elements.priority.value)
  };
}

async function saveEditor() {
  clearFormErrors();
  elements.saveRuleButton.disabled = true;
  try {
    const rule = readEditorRule();
    const candidate = clone(state);
    if (editingRuleId === null) {
      candidate.rules.push(rule);
      candidate.nextRuleId = rule.id + 1;
    } else {
      const index = candidate.rules.findIndex((item) => item.id === editingRuleId);
      candidate.rules[index] = rule;
    }
    const normalized = normalizeState(candidate);
    const savedId = rule.id;
    await persist(normalized);
    editingRuleId = savedId;
    selectedRuleId = savedId;
    const saved = state.rules.find((item) => item.id === savedId);
    if (saved) {
      fillEditor(saved);
      updateEditorSubtitle(saved);
    }
    elements.editorTitle.textContent = "编辑规则";
    elements.editorDeleteButton.hidden = false;
    renderList();
    showToast("规则已保存");
  } catch (error) {
    showFormError(error);
  } finally {
    elements.saveRuleButton.disabled = false;
  }
}

function requestDelete(ruleId) {
  const rule = state.rules.find((item) => item.id === ruleId);
  if (!rule) return;
  pendingDeleteId = ruleId;
  elements.deleteDialogText.textContent = `删除“${rule.name || rule.headerChanges[0]?.header || "响应覆盖"}”？此操作无法撤销。`;
  elements.deleteDialog.returnValue = "";
  elements.deleteDialog.showModal();
}

async function deletePendingRule() {
  if (pendingDeleteId === null) return;
  const deletedId = pendingDeleteId;
  pendingDeleteId = null;
  const candidate = clone(state);
  candidate.rules = candidate.rules.filter((rule) => rule.id !== deletedId);
  try {
    await persist(candidate, "规则已删除");
    if (selectedRuleId === deletedId) closeEditor({ force: true });
  } catch (error) {
    showToast(error.message || "删除失败", { error: true });
  }
}

async function duplicateRule(ruleId) {
  const source = state.rules.find((rule) => rule.id === ruleId);
  if (!source) return;
  const candidate = clone(state);
  const index = candidate.rules.findIndex((rule) => rule.id === ruleId);
  const copyRule = {
    ...clone(source),
    id: candidate.nextRuleId,
    enabled: false,
    name: `${source.name || source.headerChanges[0]?.header || "响应覆盖"}（副本）`
  };
  candidate.nextRuleId += 1;
  candidate.rules.splice(index + 1, 0, copyRule);
  try {
    await persist(candidate, "已复制规则，副本保持停用");
    openEditor(copyRule.id);
  } catch (error) {
    showToast(error.message || "复制失败", { error: true });
  }
}

async function toggleRule(ruleId, enabled) {
  const candidate = clone(state);
  const rule = candidate.rules.find((item) => item.id === ruleId);
  if (!rule) return;
  rule.enabled = enabled;
  try {
    await persist(candidate, enabled ? "规则已启用" : "规则已停用");
    if (selectedRuleId === ruleId) elements.ruleEnabled.checked = enabled;
  } catch (error) {
    render();
    showToast(error.message || "规则更新失败", { error: true });
  }
}

function exportRules() {
  const blob = new Blob([exportState(state)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `nyamodifyheader-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${state.rules.length} 条规则`);
}

async function readImportFile(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) throw new RuleValidationError("规则文件不能超过 1 MB", "import");
  pendingImportState = importState(await file.text());
  elements.importSummary.textContent = `发现 ${pendingImportState.rules.length} 条有效规则。`;
  elements.importDialog.returnValue = "";
  elements.importDialog.showModal();
}

async function importPendingRules() {
  if (!pendingImportState) return;
  const mode = elements.importForm.querySelector('input[name="importMode"]:checked')?.value;
  let candidate;
  if (mode === "replace") {
    candidate = clone(pendingImportState);
  } else {
    if (state.rules.length + pendingImportState.rules.length > MAX_RULES) {
      throw new RuleValidationError(`导入后不能超过 ${MAX_RULES} 条规则`, "rules");
    }
    candidate = clone(state);
    let nextId = candidate.nextRuleId;
    const imported = pendingImportState.rules.map((rule) => ({ ...clone(rule), id: nextId++ }));
    candidate.rules.push(...imported);
    candidate.nextRuleId = nextId;
  }
  await persist(candidate, `已导入 ${pendingImportState.rules.length} 条规则`);
  pendingImportState = null;
  closeEditor({ force: true });
}

function setFilter(filter) {
  currentFilter = filter;
  for (const button of document.querySelectorAll(".filter-tab")) {
    const active = button.dataset.filter === filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  renderList();
}

function bindEvents() {
  elements.addRuleButton.addEventListener("click", () => openEditor());
  elements.mobileBackButton.addEventListener("click", () => closeEditor());
  elements.cancelEditButton.addEventListener("click", () => closeEditor());
  elements.editorDeleteButton.addEventListener("click", () => {
    if (editingRuleId !== null) requestDelete(editingRuleId);
  });
  elements.ruleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveEditor();
  });
  elements.ruleForm.addEventListener("input", () => {
    if (!suppressDirty) dirty = true;
  });
  elements.ruleForm.addEventListener("change", () => {
    if (!suppressDirty) dirty = true;
  });
  elements.sitePatterns.addEventListener("input", updatePatternCount);
  elements.addHeaderChangeButton.addEventListener("click", addHeaderChange);
  elements.responseBodyEnabled.addEventListener("change", syncResponseOverrideFields);
  elements.headerChangesList.addEventListener("input", updateSensitiveWarning);
  elements.headerChangesList.addEventListener("change", (event) => {
    const row = event.target.closest(".header-change-row");
    if (row && event.target.matches(".change-operation")) syncHeaderChangeRow(row);
    updateSensitiveWarning();
  });
  elements.headerChangesList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-remove-change]");
    if (!button) return;
    const row = button.closest(".header-change-row");
    const changes = collectDraftHeaderChanges();
    changes.splice(Number(row.dataset.changeIndex), 1);
    renderHeaderChanges(changes);
    dirty = true;
  });
  for (const input of elements.ruleForm.querySelectorAll('input[name="matchType"]')) {
    input.addEventListener("change", handleMatchTypeChange);
  }
  elements.allResources.addEventListener("change", () => updateResourceFields({ selectDefault: true }));
  elements.resourceTypeGrid.addEventListener("change", () => {
    const inputs = [...elements.resourceTypeGrid.querySelectorAll("input")];
    if (!inputs.some((input) => input.checked)) {
      elements.allResources.checked = true;
      updateResourceFields();
    }
  });
  elements.allRequestMethods.addEventListener("change", updateRequestMethodFields);
  elements.requestMethodGrid.addEventListener("change", updateRequestMethodFields);

  elements.rulesList.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || target.dataset.action === "toggle") return;
    const ruleId = Number(target.dataset.ruleId);
    if (target.dataset.action === "edit") openEditor(ruleId);
    if (target.dataset.action === "duplicate") duplicateRule(ruleId);
    if (target.dataset.action === "delete") requestDelete(ruleId);
  });
  elements.rulesList.addEventListener("change", (event) => {
    if (event.target.matches('[data-action="toggle"]')) {
      toggleRule(Number(event.target.dataset.ruleId), event.target.checked);
    }
  });
  elements.searchInput.addEventListener("input", renderList);
  for (const button of document.querySelectorAll(".filter-tab")) {
    button.addEventListener("click", () => setFilter(button.dataset.filter));
  }

  elements.globalToggle.addEventListener("change", async () => {
    const candidate = clone(state);
    candidate.globalEnabled = elements.globalToggle.checked;
    try {
      await persist(candidate, candidate.globalEnabled ? "全部规则已启用" : "全部规则已暂停");
    } catch (error) {
      render();
      showToast(error.message || "总开关更新失败", { error: true });
    }
  });

  elements.permissionButton.addEventListener("click", async () => {
    try {
      if (hasSiteAccess) {
        if (!window.confirm("撤销 HTTP/HTTPS 网站访问权限？规则会保留，但不会再生效。")) return;
        const removed = await revokeSiteAccess();
        if (removed) hasSiteAccess = false;
        showToast(removed ? "网站权限已撤销" : "网站权限未改变");
      } else {
        const granted = await requestSiteAccess();
        hasSiteAccess = granted && await containsSiteAccess();
        showToast(granted ? "网站权限已授予" : "未授予网站权限", { error: !granted });
      }
      renderPermission();
    } catch (error) {
      showToast(error.message || "网站权限操作失败", { error: true });
    }
  });

  elements.importButton.addEventListener("click", () => elements.importFileInput.click());
  elements.exportButton.addEventListener("click", exportRules);
  elements.importFileInput.addEventListener("change", async () => {
    try {
      await readImportFile(elements.importFileInput.files?.[0]);
    } catch (error) {
      showToast(error.message || "无法读取规则文件", { error: true });
    } finally {
      elements.importFileInput.value = "";
    }
  });
  elements.importDialog.addEventListener("close", async () => {
    if (elements.importDialog.returnValue !== "confirm") {
      pendingImportState = null;
      return;
    }
    try {
      await importPendingRules();
    } catch (error) {
      showToast(error.message || "导入失败", { error: true });
      pendingImportState = null;
    }
  });
  elements.deleteDialog.addEventListener("close", () => {
    if (elements.deleteDialog.returnValue === "confirm") deletePendingRule();
    else pendingDeleteId = null;
  });

  window.addEventListener("beforeunload", (event) => {
    if (dirty) event.preventDefault();
  });
  document.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "n") {
      event.preventDefault();
      openEditor();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "s" && !elements.editorView.hidden) {
      event.preventDefault();
      saveEditor();
    } else if (event.key === "Escape" && !elements.editorView.hidden) {
      event.preventDefault();
      closeEditor();
    }
  });
}

function openInitialRoute() {
  const params = new URLSearchParams(window.location.search);
  const initialPattern = params.get("new");
  const ruleId = Number(params.get("rule"));
  if (initialPattern) {
    openEditor(null, initialPattern);
  } else if (Number.isInteger(ruleId) && state.rules.some((rule) => rule.id === ruleId)) {
    openEditor(ruleId);
  } else if (state.rules.length) {
    openEditor(state.rules[0].id);
  }
}

async function initialize() {
  bindEvents();
  try {
    const [stateResponse, permission] = await Promise.all([loadState(), containsSiteAccess()]);
    state = stateResponse.state;
    hasSiteAccess = permission;
    render();
    openInitialRoute();
  } catch (error) {
    elements.ruleCount.textContent = "无法读取规则";
    elements.globalToggle.disabled = true;
    showToast(error.message || "管理页初始化失败", { error: true });
  }
}

initialize();
