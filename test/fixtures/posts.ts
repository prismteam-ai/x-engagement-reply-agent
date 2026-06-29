import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InputPost } from "@/pipeline/run-monitor";

export const DEFAULT_FIXTURE_PATH = resolve(
  process.cwd(),
  "examples/reference/fixtures/synthetic-post-and-reply.json",
);

type SyntheticFixture = {
  targetPost: {
    sourceUri: string;
    statusId: string;
    header?: string;
    text: string;
  };
};

export function loadFixturePosts(path: string = DEFAULT_FIXTURE_PATH): InputPost[] {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as SyntheticFixture;
  const target = fixture.targetPost;
  return [
    {
      statusId: target.statusId,
      sourceUri: target.sourceUri,
      ...(target.header ? { header: target.header } : {}),
      text: target.text,
      author: "Example Author",
      handle: "exampleauthor",
      contentType: "post",
    },
  ];
}
