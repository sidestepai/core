/**
 * Reference index — every guid in a bundle, mapped back to the object it names.
 *
 * A pulled bundle refers to its own objects by guid: a `function.run` names its
 * callee's guid, a `db.get` names a table's, a trigger names its bound toolset's.
 * Turning those into readable cross-file symbol references needs one pass over
 * the payload up front.
 *
 * The guid itself is **preserved, never re-derived** (KTD-7). SideStep derives
 * `md5(type:name)` for objects it authors, but a pulled object's guid is the
 * engine's own random value; re-deriving would silently rewrite identity and
 * break every reference that points at it.
 */
import { REFERENCEABLE_KIND_PAYLOAD_KEYS } from "../refs/guid.js";
import type { DecodeContext } from "./context.js";
import { id, lit, obj, type Expr } from "./print.js";

/** One object located in the bundle payload. */
export interface IndexedObject {
  /** The engine's stored guid, verbatim. */
  readonly guid: string;
  /** The payload array it came from, e.g. `function`, `dbo`, `toolset`. */
  readonly payloadKey: string;
  /** The SideStep kind name, e.g. `function`, `table`, `mcp_server`. */
  readonly kind: string;
  readonly name: string;
  /** Position within its payload array — a stable tiebreak for symbol naming. */
  readonly position: number;
}

/**
 * Payload key → the kinds that persist under it. Derived by inverting the
 * authoritative map rather than restated, so a new kind cannot drift out of sync.
 * Only `toolset` is ambiguous (mcp-server and agent share it); tools persist
 * under their own `tool` key.
 */
const KINDS_BY_PAYLOAD_KEY: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [kind, payloadKey] of Object.entries(REFERENCEABLE_KIND_PAYLOAD_KEYS)) {
    const kinds = out.get(payloadKey) ?? [];
    kinds.push(kind);
    out.set(payloadKey, kinds);
  }
  return out;
})();

/**
 * Which kind an object under an ambiguous payload key actually is.
 * `toolset` holds both mcp-servers and agents, discriminated by the stored
 * `type` the engine persists (`"mcp"` vs `"agent"`).
 */
function discriminate(payloadKey: string, object: Record<string, unknown>): string | null {
  const candidates = KINDS_BY_PAYLOAD_KEY.get(payloadKey);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const type = object.type;
  if (type === "mcp") return "mcp_server";
  if (type === "agent") return "agent";
  return null;
}

/** Guid → object, built once per bundle. */
export class RefIndex {
  readonly #byGuid = new Map<string, IndexedObject>();

  /**
   * Whether the bundle this index was built from is a WHOLE-workspace export.
   *
   * It decides what a blank reference can mean. A scoped export blanks a
   * reference whose target sits outside the selection rather than failing, so in
   * that bundle "blank" is genuinely two things — a lost binding, or one that
   * merely was not exported — and the report has to name both. A full export has
   * no outside: every object the workspace holds is present, so a blank
   * reference is unbound IN THE WORKSPACE and saying "re-pull with it in scope"
   * is advice that cannot help.
   *
   * Read from the payload's own `partial` flag, which the engine sets on export
   * and reads back on import. Defaults to the cautious reading (both causes) when
   * the flag is absent or not a boolean — an unknown provenance is not evidence
   * of a full export.
   */
  wholeWorkspace = false;

  /**
   * Walk every payload array once, keying each object by its stored guid.
   *
   * An object with no usable guid is reported rather than assigned a derived one:
   * a derived guid would look correct and quietly point somewhere else.
   */
  static fromPayload(payload: Record<string, unknown>, ctx: DecodeContext): RefIndex {
    const index = new RefIndex();
    index.wholeWorkspace = payload["partial"] === false;
    for (const payloadKey of KINDS_BY_PAYLOAD_KEY.keys()) {
      const section = payload[payloadKey];
      if (!Array.isArray(section)) continue;
      section.forEach((entry, position) => {
        if (entry === null || typeof entry !== "object") return;
        const object = entry as Record<string, unknown>;
        const name = typeof object.name === "string" ? object.name : "";
        const kind = discriminate(payloadKey, object);
        const guid = object.guid;
        if (typeof guid !== "string" || guid === "") {
          ctx.problem(
            "unresolved-ref",
            `${payloadKey}[${position}]${name ? ` "${name}"` : ""} has no stored guid; references to it cannot resolve`,
          );
          return;
        }
        if (kind === null) {
          ctx.problem(
            "unresolved-ref",
            `${payloadKey} "${name}" (guid ${guid}) has no recognizable kind; its stored \`type\` is ${JSON.stringify(object.type)}`,
          );
          return;
        }
        index.#byGuid.set(guid, { guid, payloadKey, kind, name, position });
      });
    }
    return index;
  }

