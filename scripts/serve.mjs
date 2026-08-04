import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requestedPort = Number(process.argv[2] || 4173);
const mimeTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png"
});

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://127.0.0.1").pathname);
  const relative = normalize(pathname).replace(/^([/\\])+/, "") || "popup.html";
  const target = resolve(join(root, relative));
  return target.startsWith(root) ? target : null;
}

const server = createServer(async (request, response) => {
  const target = resolveRequestPath(request.url || "/");
  if (!target) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const details = await stat(target);
    if (!details.isFile()) {
      throw new Error("Not a file");
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes[extname(target)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  console.log(`NyaModifyHeader demo: http://127.0.0.1:${requestedPort}/popup.html`);
});
