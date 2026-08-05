import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_HEADER_CHANGES_PER_RULE,
  MAX_PATTERNS_PER_RULE,
  RuleValidationError,
  canonicalizeWildcardPattern,
  collectRegexFiltersForValidation,
  compileDynamicRules,
  compileResponseRules,
  createDefaultState,
  exportState,
  importState,
  normalizeState,
  patternForUrl,
  ruleMatchesUrl,
  wildcardToRegexSource
} from "../src/core.js";

function makeChange(overrides = {}) {
  return { direction: "request", operation: "set", header: "X-Debug", value: "1", ...overrides };
}

function makeRule(overrides = {}) {
  return {
    id: 1,
    enabled: true,
    name: "Debug API",
    headerChanges: [makeChange()],
    matchType: "wildcard",
    sitePatterns: ["https://*.example.com/*"],
    excludedSitePatterns: [],
    resourceTypes: ["xmlhttprequest"],
    priority: 10,
    ...overrides
  };
}

function makeState(rules = [makeRule()], overrides = {}) {
  return {
    schemaVersion: 5,
    globalEnabled: true,
    nextRuleId: Math.max(0, ...rules.map((rule) => rule.id)) + 1,
    rules,
    ...overrides
  };
}

test("default state uses schema v5", () => {
  assert.deepEqual(createDefaultState(), {
    schemaVersion: 5,
    globalEnabled: true,
    nextRuleId: 1,
    rules: []
  });
});

test("canonicalizes convenient wildcard shorthand", () => {
  assert.equal(canonicalizeWildcardPattern("example.com"), "*://example.com/*");
  assert.equal(canonicalizeWildcardPattern("*.example.com/api/*"), "*://*.example.com/api/*");
  assert.equal(canonicalizeWildcardPattern("*"), "*");
});

test("subdomain wildcard matches apex and nested subdomains", () => {
  const expression = new RegExp(wildcardToRegexSource("*://*.example.com/*"), "i");
  assert.equal(expression.test("https://example.com/path"), true);
  assert.equal(expression.test("http://api.dev.example.com/path"), true);
  assert.equal(expression.test("https://evil-example.com/path"), false);
});

