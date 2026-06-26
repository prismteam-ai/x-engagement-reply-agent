import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PostCandidate } from "../domain/types.js";
import type { XClient } from "./client.js";

/**
 * Offline XClient backed by JSON fixtures. Used for dev, dry-run, tests, and
 * single-author isolation — no credentials, fully deterministic.
 *
 * Fixtures may be either:
 *  - the reference shape (`{ targetPost: {...} }`) in examples/reference/fixtures, or
 *  - a direct `{ posts: PostCandidate[] }` array.
 * Each fixture is associated with a handle so a single-author run is reproducible.
 */
export interface FixtureFile {
  handle: string;
  posts: PostCandidate[];
}

export class FixtureXClient implements XClient {
  private readonly byHandle = new Map<string, PostCandidate[]>();

  constructor(fixtures: FixtureFile[]) {
    for (const f of fixtures) {
      const existing = this.byHandle.get(f.handle.toLowerCase()) ?? [];
      this.byHandle.set(f.handle.toLowerCase(), [...existing, ...f.posts]);
    }
  }

  async fetchAuthorPosts(params: {
    handle: string;
    sinceStatusId?: string;
    maxResults: number;
  }): Promise<PostCandidate[]> {
    const posts = this.byHandle.get(params.handle.toLowerCase()) ?? [];
    // newest first
    const sorted = [...posts].sort((a, b) => cmpId(b.statusId, a.statusId));
    return sorted.slice(0, params.maxResults);
  }
}

function cmpId(a: string, b: string): number {
  try {
    const av = BigInt(a);
    const bv = BigInt(b);
    return av < bv ? -1 : av > bv ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

/** Coerce the reference fixture shape into PostCandidate[] for a handle. */
function coerceFixture(json: unknown, handle: string): PostCandidate[] {
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj.posts)) {
    return obj.posts as PostCandidate[];
  }
  if (obj.targetPost && typeof obj.targetPost === "object") {
    const t = obj.targetPost as Record<string, string | undefined>;
    return [
      {
        sourceUri: t.sourceUri ?? "",
        statusId: t.statusId ?? "0",
        handle,
        header: t.header ?? "",
        text: t.text ?? "",
      },
    ];
  }
  return [];
}

/**
 * Build a FixtureXClient from a directory of `*.json` fixtures. The handle for
 * each fixture comes from an explicit `handle` field, else the filename stem.
 */
export function loadFixtureClient(dir: string, defaultHandle = "exampleauthor"): FixtureXClient {
  if (!existsSync(dir)) {
    return new FixtureXClient([]);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const fixtures: FixtureFile[] = files.map((file) => {
    const json = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    const handle = (json.handle as string) ?? defaultHandle;
    return { handle, posts: coerceFixture(json, handle) };
  });
  return new FixtureXClient(fixtures);
}