  /** The object a guid names, or undefined when the bundle does not contain it. */
  lookup(guid: string): IndexedObject | undefined {
    return this.#byGuid.get(guid);
  }

  /** Every indexed object, in payload-walk order. */
  all(): IndexedObject[] {
    return [...this.#byGuid.values()];
  }
}

/** How a reference site should render a target the index resolved. */
export interface ResolveOptions {
  /**
   * The TypeScript symbol to reference, or `null` to emit a `{name, guid}`
   * literal instead. Project assembly returns `null` on a cycle back edge
   * (KTD-8), so two mutually-calling objects never produce circular imports.
   */
  symbolFor?: (target: IndexedObject) => string | null;
  /**
   * What an *unresolvable* guid degrades to.
   *
   * `"guid-string"` (the default) suits a stored slot that holds a bare guid,
   * like a statement's `context.function_id`. `"object-ref"` is required wherever
   * the authoring surface takes an {@link ObjectRef}, because a bare string there
   * is read as a **name** and re-derived into a completely different guid — which
   * silently repoints the reference instead of preserving it.
   */
  unresolved?: "guid-string" | "object-ref";
}

/**
 * A stored reference id, in either spelling the engine uses.
 *
 * A target is identified by a guid **or** by a numeric id depending on how and
 * when the referring object was saved, so a decoder that insists on a string
 * cannot even classify half of them. Read the type, then decide by value.
 */
export function isReferenceId(v: unknown): v is string | number {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

/**
 * True when a stored reference id names nothing — the UNBOUND state.
 *
 * Both spellings have an empty form and they mean the same thing: a blank guid
 * (`""`) and a zero numeric id (`0`) are each "no target", never "target zero".
 * That equivalence is what lets one authored `null` stand for either, and it is
 * safe to rely on because an id is not byte-compared at all (see
 * {@link isBoundNumericId}).
 */
export function isUnboundId(v: string | number): boolean {
  return v === "" || v === 0;
}

/**
 * True for a reference to a real target recorded as a NUMBER rather than a guid.
 *
 * These are not decodable today, and the reason is subtle enough to be worth
 * stating where it is enforced. `normalize` lists `id` among the server columns it
 * strips, so a reference id is never byte-compared — which means the proof-carrying
 * contract, the thing that makes an aggressive decoder safe everywhere else,
 * cannot catch a wrong one here. A recovered reference re-encodes the guid as a
 * STRING (`"3"` for a stored `3`), and that type change would sail through the
 * comparison unexamined.
 *
 * So this stays a decline until a reference can carry its stored spelling
 * (widening an `ObjectRef`'s guid to `string | number`), rather than emitting a
 * reference nothing can verify. The unbound forms above are unaffected: `null`
 * means "no target" in either spelling, so nothing is being guessed.
 */
export function isBoundNumericId(v: string | number): boolean {
  return typeof v === "number" && !isUnboundId(v);
}

/**
 * Render a reference to `guid` at the current decode site.
 *
 * Resolution order: a symbol when one is available, a `{name, guid}` literal when
 * the target is known but a symbol would not work, and the bare guid — reported —
 * when the bundle does not contain the target at all.
 */
export function resolveReference(
  ctx: DecodeContext,
  index: RefIndex,
  guid: string,
  options: ResolveOptions = {},
): Expr {
  const target = index.lookup(guid);
  if (!target) {
    ctx.problem("unresolved-ref", `guid ${guid} is not present in this bundle`);
    return options.unresolved === "object-ref"
      ? obj([
          ["name", lit("")],
          ["guid", lit(guid)],
        ])
      : lit(guid);
  }
  const symbol = options.symbolFor?.(target) ?? null;
  if (symbol !== null) return id(symbol);
  return obj([
    ["name", lit(target.name)],
    ["guid", lit(target.guid)],
  ]);
}
