/**
 * Runtime execution (R3): prove deployed logic actually runs, not just that it
 * imports and round-trips. Two paths — run a workspace function via the meta
 * function-run route, or invoke a deployed public API at `/api:{canonical}/...` (the
 * canonical is resolved from the workspace, never guessed; KTD-6).
 *
 * `smokeRunFunctions` is the generally-applicable default the `--runtime` flag
 * uses: it executes each function and reports whether the engine ran it, with
 * logs surfaced on failure. `assertResponse` is the building block for
 * expected-output checks (programmatic / future expansion).
 *
 * Node-only; reached through the command.
 */
import { deepDiff } from "./loop.js";
import type { ApiGroupSummary, InvokeResult } from "./meta-client.js";

/** Client surface runtime needs (satisfied structurally by MetaClient). */
export interface RuntimeClient {
  runFunction(workspaceId: number, name: string, input?: unknown): Promise<InvokeResult>;
  listApigroups(workspaceId: number): Promise<ApiGroupSummary[]>;
  invokeApi(
    canonical: string,
    path: string,
    opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<InvokeResult>;
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
 * and report the outcome. A function with required inputs may legitimately error
 * on an empty input — that surfaces as `ran:false` with the engine's message, not
 * as a hidden failure.
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

/**
 * Resolve a public API-group canonical. With a name, match it; without, return
 * the sole group's canonical (undefined when ambiguous or none exist).
 */
export async function resolveCanonical(
  client: RuntimeClient,
  workspaceId: number,
  groupName?: string,
): Promise<string | undefined> {
  const groups = await client.listApigroups(workspaceId);
  const withCanonical = groups.filter((g) => g.canonical !== undefined && g.canonical !== "");
  if (groupName !== undefined) {
    return withCanonical.find((g) => g.name === groupName)?.canonical;
  }
  return withCanonical.length === 1 ? withCanonical[0]!.canonical : undefined;
}

/** What to assert about an invocation response. */
export interface AssertExpectation {
  status?: number;
  body?: unknown;
}

/** Result of an assertion: pass plus any human-readable failure lines. */
export interface AssertOutcome {
  pass: boolean;
  failures: string[];
}

/** Assert an invocation matched the expected status and/or body (deep). */
export function assertResponse(actual: InvokeResult, expected: AssertExpectation): AssertOutcome {
  const failures: string[] = [];
  if (expected.status !== undefined && actual.status !== expected.status) {
    failures.push(`status: expected ${expected.status}, got ${actual.status}`);
  }
  if (expected.body !== undefined) {
    for (const d of deepDiff(expected.body, actual.body)) {
      failures.push(`body ${d.path}: expected ${fmt(d.expected)}, got ${fmt(d.actual)}`);
    }
  }
  return { pass: failures.length === 0, failures };
}

function fmt(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}
