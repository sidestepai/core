/**
 * The one list of Xano source-internal identifiers this repo must not name
 * (project CLAUDE.md R10). SideStep is an unofficial third-party plugin; the
 * engine is a third party it does not document.
 *
 * Sole home for these strings, for two reasons. The list was previously copied
 * inline into two scaffold-template tests, which is how a shared rule drifts —
 * and the repo-wide guard (`test/no-source-leak.test.ts`) scans every source
 * file, so a file that spells a banned identifier in order to ban it would
 * report itself. Centralizing gives one exemption instead of several, and one
 * place to extend.
 *
 * ## What belongs here
 *
 * Names only visible from inside the engine's own source: its repositories, its
 * class and method names, its internal namespaces.
 *
 * ## What does NOT
 *
 * The WIRE FORMAT, which must stay spellable — stored statement names (`mvp:*`),
 * schema-DSL directives (`!assign context`), tags (`const:expr2`), and public
 * URL paths (`/x2/mcp/…`). Those are observable from outside and the SDK
 * legitimately reads and writes them. `x2` is matched only as a standalone word
 * so the real, user-facing URL route keeps working.
 */

/** Engine-internal identifiers, as patterns (see the module note on `x2`). */
export const SOURCE_LEAK_PATTERNS: readonly RegExp[] = [
  // Repositories.
  /\bcloud-master\b/,
  /\bcloud-client\b/,
  /\bcloud-frontend\b/,
  /\bcloud-realtime\b/,
  /\bcloud-deno\b/,
  /\bx2\s/,
  // Internal class/method names.
  /\bgetInputSchema\b/,
  /\bgetOutputSchema\b/,
  /\bgetContextSchema\b/,
  /\bApplicationContext\b/,
  // Internal namespaces and call forms.
  /xano\\xs\\/,
  /xano::decode/,
  // A checkout path into the engine tree.
  /extensions\/MVP/,
];

/**
 * The scaffold templates carry ONE extra ban: "orchestrator", which is what
 * Xano calls the service the engine runs under. It is scoped to the templates
 * because it is also an ordinary English word the SDK uses correctly elsewhere
 * — an agent is described as "an LLM orchestrator", which is accurate and has
 * nothing to do with Xano. Repo-wide it would be a false positive; in a file
 * written into a user's own repo it reads as the internal name.
 */
export const TEMPLATE_LEAK_PATTERNS: readonly RegExp[] = [
  ...SOURCE_LEAK_PATTERNS,
  /\borchestrator\b/i,
];

/** Every banned pattern this `text` matches (empty when clean). */
export function sourceLeaks(text: string): string[] {
  return SOURCE_LEAK_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
}

/** As {@link sourceLeaks}, plus the template-only bans. */
export function templateLeaks(text: string): string[] {
  return TEMPLATE_LEAK_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
}
