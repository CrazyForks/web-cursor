import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser/specs",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
  },
  webServer: {
    command: "pnpm exec vite --config tests/browser/vite.config.ts",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
