import { createLogger, type Logger } from "../observability/logger.js";

/**
 * Lightweight LangSmith tracing facade. When LANGSMITH_API_KEY + LANGSMITH_TRACING
 * are set it posts an LLM run to the LangSmith REST API; otherwise it no-ops so
 * the agent runs without observability creds. Every LLM entrypoint wraps its call
 * in `trace(...)` and the run is flushed before the function returns.
 *
 * Docs: https://docs.smith.langchain.com/reference/data_formats/run_data_format
 */
export interface TraceInputs {
  name: string;
  input: unknown;
  /** Static metadata attached to the run (e.g. modelId, promptLabel). */
  metadata?: Record<string, unknown>;
}

export interface TraceHandle {
  /** Record successful completion + outputs/usage and flush the run. */
  end(output: unknown, extra?: Record<string, unknown>): Promise<void>;
  /** Record an error and flush the run. */
  fail(error: unknown): Promise<void>;
}

export interface LangSmithOptions {
  apiKey?: string;
  endpoint?: string;
  project?: string;
  enabled?: boolean;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Injected for deterministic tests; defaults to Date/randomUUID at runtime. */
  now?: () => string;
  uuid?: () => string;
}

export class LangSmithTracer {
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly project: string;
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;
  private readonly uuid: () => string;

  constructor(opts: LangSmithOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.LANGSMITH_API_KEY;
    this.endpoint = opts.endpoint ?? process.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com";
    this.project = opts.project ?? process.env.LANGSMITH_PROJECT ?? "x-engagement-reply-agent";
    const tracingFlag = (process.env.LANGSMITH_TRACING ?? "false").toLowerCase() === "true";
    this.enabled = (opts.enabled ?? tracingFlag) && Boolean(this.apiKey);
    this.logger = opts.logger ?? createLogger("langsmith");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.uuid =
      opts.uuid ??
      (() =>
        // Node 20+ global crypto
        (globalThis.crypto?.randomUUID?.() ?? `run-${Math.random().toString(16).slice(2)}`));
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  start(inputs: TraceInputs): TraceHandle {
    if (!this.enabled) {
      return { end: async () => {}, fail: async () => {} };
    }
    const id = this.uuid();
    const startTime = this.now();
    const create = this.post("/runs", {
      id,
      name: inputs.name,
      run_type: "llm",
      start_time: startTime,
      inputs: inputs.input,
      session_name: this.project,
      extra: { metadata: inputs.metadata ?? {} },
    });

    return {
      end: async (output, extra) => {
        await create;
        await this.patch(`/runs/${id}`, {
          end_time: this.now(),
          outputs: output,
          extra: { metadata: { ...(inputs.metadata ?? {}), ...(extra ?? {}) } },
        });
      },
      fail: async (error) => {
        await create;
        await this.patch(`/runs/${id}`, {
          end_time: this.now(),
          error: error instanceof Error ? error.message : String(error),
        });
      },
    };
  }

  private async post(path: string, body: unknown): Promise<void> {
    await this.send("POST", path, body);
  }

  private async patch(path: string, body: unknown): Promise<void> {
    await this.send("PATCH", path, body);
  }

  private async send(method: string, path: string, body: unknown): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.endpoint}${path}`, {
        method,
        headers: { "Content-Type": "application/json", "x-api-key": this.apiKey! },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.logger.warn("langsmith request failed", { status: res.status, path });
      }
    } catch (err) {
      // Tracing must never break the pipeline.
      this.logger.warn("langsmith request error", { error: String(err), path });
    }
  }
}
