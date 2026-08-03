/**
 * Scoped corrections for defects in Xano's upstream statement schema YAML
 * (which `CLAUDE.md` treats as read-only third-party). Applied to an
 * interpreted {@link StatementSpec} as the last step of generation, so the fix
 * survives every regeneration — hand-editing the generated catalog would be
 * clobbered on the next codegen run. The canonical regeneration pipeline
 * (`scripts/codegen.ts`) and the reproducibility test both route through here,
 * so the committed catalog and a fresh regeneration always agree.
 */
import type { FieldRule, StatementSpec } from "./interpret.js";

/**
 * Apply every known upstream-schema correction to `spec` in place.
 *
 * - `mvp:mcp_call_tool` (`s.ai.external.mcp.tool.run`): the upstream engine
 *   schema copy-pastes `connection_type`'s `?="sse"`
 *   default onto the unrelated `args` rule (`args?="sse"`), so the grounding
 *   doc renders a bogus `args = "sse"`. Drop that default; `connection_type`'s
 *   own legitimate "sse" default is left intact.
 *
 * - The **Elasticsearch / OpenSearch / S3-list family**: the upstream schema for
 *   these six carries the wrong field set, and it is not a cosmetic difference —
 *   `cloud.elasticsearch.query` had no way to emit `base_url`, so every
 *   statement it authored named no server.
 *
 *   Elasticsearch is not AWS and its engine classes have **no `region`**, while
 *   OpenSearch's do; the upstream schema gives `region` to both, which is what a
 *   copy of the OpenSearch shape onto the Elasticsearch surfaces would produce.
 *   Both query surfaces also lost `base_url` and `expression`.
 *
 *   Four independent sources agree on the corrected shapes, which is why these
 *   are safe to assert: the engine's own declared schema for each statement;
 *   the stored bytes of every affected statement in a 187-workspace sweep; the
 *   editor, whose shared query component carries a per-platform POSITIONAL index
 *   map that is uniformly one lower for Elasticsearch than OpenSearch — exactly
 *   the `region` it does not have; and the round trip, which now decodes.
 *
 *   Order is load-bearing: the engine binds these `input[]` entries by POSITION
 *   (the editor's index map is the same fact), so the rules are re-ordered to
 *   match the engine schema rather than merely corrected in content.
 */
export function applySpecOverrides(spec: StatementSpec): void {
  if (spec.name === "mvp:mcp_call_tool") {
    const args = spec.rules.find((r) => r.field === "args");
    if (args && args.default === "sse") delete args.default;
  }
  if (spec.name === "mvp:elasticsearch_request") {
    // Upstream names the body `query`; the engine class reads `payload`. Renamed
    // before the reshape below, so the rule's default survives the move.
    const body = spec.rules.find((r) => r.field === "query");
    if (body && body.route.kind === "input") {
      body.field = "payload";
      body.route = { ...body.route, name: "payload" };
    }
  }
  const search = SEARCH_FAMILY[spec.name];
  if (search) reshapeInputs(spec, search);
  if (spec.name === "mvp:amazon_s3_list_directory") {
    // The engine declares both with a trailing `?`; upstream marks them
    // required, so a stored statement that omits `prefix` could not decode and
    // an author was forced to pass a paging token they do not have.
    for (const field of ["prefix", "next_page_token"]) {
      const rule = spec.rules.find((r) => r.field === field);
      if (rule) rule.optional = true;
    }
  }
  const missing = UNDECLARED_INPUT[spec.name];
  if (missing && !spec.rules.some((r) => r.field === missing)) {
    spec.rules.push({
      field: missing,
      type: "value",
      optional: true,
      route: { kind: "input", name: missing },
    });
  }
}

/**
 * Statement inputs the engine READS that upstream's schema never declares.
 *
 * Both are ordinary optional inputs in the engine's declared schema for these
 * statements, and both are read at runtime: `set_data_source` takes
 * `workspace_id` as the workspace to switch to, and `create_attachment` takes
 * `type` and honours it when it is one of `image`/`video`/`audio`. Upstream's
 * schema YAML lists neither, so the generated factories had no way to author them
 * and a stored one had nowhere to go.
 *
 * They are asserted rather than dropped BECAUSE they are live. The two instances
 * in the survey corpus happen to be inert at their stored values — PHP reads
 * `workspace_id: 0` as falsy, so it behaves exactly like absent, and `type: ""`
 * is not in the allowed list — but that is a fact about those two values, not
 * about the fields. A real `workspace_id` or `type: "image"` changes what the
 * statement does, so discarding the surface would lose a live one.
 */
const UNDECLARED_INPUT: Readonly<Record<string, string>> = {
  "mvp:set_data_source": "workspace_id",
  "mvp:create_attachment": "type",
};

/**
 * The stored `input[]` order and membership per statement.
 *
 * Membership comes from the engine's declared schema per statement. ORDER comes from
 * the EDITOR, which is what actually writes the bytes: its shared query
 * component carries a per-platform positional index map, and the two disagree —
 * the engine declares `expression`/`sort` mid-schema while the editor stores
 * them last. The editor's order is the one every stored statement has.
 *
 * That per-platform map is also the cleanest proof that Elasticsearch has no
 * `region`: every Elasticsearch index is exactly one lower than its OpenSearch
 * counterpart.
 *
 * `[]`-suffixed names are list-valued (default `[]`).
 */
const SEARCH_FAMILY: Readonly<Record<string, readonly string[]>> = {
  "mvp:elasticsearch_document": ["auth_type", "key_id", "access_key", "base_url", "index", "method", "doc_id", "doc"],
  "mvp:elasticsearch_query": ["auth_type", "key_id", "access_key", "base_url", "index", "payload", "size", "from", "included_fields[]", "return_type", "expression[]", "sort[]"],
  "mvp:elasticsearch_request": ["auth_type", "key_id", "access_key", "method", "url", "payload"],
  "mvp:amazon_opensearch_query": ["auth_type", "key_id", "access_key", "region", "base_url", "index", "payload", "size", "from", "included_fields[]", "return_type", "expression[]", "sort[]"],
  "mvp:amazon_opensearch_document": ["auth_type", "key_id", "access_key", "region", "base_url", "method", "index", "doc_id", "doc"],
};

/**
 * Rewrite a spec's INPUT rules to `wanted`, in order: drop the ones the engine
 * does not declare, add the ones it does, and re-order the rest. Non-input rules
 * (`as`, and anything routed elsewhere) keep their place at the front.
 *
 * Existing rules are reused wherever the name matches, so upstream's defaults
 * and optionality survive; only membership and order are asserted here.
 */
function reshapeInputs(spec: StatementSpec, wanted: readonly string[]): void {
  const byName = new Map<string, FieldRule>();
  for (const rule of spec.rules) {
    if (rule.route.kind === "input") byName.set(rule.route.name, rule);
  }
  const rebuilt = wanted.map((entry) => {
    const isList = entry.endsWith("[]");
    const name = isList ? entry.slice(0, -2) : entry;
    return (
      byName.get(name) ?? {
        field: name,
        type: "value" as const,
        optional: true,
        default: isList ? "[]" : "",
        route: { kind: "input" as const, name },
      }
    );
  });
  spec.rules = [...spec.rules.filter((r) => r.route.kind !== "input"), ...rebuilt];
}
