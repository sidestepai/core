/**
 * Agent-grounding manifest generator (`npm run manifest`). Writes two committed
 * artifacts at the repo root:
 *   - manifest.json — machine-readable authoring surface (kinds, statements,
 *     value/tag catalog, coverage).
 *   - llms.txt      — concise plaintext grounding doc for LLM agents.
 *
 * Both are pure functions of the SDK's sources of truth (`buildManifest`), so
 * regenerating is deterministic. The manifest test fails if the committed files
 * drift from a fresh build. Run under tsx (`npm run manifest`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, renderLlmsTxt } from "../src/manifest/manifest.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const manifest = buildManifest({ version: pkg.version });

const jsonPath = join(ROOT, "manifest.json");
const llmsPath = join(ROOT, "llms.txt");
writeFileSync(jsonPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(llmsPath, renderLlmsTxt(manifest));

console.log(
  `Wrote ${jsonPath} and ${llmsPath}\n` +
    `  object kinds: ${manifest.coverage.objectKinds.implemented}/${manifest.coverage.objectKinds.total}\n` +
    `  statements:   ${manifest.coverage.statements.implemented}/${manifest.coverage.statements.total}`,
);
