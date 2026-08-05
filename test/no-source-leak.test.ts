import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sourceLeaks } from "./helpers/source-leak.js";

/**
 * Repo-wide guard against leaking Xano's source-internal naming (project
 * CLAUDE.md R10), over every `.ts` and `.md` file in `src/`, `scripts/`, and
 * `test/`. The list it enforces lives in `./helpers/source-leak.ts`.
 *
 * Two narrower versions of this already existed for the scaffold templates
 * (`test/emit/*`), which is where a leak would reach a user's own repo. That
 * left everything else uncovered, and it drifted: engine method names accreted
 * in comments across `src/` and `test/` where nothing was watching. This is the
 * same rule applied to every source file the repo ships or publishes.
 *
 * ## What counts as a leak
 *
 * Names that only someone reading the engine's source would know: its class and
 * method names, its internal namespaces, and the repositories it lives in.
 *
 * ## What does NOT count
 *
 * The WIRE FORMAT is not a leak, and must stay spellable. Stored statement
 * names (`mvp:*`), schema-DSL directives (`!assign context`, `!kinds assign`),
 * tags (`const:expr2`), and public URL paths (`/x2/mcp/…`) are all things the
 * SDK legitimately reads or writes and that a user can observe from outside.
 * `x2` is matched only as a standalone word for that reason — the URL path is a
 * real, user-facing route.
 */

const ROOTS = ["src", "scripts", "test"];
const EXTENSIONS = [".ts", ".md"];
/**
 * The one file allowed to spell these identifiers: it is the list itself. Every
 * other file — including this test — is scanned.
 */
const LIST = join("test", "helpers", "source-leak.ts");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (EXTENSIONS.some((e) => path.endsWith(e)) && path !== LIST) out.push(path);
  }
  return out;
}

describe("no Xano source-internal naming (CLAUDE.md R10)", () => {
  const files = ROOTS.flatMap((root) => sourceFiles(root));

  it("covers the whole tree, so this cannot silently stop checking", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("names no engine repository, class, method, or internal namespace", () => {
    const leaks: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const pattern of sourceLeaks(line)) {
          leaks.push(`${file}:${i + 1}  /${pattern}/  ${line.trim()}`);
        }
      });
    }
    expect(leaks, `source-internal naming found:\n${leaks.join("\n")}`).toEqual([]);
  });

  it("still allows the wire format and public URL paths", () => {
    // Guards the guard: these are observable from outside and must stay
    // spellable, or the rule would start deleting things users need.
    for (const allowed of [
      'const name = "mvp:mcp_call_tool";',
      'target: "!assign context.value"',
      '`/x2/mcp/${canonical}/${token}/stream`',
      'tag: "const:expr2"',
    ]) {
      expect(sourceLeaks(allowed), allowed).toEqual([]);
    }
  });
});
