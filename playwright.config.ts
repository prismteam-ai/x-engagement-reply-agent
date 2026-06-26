import { defineConfig } from "@playwright/test";

/**
 * Responsive design-test config for the X Engagement Reply Agent dashboard.
 *
 * One-command suite: the `webServer` block boots the real dashboard via
 * `pnpm run serve` on a fixed port and waits on `/api/health` before any spec
 * runs. Breakpoints are modeled as three chromium projects (mobile / tablet /
 * desktop) so each viewport is an explicit, named run. The specs mock
 * `/api/config` and `/api/run` with committed JSON fixtures (see
 * `test/design/fixtures`), so the suite is deterministic and needs no secrets
 * or live network — only the static serving and `/api/health` hit the real
 * server.
 */

const PORT = Number(process.env.DESIGN_PORT) || 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./test/design",
  testMatch: /.*\.spec\.(ts|js)$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "mobile",
      use: { browserName: "chromium", viewport: { width: 375, height: 812 } },
    },
    {
      name: "tablet",
      use: { browserName: "chromium", viewport: { width: 768, height: 1024 } },
    },
    {
      name: "desktop",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "pnpm run serve",
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
});
