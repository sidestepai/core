/**
 * Runtime execution (R3): prove deployed logic actually runs, not just that it
 * imports and round-trips. `smokeRunFunctions` runs each deployed function via
 * the meta function-run route and reports whether the engine executed it, with
 * the result body (or the engine error + logs) surfaced for diagnosis.
 *
 * Node-only; reached through the command.
 */
import type { InvokeResult } from "./meta-client.js";

/** Client surface runtime needs (satisfied structurally by MetaClient). */
export interface RuntimeClient {
  runFunction(workspaceId: number, name: string, input?: unknown): Promise<InvokeResult>;
}

/** Outcome of running one function through the engine. */
export interface RuntimeEntry {
  name: string;
  /** True when the engine executed it without error. */
  ran: boolean;
  status: number;
  /** Result body on success, or the engine error + logs on failure. */
  detail: unknown;
}

/**
 * Execute each named function on the engine with the given input (default `{}`)
 * and report the outcome. Runs sequentially: these are live executions against a
 * shared tenant and may have side effects, so ordering/isolation matters more
 * than shaving wall-clock. A function with required inputs may legitimately error
 * on an empty input — that surfaces as `ran:false` with the engine's message.
 */
export async function smokeRunFunctions(
  client: RuntimeClient,
  workspaceId: number,
  names: string[],
  inputs: Record<string, unknown> = {},
): Promise<RuntimeEntry[]> {
  const out: RuntimeEntry[] = [];
  for (const name of names) {
    const res = await client.runFunction(workspaceId, name, inputs[name] ?? {});
    out.push({ name, ran: res.ok, status: res.status, detail: res.body });
  }
  return out;
}
