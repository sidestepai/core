import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emit } from "../src/emit/emit.js";
import { writeArtifact } from "../src/emit/write.js";
import { parseArgs, run } from "../src/emit/cli.js";
import { defineFunction } from "../src/function/define.js";
import { compile } from "../src/function/compile.js";
import { input } from "../src/inputs/input.js";
import { setVar } from "../src/statements/set-var.js";
import { c, ref } from "../src/values/value.js";
import { query, encodeQuery } from "../src/kinds/query.js";
import { table, encodeTable } from "../src/kinds/table.js";
import { f } from "../src/fields/catalog.js";
import { apiGroup } from "../src/kinds/api-group.js";

const sample = defineFunction({
  name: "omg1",
  input: { name: input.text({ methods: ["trim"] }) },
  stack: [setVar("x1", c.int(123))],
  response: ref("x1"),
});

describe("emit", () => {
  it("returns valid JSON that round-trips and deep-equals compile()", () => {
    const json = emit(sample);
    expect(JSON.parse(json)).toEqual(compile(sample));
  });

  it("an empty-stack function still emits valid JSON", () => {
    const json = emit(defineFunction({ name: "empty" }));
    expect(JSON.parse(json).run).toEqual([]);
  });

  it("dispatches a table def to the dbo payload (its real columns), not a function envelope", () => {
    const post = table({ name: "post", schema: { title: f.text({ required: true }) } });
    const parsed = JSON.parse(emit(post));
    // The dbo payload has a `schema` with the real columns — the old function-
    // shaped envelope (input/result/run) hid them.
    expect(parsed).toEqual(encodeTable(post));
    expect(parsed.schema.map((col: { name: string }) => col.name)).toEqual([
      "id",
      "created_at",
      "title",
    ]);
    expect(parsed).not.toHaveProperty("run");
  });

  it("dispatches a query def to the query envelope", () => {
    const g = apiGroup({ name: "Blog", canonical: "blog" });
    const q = query({ name: "list", verb: "GET", apiGroup: g, response: ref("posts") });
    expect(JSON.parse(emit(q))).toEqual(encodeQuery(q));
  });

  it("writeArtifact writes a file whose contents parse and match", () => {
    const path = join(tmpdir(), `sidestep-emit-${process.pid}.json`);
    try {
      writeArtifact(sample, path);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(compile(sample));
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("CLI", () => {
  it("parseArgs reads command, file, and --out", () => {
    expect(parseArgs(["compile", "f.ts", "--out", "o.json"])).toMatchObject({
      command: "compile",
      file: "f.ts",
      out: "o.json",
    });
  });

  it("parseArgs reads the lock flags (--lock, --lock=<path>, --frozen-lock)", () => {
    expect(parseArgs(["export", "f.ts", "--lock"])).toMatchObject({
      file: "f.ts",
      lock: true,
      lockPath: undefined,
    });
    expect(parseArgs(["export", "f.ts", "--lock=custom.lock", "--frozen-lock"])).toMatchObject({
      file: "f.ts",
      lock: true,
      lockPath: "custom.lock",
      frozenLock: true,
    });
    expect(parseArgs(["lock", "rename", "function", "a", "b"])).toMatchObject({
      command: "lock",
      positionals: ["rename", "function", "a", "b"],
    });
  });

  it("compiling the example module writes the expected JSON to --out", async () => {
    const examplePath = fileURLToPath(new URL("./fixtures/function-module.ts", import.meta.url));
    const outPath = join(tmpdir(), `sidestep-cli-${process.pid}.json`);
    try {
      await run(["compile", examplePath, "--out", outPath]);
      const written = JSON.parse(readFileSync(outPath, "utf8"));
      expect(written).toEqual(compile(sample));
    } finally {
      rmSync(outPath, { force: true });
    }
  });

  it("an unknown command throws a usage error", async () => {
    await expect(run(["frobnicate"])).rejects.toThrow(/Unknown command/);
  });
});
