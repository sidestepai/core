/**
 * Field-method codegen. A table column / function input carries a `methods[]`
 * pipeline of bind-time validators/transforms (`trim`, `min:8`, `lower`, …).
 * Unlike the value `filters[]` pipeline (377 names, any value), the methods
 * valid on a *field* are a small set that depends on the field's **type** — and
 * the engine declares that set authoritatively per type in the column-create API
 * schema (cloud-client `app/workspace/mvp/app/meta/dbo-schema-<type>.yaml`, the
 * `?filters?` block). This codegen distills those per-type sets so each `f.<type>`
 * / `input.<type>` constructor can type its `methods` to exactly the names valid
 * for that type, giving authors (and code-gen agents) discoverable, checked values.
 *
 * Two-stage, like the filter/statement codegen:
 *   1. `--refresh` parses every `dbo-schema-<type>.yaml` `?filters?` block into the
 *      committed `vendor/field-methods.json` (offline snapshot).
 *   2. always: emit `src/fields/generated/field-methods.generated.ts` from that JSON.
 *
 * Run:
 *   npm run codegen:methods            # regenerate the TS from vendor/field-methods.json
 *   npm run codegen:methods -- --refresh   # re-distill upstream → vendor JSON, then emit
 *
 * Reproducible: same vendor JSON → identical TS (types + methods sorted by name).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const VENDOR = join(ROOT, "vendor/field-methods.json");
const OUT = join(ROOT, "src/fields/generated/field-methods.generated.ts");

const META_DIR =
  process.env.XANO_DBO_SCHEMA_DIR ??
  join(homedir(), "git/cloud-client/extensions/MVP/includes/xano/app/workspace/mvp/app/meta");

/**
 * Maps a `dbo-schema-<type>.yaml` basename type to the sidestep catalog/input
 * constructor key (and thus the generated `<Key>Method` type name). Only types
 * whose schema declares a `?filters?` block appear; everything else has no
 * field methods (its `methods` accepts only the explicit `{name,arg}` escape hatch).
 */
const TYPE_KEY: Record<string, string> = {
  text: "text",
  int: "int",
  decimal: "decimal",
  email: "email",
  password: "password",
  vector: "vector",
  tableref: "tableRef",
};

/** Family aliases: a type with no own `?filters?` block that shares another's set.
 * `email` stores as `text` (the schema's `type=email: text`) and the corpus uses
 * trim/lower on email columns, so email inherits text's methods. */
const ALIAS: Record<string, string> = { email: "text" };

/** name → arg type (the colon-form argument's type, e.g. `int`; `bool` = flag, no arg). */
type MethodSet = Record<string, string>;
interface MethodCatalog {
  /** Per catalog key (text/int/…): method name → arg type. */
  types: Record<string, MethodSet>;
}

// --- distillation (--refresh) -------------------------------------------------

/** Extract the `?filters?` block of a dbo-schema yaml into name → arg-type. */
function parseFilters(src: string): MethodSet {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /\?filters\?/.test(l));
  if (start === -1) return {};
  const headIndent = lines[start].search(/\S/);
  const out: MethodSet = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (indent <= headIndent) break; // dedented out of the filters block
    const m = line.match(/^\s*\??([a-zA-Z_]+)\??(?:=[^:]*)?:\s*(.+?)\s*$/);
    if (!m) continue;
    const [, name, rawType] = m;
    out[name] = rawType.split("|")[0].trim(); // strip `|min(0)` constraints
  }
  return out;
}

function refresh(): MethodCatalog {
  if (!existsSync(META_DIR)) throw new Error(`--refresh: dbo-schema dir not found: ${META_DIR}`);
  const types: Record<string, MethodSet> = {};
  for (const file of readdirSync(META_DIR)) {
    const m = file.match(/^dbo-schema-(.+)\.yaml$/);
    if (!m) continue;
    const key = TYPE_KEY[m[1]];
    if (!key) continue;
    const methods = parseFilters(readFileSync(join(META_DIR, file), "utf8"));
    if (Object.keys(methods).length) types[key] = methods;
  }
  for (const [alias, source] of Object.entries(ALIAS)) {
    if (!types[alias] && types[source]) types[alias] = types[source];
  }
  // Sort keys + methods for reproducible output.
  const sorted: Record<string, MethodSet> = {};
  for (const key of Object.keys(types).sort()) {
    const set = types[key];
    sorted[key] = Object.fromEntries(Object.keys(set).sort().map((n) => [n, set[n]]));
  }
  return { types: sorted };
}

// --- emission -----------------------------------------------------------------

/** Catalog key → generated TS type name, e.g. `text` → `TextMethod`, `tableRef` → `TableRefMethod`. */
function typeName(key: string): string {
  return `${key.charAt(0).toUpperCase()}${key.slice(1)}Method`;
}

function emit(cat: MethodCatalog): string {
  const keys = Object.keys(cat.types);
  const unions = keys
    .map((key) => {
      const members = Object.keys(cat.types[key]).map((n) => JSON.stringify(n));
      return `/** Field methods valid on \`${key}\` fields. */\nexport type ${typeName(key)} = ${members.join(" | ")};`;
    })
    .join("\n\n");
  return `/**
 * AUTO-GENERATED by scripts/codegen-field-methods.ts — DO NOT EDIT BY HAND.
 *
 * Per-field-type method-name unions, distilled from the engine's column-create
 * API schema (the per-type field-schema definitions). Each
 * \`f.<type>\` / \`input.<type>\` constructor types its \`methods\` against the
 * matching union so only names valid for that field type are accepted (the
 * explicit \`{ name, arg }\` form remains a universal escape hatch).
 *
 * Regenerate with \`npm run codegen:methods\` (\`-- --refresh\` to re-distill upstream).
 */

/** Per-field-type method metadata (method name → colon-form arg type; \`bool\` = flag, no arg). */
export const FIELD_METHODS: Readonly<Record<string, Readonly<Record<string, string>>>> = ${JSON.stringify(cat.types, null, 2)};

${unions}
`;
}

// --- main ---------------------------------------------------------------------

const doRefresh = process.argv.includes("--refresh");
let catalog: MethodCatalog;
if (doRefresh) {
  catalog = refresh();
  writeFileSync(VENDOR, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`Refreshed ${VENDOR}: ${Object.keys(catalog.types).length} typed field types.`);
} else {
  catalog = JSON.parse(readFileSync(VENDOR, "utf8")) as MethodCatalog;
}
writeFileSync(OUT, emit(catalog));
const total = Object.values(catalog.types).reduce((n, s) => n + Object.keys(s).length, 0);
console.log(`Wrote ${OUT}: ${Object.keys(catalog.types).length} types, ${total} methods.`);
