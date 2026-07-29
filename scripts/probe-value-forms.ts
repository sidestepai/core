/**
 * Empirical probe for two engine questions the offline corpus cannot answer.
 *
 * Both came out of a codegen sweep over real workspaces, where a stored shape
 * the SDK cannot author sent an otherwise-decodable value to `rawValue()`. The
 * fix in each case depends on what the ENGINE does, not on what the SDK prefers:
 *
 * 1. **Empty `const:obj`.** Real workspaces store `{tag:"const:obj", value:""}`
 *    (and `value:null`) where the current form is `"{}"`. If the engine treats
 *    them identically — same persisted shape after a save, same runtime value —
 *    then normalizing the empty forms forward to `"{}"` is safe, and every one of
 *    those values decodes to a readable `c.obj({})`. If it does NOT, they are
 *    different values and must stay verbatim.
 *
 * 2. **`c.now()`.** The SDK emits `const:"now"` piped through `to_epoch_ms`; the
 *    engine has a native `const:epochms` constant that needs no filter. This
 *    checks that the native tag evaluates to the same epoch-ms number, and — the
 *    part only a live engine can answer — whether the engine REWRITES the SDK's
 *    filtered form into the native tag on save (which would mean the current
 *    encoder never round-trips on a real instance).
 *
 * Method: author one function per form, import into the disposable validate
 * sandbox, read the workspace back to see what was PERSISTED, then run each to
 * see what it EVALUATES to. Both halves matter — a shape can survive the save
 * and still mean something different at runtime.
 *
 * Run (maintainer step; needs a live sandbox, resets it):
 *   tsx scripts/probe-value-forms.ts        # reads XANO_VALIDATE_* from .env
 */
import { workspace, defineFunction, s, c, ref, filter, withFilters, serializeBundle } from "../src/index.js";
import { rawValue } from "../src/values/raw-value.js";
import type { TaggedValue } from "../src/types/xdo.js";
import { resolveValidateConfig } from "../src/validate/config.js";
import { MetaClient } from "../src/validate/meta-client.js";

/** One authored form, and what the probe is asking about it. */
interface Case {
  readonly name: string;
  readonly question: string;
  readonly value: TaggedValue;
}

const CASES: Case[] = [
  {
    name: "obj_empty_string",
    question: 'const:obj stored as value:"" — the older empty form',
    value: rawValue({ value: "", tag: "const:obj" }),
  },
  {
    name: "obj_null",
    question: "const:obj stored as value:null — the other empty form seen in the wild",
    value: rawValue({ value: null as unknown as string, tag: "const:obj" }),
  },
  {
    name: "obj_braces",
    question: 'const:obj stored as value:"{}" — what c.obj({}) writes today (the control)',
    value: c.obj({}),
  },
  {
    name: "now_filtered",
    question: 'the OLD c.now() form: const:"now" piped through to_epoch_ms',
    value: withFilters(rawValue({ value: "now", tag: "const" }), filter("to_epoch_ms")),
  },
  {
    name: "now_epochms",
    question: "what c.now() emits today: the engine-native const:epochms constant, no filter",
    value: c.now(),
  },
];

/**
 * The stored value of a probe function's single `set_var`, as persisted.
 *
 * The exported statement list is `run[]` (not the authored `stack`), and a
 * `set_var`'s value rides on `context` — the engine's own naming, not the SDK's.
 */
function storedValue(fn: unknown): unknown {
  const run = (fn as { run?: Array<Record<string, unknown>> }).run ?? [];
  return run[0]?.context ?? null;
}

async function main(): Promise<void> {
  const config = resolveValidateConfig();
  const client = new MetaClient(config);

  const fns = CASES.map((probe) =>
    defineFunction({
      name: probe.name,
      stack: [s.set_var("out", probe.value)],
      response: ref("out"),
    }),
  );
  const ws = workspace("value_form_probe").registerFunctions(fns);
  const bundle = serializeBundle((ws as unknown as { export(): unknown }).export());

  console.error(`Importing ${fns.length} probe functions → sandbox (${config.instance})…`);
  const imported = await client.importBundle(bundle, { reset: true });
  if (imported.workspaceId === undefined) {
    throw new Error(`Import returned no workspaceId. Raw: ${imported.raw.slice(0, 400)}`);
  }
  console.error(`Imported to workspace ${imported.workspaceId}. Reading back…\n`);

  const exported = await client.exportWorkspace(imported.workspaceId);
  if (process.env.PROBE_DUMP) {
    console.error(JSON.stringify(exported.payload.function, null, 1).slice(0, 4000));
  }
  const persisted = new Map<string, unknown>();
  for (const fn of (exported.payload.function as unknown[]) ?? []) {
    const named = fn as { name?: string };
    if (typeof named.name === "string") persisted.set(named.name, storedValue(fn));
  }

  for (const probe of CASES) {
    // Canonical key order on both sides — the engine reorders keys freely, and
    // that is not a rewrite.
    const canon = (v: unknown): string =>
      JSON.stringify(v, (_k, val: unknown) =>
        val !== null && typeof val === "object" && !Array.isArray(val)
          ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort())
          : val,
      );
    const sent = canon(probe.value);
    const back = canon(persisted.get(probe.name) ?? null);
    const run = await client.runFunction(imported.workspaceId, probe.name, {});
    console.log(`── ${probe.name}`);
    console.log(`   ${probe.question}`);
    console.log(`   sent      ${sent}`);
    console.log(`   persisted ${back}`);
    console.log(`   rewritten ${sent === back ? "no — persisted exactly as sent" : "YES — the engine changed it on save"}`);
    console.log(`   run       ${run.status} ${JSON.stringify(run.body)}`);
    console.log("");
  }

  console.error(`Reference: Date.now() at probe time ≈ ${process.env.PROBE_NOW ?? "(pass PROBE_NOW)"}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
