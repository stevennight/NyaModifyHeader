(() => {
  if (window.__NyaModifyHeaderResponseInterceptor) {
    return;
  }
  window.__NyaModifyHeaderResponseInterceptor = true;

  const MESSAGE_SOURCE = "NyaModifyHeader";
  const NativeXMLHttpRequest = window.XMLHttpRequest;
  const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  let responseRules = [];

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

  function wildcardToRegexSource(pattern) {
    if (pattern === "*") {
      return "^https?://.*$";
    }
    const match = pattern.match(/^(\*|https?):\/\/([^/\s]+)(\/.*)?$/i);
    if (!match) {
      return "a^";
    }
    const [, scheme, authority, path = "/*"] = match;
    const schemeSource = scheme === "*" ? "https?" : escapeRegex(scheme.toLowerCase());
    const authoritySource = authority.toLowerCase().startsWith("*.")
      ? `(?:[^./]+\\.)*${globSegmentToRegex(authority.slice(2), "[^/]*")}`
      : globSegmentToRegex(authority, "[^/]*");
    return `^${schemeSource}://${authoritySource}${globSegmentToRegex(path, ".*")}$`;
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

  function ruleMatchesUrl(rule, url) {
    if (rule.resourceTypes?.length && !rule.resourceTypes.includes("xmlhttprequest")) {
      return false;
    }
    const included = !rule.sitePatterns?.length
      || rule.sitePatterns.some((pattern) => patternMatchesUrl(rule.matchType, pattern, url));
    return included && !(rule.excludedSitePatterns || [])
      .some((pattern) => patternMatchesUrl(rule.matchType, pattern, url));
  }

  function responseOverrideFor(url) {
    const matches = responseRules
      .filter((rule) => ruleMatchesUrl(rule, url))
      .sort((left, right) => right.priority - left.priority || left.id - right.id);
    let status = null;
    let body = null;
    for (const rule of matches) {
      if (status === null && rule.responseStatus !== null) {
        status = rule.responseStatus;
      }
      if (body === null && rule.responseBody !== null) {
        body = rule.responseBody;
      }
    }
    return status === null && body === null ? null : { status, body };
  }

  function requestUrl(input) {
    try {
      const value = typeof input === "string" ? input : input?.url || String(input);
      return new URL(value, window.location.href).href;
    } catch {
      return "";
    }
  }

  function createResponse(response, override) {
    const status = override.status ?? (response.status >= 200 ? response.status : 200);
    const bodyNotAllowed = [204, 205, 304].includes(status);
    const body = bodyNotAllowed
      ? null
      : override.body === null
        ? response.body
        : override.body;
    return new Response(body, {
      status,
      statusText: response.statusText,
      headers: new Headers(response.headers)
    });
  }

  async function applyFetchOverride(response, url) {
    const override = responseOverrideFor(url);
    if (!override) {
      return response;
    }
    try {
      return createResponse(response, override);
    } catch {
      return response;
    }
  }

  function dispatchEventWithHandler(target, type, nativeEvent) {
    let event;
    try {
      event = type === "progress" && typeof ProgressEvent === "function"
        ? new ProgressEvent(type, { loaded: nativeEvent?.loaded || 0, total: nativeEvent?.total || 0 })
        : new Event(type);
    } catch {
      event = document.createEvent("Event");
      event.initEvent(type, false, false);
    }
    target.dispatchEvent(event);
    const handler = target[`on${type}`];
    if (typeof handler === "function") {
      handler.call(target, event);
    }
  }

  function bodyForResponseType(body, responseType, contentType) {
    if (responseType === "arraybuffer") {
      return new TextEncoder().encode(body).buffer;
    }
    if (responseType === "blob") {
      return new Blob([body], { type: contentType || "text/plain;charset=UTF-8" });
    }
    if (responseType === "json") {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    }
    return body;
  }

  class ResponseOverrideXMLHttpRequest extends EventTarget {
    constructor() {
      super();
      this._xhr = new NativeXMLHttpRequest();
      this._requestUrl = "";
      this._async = true;
      this._prepared = false;
      this._bodyOverride = null;
      this._responseValue = undefined;
      this._status = 0;
      this._statusText = "";
      for (const type of ["readystatechange", "load", "error", "timeout", "abort", "loadend", "progress", "loadstart"]) {
        this[`on${type}`] = null;
        this._xhr.addEventListener(type, (event) => this._handleNativeEvent(type, event));
      }
    }

    _handleNativeEvent(type, nativeEvent) {
      if (!this._prepared) {
        this._status = this._xhr.status;
        this._statusText = this._xhr.statusText;
      }
      if (type === "readystatechange") {
        if (this._xhr.readyState === 4) {
          this._prepareResponse();
        }
        dispatchEventWithHandler(this, type, nativeEvent);
        return;
      }
      if (type === "load") {
        this._prepareResponse();
      }
      dispatchEventWithHandler(this, type, nativeEvent);
    }

    _prepareResponse() {
      if (this._prepared) {
        return;
      }
      this._prepared = true;
      this._status = this._xhr.status;
      this._statusText = this._xhr.statusText;
      this._responseValue = this._xhr.response;
      const override = responseOverrideFor(this._requestUrl);
      if (!override) {
        return;
      }
      if (override.status !== null) {
        this._status = override.status;
      }
      if (override.body !== null) {
        this._bodyOverride = override.body;
        this._responseValue = bodyForResponseType(
          override.body,
          this._xhr.responseType,
          this._xhr.getResponseHeader("content-type")
        );
      }
    }

    open(method, url, async = true, user, password) {
      this._requestUrl = requestUrl(url);
      this._async = async !== false;
      this._prepared = false;
      this._bodyOverride = null;
      this._responseValue = undefined;
      return this._xhr.open(method, url, async, user, password);
    }

    send(body) {
      return this._xhr.send(body);
    }

    abort() { return this._xhr.abort(); }
    setRequestHeader(name, value) { return this._xhr.setRequestHeader(name, value); }
    getResponseHeader(name) { return this._xhr.getResponseHeader(name); }
    getAllResponseHeaders() { return this._xhr.getAllResponseHeaders(); }
    overrideMimeType(value) { return this._xhr.overrideMimeType(value); }

    get readyState() { return this._xhr.readyState; }
    get responseURL() { return this._xhr.responseURL; }
    get status() { return this._status; }
    get statusText() { return this._statusText; }
    get responseType() { return this._xhr.responseType; }
    set responseType(value) { this._xhr.responseType = value; }
    get response() { return this._responseValue === undefined ? this._xhr.response : this._responseValue; }
    get responseText() {
      if (this.responseType && this.responseType !== "text") {
        throw new DOMException("responseText is unavailable for this responseType", "InvalidStateError");
      }
      return this._bodyOverride === null ? this._xhr.responseText : this._bodyOverride;
    }
    get timeout() { return this._xhr.timeout; }
    set timeout(value) { this._xhr.timeout = value; }
    get withCredentials() { return this._xhr.withCredentials; }
    set withCredentials(value) { this._xhr.withCredentials = value; }
    get upload() { return this._xhr.upload; }
  }

  Object.assign(ResponseOverrideXMLHttpRequest, {
    UNSENT: 0,
    OPENED: 1,
    HEADERS_RECEIVED: 2,
    LOADING: 3,
    DONE: 4
  });
  for (const name of ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"]) {
    Object.defineProperty(ResponseOverrideXMLHttpRequest.prototype, name, {
      value: ResponseOverrideXMLHttpRequest[name],
      enumerable: true
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MESSAGE_SOURCE) {
      return;
    }
    if (event.data.type === "SET_RESPONSE_RULES") {
      responseRules = Array.isArray(event.data.rules) ? event.data.rules : [];
    }
  });

  if (nativeFetch) {
    window.fetch = function patchedFetch(input, init) {
      const url = requestUrl(input);
      return nativeFetch(input, init).then((response) => applyFetchOverride(response, url));
    };
  }
  if (NativeXMLHttpRequest) {
    window.XMLHttpRequest = ResponseOverrideXMLHttpRequest;
  }
})();
