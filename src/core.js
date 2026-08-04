export const SCHEMA_VERSION = 4;
export const MAX_RULES = 1000;
export const MAX_PATTERNS_PER_RULE = 20;
export const MAX_HEADER_CHANGES_PER_RULE = 20;
export const MAX_COMPILED_RULES = 5000;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BODY_LENGTH = 1024 * 1024;

export const DIRECTIONS = Object.freeze(["request", "response"]);
export const OPERATIONS = Object.freeze(["set", "append", "remove"]);
export const MATCH_TYPES = Object.freeze(["wildcard", "regex", "dnr"]);
export const RESOURCE_TYPES = Object.freeze([
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "script",
  "stylesheet",
  "image",
  "font",
  "media",
  "websocket",
  "other"
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const WILDCARD_PATTERN = /^(\*|https?):\/\/([^/\s]+)(\/.*)?$/i;
const LIMITS = Object.freeze({
  name: 80,
  header: 256,
  value: 8192,
  pattern: 1024
});
const MAX_COMBINED_REGEX_LENGTH = 2048;

export class RuleValidationError extends Error {
  constructor(message, field = "") {
    super(message);
    this.name = "RuleValidationError";
    this.field = field;
  }
}

export function createDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    globalEnabled: true,
    nextRuleId: 1,
    rules: []
  };
}

export function createBlankRule(id, initialPattern = "") {
  return {
    id,
    enabled: true,
    name: "",
    headerChanges: [],
    matchType: "wildcard",
    sitePatterns: initialPattern ? [canonicalizeWildcardPattern(initialPattern)] : [],
    excludedSitePatterns: [],
    resourceTypes: [],
    priority: 1,
    responseStatus: null,
    responseBody: null
  };
}

export function createBlankHeaderChange() {
  return {
    direction: "request",
    operation: "set",
    header: "",
    value: ""
  };
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuleValidationError(`${field || "数据"}必须是对象`, field);
  }
  return value;
}

function requireString(value, field, maximum, { allowEmpty = true, trim = true } = {}) {
  if (typeof value !== "string") {
    throw new RuleValidationError(`${field}必须是文本`, field);
  }
  const normalized = trim ? value.trim() : value;
  if (!allowEmpty && !normalized) {
    throw new RuleValidationError(`请填写${field}`, field);
  }
  if (value.length > maximum) {
    throw new RuleValidationError(`${field}不能超过 ${maximum} 个字符`, field);
  }
  return normalized;
}

function requireInteger(value, field, minimum, maximum, errorField = field) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RuleValidationError(`${field}必须是 ${minimum} 到 ${maximum} 之间的整数`, errorField);
  }
  return value;
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function globSegmentToRegex(value, wildcardExpression) {
  let source = "";
  for (const character of value) {
    if (character === "*") {
      source += wildcardExpression;
    } else if (character === "?") {
      source += wildcardExpression === ".*" ? "." : "[^/]";
    } else {
      source += escapeRegex(character);
    }
  }
  return source;
}

export function canonicalizeWildcardPattern(input) {
  let pattern = requireString(input, "网址模式", LIMITS.pattern, { allowEmpty: false });
  if (pattern === "*") {
    return pattern;
  }
  if (!pattern.includes("://")) {
    pattern = `*://${pattern}`;
  }
  if (!pattern.slice(pattern.indexOf("://") + 3).includes("/")) {
    pattern += "/*";
  }

  const match = pattern.match(WILDCARD_PATTERN);
  if (!match) {
    throw new RuleValidationError(
      "通配符格式无效，例如 *://*.example.com/*",
      "sitePatterns"
    );
  }
  return `${match[1].toLowerCase()}://${match[2]}${match[3] || "/*"}`;
}

