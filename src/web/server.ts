import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { z } from "zod";
import { createLogger } from "../observability/logger.js";
import { loadConfigView, runPipeline } from "./runner.js";

/**
 * Minimal HTTP surface for the headless engagement agent: serves the static
 * dashboard from public/ and exposes a tiny JSON API to read the code-managed
 * config and trigger the dry-run / fixture pipeline on demand. Built on Node's
 * node:http with a hand-rolled router to keep the dependency set lean.
 */

const log = createLogger("web");
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const PUBLIC_DIR = join(process.cwd(), "public");

const runBodySchema = z.object({ author: z.string().trim().min(1).optional() }).default({});

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  // Resolve under PUBLIC_DIR and reject any traversal outside it.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  const filePath = rel === "" ? join(PUBLIC_DIR, "index.html") : join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const data = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
  const path = url.pathname;

  if (method === "GET" && path === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && path === "/api/config") {
    try {
      sendJson(res, 200, loadConfigView());
    } catch (err) {
      log.error("config load failed", { error: err instanceof Error ? err.message : String(err) });
      sendJson(res, 500, { error: err instanceof Error ? err.message : "failed to load config" });
    }
    return;
  }

  if (method === "POST" && path === "/api/run") {
    try {
      const raw = await readBody(req);
      const parsed = runBodySchema.parse(raw ? JSON.parse(raw) : {});
      log.info("run requested", { author: parsed.author ?? "all" });
      const result = await runPipeline(parsed.author);
      sendJson(res, 200, result);
    } catch (err) {
      log.error("run failed", { error: err instanceof Error ? err.stack : String(err) });
      sendJson(res, 500, { error: err instanceof Error ? err.message : "run failed" });
    }
    return;
  }

  if (method === "GET" || method === "HEAD") {
    await serveStatic(res, path);
    return;
  }

  sendJson(res, 405, { error: "method not allowed" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    log.error("unhandled request error", { error: err instanceof Error ? err.stack : String(err) });
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  log.info("web server listening", { host: HOST, port: PORT, publicDir: PUBLIC_DIR });
});
