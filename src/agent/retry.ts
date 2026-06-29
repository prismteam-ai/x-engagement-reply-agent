export type EnvRecord = Record<string, string | undefined>;

export function resolvePositiveIntEnv(
  env: EnvRecord,
  name: string,
  fallback: number,
  { minimum = 1 }: { minimum?: number } = {},
): number {
  const raw = Number.parseInt((env[name] ?? "").trim(), 10);
  return Number.isFinite(raw) && raw >= minimum ? raw : fallback;
}

function errorStatus(error: unknown): number | undefined {
  return (
    (error as { statusCode?: number } | null)?.statusCode ??
    (error as { status?: number } | null)?.status
  );
}

export function isThrottleError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const status = errorStatus(error);
  return (
    status === 429 ||
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("throttl") ||
    message.includes("rate exceeded") ||
    message.includes("rate limit")
  );
}

export function isRetryableError(error: unknown): boolean {
  if (isThrottleError(error)) return true;
  const status = errorStatus(error);
  if (typeof status === "number" && status >= 500 && status <= 599) return true;
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const code = (error as { code?: string } | null)?.code ?? "";
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("aborted") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("connection closed") ||
    message.includes("transport closed")
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RequestTimeoutError extends Error {
  override readonly name = "TimeoutError";
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
  }
}

export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type RunWithRetryOptions = {
  maxRetries: number;
  timeoutMs: number;
  isRetryable?: (error: unknown) => boolean;
};

export async function runWithRetry<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: RunWithRetryOptions,
): Promise<T> {
  const retryable = options.isRetryable ?? isRetryableError;
  let attempt = 0;
  while (true) {
    try {
      return await withTimeout(run, options.timeoutMs);
    } catch (error) {
      if (attempt >= options.maxRetries || !retryable(error)) throw error;
      const backoffMs = Math.round(500 * 2 ** attempt + Math.random() * 250);
      attempt += 1;
      await sleep(backoffMs);
    }
  }
}
