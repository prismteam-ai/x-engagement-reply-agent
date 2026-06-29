import { createHash, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { runFromConfig } from "@/pipeline/run-from-config";
import {
  readLatestRun,
  readShowcaseRun,
  saveLatestRun,
  saveShowcaseRun,
} from "@/pipeline/run-store";
import { logRuntime } from "@/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function constantTimeSecretEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return nodeTimingSafeEqual(ha, hb);
}

function presentedSecret(req: Request, url: URL): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const key = url.searchParams.get("key");
  return key !== null ? key.trim() : null;
}

function isRealRunAuthorized(req: Request, url: URL): boolean {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  if (!expected) return false;
  const presented = presentedSecret(req, url);
  if (!presented) return false;
  return constantTimeSecretEqual(presented, expected);
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const isCron = req.headers.get("x-vercel-cron") !== null;
  const showcase = parseBoolean(url.searchParams.get("showcase"), false);
  const dryRun = showcase ? false : parseBoolean(url.searchParams.get("dryRun"), !isCron);
  const authorHandle = url.searchParams.get("author") || undefined;

  if (dryRun && !showcase) {
    const snapshot = (await readShowcaseRun()) ?? (await readLatestRun());
    if (snapshot) {
      return Response.json({
        ok: true,
        source: "snapshot",
        summary: snapshot.summary,
        tasks: snapshot.tasks,
        organic: snapshot.organic ?? true,
        savedAt: snapshot.savedAt,
      });
    }
    return Response.json({
      ok: true,
      source: "none",
      message: "No organic run available yet",
    });
  }

  if (!isRealRunAuthorized(req, url)) {
    return Response.json(
      { ok: false, error: "unauthorized", message: "A real run requires a valid secret." },
      { status: 401 },
    );
  }

  try {
    const result = await runFromConfig(
      showcase
        ? {
            dryRun: false,
            skipState: true,
            ...(authorHandle ? { authorHandle } : {}),
          }
        : { dryRun, ...(authorHandle ? { authorHandle } : {}) },
    );
    try {
      await saveLatestRun(result);
    } catch (error) {
      logRuntime({
        level: "warn",
        message: "Failed to persist latest run snapshot; status page will fall back.",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await saveShowcaseRun(result);
    } catch (error) {
      logRuntime({
        level: "warn",
        message: "Failed to persist showcase run snapshot; keeping previous showcase.",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return Response.json({ ok: true, ...result });
  } catch (error) {
    logRuntime({
      level: "error",
      message: "monitor-x run failed.",
      reason: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        ok: false,
        error: "monitor-failed",
        message: "The monitor run failed. Check server logs for details.",
      },
      { status: 500 },
    );
  }
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
