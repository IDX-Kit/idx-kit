import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/demo",
  workers: 1,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4321", javaScriptEnabled: false },
  reporter: "list",
});
