import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    cli: "src/emit/cli.ts",
    bin: "src/emit/bin.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  // `tsx` is an optional runtime dependency the CLI loads on demand to read a
  // `.ts` workspace entry. It must stay an external `import("tsx/esm/api")`
  // resolved from the consumer's install — bundling its loader produces a copy
  // that can't register Node's module hooks, so the `.ts` fallback would break.
  external: ["tsx", "tsx/esm/api"],
});
