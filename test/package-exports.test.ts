import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  exports: Record<string, unknown>;
};

describe("package exports map", () => {
  // Consumers and version-audit tooling read the resolved version via
  // `require('@sidestep/core/package.json').version`. Without this subpath the
  // exports map turns that into ERR_PACKAGE_PATH_NOT_EXPORTED. See issue #7.
  it("exposes ./package.json so the conventional version probe resolves", () => {
    expect(pkg.exports["./package.json"]).toBe("./package.json");
  });
});
