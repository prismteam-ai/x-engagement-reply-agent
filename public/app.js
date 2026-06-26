"use strict";

/** Vanilla dashboard client. Reads /api/config, triggers /api/run, renders results. */

const $ = (sel) => document.querySelector(sel);

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.testid) node.setAttribute("data-testid", opts.testid);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

function showError(node, message) {
  node.textContent = message;
  node.hidden = false;
}

async function loadConfig() {
  const errBox = $("#config-error");
  errBox.hidden = true;
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`config request failed (${res.status})`);
    const cfg = await res.json();
    renderConfig(cfg);
    populateAuthorSelect(cfg.authors);
  } catch (err) {
    showError(errBox, `Could not load config: ${err.message}`);
  }
}

function renderConfig(cfg) {
  $("[data-testid='config-model']").textContent = cfg.modelId;
  $("[data-testid='config-parent-threshold']").textContent = cfg.thresholds.asanaTaskSimilarityThreshold;
  $("[data-testid='config-article-threshold']").textContent = cfg.thresholds.articleSimilarityThreshold;
  $("[data-testid='config-poll-interval']").textContent = cfg.pollIntervalMinutes;
  $("[data-testid='config-batch-size']").textContent = cfg.defaultBatchSize;
  $("[data-testid='config-topk']").textContent = cfg.defaultTopK;
  $("[data-testid='config-max-articles']").textContent = cfg.maxArticlesPerPost;

  const promptList = $("[data-testid='prompt-file-list']");
  promptList.replaceChildren(
    ...cfg.replyPrompts.map((p) => {
      const details = el("details", {}, [
        el("summary", { text: "View prompt text" }),
        el("pre", { text: p.text }),
      ]);
      return el("li", { testid: "prompt-file" }, [
        el("div", { class: "label", text: `${p.label}: ${p.title}` }),
        el("div", { class: "file", text: p.file }),
        details,
      ]);
    }),
  );

  const tbody = $("[data-testid='config-author-tbody']");
  tbody.replaceChildren(
    ...cfg.authors.map((a) =>
      el("tr", { testid: "config-author-row" }, [
        el("td", { text: a.name }),
        el("td", { text: `@${a.handle}` }),
        el("td", { text: a.company || "—" }),
        el("td", {}, [badge(a.active)]),
        el("td", {}, [badge(a.excludeFromTasking)]),
      ]),
    ),
  );
}

function badge(value) {
  return el("span", { class: `badge ${value ? "yes" : "no"}`, text: value ? "Yes" : "No" });
}

function populateAuthorSelect(authors) {
  const select = $("#author-select");
  for (const a of authors) {
    select.appendChild(el("option", { text: `${a.name} (@${a.handle})`, attrs: { value: a.handle } }));
  }
}

/** A run is privileged (live X poll and/or real Asana writes) when the driver is
 *  live or the dry-run toggle is unchecked. Drives the warning + button label. */
function isPrivileged() {
  return $("#driver-select").value === "live" || !$("#dryrun-toggle").checked;
}

function syncRunControls() {
  $("#live-warning").hidden = !isPrivileged();
  $("#run-button").textContent = isPrivileged() ? "Run pipeline (LIVE)" : "Run pipeline (dry-run)";
}

async function runPipeline() {
  const button = $("#run-button");
  const status = $("#run-status");
  const runError = $("#run-error");
  const author = $("#author-select").value;
  const driver = $("#driver-select").value;
  const dryRun = $("#dryrun-toggle").checked;
  const token = $("#run-token").value.trim();

  button.disabled = true;
  status.textContent = isPrivileged() ? "Running LIVE pipeline…" : "Running dry-run pipeline…";
  runError.hidden = true;

  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Run-Token"] = token;
  const body = { driver, dryRun };
  if (author) body.author = author;

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.error ? data.error : `run failed (${res.status})`);
    renderResults(data);
    status.textContent = "Done.";
  } catch (err) {
    showError(runError, `Run failed: ${err.message}`);
    status.textContent = "Failed.";
  } finally {
    button.disabled = false;
  }
}

function renderResults(data) {
  const { summary, subtasks } = data;
  const summaryBox = $("#summary");
  summaryBox.hidden = false;

  const set = (id, v) => ($(`[data-testid='summary-${id}']`).textContent = v);
  set("authorsPolled", summary.authorsPolled);
  set("postsFetched", summary.postsFetched);
  set("newPostsProcessed", summary.newPostsProcessed);
  set("parentTasks", summary.parentTasksCreated);
  set("subtasks", summary.subtasksCreated);
  set("skipped", summary.skipped);
  set("failed", summary.failed);

  // Group captured reply drafts by the post they belong to.
  const draftsByStatus = new Map();
  for (const st of subtasks || []) {
    const key = st.post.statusId;
    if (!draftsByStatus.has(key)) draftsByStatus.set(key, []);
    draftsByStatus.get(key).push(st);
  }

  const empty = $("#empty-state");
  const postsBox = $("#posts");
  const results = summary.results || [];
  if (results.length === 0) {
    postsBox.replaceChildren();
    empty.textContent = "No posts were processed in this run.";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  postsBox.replaceChildren(...results.map((r) => renderPost(r, draftsByStatus.get(r.post.statusId) || [])));
}

function renderPost(result, drafts) {
  const post = result.post;
  const head = el("div", { class: "post-head" }, [
    el("span", { class: "handle", text: `@${post.handle}` }),
    el("span", { class: `outcome ${result.outcome}`, testid: "post-outcome", text: result.outcome }),
  ]);

  const children = [head, el("p", { class: "post-text", text: post.text || post.header })];

  const metaBits = [];
  if (result.reason) metaBits.push(`Reason: ${result.reason}`);
  if (typeof result.bestRawScore === "number") metaBits.push(`Best raw score: ${result.bestRawScore.toFixed(4)}`);
  if (metaBits.length) children.push(el("p", { class: "post-meta", text: metaBits.join("  ·  ") }));

  if (result.matches && result.matches.length) {
    children.push(el("h4", { text: "Matched articles" }));
    children.push(
      el(
        "ul",
        { class: "matches", testid: "match-list" },
        result.matches.map((m) =>
          el("li", { testid: "article-match" }, [
            document.createTextNode(`${m.title} `),
            el("span", { class: "match-score", text: `(score ${m.score})` }),
          ]),
        ),
      ),
    );
  }

  if (drafts.length) {
    children.push(el("h4", { text: "Reply drafts" }));
    children.push(el("div", { class: "drafts" }, drafts.map(renderDraft)));
  }

  return el("article", { class: "post-card", testid: "post-card" }, children);
}

function renderDraft(st) {
  const d = st.draft;
  return el("div", { class: "reply-draft", testid: "reply-draft" }, [
    el("div", { class: "prompt-label", testid: "reply-prompt-label", text: `${d.promptLabel} · article: ${st.article.title}` }),
    el("p", { class: "response", testid: "reply-response", text: d.suggestedResponse }),
    el("p", { class: "why", testid: "reply-why", text: d.whyRecommended }),
    el("a", {
      class: "compose-link",
      testid: "compose-link",
      text: "Post & reply on X",
      attrs: { href: st.composeLink, target: "_blank", rel: "noopener noreferrer" },
    }),
  ]);
}

document.addEventListener("DOMContentLoaded", () => {
  loadConfig();
  $("#run-button").addEventListener("click", runPipeline);
  $("#driver-select").addEventListener("change", syncRunControls);
  $("#dryrun-toggle").addEventListener("change", syncRunControls);
  syncRunControls();
});
