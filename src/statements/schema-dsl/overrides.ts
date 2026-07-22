/**
 * Scoped corrections for defects in Xano's upstream statement schema YAML
 * (which `CLAUDE.md` treats as read-only third-party). Applied to an
 * interpreted {@link StatementSpec} as the last step of generation, so the fix
 * survives every regeneration — hand-editing the generated catalog would be
 * clobbered on the next codegen run. The canonical regeneration pipeline
 * (`scripts/codegen.ts`) and the reproducibility test both route through here,
 * so the committed catalog and a fresh regeneration always agree.
 */
import type { StatementSpec } from "./interpret.js";

/**
 * Apply every known upstream-schema correction to `spec` in place.
 *
 * - `mvp:mcp_call_tool` (`s.ai.external.mcp.tool.run`): the upstream
 *   `ai.external.mcp.tool.run.yaml` copy-pastes `connection_type`'s `?="sse"`
 *   default onto the unrelated `args` rule (`args?="sse"`), so the grounding
 *   doc renders a bogus `args = "sse"`. Drop that default; `connection_type`'s
 *   own legitimate "sse" default is left intact.
 */
export function applySpecOverrides(spec: StatementSpec): void {
  if (spec.name === "mvp:mcp_call_tool") {
    const args = spec.rules.find((r) => r.field === "args");
    if (args && args.default === "sse") delete args.default;
  }
}
