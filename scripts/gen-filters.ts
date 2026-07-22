/**
 * Generate one example file per value filter (`fl.<name>`), driven by
 * FILTER_SPECS (arg names + types) and FILTER_NAMES. Each example pipes a
 * group-appropriate seed value through the filter inside a function. Existing
 * files are never overwritten. Run: `tsx scripts/gen-filters.ts`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FILTER_NAMES, FILTER_SPECS } from "../src/values/generated/filters.generated.js";

const ROOT = fileURLToPath(new URL("../examples/sandbox/filters", import.meta.url));

function groupDir(g?: string): string {
  if (!g || g === "?") return "misc";
  return g.replace(/\s+functions?$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function seedFor(group?: string): string {
  switch (group) {
    case "math":
      return "c.decimal(6.5)";
    case "text":
    case "security":
      return `c.text("Hello World")`;
    case "array":
    case "aggregate functions":
    case "manipulation":
      return "c.array([3, 1, 2])";
    case "comparison":
      return "c.int(5)";
    case "timestamp":
      return "c.int(1700000000000)";
    case "geo":
      return `c.obj({ type: "Point", coordinates: [0, 0] })`;
    default:
      return `c.text("value")`;
  }
}

function argExpr(type?: string, name?: string): string {
  const t = (type ?? "").toLowerCase();
  if (/int|integer/.test(t)) return "c.int(2)";
  if (/decimal|float|number/.test(t)) return "c.decimal(2)";
  if (/bool/.test(t)) return "c.bool(true)";
  if (/\[\]|array|list/.test(t)) return "c.array([1, 2])";
  if (/obj|json/.test(t)) return "c.obj({})";
  if (name && /path|key|field/.test(name)) return `c.text("field")`;
  return `c.text("x")`;
}

function camel(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+(.)/g, (_, ch: string) => ch.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "");
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

let created = 0;
let skipped = 0;
for (const name of FILTER_NAMES) {
  const spec = (FILTER_SPECS as Record<string, { args?: { name: string; type: string; optional?: boolean }[]; group?: string; description?: string }>)[name];
  const group = spec?.group;
  const dir = groupDir(group);
  const file = join(ROOT, dir, `${name}.ts`);
  if (existsSync(file)) {
    skipped++;
    continue;
  }
  // Supply only required args (keeps each example minimal + valid). Variadic
  // filters (no spec) take zero args.
  const required = (spec?.args ?? []).filter((a) => !a.optional);
  const argExprs = required.map((a) => argExpr(a.type, a.name));
  const filterCall = `fl["${name}"](${argExprs.join(", ")})`;
  const desc = spec?.description ? `\n * ${spec.description.replace(/\*\//g, "*\\/")}` : "";
  const constId = `filter${cap(camel(name))}`;

  const src = `/**
 * \`fl.${name}\` filter${group && group !== "?" ? ` (group: ${group})` : ""}.${desc}
 *
 * Filters attach to a value with \`withFilters(value, fl.<name>(...))\`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const ${constId} = defineFunction({
  name: "ex_filter_${name.replace(/[^a-zA-Z0-9]/g, "_")}",
  stack: [s.set_var("out", withFilters(${seedFor(group)}, ${filterCall}))],
  response: ref("out"),
});
`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, src);
  created++;
}

console.log(`filters: ${created} created, ${skipped} skipped.`);
