import { defineConfig } from "vitest/config";

// Source uses ESM ".js" specifiers that point at ".ts" — mirror the web app's
// extensionAlias so Vite/vitest resolves them in tests too.
export default defineConfig({
  resolve: {
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
