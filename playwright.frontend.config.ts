import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm start --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
  },
});
