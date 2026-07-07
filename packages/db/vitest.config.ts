import { defineConfig } from "vitest/config";

// Source uses ESM ".js" specifiers that point at ".ts" (incl. cross-package into
// @jobflow/core) — mirror the web app's extensionAlias so vitest resolves them.
export default defineConfig({
  resolve: {
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
