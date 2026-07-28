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
   * Walk every payload array once, keying each object by its stored guid.
   *
   * An object with no usable guid is reported rather than assigned a derived one:
   * a derived guid would look correct and quietly point somewhere else.
   */
  static fromPayload(payload: Record<string, unknown>, ctx: DecodeContext): RefIndex {
    const index = new RefIndex();
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
