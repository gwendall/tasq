import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const exportRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../out");
const portArgumentIndex = process.argv.indexOf("--port");
const rawPort = portArgumentIndex === -1 ? process.env.PORT ?? "3000" : process.argv[portArgumentIndex + 1];
const port = Number(rawPort);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid static export port: ${rawPort ?? "<missing>"}`);
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveRequestPath(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch {
    return undefined;
  }

  const candidate = resolve(exportRoot, `.${pathname}`);
  if (candidate !== exportRoot && !candidate.startsWith(`${exportRoot}${sep}`)) return undefined;
  return candidate;
}

async function findExportedFile(requestUrl) {
  const candidate = resolveRequestPath(requestUrl);
  if (!candidate) return undefined;

  try {
    const candidateStats = await stat(candidate);
    if (candidateStats.isDirectory()) {
      const indexPath = resolve(candidate, "index.html");
      return (await stat(indexPath)).isFile() ? indexPath : undefined;
    }
    return candidateStats.isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const filePath = await findExportedFile(request.url ?? "/");
  if (!filePath) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  const fileStats = await stat(filePath);
  response.writeHead(200, {
    "Content-Length": fileStats.size,
    "Content-Type": contentTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Serving static export from ${exportRoot} at http://127.0.0.1:${port}\n`);
});
