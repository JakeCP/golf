import { defineConfig, devices } from "@playwright/test";

// Standalone Playwright config for the locked-modal fixture tests under
// tests/playwright/. These are real browser tests against inline HTML fixtures;
// the rest of the suite still runs under vitest with @playwright/test mocked.
export default defineConfig({
  testDir: "./tests/playwright",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
