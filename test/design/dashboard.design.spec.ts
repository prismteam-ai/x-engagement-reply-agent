import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Mocked responsive design spec for the dashboard (skill `test/design` lane).
 *
 * There is no Figma source for this UI, so expectations are derived from the
 * actual rendered dashboard and its CSS breakpoints (860px and 480px). The page
 * normally calls `/api/config` (live config) and `/api/run` (LIVE investors-mcp
 * + a real LLM). Both are intercepted with committed JSON fixtures so the
 * assertions are exact, deterministic, and runnable in CI without secrets.
 * Static serving and `/api/health` still hit the real server.
 *
 * Breakpoints are driven by the three Playwright projects (mobile / tablet /
 * desktop) in `playwright.config.ts`; per-breakpoint expectations are keyed by
 * project name so one shared test body covers all viewports.
 */

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

const configFixture = readFixture("config.json") as {
  modelId: string;
  authors: unknown[];
  replyPrompts: unknown[];
};
const runFixture = readFixture("run.json") as {
  summary: { subtasksCreated: number };
};

/**
 * Per-breakpoint layout expectations. Track counts come straight from the CSS:
 *   .config-grid  -> 2 columns (>860px) collapses to 1 (<=860px)
 *   .summary      -> 7 columns (>860px) -> 3 (<=860px) -> 2 (<=480px)
 *   .controls     -> select/button go full-width (<=480px)
 */
const EXPECTATIONS: Record<
  string,
  { configGridCols: number; summaryCols: number; controlsStacked: boolean }
> = {
  mobile: { configGridCols: 1, summaryCols: 2, controlsStacked: true },
  tablet: { configGridCols: 1, summaryCols: 3, controlsStacked: false },
  desktop: { configGridCols: 2, summaryCols: 7, controlsStacked: false },
};

const expectationsFor = (projectName: string) => {
  const bp = EXPECTATIONS[projectName];
  if (!bp) throw new Error(`No breakpoint expectations for project "${projectName}"`);
  return bp;
};

const tid = (id: string) => `[data-testid='${id}']`;

const ensureBox = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box as NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;
};

/** Count the rendered grid tracks of an element's computed grid-template-columns. */
const gridTrackCount = async (locator: Locator): Promise<number> => {
  const value = await locator.evaluate((node) => getComputedStyle(node).gridTemplateColumns);
  return value.split(" ").filter(Boolean).length;
};

const mockApi = async (page: Page) => {
  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(configFixture),
    });
  });
  await page.route("**/api/run", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(runFixture),
    });
  });
};

const gotoDashboard = async (page: Page) => {
  await mockApi(page);
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  // Config panel hydrates from the mocked /api/config before we assert.
  await page.waitForSelector(`${tid("config-author-row")}`);
  await page.evaluate(() => document.fonts.ready);
};

test.describe("Dashboard responsive design", () => {
  test.beforeEach(async ({ page }) => {
    await gotoDashboard(page);
  });

  test("config panel renders and layout is responsive without overflow", async ({ page }, testInfo) => {
    const bp = expectationsFor(testInfo.project.name);

    // 1. Visibility: header + config content populated from mocked config.
    await expect(page.locator(tid("app-title"))).toBeVisible();
    await expect(page.locator(tid("app-title"))).toHaveText("X Engagement Reply Agent");
    await expect(page.locator(tid("config-error"))).toBeHidden();

    await expect(page.locator(tid("config-model"))).toHaveText(configFixture.modelId);
    await expect(page.locator(tid("config-parent-threshold"))).not.toHaveText("—");
    await expect(page.locator(tid("config-article-threshold"))).not.toHaveText("—");
    await expect(page.locator(tid("config-poll-interval"))).not.toHaveText("—");

    await expect(page.locator(tid("config-author-row"))).toHaveCount(configFixture.authors.length);
    await expect(page.locator(tid("prompt-file"))).toHaveCount(configFixture.replyPrompts.length);

    // 2. Layout mode: config grid collapses to a single column at <=860px.
    await expect(page.locator(".config-grid")).toBeVisible();
    expect(await gridTrackCount(page.locator(".config-grid"))).toBe(bp.configGridCols);

    // 3. No horizontal overflow at this breakpoint.
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual((viewport as { width: number }).width + 1);

    // 4. Controls reachable; select/button stack full-width only on mobile.
    const select = page.locator(tid("author-select"));
    const runButton = page.locator(tid("run-button"));
    await expect(select).toBeVisible();
    await expect(runButton).toBeVisible();

    const controlsBox = await ensureBox(page.locator(".controls"));
    const selectBox = await ensureBox(select);
    const buttonBox = await ensureBox(runButton);
    if (bp.controlsStacked) {
      // Stacked: each control spans (almost) the full controls width.
      expect(selectBox.width).toBeGreaterThan(controlsBox.width * 0.9);
      expect(Math.abs(selectBox.width - buttonBox.width)).toBeLessThanOrEqual(2);
    } else {
      // Side by side: neither control spans the full row.
      expect(selectBox.width).toBeLessThan(controlsBox.width * 0.9);
    }
  });

  test("run flow renders summary tiles, post cards and reply drafts", async ({ page }, testInfo) => {
    const bp = expectationsFor(testInfo.project.name);

    // Empty state before a run: prompt shown, no post cards yet.
    await expect(page.locator(tid("empty-state"))).toBeVisible();
    await expect(page.locator(tid("post-card"))).toHaveCount(0);

    // Core flow: pick an author and trigger the mocked run.
    await page.locator(tid("author-select")).selectOption("balajis");
    await page.locator(tid("run-button")).click();

    // Summary tiles surface the fixture numbers.
    await expect(page.locator(tid("run-summary"))).toBeVisible();
    await expect(page.locator(tid("run-error"))).toBeHidden();
    await expect(page.locator(tid("summary-subtasks"))).toHaveText(
      String(runFixture.summary.subtasksCreated),
    );
    await expect(page.locator(tid("summary-parentTasks"))).toHaveText("1");

    // Summary grid track count follows the breakpoint.
    expect(await gridTrackCount(page.locator(tid("run-summary")))).toBe(bp.summaryCols);

    // At least one post card with a matched article and reply drafts.
    await expect(page.locator(tid("post-card"))).toHaveCount(2);
    await expect(page.locator(tid("article-match")).first()).toBeVisible();

    const drafts = page.locator(tid("reply-draft"));
    await expect(drafts).toHaveCount(2);
    await expect(drafts.first().locator(tid("reply-response"))).not.toBeEmpty();
    await expect(drafts.first().locator(tid("reply-why"))).not.toBeEmpty();

    // Compose link points at the X intent endpoint and opens safely.
    const composeLink = page.locator(tid("compose-link")).first();
    await expect(composeLink).toHaveAttribute("href", /^https:\/\/x\.com\/intent\/post/);
    await expect(composeLink).toHaveAttribute("target", "_blank");

    // Results must not introduce horizontal overflow at any breakpoint.
    const viewport = page.viewportSize();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual((viewport as { width: number }).width + 1);

    // The compose link stays inside the viewport (no clipped CTA).
    const linkBox = await ensureBox(composeLink);
    expect(linkBox.x).toBeGreaterThanOrEqual(0);
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual((viewport as { width: number }).width + 1);
  });
});
