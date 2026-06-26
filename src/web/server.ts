import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
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

const runBodySchema = z
  .object({
    author: z.string().trim().min(1).optional(),
    driver: z.enum(["fixture", "live"]).default("fixture"),
    dryRun: z.boolean().default(true),
  })
  .default({});

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : undefined;
}

/** Constant-time compare that never throws on length mismatch. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
      // liveAvailable reflects whether the gate is configured (RUN_TOKEN set).
      // The token value itself is never exposed.
      sendJson(res, 200, { ...loadConfigView(), liveAvailable: Boolean(process.env.RUN_TOKEN) });
    } catch (err) {
      log.error("config load failed", { error: err instanceof Error ? err.message : String(err) });
      sendJson(res, 500, { error: err instanceof Error ? err.message : "failed to load config" });
    }
    return;
  }

  if (method === "POST" && path === "/api/run") {
    let parsed: z.infer<typeof runBodySchema>;
    try {
      const raw = await readBody(req);
      parsed = runBodySchema.parse(raw ? JSON.parse(raw) : {});
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid request body" });
      return;
    }

    // A run is PRIVILEGED when it polls real X or writes real Asana tasks. The
    // default fixture + dry-run run requires no token (unchanged behaviour).
    const privileged = parsed.driver === "live" || parsed.dryRun === false;
    if (privileged) {
      const expected = process.env.RUN_TOKEN ?? "";
      if (!expected) {
        sendJson(res, 403, { error: "live mode not configured (RUN_TOKEN unset)" });
        return;
      }
      const provided = headerValue(req, "x-run-token");
      if (!provided || !tokensMatch(provided, expected)) {
        sendJson(res, 401, { error: "invalid or missing run token" });
        return;
      }
    }

    try {
      log.info("run requested", {
        author: parsed.author ?? "all",
        driver: parsed.driver,
        dryRun: parsed.dryRun,
      });
      const result = await runPipeline({
        onlyHandle: parsed.author,
        driver: parsed.driver,
        dryRun: parsed.dryRun,
      });
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
