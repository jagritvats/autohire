import { defineConfig } from "vitest/config";

/**
 * The source uses NodeNext `.js` import specifiers (invariant: ESM + `.js`). Vitest runs
 * over the TS source, so map `.js` → `.ts` at resolve time (mirrors the web app's
 * next.config.mjs `extensionAlias`).
 */
export default defineConfig({
  resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
  test: { include: ["test/**/*.test.ts", "src/**/*.test.ts"] },
});