export function wildcardToRegexSource(input) {
  const pattern = canonicalizeWildcardPattern(input);
  if (pattern === "*") {
    return "^https?://.*$";
  }

  const [, scheme, authority, path = "/*"] = pattern.match(WILDCARD_PATTERN);
  const schemeSource = scheme === "*" ? "https?" : escapeRegex(scheme.toLowerCase());
  let authoritySource;
  if (authority.startsWith("*.")) {
    authoritySource = `(?:[^./]+\\.)*${globSegmentToRegex(authority.slice(2), "[^/]*")}`;
  } else {
    authoritySource = globSegmentToRegex(authority, "[^/]*");
  }
  const pathSource = globSegmentToRegex(path, ".*");
  return `^${schemeSource}://${authoritySource}${pathSource}$`;
}

function validateRegex(pattern, field) {
  try {
    new RegExp(pattern);
  } catch {
    throw new RuleValidationError("正则表达式语法无效", field);
  }
}

function normalizePatterns(value, matchType, field) {
  if (!Array.isArray(value)) {
    throw new RuleValidationError(`${field === "sitePatterns" ? "网址模式" : "排除模式"}必须是数组`, field);
  }
  if (value.length > MAX_PATTERNS_PER_RULE) {
    throw new RuleValidationError(`每条规则最多支持 ${MAX_PATTERNS_PER_RULE} 个网址模式`, field);
  }

  const normalized = value.map((pattern) => {
    const text = requireString(pattern, "网址模式", LIMITS.pattern, { allowEmpty: false });
    if (matchType === "wildcard") {
      return canonicalizeWildcardPattern(text);
    }
    if (matchType === "regex") {
      validateRegex(text, field);
    }
    return text;
  });
  return [...new Set(normalized)];
}

function legacyFields(rule) {
  const hasLegacyFilter = typeof rule.urlFilter === "string" && rule.urlFilter.trim();
  const hasLegacyExclusion = typeof rule.excludedUrlFilter === "string" && rule.excludedUrlFilter.trim();
  return {
    matchType: hasLegacyFilter || hasLegacyExclusion ? "dnr" : "wildcard",
    sitePatterns: hasLegacyFilter ? [rule.urlFilter] : [],
    excludedSitePatterns: hasLegacyExclusion ? [rule.excludedUrlFilter] : []
  };
}

function normalizeHeaderChange(input, index) {
  const change = requireObject(input, `Header 修改项 ${index + 1}`);
  const direction = requireString(change.direction ?? "request", "修改对象", 16, {
    allowEmpty: false
  });
  const operation = requireString(change.operation ?? "set", "操作", 16, {
    allowEmpty: false
  });
  if (!DIRECTIONS.includes(direction)) {
    throw new RuleValidationError(`第 ${index + 1} 项的修改对象无效`, "headerChanges");
  }
  if (!OPERATIONS.includes(operation)) {
    throw new RuleValidationError(`第 ${index + 1} 项的操作无效`, "headerChanges");
  }

  const header = requireString(change.header ?? "", "Header 名称", LIMITS.header, {
    allowEmpty: false
  });
  if (!HEADER_NAME_PATTERN.test(header)) {
    throw new RuleValidationError(`第 ${index + 1} 项的 Header 名称包含无效字符`, "headerChanges");
  }
  const value = requireString(change.value ?? "", "Header 值", LIMITS.value, {
    allowEmpty: operation === "remove",
    trim: false
  });
  if (operation !== "remove" && /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
    throw new RuleValidationError(
      `第 ${index + 1} 项的 Header 值不能包含换行或控制字符`,
      "headerChanges"
    );
  }
  return {
    direction,
    operation,
    header,
    value: operation === "remove" ? "" : value
  };
}

function normalizeHeaderChanges(rule) {
  const legacyChange = {
    direction: rule.direction ?? "request",
    operation: rule.operation ?? "set",
    header: rule.header ?? "",
    value: rule.value ?? ""
  };
  const hasLegacyHeaderFields = ["direction", "operation", "header", "value"]
    .some((field) => field in rule);
  const source = rule.headerChanges ?? (hasLegacyHeaderFields ? [legacyChange] : []);
  if (!Array.isArray(source)) {
    throw new RuleValidationError("Header 修改项必须是数组", "headerChanges");
  }
  if (!source.length) {
    return [];
  }
  if (source.length > MAX_HEADER_CHANGES_PER_RULE) {
    throw new RuleValidationError(
      `每条规则最多支持 ${MAX_HEADER_CHANGES_PER_RULE} 项 Header 修改`,
      "headerChanges"
    );
  }

  const changes = source.map(normalizeHeaderChange);
  const seenHeaders = new Map();
  for (const [index, change] of changes.entries()) {
    const key = `${change.direction}:${change.header.toLocaleLowerCase()}`;
    if (seenHeaders.has(key)) {
      throw new RuleValidationError(
        `第 ${index + 1} 项与第 ${seenHeaders.get(key) + 1} 项重复修改同一 Header`,
        "headerChanges"
      );
    }
    seenHeaders.set(key, index);
  }
  return changes;
}

