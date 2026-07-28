/**
 * What codegen deliberately does **not** carry into the generated tree — and why.
 *
 * Decode has two very different reasons for an object not appearing in the
 * output, and collapsing them is what made a real-workspace pull unreadable:
 *
 * - **Loss.** A statement, field, or def key that *should* round-trip and does
 *   not. This is a hard failure and always has been (KTD-9).
 * - **Policy.** A section or key this SDK has decided not to represent, because
 *   it is an instance's private key material or server-assigned identity. A
 *   generated TypeScript tree is source you commit and redeploy — putting an
 *   instance's crypto secret or its DNS prefix in it is a bug, not fidelity.
 *
 * Verification used to report both as "does not match the source bundle", which
 * is neither actionable nor honest: it told a user their workspace failed to
 * round-trip when in fact the SDK had chosen, correctly, to leave four keys
 * behind. This module is the written-down policy the plan asked for, and it is
 * the **single** source both `decodeBundle` and `verifyBundles` read, so the
 * list that suppresses a mismatch is the same list that reports the omission.
 *
 * Codegen is not a backup tool. Anything listed here is recoverable only from
 * the live workspace.
 */

/** Why a section or key is left out of the generated tree. */
export type OmissionReason =
  /** Private key material or an integration credential. Must never be emitted. */
  | "secret"
  /** Assigned and owned by the instance; carrying it to another tenant is wrong. */
  | "server-managed"
  /** Carried elsewhere in the bundle, where the import actually reads it. */
  | "relocated"
  /** A first-class Xano object type this SDK models no kind for. */
  | "unmodeled";

/** A deliberately-omitted payload section or workspace key. */
export interface OmissionPolicy {
  readonly reason: OmissionReason;
  /** One line, written for a user reading the report. */
  readonly detail: string;
  /**
   * True when the generated tree writes the key **empty** rather than dropping
   * it. Only `env` does this today: the import reads workspace env vars from
   * top-level `payload.env`, so the encoder hoists them there and leaves
   * `workspace.env` empty rather than duplicating secrets inside the bundle.
   *
   * Without this, that deliberate emptying reads as a round-trip failure on
   * every real workspace that has env vars. The values are still verified — as
   * the top-level `payload.env` section, where they actually live.
   */
  readonly emptied?: true;
}

/**
 * Payload sections this SDK models no kind for.
 *
 * A non-empty one cannot be represented in the generated tree, so it is reported
 * rather than dropped silently (R9) — but it is reported as a *known* gap, not
 * as a round-trip failure, because no amount of re-running codegen will fix it.
 *
 * `knowledge` is a first-class engine object type (it has its own statement
 * family) rather than an incidental blob. It is listed here as an explicit
 * product decision: SideStep does not author knowledge objects in TypeScript.
 */
export const UNSUPPORTED_SECTIONS: Readonly<Record<string, OmissionPolicy>> = {
  vault: { reason: "secret", detail: "vault entries are instance secrets and are never emitted as source" },
  knowledge: {
    reason: "unmodeled",
    detail: "knowledge objects are not authored in TypeScript by this SDK",
  },
  market_item: { reason: "unmodeled", detail: "marketplace provenance is owned by the instance" },
  run_install: { reason: "unmodeled", detail: "install runs are instance history, not workspace source" },
  action_package_install: {
    reason: "unmodeled",
    detail: "action-package installs are owned by the instance",
  },
  workflow_test: { reason: "unmodeled", detail: "workflow tests are not modeled by this SDK" },
  service: { reason: "unmodeled", detail: "services are not modeled by this SDK" },
  branch: { reason: "server-managed", detail: "branches are instance state, not workspace source" },
};

/**
 * Keys of the singleton `payload.workspace` object that are deliberately dropped.
 *
 * Classified against the engine's own persisted workspace schema rather than
 * guessed. The two categories matter for different reasons:
 *
 * - `secret` — emitting these into a committed source tree leaks an instance's
 *   private key material or a third-party integration credential.
 * - `server-managed` — the instance assigns these and derives behavior from
 *   them. `domain_prefix`, for example, is auto-generated from random bytes when
 *   empty and is used to build the workspace's hostnames; carrying it into a
 *   tree that is redeployed to a *different* tenant would have that tenant claim
 *   another workspace's routing prefix.
 *
 * A workspace key that is neither modeled nor listed here is a genuine gap, and
 * verification reports it by name so it can be triaged rather than absorbed.
 */
export const WORKSPACE_OMITTED_KEYS: Readonly<Record<string, OmissionPolicy>> = {
  // --- private key material ---
  iv: { reason: "secret", detail: "instance crypto material" },
  salt: { reason: "secret", detail: "instance crypto material" },
  secret: { reason: "secret", detail: "instance crypto material" },
  crypto: { reason: "secret", detail: "instance crypto material" },
  mesh0: { reason: "secret", detail: "integration API keys" },
  git: { reason: "secret", detail: "integration deploy keys" },

  // --- assigned and owned by the instance ---
  id: { reason: "server-managed", detail: "instance-assigned workspace id" },
  guid: { reason: "server-managed", detail: "instance-assigned workspace guid" },
  checksum: { reason: "server-managed", detail: "derived by the engine on save" },
  created_at: { reason: "server-managed", detail: "engine timestamp" },
  updated_at: { reason: "server-managed", detail: "engine timestamp" },
  deleted_at: { reason: "server-managed", detail: "engine timestamp" },
  domain_prefix: {
    reason: "server-managed",
    detail: "instance-assigned routing prefix; redeploying it to another tenant would claim its hostnames",
  },
  branch: { reason: "server-managed", detail: "current-branch pointer, instance state" },
  release: { reason: "server-managed", detail: "release pointer, instance state" },
  user: { reason: "server-managed", detail: "owning-user record" },
  usage: { reason: "server-managed", detail: "metered usage counters" },
  features: { reason: "server-managed", detail: "instance feature flags" },
  installed_services: { reason: "server-managed", detail: "per-branch installed service ids" },
  provision: { reason: "server-managed", detail: "provisioning progress, instance state" },
  well_known: { reason: "server-managed", detail: "well-known hosting records, instance state" },
  tailor_experience: { reason: "server-managed", detail: "onboarding survey answers" },
  require_setup: { reason: "server-managed", detail: "onboarding state" },
  disabled: { reason: "server-managed", detail: "instance-level workspace disable flag" },
  jumpstart: { reason: "server-managed", detail: "onboarding state" },
  sql_schema_name: { reason: "server-managed", detail: "physical schema name, instance-assigned" },
  connect: { reason: "server-managed", detail: "third-party connection state" },

  // --- carried elsewhere in the bundle ---
  env: {
    reason: "relocated",
    emptied: true,
    detail:
      "workspace env vars are carried at top-level payload.env, where the import reads them; they are verified there",
  },
};

/** The policy for a payload section, or `undefined` if it is not deliberately omitted. */
export function sectionOmission(key: string): OmissionPolicy | undefined {
  return Object.hasOwn(UNSUPPORTED_SECTIONS, key) ? UNSUPPORTED_SECTIONS[key] : undefined;
}

/** The policy for a `payload.workspace` key, or `undefined` if it is not deliberately omitted. */
export function workspaceKeyOmission(key: string): OmissionPolicy | undefined {
  return Object.hasOwn(WORKSPACE_OMITTED_KEYS, key) ? WORKSPACE_OMITTED_KEYS[key] : undefined;
}
