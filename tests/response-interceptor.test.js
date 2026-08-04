import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const projectRoot = resolve(import.meta.dirname, "..");
const interceptorSource = await readFile(resolve(projectRoot, "src/response-interceptor.js"), "utf8");

function createWindow() {
  const listeners = new Map();
  const window = {
    location: { href: "https://api.example.com/dashboard" },
    fetch: async () => new Response("original", {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(data) {
      listeners.get("message")?.({ source: window, data });
    }
  };
  return window;
}

function loadInterceptor(window) {
  vm.runInNewContext(interceptorSource, {
    window,
    Blob,
    Event,
    EventTarget,
    Headers,
    Response,
    TextEncoder,
    URL
  });
}

class FakeXMLHttpRequest extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.status = 0;
    this.statusText = "";
    this.responseType = "";
    this.response = "";
    this.responseText = "";
    this.responseURL = "";
  }

  open(method, url) {
    this.responseURL = new URL(url, "https://api.example.com/").href;
    this.readyState = 1;
    this.dispatchEvent(new Event("readystatechange"));
  }

  send() {
    this.readyState = 4;
    this.status = 200;
    this.statusText = "OK";
    this.response = "original";
    this.responseText = "original";
    this.dispatchEvent(new Event("readystatechange"));
    this.dispatchEvent(new Event("load"));
    this.dispatchEvent(new Event("loadend"));
  }

  getResponseHeader(name) {
    return name.toLowerCase() === "content-type" ? "application/json" : null;
  }

  getAllResponseHeaders() { return "content-type: application/json\r\n"; }
  setRequestHeader() {}
  abort() {}
  overrideMimeType() {}
}

test("fetch response overrides replace status and body", async () => {
  const window = createWindow();
  loadInterceptor(window);
  window.postMessage({
    source: "NyaModifyHeader",
    type: "SET_RESPONSE_RULES",
    rules: [{
      id: 1,
      priority: 10,
      matchType: "wildcard",
      sitePatterns: ["https://api.example.com/*"],
      excludedSitePatterns: [],
      resourceTypes: ["xmlhttprequest"],
      responseStatus: 418,
      responseBody: "{\"debug\":true}"
    }]
  });

  const response = await window.fetch("https://api.example.com/items");
  assert.equal(response.status, 418);
  assert.deepEqual(await response.json(), { debug: true });
});

test("fetch response overrides honor exclusions", async () => {
  const window = createWindow();
  loadInterceptor(window);
  window.postMessage({
    source: "NyaModifyHeader",
    type: "SET_RESPONSE_RULES",
    rules: [{
      id: 1,
      priority: 10,
      matchType: "wildcard",
      sitePatterns: ["https://api.example.com/*"],
      excludedSitePatterns: ["https://api.example.com/private/*"],
      resourceTypes: [],
      responseStatus: 404,
      responseBody: null
    }]
  });

  const response = await window.fetch("https://api.example.com/private/items");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "original");
});

test("XMLHttpRequest response overrides are visible before load handlers run", () => {
  const window = createWindow();
  window.XMLHttpRequest = FakeXMLHttpRequest;
  loadInterceptor(window);
  window.postMessage({
    source: "NyaModifyHeader",
    type: "SET_RESPONSE_RULES",
    rules: [{
      id: 1,
      priority: 10,
      matchType: "wildcard",
      sitePatterns: ["https://api.example.com/*"],
      excludedSitePatterns: [],
      resourceTypes: ["xmlhttprequest"],
      responseStatus: 503,
      responseBody: "{\"retry\":true}"
    }]
  });

  const xhr = new window.XMLHttpRequest();
  let seen;
  xhr.open("GET", "https://api.example.com/items");
  xhr.onload = () => { seen = [xhr.status, xhr.responseText]; };
  xhr.send();
  assert.deepEqual(seen, [503, "{\"retry\":true}"]);
});
