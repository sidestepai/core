import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/emit/cli.js";
import { emitBundle } from "../../src/emit/emit.js";
import exampleXano from "../fixtures/workspace/index.js";

describe("sidestep export CLI", () => {
  it("compiles the example workspace to an aggregate bundle file", async () => {
    const examplePath = fileURLToPath(new URL("../fixtures/workspace/index.ts", import.meta.url));
    const outPath = join(tmpdir(), `sidestep-bundle-${process.pid}.json`);
    try {
      await run(["export", examplePath, "--out", outPath]);
      const written = JSON.parse(readFileSync(outPath, "utf8"));
      expect(written.app).toBe("xano");
      expect(written.payload.function).toHaveLength(1);
      expect(written.payload.dbo).toHaveLength(1);
      expect(written.payload.trigger).toHaveLength(1);
      expect(written.payload.workspace).toMatchObject({ name: "example" });
      expect(typeof written.sig).toBe("string");
    } finally {
      rmSync(outPath, { force: true });
    }
  });

  it("resolves a DEFERRED seed at export, so it cannot pass here and fail at deploy (#209)", async () => {
    // `export` never used to call the seed source, so a bad row was caught only
    // by `deploy` — after a full-replace import had already begun. Both paths
    // now go through the same resolver, so they cannot disagree about what they
    // accept. The message must name the table, the row index and the column.
    const entry = fileURLToPath(new URL("../fixtures/seed-deferred/index.ts", import.meta.url));
    await expect(run(["export", entry])).rejects.toThrow(
      /table "probe_seed", seed row 0, column "name".*"a", "b"/s,
    );
  });

  it("emitBundle round-trips and matches export()", () => {
    expect(JSON.parse(emitBundle(exampleXano))).toEqual(exampleXano.export());
  });

  it("export rejects a module that does not default-export a Xano", async () => {
    const fnPath = fileURLToPath(new URL("../fixtures/function-module.ts", import.meta.url));
    await expect(run(["export", fnPath])).rejects.toThrow(/must default-export a Xano/);
  });

  it("unknown command throws usage", async () => {
    await expect(run(["frobnicate"])).rejects.toThrow(/Unknown command/);
  });
});
