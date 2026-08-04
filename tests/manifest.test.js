import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(projectRoot, "manifest.json"), "utf8"));

test("manifest requests only the reviewed runtime permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage", "declarativeNetRequestWithHostAccess", "activeTab"]);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal(manifest.content_scripts.length, 2);
  assert.deepEqual(manifest.content_scripts[0].matches, ["http://*/*", "https://*/*"]);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[1].world, undefined);
  assert.equal("web_accessible_resources" in manifest, false);
  assert.equal("externally_connectable" in manifest, false);
  assert.equal(manifest.options_page, "manager.html");
});

test("extension CSP blocks outbound connections and remote execution", () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
});

test("all icon files referenced by the manifest exist", async () => {
  const iconPaths = new Set([
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ]);
  await Promise.all([...iconPaths].map((path) => access(resolve(projectRoot, path))));
});

test("all response content script files referenced by the manifest exist", async () => {
  const scriptPaths = manifest.content_scripts.flatMap((entry) => entry.js);
  await Promise.all(scriptPaths.map((path) => access(resolve(projectRoot, path))));
});

test("runtime JavaScript contains no outbound network API", async () => {
  const runtimeFiles = [
    "src/background.js",
    "src/client.js",
    "src/core.js",
    "src/manager.js",
    "src/popup.js"
  ];
  const forbidden = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/;
  for (const file of runtimeFiles) {
    const contents = await readFile(resolve(projectRoot, file), "utf8");
    assert.doesNotMatch(contents, forbidden, file);
    assert.doesNotMatch(contents, /\b(?:eval|Function)\s*\(/, file);
    assert.doesNotMatch(contents, /\.innerHTML\s*=/, file);
  }
});
