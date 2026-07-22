/**
 * Generate example files for the 154 codegen'd declarative statements, driven by
 * the real GENERATED_SPECS (field names + types + routes) joined to each
 * statement's public `s.<sPath>` from the manifest. Hand-authored examples
 * (specials, rich db/control-flow) are never overwritten — existing files are
 * skipped. Run: `tsx scripts/gen-examples.ts`.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_SPECS } from "../src/statements/generated/specs.generated.js";

const ROOT = fileURLToPath(new URL("../examples/implementations", import.meta.url));
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"));

/** storedName -> public sPath (e.g. "mvp:array_find" -> "array.find"). */
const sPathByStored = new Map<string, string>();
for (const s of manifest.statements) {
  if (s.storedName && s.sPath) sPathByStored.set(s.storedName, s.sPath);
}

const NUMERIC_HINTS = /^(timeout|size|ttl|count|page|per_page|offset|limit|from|n|amount|decimals|expiration|cnt|len|length|precision|radius|width|height|quality)$/;

/** Pick a source-text Value constructor for a `value`-typed field. */
function valueExpr(field: string, ns: string): string {
  if (NUMERIC_HINTS.test(field)) return "c.int(1)";
  if (/password|secret|token|key/i.test(field)) return `c.text("••••")`;
  if (field === "payload" || field === "params" || field === "headers" || field === "doc" || field === "metadata")
    return `c.obj({})`;
  if (field === "ids" || field === "items" || field === "sort" || field === "included_fields")
    return `c.array([])`;
  if (ns === "math") return "c.int(1)";
  return `c.text("example")`;
}

/** The set_var seed value for an argNameIsVar target, by namespace. */
function seedFor(ns: string): string {
  if (ns === "array") return "c.array([1, 2, 3])";
  if (ns === "text") return `c.text("hello")`;
  if (ns === "object") return `c.obj({ a: 1 })`;
  return "c.int(0)";
}

interface Emit {
  imports: Set<string>;
  pre: string[];
  args: string[];
  hasOutput: boolean;
  varName?: string;
}

function build(spec: (typeof GENERATED_SPECS)[number], sPath: string): Emit | null {
  const ns = sPath.split(".")[0];
  const e: Emit = { imports: new Set(["defineFunction", "s"]), pre: [], args: [], hasOutput: false };
  const argNameIsVar = (spec as { argNameIsVar?: boolean }).argNameIsVar === true;

  for (const rule of spec.rules) {
    const { field, type } = rule as { field: string; type: string; optional?: boolean };
    const optional = (rule as { optional?: boolean }).optional ?? false;
    const routeKind = (rule as { route?: { kind?: string } }).route?.kind;

    if (routeKind === "as") {
      e.args.push(`as: "result"`);
      e.hasOutput = true;
      continue;
    }
    if (argNameIsVar && field === "name") {
      e.varName = "acc";
      e.imports.add("c");
      e.pre.push(`s.set_var("acc", ${seedFor(ns)})`);
      e.args.push(`name: "acc"`);
      continue;
    }
    // Only emit required fields (keeps the example minimal + always valid);
    // an optional `value`/`comparison` on an output-only statement is skipped.
    if (optional && type !== "value") continue;
    if (type === "value") {
      if (optional && !argNameIsVar) {
        // Skip optional values unless the statement would otherwise be empty.
        continue;
      }
      e.imports.add("c");
      e.args.push(`${field}: ${valueExpr(field, ns)}`);
    } else if (type === "comparison") {
      e.imports.add("c");
      e.imports.add("ref");
      e.imports.add("expr");
      e.args.push(`${field}: expr(ref("$this"), "=", c.int(1))`);
    } else if (type === "string") {
      e.args.push(`${field}: "example"`);
    }
  }

  // Ensure statements with only-optional value fields still show at least the call.
  return e;
}

function fnName(sPath: string): string {
  return "ex_" + sPath.replace(/[^a-zA-Z0-9]/g, "_");
}
const RESERVED = new Set([
  "throw", "await", "return", "for", "while", "switch", "try", "catch",
  "delete", "in", "do", "if", "else", "new", "void", "yield", "class",
]);
function constName(sPath: string): string {
  const camel = sPath.replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase());
  const name = camel.replace(/[^a-zA-Z0-9]/g, "");
  return RESERVED.has(name) ? `${name}Stmt` : name;
}

let created = 0;
let skipped = 0;
for (const spec of GENERATED_SPECS) {
  const sPath = sPathByStored.get(spec.name);
  if (!sPath) {
    continue;
  }
  const parts = sPath.split(".");
  const file = join(ROOT, "statements", ...parts) + ".ts";
  if (existsSync(file)) {
    skipped++;
    continue;
  }
  const e = build(spec, sPath);
  if (!e) continue;

  const call = `s.${sPath}(${e.args.length ? `{ ${e.args.join(", ")} }` : "{}"})`;
  const stack = [...e.pre, call];
  if (e.hasOutput) {
    e.imports.add("ref");
  }
  const importList = [...e.imports].sort().join(", ");
  const responseLine = e.hasOutput ? `\n  response: ref("result"),` : "";
  const src = `/**
 * \`s.${sPath}\` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { ${importList} } from "@sidestep/core";

export const ${constName(sPath)} = defineFunction({
  name: "${fnName(sPath)}",
  stack: [
    ${stack.join(",\n    ")},
  ],${responseLine}
});
`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, src);
  created++;
}

console.log(`generated statements: ${created} created, ${skipped} skipped (existing).`);
