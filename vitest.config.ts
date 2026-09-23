import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: "./tests/global-setup.ts",
    setupFiles: ["./tests/register.ts"],
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@apiweld/core": path.resolve("packages/core/src/index.ts"),
      "@apiweld/cli": path.resolve("packages/cli/src/main.ts"),
      "@apiweld/mcp": path.resolve("packages/mcp/src/server.ts"),
      "@apiweld/gen-heyapi": path.resolve("packages/gen-heyapi/src/index.ts"),
      "@apiweld/gen-oapi": path.resolve("packages/gen-oapi/src/index.ts"),
      apiweld: path.resolve("packages/apiweld/src/index.ts"),
    },
  },
});