function normalizeRule(input, fallbackId) {
  const rule = requireObject(input, "规则");
  const id = requireInteger(rule.id ?? fallbackId, "规则 ID", 1, 2_147_483_647);
  const headerChanges = normalizeHeaderChanges(rule);

  const legacy = legacyFields(rule);
  const matchType = requireString(rule.matchType ?? legacy.matchType, "匹配方式", 16, {
    allowEmpty: false
  });
  if (!MATCH_TYPES.includes(matchType)) {
    throw new RuleValidationError("匹配方式无效", "matchType");
  }

  const sitePatterns = normalizePatterns(
    rule.sitePatterns ?? legacy.sitePatterns,
    matchType,
    "sitePatterns"
  );
  const excludedSitePatterns = normalizePatterns(
    rule.excludedSitePatterns ?? legacy.excludedSitePatterns,
    matchType,
    "excludedSitePatterns"
  );
  if (matchType === "dnr" && excludedSitePatterns.length > 1) {
    throw new RuleValidationError("旧版 DNR 匹配最多支持一个排除模式", "excludedSitePatterns");
  }

  const resourceTypes = rule.resourceTypes ?? [];
  if (!Array.isArray(resourceTypes)) {
    throw new RuleValidationError("资源类型必须是数组", "resourceTypes");
  }
  const uniqueResourceTypes = [...new Set(resourceTypes)];
  if (uniqueResourceTypes.some((type) => !RESOURCE_TYPES.includes(type))) {
    throw new RuleValidationError("包含不支持的资源类型", "resourceTypes");
  }

  const responseStatusValue = rule.responseStatus;
  const responseStatus = responseStatusValue === undefined
    || responseStatusValue === null
    || responseStatusValue === ""
    ? null
    : requireInteger(responseStatusValue, "HTTP 状态码", 200, 599, "responseStatus");
  const responseBody = rule.responseBody === undefined || rule.responseBody === null
    ? null
    : requireString(rule.responseBody, "响应 Body", MAX_RESPONSE_BODY_LENGTH, { trim: false });
  if ([204, 205, 304].includes(responseStatus) && responseBody !== null && responseBody.length) {
    throw new RuleValidationError("204、205 和 304 响应不能包含非空 Body", "responseBody");
  }

  return {
    id,
    enabled: rule.enabled !== false,
    name: requireString(rule.name ?? "", "规则名称", LIMITS.name),
    headerChanges,
    matchType,
    sitePatterns,
    excludedSitePatterns,
    resourceTypes: uniqueResourceTypes,
    priority: requireInteger(rule.priority ?? 1, "优先级", 1, 1_000_000),
    responseStatus,
    responseBody
  };
}

