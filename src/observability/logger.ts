export type PostOutcome = "ingested" | "skipped" | "tasked" | "failed";

export type PostOutcomeRecord = {
  sourceUri: string;
  statusId: string;
  author: string;
  handle: string;
  outcome: PostOutcome;
  reason?: string;
  bestRawScore?: number | null;
  matchedArticleCount?: number;
  draftCount?: number;
};

export type RunCounts = {
  authorsPolled: number;
  postsFetched: number;
  newPosts: number;
  matched: number;
  tasksWouldCreate: number;
  tasksCreated: number;
  skipped: number;
  failures: number;
  skipReasons: Record<string, number>;
};

export type RunSummary = {
  runKey: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  skipReason?: string;
  counts: RunCounts;
  posts: PostOutcomeRecord[];
};

function emptyCounts(): RunCounts {
  return {
    authorsPolled: 0,
    postsFetched: 0,
    newPosts: 0,
    matched: 0,
    tasksWouldCreate: 0,
    tasksCreated: 0,
    skipped: 0,
    failures: 0,
    skipReasons: {},
  };
}

export function bucketSkipReason(reason: string | undefined): string {
  const cleaned = String(reason ?? "").trim();
  if (!cleaned) return "unspecified";
  const head = cleaned.split(/[:]/, 1)[0] ?? cleaned;
  return head.trim() || "unspecified";
}

export type RunSummaryBuilder = {
  recordAuthorsPolled(count: number): void;
  recordPostsFetched(count: number): void;
  recordNewPosts(count: number): void;
  recordPost(record: PostOutcomeRecord): void;
  setSkipReason(reason: string): void;
  build(params: { finishedAt: string }): RunSummary;
};

export function createRunSummaryBuilder(params: {
  runKey: string;
  startedAt: string;
  dryRun: boolean;
}): RunSummaryBuilder {
  const counts = emptyCounts();
  const posts: PostOutcomeRecord[] = [];
  let skipReason: string | undefined;

  return {
    recordAuthorsPolled(count: number): void {
      counts.authorsPolled += Math.max(0, count);
    },
    recordPostsFetched(count: number): void {
      counts.postsFetched += Math.max(0, count);
    },
    recordNewPosts(count: number): void {
      counts.newPosts += Math.max(0, count);
    },
    recordPost(record: PostOutcomeRecord): void {
      posts.push(record);
      if ((record.matchedArticleCount ?? 0) > 0) counts.matched += 1;
      switch (record.outcome) {
        case "tasked":
          if (params.dryRun) counts.tasksWouldCreate += 1;
          else counts.tasksCreated += 1;
          break;
        case "skipped": {
          counts.skipped += 1;
          const bucket = bucketSkipReason(record.reason);
          counts.skipReasons[bucket] = (counts.skipReasons[bucket] ?? 0) + 1;
          break;
        }
        case "failed":
          counts.failures += 1;
          break;
        case "ingested":
        default:
          break;
      }
    },
    setSkipReason(reason: string): void {
      skipReason = reason;
    },
    build(buildParams: { finishedAt: string }): RunSummary {
      return {
        runKey: params.runKey,
        startedAt: params.startedAt,
        finishedAt: buildParams.finishedAt,
        dryRun: params.dryRun,
        ...(skipReason ? { skipReason } : {}),
        counts: {
          ...counts,
          skipReasons: { ...counts.skipReasons },
        },
        posts: [...posts],
      };
    },
  };
}

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export type RuntimeLogEntry = {
  level: RuntimeLogLevel;
  message: string;
  [key: string]: unknown;
};

export function logRuntime(entry: RuntimeLogEntry): void {
  if (process.env.RUNTIME_LOG_SILENT === "1") return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    process.stderr.write(`${line}\n`);
  } catch {
  }
}
