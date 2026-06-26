# Demo walkthrough

📹 **Recorded demo:** embedded in the [pull request description](https://github.com/prismteam-ai/x-engagement-reply-agent/pull/1) — **live scheduled polling end to end.**
The agent runs on its schedule (`run --watch --live`); a brand-new tweet is posted from a watched
X account; the next polling cycle detects it, matches it against Soofi's article corpus via the MCP,
generates the prompt-driven reply drafts, and creates the Asana parent task + approval subtasks.
(Covers: scheduled polling, live new-post detection, similarity matching, reply generation, Asana
tasking with X compose links.)

🚀 **Working runtime (one command):** `docker compose --profile demo run --rm --build demo` runs
the full pipeline in dry-run (live MCP scores + LLM drafts, no Asana/state writes). See
[USAGE → Working runtime](./USAGE.md#working-runtime--one-command-docker).

Each step below maps to the README's Demo Requirements / Required Demo Scenarios.
Run from the repo root after `pnpm install` and filling in `.env`.

## 0. Show config is code-managed (no admin UI / DB)

```bash
pnpm run validate-config
```

Shows the watchlist authors, the discovered reply prompt files, and `modelId` — all
loaded from `config/` and `prompts/`. (Demo req: config from files, not admin/DB.)

## 1. Poll + process one post end-to-end (dry-run, offline)

```bash
pnpm run run:dry
```

Uses the fixture X driver, calls the **live** investors-mcp for real similarity scores,
drafts replies, and prints a structured run summary. No Asana/state side effects.
(Demo reqs: scheduled polling shape, similarity matching with visible scores, multiple
replies per prompt file, dry-run parity.)

A captured example of this output (drafts + compose links + summary, no side effects) is
committed at [`docs/sample-dry-run-output.md`](./docs/sample-dry-run-output.md) as a
permanent artifact of the dry-run requirement.

## 2. Live polling detects a new post

```bash
pnpm run run -- --live --author=<watched-handle>
```

With a real `X_BEARER_TOKEN`, polls the author and processes posts newer than the stored
cursor. Re-running shows `fresh: 0` until the author posts again. (Demo req: scheduled
polling detects a new post.)

## 3. Referenced / quoted post handling

The `fixtures/balajis.json` second post is a quote with a `referencedOriginal`. The
pipeline folds the referenced text into the RAG query. With the live driver, reply/quote
references are detected via `referenced_tweets`. (Demo req: referenced-post handling.)

## 4. Threshold gating

`fixtures/cdixon.json` includes an off-topic ("burrito") post. It scores below
`articleSimilarityThreshold` (0.7) and produces **no subtasks**. The relevant posts clear
the gate and produce one subtask per reply prompt. (Demo req: below-threshold → no subtasks.)

## 5. Multiple replies from distinct prompt files

A qualifying post creates one Asana approval subtask per `prompts/replies/*.md` (5 in the
default demo). Each subtask carries the draft reply, why-recommended, matched article, and
an **X compose-intent link**. (Demo reqs: multiple replies; subtasks with drafts + compose links.)

## 6. Edit a prompt to change tone

Edit `prompts/replies/02-contrarian-thesis.md` (e.g. change "respectfully challenges" to
"sharply challenges"), then re-run on a fresh post (or delete `data/state.json` to reprocess).
The Prompt 2 draft reflects the new tone. (Demo req: edit a prompt, show updated draft.)

## 7. Add a 6th reply prompt — no code change

Create `prompts/replies/06-future-trend.md`:

```markdown
# Prompt 6 — Future trend

Draft a forward-looking reply that connects the matched Soofi article to where this trend
goes next. Include a short quoted phrase from the article and end with a thought-provoking
question.
```

Then:

```bash
pnpm run validate-config   # now lists 6 reply files
pnpm run run:dry           # the same matched article now yields a 6th subtask
```

No code, migration, or UI change. (Demo req: add a 6th prompt → additional subtask.)

## 8. Threshold-based assignee + due date

Set `asana.thresholdAssigneeRawScore`, `asana.thresholdAssignee`, and `asana.defaultAssignee`
in `config/settings.yaml`. Posts whose best match meets the threshold route to the threshold
assignee with **due = today**; others go to the default assignee. (Demo req: threshold assignee/due.)

## 9. Open a subtask and use the compose link

In Asana, open an approval subtask and click the `https://x.com/intent/post?...` link to
preview the drafted reply pre-filled in X's composer. (Demo req: embedded compose link.)

## 10. LLM run traceability

With `LANGSMITH_API_KEY` + `LANGSMITH_TRACING=true`, each draft appears as a LangSmith run
under the configured project, tagged with model, prompt label/file, matched article, raw
score, and token usage. (Demo req: traceability of LLM runs.)

## 11. Single-author isolated run

```bash
pnpm run run -- --author=balajis --dry-run
```

Processes only that author with no side effects. (Demo req: local/isolated testing.)
