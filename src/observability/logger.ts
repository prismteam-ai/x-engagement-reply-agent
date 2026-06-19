/**
 * Minimal structured JSON logger (Powertools-style shape) so the agent emits
 * machine-parseable logs locally and in Lambda/CloudWatch without extra deps.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(service: string, bindings: Record<string, unknown>, level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    level,
    timestamp: new Date().toISOString(),
    service,
    message: msg,
    ...bindings,
    ...ctx,
  };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export function createLogger(service = "x-engagement-reply-agent", bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, c) => emit(service, bindings, "debug", m, c),
    info: (m, c) => emit(service, bindings, "info", m, c),
    warn: (m, c) => emit(service, bindings, "warn", m, c),
    error: (m, c) => emit(service, bindings, "error", m, c),
    child: (b) => createLogger(service, { ...bindings, ...b }),
  };
}