test("one rule compiles multiple header changes into one DNR action", () => {
  const [compiled] = compileDynamicRules(makeState([
    makeRule({
      headerChanges: [
        makeChange({ header: "X-Debug", value: "1" }),
        makeChange({ header: "X-Client", value: "nya" }),
        makeChange({ direction: "response", header: "Access-Control-Allow-Credentials", value: "true" })
      ]
    })
  ]));
  assert.equal(compiled.id, 1);
  assert.deepEqual(compiled.action.requestHeaders, [
    { header: "X-Debug", operation: "set", value: "1" },
    { header: "X-Client", operation: "set", value: "nya" }
  ]);
  assert.deepEqual(compiled.action.responseHeaders, [
    { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
  ]);
});

test("multiple included patterns expand to multiple DNR rules while retaining all changes", () => {
  const compiled = compileDynamicRules(makeState([
    makeRule({ sitePatterns: ["https://api.example.com/*", "https://cdn.example.org/*"] })
  ]));
  assert.equal(compiled.length, 2);
  assert.deepEqual(compiled.map((rule) => rule.id), [1, 2]);
  assert.equal(compiled[0].action.requestHeaders.length, 1);
  assert.match(compiled[0].condition.regexFilter, /api\\\.example\\\.com/);
  assert.match(compiled[1].condition.regexFilter, /cdn\\\.example\\\.org/);
});

test("response remove compiles without a value", () => {
  const [compiled] = compileDynamicRules(makeState([
    makeRule({ headerChanges: [makeChange({ direction: "response", operation: "remove", header: "Server" })] })
  ]));
  assert.deepEqual(compiled.action.responseHeaders, [{ header: "Server", operation: "remove" }]);
});

test("request method filters compile to lowercase DNR conditions", () => {
  const [compiled] = compileDynamicRules(makeState([makeRule({
    requestMethods: ["OPTIONS", "POST", "options"]
  })]));
  assert.deepEqual(compiled.condition.requestMethods, ["options", "post"]);
});

test("URL pattern method prefixes compile independently and inherit rule defaults", () => {
  const compiled = compileDynamicRules(makeState([makeRule({
    requestMethods: ["DELETE"],
    sitePatterns: [
      "[OPTIONS] https://api.example.com/*",
      "[GET,POST] https://api.example.com/items/*",
      "https://cdn.example.org/*",
      "[ALL] https://all.example.org/*"
    ]
  })]));
  assert.deepEqual(compiled.map((rule) => rule.condition.requestMethods), [
    ["options"],
    ["get", "post"],
    ["delete"],
    undefined
  ]);
  assert.deepEqual(normalizeState(makeState([makeRule({
    sitePatterns: ["[OPTIONS] https://api.example.com/*"]
  })])).rules[0].sitePatternMethods, [["OPTIONS"]]);
});

test("disabled rules and global pause compile to no rules", () => {
  assert.deepEqual(compileDynamicRules(makeState([makeRule({ enabled: false })])), []);
  assert.deepEqual(compileDynamicRules(makeState([makeRule()], { globalEnabled: false })), []);
});

test("empty site patterns explicitly mean all authorized sites", () => {
  const [compiled] = compileDynamicRules(makeState([
    makeRule({ sitePatterns: [], excludedSitePatterns: [], resourceTypes: [] })
  ]));
  assert.deepEqual(compiled.condition, {});
});

test("current URL matching honors includes, exclusions and all-site rules", () => {
  const rule = makeRule({
    sitePatterns: ["*://*.example.com/*", "https://other.test/*"],
    excludedSitePatterns: ["https://example.com/private/*"]
  });
  assert.equal(ruleMatchesUrl(rule, "https://api.example.com/dashboard"), true);
  assert.equal(ruleMatchesUrl(rule, "https://example.com/private/token"), false);
  assert.equal(ruleMatchesUrl(rule, "https://unrelated.test/"), false);
  assert.equal(ruleMatchesUrl(makeRule({ sitePatterns: [] }), "https://unrelated.test/"), true);
  assert.equal(ruleMatchesUrl(rule, "chrome://extensions"), false);
});

test("current URL matching can evaluate URL pattern methods", () => {
  const rule = makeRule({
    sitePatterns: [
      "[OPTIONS] https://api.example.com/preflight/*",
      "[GET] https://api.example.com/items/*"
    ]
  });
  assert.equal(ruleMatchesUrl(rule, "https://api.example.com/items/1", "OPTIONS"), false);
  assert.equal(ruleMatchesUrl(rule, "https://api.example.com/items/1", "GET"), true);
  assert.equal(ruleMatchesUrl(rule, "https://api.example.com/preflight/items", "OPTIONS"), true);
});

test("creates an exact-origin wildcard for the current site", () => {
  assert.equal(patternForUrl("https://example.com:8443/path?q=1"), "https://example.com:8443/*");
  assert.equal(patternForUrl("chrome://settings"), "");
});

test("migrates v1/v2 single-header rules into a v5 headerChanges array", () => {
  const migratedV1 = normalizeState({
    schemaVersion: 1,
    globalEnabled: true,
    nextRuleId: 2,
    rules: [{
      id: 1,
      enabled: true,
      name: "Legacy",
      direction: "request",
      operation: "set",
      header: "X-Legacy",
      value: "1",
      urlFilter: "||example.com",
      excludedUrlFilter: "/logout",
      resourceTypes: [],
      priority: 1
    }]
  });
  const migratedV2 = normalizeState({
    schemaVersion: 2,
    nextRuleId: 2,
    rules: [{
      id: 1,
      enabled: true,
      name: "V2",
      direction: "response",
      operation: "remove",
      header: "Server",
      value: "",
      matchType: "wildcard",
      sitePatterns: ["https://example.com/*"],
      excludedSitePatterns: [],
      resourceTypes: [],
      priority: 1
    }]
  });
  assert.equal(migratedV1.schemaVersion, 5);
  assert.deepEqual(migratedV1.rules[0].headerChanges, [makeChange({ header: "X-Legacy" })]);
  assert.deepEqual(migratedV1.rules[0].requestMethods, []);
  assert.deepEqual(migratedV1.rules[0].sitePatternMethods, [null]);
  assert.equal(migratedV1.rules[0].matchType, "dnr");
  assert.deepEqual(migratedV2.rules[0].headerChanges, [makeChange({ direction: "response", operation: "remove", header: "Server", value: "" })]);
});

test("collects only user regex filters for Chrome RE2 preflight", () => {
  const state = makeState([
    makeRule({ matchType: "regex", sitePatterns: ["^https://one\\.test/"], excludedSitePatterns: ["/private/"] }),
    makeRule({ id: 2, sitePatterns: ["https://wildcard.test/*"] })
  ]);
  assert.deepEqual(collectRegexFiltersForValidation(state), ["^https://one\\.test/", "/private/"]);
  assert.throws(
    () => normalizeState(makeState([makeRule({ matchType: "regex", sitePatterns: ["["] })])),
    (error) => error instanceof RuleValidationError && error.field === "sitePatterns"
  );
});

test("rejects malformed changes, duplicate headers, injection and oversized arrays", () => {
  assert.throws(
    () => normalizeState(makeState([makeRule({ headerChanges: [makeChange({ header: "Bad Header" })] })])),
    (error) => error instanceof RuleValidationError && error.field === "headerChanges"
  );
  assert.throws(
    () => normalizeState(makeState([makeRule({ headerChanges: [makeChange({ value: "good\r\nInjected: yes" })] })])),
    (error) => error instanceof RuleValidationError && error.field === "headerChanges"
  );
  assert.throws(
    () => normalizeState(makeState([makeRule({ headerChanges: [makeChange(), makeChange({ value: "2" })] })])),
    (error) => error instanceof RuleValidationError && error.field === "headerChanges"
  );
  const changes = Array.from({ length: MAX_HEADER_CHANGES_PER_RULE + 1 }, (_, index) =>
    makeChange({ header: `X-Header-${index}` })
  );
  assert.throws(() => normalizeState(makeState([makeRule({ headerChanges: changes })])), /20/);
});

test("compiles response status and body overrides separately from DNR rules", () => {
  const state = makeState([makeRule({
    headerChanges: [],
    responseStatus: 418,
    responseBody: "{\"debug\":true}"
  })]);
  assert.deepEqual(compileDynamicRules(state), []);
  assert.deepEqual(compileResponseRules(state), [{
    id: 1,
    priority: 10,
    matchType: "wildcard",
    sitePatterns: ["https://*.example.com/*"],
    excludedSitePatterns: [],
    resourceTypes: ["xmlhttprequest"],
    requestMethods: [],
    sitePatternMethods: [null],
    responseStatus: 418,
    responseBody: "{\"debug\":true}"
  }]);
});

test("validates response status range and body rules", () => {
  assert.throws(
    () => normalizeState(makeState([makeRule({ headerChanges: [], responseStatus: 199 })])),
    (error) => error instanceof RuleValidationError && error.field === "responseStatus"
  );
  assert.throws(
    () => normalizeState(makeState([makeRule({ headerChanges: [], responseStatus: 204, responseBody: "no" })])),
    (error) => error instanceof RuleValidationError && error.field === "responseBody"
  );
  assert.deepEqual(normalizeState(makeState([makeRule({
    headerChanges: [],
    responseStatus: 204,
    responseBody: ""
  })])).rules[0].responseBody, "");
});

test("validates request method filters", () => {
  assert.throws(
    () => normalizeState(makeState([makeRule({ requestMethods: ["OPTIONS", "INVALID"] })])),
    (error) => error instanceof RuleValidationError && error.field === "requestMethods"
  );
  assert.throws(
    () => normalizeState(makeState([makeRule({
      sitePatterns: ["[INVALID] https://example.com/*"]
    })])),
    (error) => error instanceof RuleValidationError && error.field === "sitePatterns"
  );
});

test("rejects a state that expands beyond Chrome dynamic-rule capacity", () => {
  const patterns = Array.from({ length: 20 }, (_, index) => `https://site${index}.test/*`);
  const rules = Array.from({ length: 251 }, (_, index) => makeRule({
    id: index + 1,
    headerChanges: [makeChange({ header: `X-Rule-${index}` })],
    sitePatterns: patterns
  }));
  assert.throws(() => compileDynamicRules(makeState(rules)), /5000/);
});

test("import reassigns IDs, rejects future schemas and export round-trips", () => {
  const imported = importState(JSON.stringify(makeState([
    makeRule({ id: 99 }),
    makeRule({ id: 100, headerChanges: [makeChange({ header: "X-Second" })] })
  ])));
  assert.deepEqual(imported.rules.map((rule) => rule.id), [1, 2]);
  assert.equal(imported.nextRuleId, 3);
  assert.throws(() => importState(JSON.stringify({ schemaVersion: 6, rules: [] })), /配置版本/);
  assert.deepEqual(importState(exportState(makeState())), normalizeState(makeState()));
});