export function normalizeState(input, { reassignIds = false } = {}) {
  const source = requireObject(input, "配置");
  const schemaVersion = source.schemaVersion ?? 1;
  if (![1, 2, 3, SCHEMA_VERSION].includes(schemaVersion)) {
    throw new RuleValidationError(`不支持的配置版本：${schemaVersion}`, "schemaVersion");
  }
  if (!Array.isArray(source.rules)) {
    throw new RuleValidationError("规则列表必须是数组", "rules");
  }
  if (source.rules.length > MAX_RULES) {
    throw new RuleValidationError(`最多支持 ${MAX_RULES} 条规则`, "rules");
  }

  const rules = source.rules.map((rule, index) => {
    const candidate = reassignIds ? { ...requireObject(rule, "规则"), id: index + 1 } : rule;
    return normalizeRule(candidate, index + 1);
  });
  const ids = new Set(rules.map((rule) => rule.id));
  if (ids.size !== rules.length) {
    throw new RuleValidationError("规则 ID 不能重复", "rules");
  }

  const highestId = rules.reduce((maximum, rule) => Math.max(maximum, rule.id), 0);
  let nextRuleId = reassignIds ? rules.length + 1 : source.nextRuleId ?? highestId + 1;
  nextRuleId = requireInteger(nextRuleId, "下一个规则 ID", 1, 2_147_483_647);
  if (nextRuleId <= highestId) {
    nextRuleId = highestId + 1;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    globalEnabled: source.globalEnabled !== false,
    nextRuleId,
    rules
  };
}

function combineExcludedRegex(rule) {
  if (!rule.excludedSitePatterns.length || rule.matchType === "dnr") {
    return "";
  }
  const sources = rule.excludedSitePatterns.map((pattern) =>
    rule.matchType === "wildcard" ? wildcardToRegexSource(pattern) : pattern
  );
  const combined = sources.length === 1 ? sources[0] : sources.map((source) => `(?:${source})`).join("|");
  if (combined.length > MAX_COMBINED_REGEX_LENGTH) {
    throw new RuleValidationError(
      `排除模式编译后不能超过 ${MAX_COMBINED_REGEX_LENGTH} 个字符`,
      "excludedSitePatterns"
    );
  }
  return combined;
}

export function collectRegexFiltersForValidation(input) {
  const state = normalizeState(input);
  if (!state.globalEnabled) {
    return [];
  }
  const regexes = new Set();
  for (const rule of state.rules) {
    if (!rule.enabled || !rule.headerChanges.length || rule.matchType !== "regex") {
      continue;
    }
    for (const pattern of rule.sitePatterns) {
      regexes.add(pattern);
    }
    const excluded = combineExcludedRegex(rule);
    if (excluded) {
      regexes.add(excluded);
    }
  }
  return [...regexes];
}

function createCondition(rule, pattern) {
  const condition = {};
  if (rule.matchType === "dnr") {
    if (pattern) {
      condition.urlFilter = pattern;
    }
    if (rule.excludedSitePatterns[0]) {
      condition.excludedUrlFilter = rule.excludedSitePatterns[0];
    }
  } else {
    if (pattern) {
      condition.regexFilter = rule.matchType === "wildcard" ? wildcardToRegexSource(pattern) : pattern;
    }
    const excludedRegexFilter = combineExcludedRegex(rule);
    if (excludedRegexFilter) {
      condition.excludedRegexFilter = excludedRegexFilter;
    }
    if (condition.regexFilter || condition.excludedRegexFilter) {
      condition.isUrlFilterCaseSensitive = false;
    }
  }
  if (rule.resourceTypes.length) {
    condition.resourceTypes = rule.resourceTypes;
  }
  return condition;
}

export function compileDynamicRules(input) {
  const state = normalizeState(input);
  if (!state.globalEnabled) {
    return [];
  }

  const dynamicRules = [];
  for (const rule of state.rules.filter((candidate) => candidate.enabled)) {
    if (!rule.headerChanges.length) {
      continue;
    }
    const patterns = rule.sitePatterns.length ? rule.sitePatterns : [""];
    for (const pattern of patterns) {
      if (dynamicRules.length >= MAX_COMPILED_RULES) {
        throw new RuleValidationError(
          `启用的网址模式总数不能超过 ${MAX_COMPILED_RULES}`,
          "sitePatterns"
        );
      }
      const action = { type: "modifyHeaders" };
      const requestHeaders = [];
      const responseHeaders = [];
      for (const change of rule.headerChanges) {
        const compiledChange = { header: change.header, operation: change.operation };
        if (change.operation !== "remove") {
          compiledChange.value = change.value;
        }
        (change.direction === "request" ? requestHeaders : responseHeaders).push(compiledChange);
      }
      if (requestHeaders.length) action.requestHeaders = requestHeaders;
      if (responseHeaders.length) action.responseHeaders = responseHeaders;
      dynamicRules.push({
        id: dynamicRules.length + 1,
        priority: rule.priority,
        action,
        condition: createCondition(rule, pattern)
      });
    }
  }
  return dynamicRules;
}

