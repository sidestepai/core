/**
 * Codegen import check — does every generated specifier point at a real file?
 *
 * Maintainer tooling, and the check a replay cannot make. `codegen:replay` proves
 * the DECODER ran over a bundle; it says nothing about whether the tree it emitted
 * would load. A wrong relative specifier is invisible to both the decoder and the
 * bundle round trip, and fails at import time with `ERR_MODULE_NOT_FOUND` — after
 * install, in the user's project.
 *
 * Resolves every relative import in every generated file against the tree's own
 * file list, for every bundle the sweep captured. Pure string work, so it covers
 * the whole corpus in seconds rather than needing 177 `npm install`s.
 *
 *   npm run codegen:imports -- --dir /tmp/swb
 *
 * Flags:
 *   --dir <dir>   a sweep --out dir holding projects/<id>/bundle.json
 *                 (default /tmp/swb)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeBundle, type GeneratedFile } from "../src/codegen/index.js";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Resolve `./x.js` / `../a/b.js` against the directory of the importing file. */
function resolveSpecifier(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    else if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/** Every unresolvable relative import in a generated tree, as readable lines. */
function brokenImports(files: readonly GeneratedFile[]): string[] {
  const present = new Set(files.map((f) => f.path));
  const out: string[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".ts")) continue;
    for (const m of file.contents.matchAll(/^import(?: type)? \{[^}]*\} from "(\.[^"]*)";$/gm)) {
      const specifier = m[1]!;
      // Generated specifiers are always `.js` (ESM), pointing at a `.ts` source.
      const target = resolveSpecifier(file.path, specifier).replace(/\.js$/, ".ts");
      if (!present.has(target)) out.push(`${file.path} → ${specifier} (no ${target})`);
    }
  }
  return out;
}

const dir = join(flag("dir", "/tmp/swb")!, "projects");
let workspaces = 0;
let broken = 0;
let imports = 0;

for (const entry of readdirSync(dir).sort()) {
  let bundle: { payload: Record<string, unknown> };
  try {
    bundle = JSON.parse(readFileSync(join(dir, entry, "bundle.json"), "utf8"));
  } catch {
    continue;
  }
  workspaces++;
  const files = decodeBundle(bundle).files;
  for (const file of files) {
    if (file.path.endsWith(".ts")) {
      imports += [...file.contents.matchAll(/^import(?: type)? \{[^}]*\} from "\.[^"]*";$/gm)].length;
    }
  }
  const bad = brokenImports(files);
  if (bad.length > 0) {
    broken++;
    console.error(`\n${entry}: ${bad.length} unresolvable`);
    for (const line of bad.slice(0, 5)) console.error(`  ${line}`);
  }
}

console.log(
  `\n${workspaces} workspaces, ${imports} relative imports checked, ` +
    `${broken} workspaces with an unresolvable specifier`,
);
process.exit(broken === 0 ? 0 : 1);
