import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Let the `examples/` sandbox import the package by its public name while
      // resolving to source in tests (mirrors the examples tsconfig `paths`).
      "@sidestep/core/node": fileURLToPath(new URL("./src/node.ts", import.meta.url)),
      "@sidestep/core/codegen": fileURLToPath(new URL("./src/codegen-entry.ts", import.meta.url)),
      "@sidestep/core": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