export function compileResponseRules(input) {
  const state = normalizeState(input);
  if (!state.globalEnabled) {
    return [];
  }
  return state.rules
    .filter((rule) => rule.enabled && (rule.responseStatus !== null || rule.responseBody !== null))
    .map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      matchType: rule.matchType,
      sitePatterns: rule.sitePatterns,
      excludedSitePatterns: rule.excludedSitePatterns,
      resourceTypes: rule.resourceTypes,
      responseStatus: rule.responseStatus,
      responseBody: rule.responseBody
    }));
}

function legacyDnrFilterToRegex(filter) {
  if (!filter) {
    return "^https?://.*$";
  }
  if (filter.startsWith("||")) {
    const domain = filter.slice(2).split(/[\^/]/, 1)[0];
    return `^https?://(?:[^/]+\\.)?${escapeRegex(domain)}(?:[/:?].*)?$`;
  }
  const anchoredStart = filter.startsWith("|");
  const anchoredEnd = filter.endsWith("|") && !filter.endsWith("||");
  const body = filter.replace(/^\|/, "").replace(/\|$/, "");
  const source = globSegmentToRegex(body, ".*").replace(/\\\^/g, "(?:[^A-Za-z0-9_.%-]|$)");
  return `${anchoredStart ? "^" : ".*"}${source}${anchoredEnd ? "$" : ".*"}`;
}

function patternMatchesUrl(matchType, pattern, url) {
  try {
    const source = matchType === "wildcard"
      ? wildcardToRegexSource(pattern)
      : matchType === "dnr"
        ? legacyDnrFilterToRegex(pattern)
        : pattern;
    return new RegExp(source, "i").test(url);
  } catch {
    return false;
  }
}

export function isSupportedPageUrl(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function ruleMatchesUrl(input, url) {
  if (!isSupportedPageUrl(url)) {
    return false;
  }
  const rule = normalizeRule(input, input?.id ?? 1);
  const included = !rule.sitePatterns.length
    || rule.sitePatterns.some((pattern) => patternMatchesUrl(rule.matchType, pattern, url));
  if (!included) {
    return false;
  }
  return !rule.excludedSitePatterns.some((pattern) => patternMatchesUrl(rule.matchType, pattern, url));
}

export function patternForUrl(url) {
  if (!isSupportedPageUrl(url)) {
    return "";
  }
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/*`;
}

export function summarizeRuleSites(input) {
  const rule = normalizeRule(input, input?.id ?? 1);
  if (!rule.sitePatterns.length) {
    return "所有已授权网站";
  }
  const first = rule.sitePatterns[0];
  return rule.sitePatterns.length === 1 ? first : `${first} 等 ${rule.sitePatterns.length} 个模式`;
}

export function summarizeHeaderChanges(input) {
  const rule = normalizeRule(input, input?.id ?? 1);
  if (!rule.headerChanges.length) {
    const overrides = [
      rule.responseStatus === null ? "" : `HTTP ${rule.responseStatus}`,
      rule.responseBody === null ? "" : "响应 Body"
    ].filter(Boolean);
    return overrides.join(" + ") || "无修改";
  }
  const first = rule.headerChanges[0];
  const direction = first.direction === "request" ? "请求" : "响应";
  const operation = first.operation === "set" ? "设置" : first.operation === "append" ? "追加" : "移除";
  const summary = `${direction} · ${operation} ${first.header}`;
  return rule.headerChanges.length === 1 ? summary : `${summary} 等 ${rule.headerChanges.length} 项`;
}

export function importState(text) {
  if (typeof text !== "string") {
    throw new RuleValidationError("导入内容必须是 JSON 文本", "import");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RuleValidationError("JSON 格式无效", "import");
  }
  return normalizeState(parsed, { reassignIds: true });
}

export function exportState(input) {
  return JSON.stringify(normalizeState(input), null, 2);
}
