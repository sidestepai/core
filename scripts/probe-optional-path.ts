/**
 * Empirical probe — which filters accept their declared-required `path` arg being
 * ABSENT?
 *
 * 20 filters in `vendor/filters.json` declare a `path` argument with no
 * `optional` flag, so `fl.<name>()` does not type-check. A real pulled workspace
 * stores `filter_null` and `filter_empty_text` with `arg: []`, which means the
 * upstream spec is stricter than the engine on at least those two — and a
 * generated tree that reproduces such a filter faithfully fails to compile.
 *
 * The upstream spec is not the authority here; the running engine is. Same
 * argument (and the same method) as `probe-filters.ts`: author one function per
 * candidate that applies the filter with NO arguments, run it, and read the
 * outcome. The difference is what counts as a pass — resolvability is assumed,
 * so a missing-argument error is the FAILURE case rather than a success.
 *
 * `path` means two different things across the 20, which is why this probes
 * rather than generalizes. On an ARRAY filter it selects a member inside each
 * element and omitting it should mean "the element itself" (`fsort`'s own
 * description calls the path optional). On a `manipulation` filter it names the
 * object path being addressed, where omitting it may be meaningless. Only
 * execution settles which is which.
 *
 * Writes `vendor/filters-optional-args.json`, which `codegen:filters` applies
 * after distilling — so `--refresh` re-reading a spec that still says `path` is
 * required cannot silently undo this.
 *
 * Run (maintainer step; needs a live sandbox):
 *   tsx scripts/probe-optional-path.ts     # reads XANO_VALIDATE_* from .env
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace, defineFunction, s, c, ref, withFilters, filter, serializeBundle } from "../src/index.js";
import { obj } from "../src/values/obj.js";
import { resolveValidateConfig } from "../src/validate/config.js";
import { MetaClient } from "../src/validate/meta-client.js";

const ROOT = join(import.meta.dirname, "..");
const specs = (
  JSON.parse(readFileSync(join(ROOT, "vendor/filters.json"), "utf8")) as {
    specs: Record<string, { args?: Array<{ name: string; optional?: boolean }>; group?: string }>;
  }
).specs;

const candidates = Object.entries(specs)
  .filter(([, spec]) => spec.args?.some((a) => a.name === "path" && a.optional !== true))
  .map(([name, spec]) => ({ name, group: spec.group ?? "" }));

// Applied to a list of objects: the shape every one of these filters is
// documented against, so a failure is about the missing ARG rather than the
// operand being the wrong type.


const fns = candidates.map((c_, i) =>
  defineFunction({
    name: `probe_${i}`,
    stack: [
      s.set_var("rows", obj({ a: c.int(1) })),
      s.set_var("out", withFilters(ref("rows"), filter(c_.name))),
    ],
    response: ref("out"),
  }),
);

const ws = workspace("optional_path_probe").registerFunctions(fns);
const bundle = serializeBundle((ws as unknown as { export(): unknown }).export());

async function main(): Promise<void> {
  const client = new MetaClient(resolveValidateConfig());
  console.error(`Importing ${fns.length} probe functions → sandbox…`);
  const imp = await client.importBundle(bundle);
  if (imp.workspaceId === undefined) throw new Error(`no workspaceId: ${imp.raw.slice(0, 300)}`);
  console.error(`workspace ${imp.workspaceId} (${imp.baseUrl}). Running…\n`);

  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const [i, c_] of candidates.entries()) {
    const res = await client.runFunction(imp.workspaceId, `probe_${i}`, {});
    const body = typeof res.body === "string" ? res.body : (JSON.stringify(res.body) ?? "");
    // The HTTP status is 200 either way — a filter that threw still ran. The
    // engine's own verdict is `result.status`, and a missing required argument
    // surfaces as an `exception` reading "Too few arguments to function".
    const verdict = (res.body as { result?: { status?: string } } | undefined)?.result?.status;
    const ok = verdict === "ok";
    (ok ? accepted : rejected).push(c_.name);
    console.error(
      `${ok ? "OPTIONAL" : "REQUIRED"}  ${c_.name.padEnd(22)} ${String(verdict).padEnd(10)} ${c_.group.padEnd(13)} ${body.slice(0, 100)}`,
    );
  }
  writeFileSync(
    join(ROOT, "vendor/filters-optional-args.json"),
    JSON.stringify(
      {
        note: "Args the ENGINE accepts as absent though the upstream filter spec marks them required. Regenerate with `tsx scripts/probe-optional-path.ts` against a sandbox; `codegen:filters` applies it after distilling.",
        optional: Object.fromEntries(accepted.sort().map((name) => [name, ["path"]])),
        required: rejected.sort(),
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`\noptional (engine ran it with no arg): ${accepted.length}\n  ${accepted.join(", ")}`);
  console.error(`required (engine threw "too few arguments"): ${rejected.length}\n  ${rejected.join(", ")}`);
  console.error(`\nWrote vendor/filters-optional-args.json`);
  await client.dispose();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
