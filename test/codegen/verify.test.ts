/**
 * U10 / KTD-9 — runtime round-trip verification.
 *
 * Every decoder is proof-carrying, so a *statement* cannot decode wrongly without
 * falling back to `raw()`. Verification exists for everything outside a
 * statement: a def key elided because the encoder looked like it would reproduce
 * it, a kind-level default read the wrong way, an object dropped entirely. Those
 * are invisible until the whole tree is loaded and exported again.
 *
 * The comparison is per object on purpose. "The bundles differ" tells a user
 * nothing they can act on; "`function signup` re-exports differently" points at
 * the file to open.
 */
import { describe, it, expect } from "vitest";
import { verifyBundles, reportMismatches } from "../../src/codegen/verify.js";
import { DecodeReport } from "../../src/codegen/report.js";

/** A bundle with one function and one table, by name. */
function bundle(functions: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { payload: { partial: false, workspace: { name: "ws" }, function: functions, ...extra } };
}

describe("verifyBundles", () => {
  it("passes when the regenerated bundle matches object for object", () => {
    const a = bundle([{ name: "signup", description: "" }]);
    const b = bundle([{ name: "signup", description: "" }]);
    expect(verifyBundles(a, b)).toEqual({ ok: true, mismatches: [], omissions: [] });
  });

  it("names the object whose re-export differs, not the whole payload", () => {
    const result = verifyBundles(
      bundle([{ name: "signup", description: "hi" }, { name: "login" }]),
      bundle([{ name: "signup", description: "" }, { name: "login" }]),
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({ payloadKey: "function", name: "signup" });
  });

  it("names the keys inside the object that differ, not just the object", () => {
    // The per-object message was the same shape of useless the workspace section
    // already outgrew: a real object carries hundreds of nested keys and
    // "re-exports differently" named none of them. A full sweep produced 1,716
    // rows saying exactly that, which is a cluster nobody can cluster.
    const result = verifyBundles(
      bundle([{ name: "signup", description: "hi", auth: { table: "user" } }]),
      bundle([{ name: "signup", description: "", auth: { table: "admin" } }]),
    );
    expect(result.mismatches[0]!.paths).toEqual([
      '.auth.table: encoded="admin" stored="user"',
      // `normalize` drops an empty `description`, so the regenerated side has no
      // such key at all — the path says so rather than claiming an empty string.
      '.description: MISSING from encoded (stored="hi")',
    ]);
    expect(result.mismatches[0]!.detail).toContain(".auth.table");
  });

  it("names the paths under a differing section key too", () => {
    const result = verifyBundles(
      { payload: { settings: { name: "ws", limits: { rate: 1 } } } },
      { payload: { settings: { name: "ws", limits: { rate: 2 } } } },
    );
    expect(result.mismatches[0]).toMatchObject({ payloadKey: "settings", name: "limits" });
    expect(result.mismatches[0]!.paths).toEqual([".rate: encoded=2 stored=1"]);
  });

  it("leaves paths empty when the object is simply absent from one side", () => {
    // A missing object has no key-level disagreement to report — the whole
    // object IS the finding, and inventing paths for it would dilute clustering.
    const result = verifyBundles(bundle([{ name: "signup" }]), bundle([]));
    expect(result.mismatches[0]!.paths).toEqual([]);
  });

  it("compares the NORMALIZED objects, so canonicalization is not re-reported", () => {
    // The paths must agree with the verdict that produced them: `normalize`
    // strips server columns, so a difference it elides is not a mismatch and
    // must not appear as a path either. Reporting the raw diff here would make
    // every object list `id` and hide the key that actually failed.
    const result = verifyBundles(
      bundle([{ name: "signup", id: 1, description: "hi" }]),
      bundle([{ name: "signup", id: 999, description: "" }]),
    );
    expect(result.mismatches).toHaveLength(1);
    // `id` differs by 998 and is absent from the paths — it is a stripped server
    // column, so the comparison never saw it and neither does the report.
    expect(result.mismatches[0]!.paths).toEqual(['.description: MISSING from encoded (stored="hi")']);
  });

  it("compares SAME-NAME objects in one section pairwise, by guid", () => {
    // Agents and MCP servers share the `toolset` payload key, so a same-name
    // pair is a shape the platform actually produces — one real workspace has
    // an agent and an MCP server both called "asdf". Keying the section by name
    // alone collapsed them to one entry, which then compared the agent against
    // the MCP server and reported a type/canonical "mismatch" on two objects
    // that each round-tripped perfectly. Worse, it made a genuinely dropped
    // twin invisible.
    const pair = () => [
      { name: "asdf", guid: "g-agent", type: "agent", canonical: "Er5dDfdN" },
      { name: "asdf", guid: "g-mcp", type: "mcp", canonical: "0XXCkdtQ" },
    ];
    expect(verifyBundles(bundle(pair()), bundle(pair()))).toMatchObject({ ok: true });
  });

  it("still catches a real difference between same-name twins", () => {
    const result = verifyBundles(
      bundle([
        { name: "asdf", guid: "g-agent", type: "agent", description: "before" },
        { name: "asdf", guid: "g-mcp", type: "mcp" },
      ]),
      bundle([
        { name: "asdf", guid: "g-agent", type: "agent", description: "after" },
        { name: "asdf", guid: "g-mcp", type: "mcp" },
      ]),
    );
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]!.name).toBe("asdf");
    expect(result.mismatches[0]!.paths).toEqual(['.description: encoded="after" stored="before"']);
  });

  it("reports a dropped same-name twin instead of hiding it", () => {
    const result = verifyBundles(
      bundle([
        { name: "asdf", guid: "g-agent", type: "agent" },
        { name: "asdf", guid: "g-mcp", type: "mcp" },
      ]),
      bundle([{ name: "asdf", guid: "g-mcp", type: "mcp" }]),
    );
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({ name: "asdf", detail: "missing from the generated tree" });
  });

  it("catches an object the generated tree dropped entirely", () => {
    // The failure mode a payload-wide deep-equal would also catch, but without
    // saying which object went missing — this is the common real-world case (an
    // object the ref index could not identify is skipped by assembly).
    const result = verifyBundles(bundle([{ name: "signup" }]), bundle([]));
    expect(result.mismatches[0]).toMatchObject({
      payloadKey: "function",
      name: "signup",
      detail: "missing from the generated tree",
    });
  });

  it("catches an object the generated tree invented", () => {
    const result = verifyBundles(bundle([]), bundle([{ name: "ghost" }]));
    expect(result.mismatches[0]!.detail).toContain("not in the source bundle");
  });

  it("names the differing key of a non-array section, not just the section", () => {
    // "workspace:(section) does not match" was true and useless — a workspace
    // object carries ~35 keys and the old message named none of them.
    const result = verifyBundles(
      { payload: { workspace: { name: "ws", canonical: "a" } } },
      { payload: { workspace: { name: "ws", canonical: "b" } } },
    );
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({ payloadKey: "workspace", name: "canonical" });
  });

  it("compares a scalar section whole, since it has no keys to report against", () => {
    const result = verifyBundles({ payload: { partial: false } }, { payload: { partial: true } });
    expect(result.mismatches[0]).toMatchObject({ payloadKey: "partial", name: "(section)" });
  });

  it("reports a deliberately-dropped workspace secret as an omission, not a mismatch", () => {
    // The whole point of the split: declining to write an instance's crypto
    // material into a committed source tree is correct behavior, so it must not
    // read as a failed round trip.
    const result = verifyBundles(
      { payload: { workspace: { name: "ws", secret: "s3cr3t", crypto: { iv: "x" } } } },
      { payload: { workspace: { name: "ws" } } },
    );
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.omissions.map((o) => o.name).sort()).toEqual(["crypto", "secret"]);
    expect(result.omissions.every((o) => o.reason === "secret")).toBe(true);
  });

  it("reports a server-assigned workspace key as an omission", () => {
    // domain_prefix is generated by the instance and builds its hostnames —
    // redeploying it to another tenant would claim that tenant's routing.
    const result = verifyBundles(
      { payload: { workspace: { name: "ws", domain_prefix: "813eef" } } },
      { payload: { workspace: { name: "ws" } } },
    );
    expect(result.ok).toBe(true);
    expect(result.omissions[0]).toMatchObject({ name: "domain_prefix", reason: "server-managed" });
  });

  it("treats a re-derived workspace guid as an omission, not a mismatch", () => {
    // The workspace config declares no guid field, so the export path mints one
    // from the workspace name — it will NEVER equal the instance-assigned guid it
    // replaced. Reporting that as a failed round trip made every real workspace
    // mismatch, which buried the genuine per-object diffs underneath it.
    // A second omitted key is what gets us past the section-level short circuit:
    // `normalize` strips `guid` *inside* an object, so two workspaces differing
    // only by guid compare equal as wholes and never reach the per-key loop. A
    // real workspace always differs by more than one omitted key, as here.
    const result = verifyBundles(
      {
        payload: {
          workspace: { name: "ws", guid: "PrXBe_AsYkmrFQexcSHLYBxEo8c", secret: "s3cr3t" },
        },
      },
      { payload: { workspace: { name: "ws", guid: "0e5f1a2b3c4d5e6f7a8b9c0d1e2f3a4b" } } },
    );
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.omissions.map((o) => o.name).sort()).toEqual(["guid", "secret"]);
    expect(result.omissions.find((o) => o.name === "guid")).toMatchObject({
      reason: "server-managed",
    });
  });

  it("does not extend the derived allowance to any other key", () => {
    // `derived` is a per-key policy, not a blanket excuse: a differing value on a
    // key with no policy is still a real divergence.
    const result = verifyBundles(
      { payload: { workspace: { name: "ws", description: "before" } } },
      { payload: { workspace: { name: "ws", description: "after" } } },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toMatchObject({ name: "description" });
  });

  it("treats the deliberately-emptied workspace.env as an omission, verified at top level", () => {
    // A real bundle carries env vars in BOTH workspace.env and top-level
    // payload.env. The encoder hoists to top-level (where the import reads them)
    // and blanks workspace.env rather than duplicating secrets — so every real
    // workspace with env vars would otherwise fail verification.
    const vars = [{ name: "A", value: "1", market_item: [] }];
    const result = verifyBundles(
      { payload: { workspace: { name: "ws", env: vars }, env: vars } },
      { payload: { workspace: { name: "ws", env: [] }, env: vars } },
    );
    expect(result.ok).toBe(true);
    expect(result.omissions[0]).toMatchObject({ name: "env", reason: "relocated" });
  });

  it("still fails when the relocated env vars are actually lost", () => {
    // The `emptied` exemption covers only workspace.env. Dropping the top-level
    // copy too is real loss and must stay a hard failure.
    const vars = [{ name: "A", value: "1", market_item: [] }];
    const result = verifyBundles(
      { payload: { workspace: { name: "ws", env: vars }, env: vars } },
      { payload: { workspace: { name: "ws", env: [] }, env: [] } },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toMatchObject({ payloadKey: "env", name: "A" });
  });

  it("does not excuse an emptied key that is emitted with a DIFFERENT value", () => {
    // `emptied` means blank-or-absent, not "anything goes".
    const result = verifyBundles(
      { payload: { workspace: { name: "ws", env: [{ name: "A", value: "1" }] } } },
      { payload: { workspace: { name: "ws", env: [{ name: "B", value: "2" }] } } },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toMatchObject({ name: "env" });
  });

  it("does not excuse a listed key that is emitted with a DIFFERENT value", () => {
    // Only an absence can be a deliberate omission. Writing the wrong secret is
    // a real divergence no policy covers.
    const result = verifyBundles(
      { payload: { workspace: { name: "ws", secret: "real" } } },
      { payload: { workspace: { name: "ws", secret: "wrong" } } },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toMatchObject({ payloadKey: "workspace", name: "secret" });
    expect(result.omissions).toEqual([]);
  });

  it("does not excuse an unlisted workspace key that went missing", () => {
    // A key that is neither modeled nor on the policy list is a genuine gap and
    // has to stay a hard failure, or the list silently becomes a catch-all.
    const result = verifyBundles(
      { payload: { workspace: { name: "ws", something_new: 1 } } },
      { payload: { workspace: { name: "ws" } } },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toMatchObject({ name: "something_new" });
  });

  it("reports objects in an unmodeled section as omissions, so a real pull verifies clean", () => {
    // payload.knowledge is a first-class engine object type this SDK decided not
    // to author in TypeScript. Its absence is policy, not loss.
    const result = verifyBundles(
      { payload: { knowledge: [{ name: "how-to" }], function: [] } },
      { payload: { knowledge: [], function: [] } },
    );
    expect(result.ok).toBe(true);
    expect(result.omissions[0]).toMatchObject({
      payloadKey: "knowledge",
      name: "how-to",
      reason: "unmodeled",
    });
  });

  it("compares under normalize(), so an engine-canonicalized difference is not a mismatch", () => {
    // Verification must not cry wolf on the same shapes the conformance corpus
    // already normalizes away, or `--no-verify` becomes the default habit.
    const result = verifyBundles(
      bundle([{ name: "signup", settings_registry: [] }]),
      bundle([{ name: "signup", settings_registry: null }]),
    );
    expect(result.ok).toBe(true);
  });
});

describe("reportMismatches", () => {
  it("folds mismatches into the report so every sink shows them", () => {
    // The README, the CLI summary, and the structured entries all read one
    // computed report — verification has to write there, not print separately.
    const report = new DecodeReport();
    reportMismatches(report, verifyBundles(bundle([{ name: "signup" }]), bundle([])));
    const group = report.summarize().byCategory.find((g) => g.category === "verify-mismatch");
    expect(group?.count).toBe(1);
    expect(report.renderMarkdown()).toContain("function:signup");
    expect(report.renderCli()).toContain("function:signup");
  });

  it("leaves a clean result alone", () => {
    const report = new DecodeReport();
    reportMismatches(report, verifyBundles(bundle([]), bundle([])));
    expect(report.entries).toEqual([]);
  });

  it("files omissions under their own category so they never read as mismatches", () => {
    const report = new DecodeReport();
    reportMismatches(
      report,
      verifyBundles(
        { payload: { workspace: { name: "ws", secret: "s" } } },
        { payload: { workspace: { name: "ws" } } },
      ),
    );
    const byCategory = report.summarize().byCategory;
    expect(byCategory.find((g) => g.category === "verify-mismatch")).toBeUndefined();
    expect(byCategory.find((g) => g.category === "expected-omission")?.count).toBe(1);
    expect(report.renderCli()).toContain("workspace:secret");
  });
});
