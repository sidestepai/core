/**
 * Empirical filter-resolvability probe (issue #106) — the authoritative source for
 * `vendor/filters-resolvable.json`, the allowlist of value-pipeline filters the
 * engine can actually resolve at runtime.
 *
 * The typed `fl.*` catalog is distilled from the LSP's "names applicable to a
 * variable" list, which lumps in operators, aggregates, type-methods, and
 * db.query filters that 500 (`Unable to locate func entry`) when used in a value
 * `filters[]` pipeline on a DEPLOYED endpoint. Static schema (`mvp/xs` `pipe`) is
 * close but not 1:1 with runtime. Only execution is authoritative, so this probe
 * runs every candidate filter and records which resolve.
 *
 * Method: author one function per candidate that applies the filter to a constant,
 * import into the disposable validate sandbox, run each, and classify. Arg-
 * correctness is irrelevant: any outcome OTHER than the func-entry error means the
 * engine RESOLVED the filter — success or an arg/type error both prove
 * resolvability. Only `Unable to locate func entry` means a true phantom.
 *
 * Run (maintainer step, like `codegen:filters --refresh`; needs a live sandbox):
 *   tsx scripts/probe-filters.ts            # reads XANO_VALIDATE_* from .env
 * Writes `vendor/filters-resolvable.json` (committed allowlist) + a debug detail
 * file. `codegen:filters` then intersects the catalog against this allowlist.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace, defineFunction, s, c, ref, withFilters, filter, serializeBundle } from "../src/index.js";
import { resolveValidateConfig } from "../src/validate/config.js";
import { MetaClient } from "../src/validate/meta-client.js";

const ROOT = join(import.meta.dirname, "..");
const catalog = JSON.parse(readFileSync(join(ROOT, "vendor/filters.json"), "utf8")) as { names: string[] };
const names = catalog.names;

// index → filter name; probe_<i> keeps the function name valid regardless of the
// filter's own characters.
const fns = names.map((name, i) =>
  defineFunction({
    name: `probe_${i}`,
    stack: [s.set_var("out", withFilters(c.int(1), filter(name)))],
    response: ref("out"),
  }),
);

const ws = workspace("filter_probe").registerFunctions(fns);
const bundle = serializeBundle((ws as unknown as { export(): unknown }).export());

const FUNC_ENTRY = "Unable to locate func entry";

async function main() {
  const config = resolveValidateConfig();
  const client = new MetaClient(config);
  console.error(`Importing ${fns.length} probe functions → sandbox…`);
  const imp = await client.importBundle(bundle, { reset: true });
  if (imp.workspaceId === undefined) throw new Error(`Import returned no workspaceId. Raw: ${imp.raw.slice(0, 400)}`);
  console.error(`Imported to workspace ${imp.workspaceId} (${imp.baseUrl}). Running…`);

  const results: Array<{ name: string; resolvable: boolean; status: number; sample: string }> = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const res = await client.runFunction(imp.workspaceId, `probe_${i}`, {});
    const bodyStr = typeof res.body === "string" ? res.body : (JSON.stringify(res.body) ?? "");
    const isPhantom = bodyStr.includes(`${FUNC_ENTRY}: ${name}`) || bodyStr.includes(FUNC_ENTRY);
    results.push({ name, resolvable: !isPhantom, status: res.status, sample: bodyStr.slice(0, 160) });
    if ((i + 1) % 25 === 0) console.error(`  …${i + 1}/${names.length}`);
  }

  const phantoms = results.filter((r) => !r.resolvable).map((r) => r.name).sort();
  const resolvable = results.filter((r) => r.resolvable).map((r) => r.name).sort();
  // Committed allowlist: just the resolvable names + provenance. codegen intersects
  // the distilled catalog against `resolvable`.
  writeFileSync(
    join(ROOT, "vendor/filters-resolvable.json"),
    JSON.stringify(
      {
        note: "Empirically runtime-resolvable value-pipeline filters (issue #106). Regenerate with `tsx scripts/probe-filters.ts` against a sandbox.",
        resolvable,
        phantoms,
      },
      null,
      2,
    ) + "\n",
  );
  // Debug detail (per-name status/sample) — not committed; useful for auditing.
  writeFileSync(
    join(ROOT, "scripts/probe-results.json"),
    JSON.stringify({ total: results.length, resolvable, phantoms, detail: results }, null, 2) + "\n",
  );
  console.error(`\nDone. resolvable=${resolvable.length} phantoms=${phantoms.length}`);
  console.error(`Wrote vendor/filters-resolvable.json`);
  console.error(`Phantoms (${phantoms.length}): ${phantoms.join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
