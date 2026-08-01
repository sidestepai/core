/**
 * Call-family decoders — every statement that invokes another workspace object.
 *
 * The family is uniform in shape: a target guid somewhere in `context`, an
 * optional `as`, and a lean `input[]` of named bindings. The one place it is not
 * uniform is `mvp:function`, which two distinct public surfaces share:
 * `service.function.run` writes `context.runtime_mode` and `function.run` does
 * not, so the stored context — not the name — is what discriminates them. A
 * name lookup would pick one arbitrarily and re-encode the wrong shape.
 */
import type { TaggedValue } from "../../types/xdo.js";
import { lit, obj, type Expr } from "../print.js";
import { isBoundNumericId, isReferenceId, isUnboundId, resolveReference } from "../ref-index.js";
import { decodeValue } from "../value.js";
import {
  blankRefDetail,
  declineHere,
  getPath,
  prove,
  type SpecialArgs,
  type SpecialDecoder,
} from "./prove.js";

/** Coerce a stored `{value, tag, filters}` block to a tagged value. */
function toValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const block = raw as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  return {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
}

/** The `input[]` bindings a call carries, as a `{name: Value}` record. */
function callInput(a: SpecialArgs): { expr: Expr; runtime: Record<string, unknown> } | null {
  const entries = Array.isArray(a.stored.input) ? a.stored.input : [];
  const source: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};
  for (const entry of entries) {
    const name = (entry as { name?: unknown }).name;
    const value = toValue(entry);
    if (typeof name !== "string" || !value)
      return declineHere("call input[]: entry is not a named tagged value");
    source.push([name, decodeValue(a.ctx, value)]);
    runtime[name] = value;
  }
  return { expr: obj(source), runtime };
}

/** How one call surface locates its target and names it in the authoring args. */
interface CallShape {
  /** The `s.` path to emit. */
  readonly path: string;
  /** The authoring argument holding the target reference. */
  readonly arg: string;
  /** Dotted path to the target guid inside `context`. */
  readonly idPath: string;
  /** Whether the surface accepts `input` bindings. */
  readonly takesInput?: boolean;
  /**
   * The surface's target argument accepts `null`, so a blank stored id decodes as
   * an unbound reference instead of declining.
   *
   * Opt-in per shape because `callDecoder` is shared: only the `mvp:function`
   * surfaces model the unbound state today (see `FnRef`), and offering `null` to a
   * factory that does not take it would just abort inside `prove`.
   */
  readonly unbindable?: boolean;
  /**
   * The target id is NOT a workspace object reference — it names something that
   * lives outside the bundle's object graph entirely, so routing it through the
   * ref index reports a missing guid for a reference that was never
   * workspace-local.
   *
   * Only `mvp:action` sets this. Its `run_version.id` identifies a GLOBALLY
   * INSTALLED marketplace action package, so the id is the same everywhere and
   * is not a workspace object anyone could have renamed or re-keyed. Three
   * things say so independently: the encoder already carries a `@TODO` admitting
   * it resolves via the "function" migrate type and that actions are a distinct
   * namespace; action packages are an unsupported payload section, so an
   * installed action is never in the tree to resolve against; and in the survey
   * corpus all 3 stored ids are absent from their bundle while ONE OF THEM
   * APPEARS IN TWO DIFFERENT WORKSPACES, which a workspace-local id cannot do.
   *
   * Note none of that rests on the id's SHAPE. A workspace guid is an arbitrary
   * unique key that anyone can change — it carries no pattern to test against,
   * so "this looks like a UUID rather than a workspace guid" is not evidence and
   * must not become one.
   *
   * The emitted expression is unchanged: `resolveReference`'s miss branch
   * already returns this exact `{name:"", guid}` form, so this drops the false
   * error without touching a byte.
   */
  readonly external?: boolean;
  /** Extra entries derived from the stored context (headers, auth, …). */
  readonly extra?: (a: SpecialArgs) => {
    entries: Array<[string, Expr]>;
    runtime: Record<string, unknown>;
  } | null;
}

/** Build a decoder for one uniform call surface. */
function callDecoder(shape: CallShape): SpecialDecoder {
  return (a) => {
    const stored = getPath(a.stored.context, shape.idPath);
    if (!isReferenceId(stored))
      return declineHere(`${shape.path}: context.${shape.idPath} is not a reference id`);
    // A blank id is an UNBOUND target, not a decode failure — the statement calls
    // a function that was deleted, or was never bound. Where the surface models
    // that state it is authored as `null`; elsewhere it stays a decline.
    const unbound = isUnboundId(stored);
    if (unbound && shape.unbindable !== true)
      return declineHere(`${shape.path}: context.${shape.idPath} is blank`);
    if (isBoundNumericId(stored))
      return declineHere(`${shape.path}: context.${shape.idPath} is a numeric object reference`);
    const guid = String(stored);

    if (unbound) {
      // Reported, not emitted quietly: presenting a lost binding as a
      // deliberate `null` would hide it. See {@link blankRefDetail}.
      a.ctx.problem(
        "unresolved-ref",
        blankRefDetail(`${shape.path} has a blank ${shape.arg} reference`, shape.arg),
      );
    }
    const target = unbound
      ? lit(null)
      : shape.external
        ? obj([
            ["name", lit("")],
            ["guid", lit(guid)],
          ])
        : resolveReference(a.ctx, a.refs, guid, { ...a.resolve, unresolved: "object-ref" });
    // The runtime side references the target by guid directly: `resolveRef`
    // returns an explicit guid verbatim, so proving does not depend on whether a
    // symbol was available at this call site.
    const entries: Array<[string, Expr]> = [[shape.arg, target]];
    const runtime: Record<string, unknown> = {
      [shape.arg]: unbound ? null : { name: "", guid },
    };

    const as = (a.stored as { as?: unknown }).as;
    if (typeof as === "string" && as !== "") {
      entries.push(["as", lit(as)]);
      runtime.as = as;
    }

    if (shape.takesInput !== false) {
      const input = callInput(a);
      if (!input) return null;
      if (Object.keys(input.runtime).length > 0) {
        entries.push(["input", input.expr]);
        runtime.input = input.runtime;
      }
    }

    if (shape.extra) {
      const extra = shape.extra(a);
      if (!extra) return null;
      entries.push(...extra.entries);
      Object.assign(runtime, extra.runtime);
    }

    return prove(a.ctx, a.stored, shape.path, [runtime], [obj(entries)]);
  };
}

/** `api.call`'s optional header override and token auth. */
const apiCallExtra: CallShape["extra"] = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const entries: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};

  const headers = toValue(context.headers);
  if (context.headers !== undefined) {
    if (!headers) return declineHere("api.call: context.headers is not a tagged value");
    entries.push(["headers", decodeValue(a.ctx, headers)]);
    runtime.headers = headers;
  }

  const token = toValue(context.token);
  if (context.token !== undefined) {
    if (!token) return declineHere("api.call: context.token is not a tagged value");
    const authEntries: Array<[string, Expr]> = [["token", decodeValue(a.ctx, token)]];
    const auth: Record<string, unknown> = { token };
    if (context.token_ignore_expiration === true) {
      authEntries.push(["ignoreExpiration", lit(true)]);
      auth.ignoreExpiration = true;
    }
    entries.push(["auth", obj(authEntries)]);
    runtime.auth = auth;
  }
  return { entries, runtime };
};

/**
 * The TOP-LEVEL `runtime` block that makes a call asynchronous.
 *
 * The engine switches on `runtime.mode` and recognizes exactly two values:
 * `async-shared` builds its runtime config from `mode` alone, and
 * `async-dedicated` additionally reads `cpu`/`memory`/`max_retry`/`timeout`.
 * Every other value — the absent block, `null`, and the editor's explicit
 * `"disabled"` — falls to the default arm, which is synchronous.
 *
 * So a non-async block carries nothing and is not authored back; anything else
 * would be noise on the 222 synchronous calls in the survey corpus that store
 * `null` or nothing at all.
 */
const asyncRuntimeExtra: CallShape["extra"] = (a) => {
  const block = (a.stored as { runtime?: unknown }).runtime;
  if (block === null || block === undefined) return { entries: [], runtime: {} };
  if (typeof block !== "object" || Array.isArray(block))
    return declineHere("function.run: `runtime` is present but not a block");
  const mode = (block as { mode?: unknown }).mode;
  if (mode !== "async-shared" && mode !== "async-dedicated")
    return { entries: [], runtime: {} };

  const cells: Array<[string, Expr]> = [["mode", lit(mode)]];
  const runtime: Record<string, unknown> = { mode };
  // The dedicated resources, and ONLY at the mode that reads them. At
  // `async-shared` the editor writes all four blank and the engine never looks
  // at them, so carrying them across would author inert members.
  if (mode === "async-dedicated") {
    for (const [stored, arg] of [
      ["cpu", "cpu"],
      ["memory", "memory"],
      ["timeout", "timeout"],
      ["max_retry", "maxRetry"],
    ] as const) {
      const v = (block as Record<string, unknown>)[stored];
      if (typeof v !== "string" && typeof v !== "number")
        return declineHere(`function.run: \`runtime.${stored}\` is not a scalar`);
      if (v === "") continue;
      cells.push([arg, lit(String(v))]);
      runtime[arg] = String(v);
    }
  }
  return { entries: [["runtime", obj(cells)]], runtime: { runtime } };
};

/**
 * `mvp:function` — the non-injective stored name.
 *
 * `serviceFunctionRun` writes `context.runtime_mode`; `functionRun` does not.
 * That single key is the discriminator, so it is read rather than guessed.
 */
const functionRunOrService: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const isService = context.runtime_mode !== undefined;
  if (!isService) {
    return callDecoder({
      path: "function.run",
      arg: "fn",
      idPath: "function.id",
      unbindable: true,
      extra: asyncRuntimeExtra,
    })(a);
  }
  return callDecoder({
    path: "service.function.run",
    arg: "fn",
    idPath: "function.id",
    unbindable: true,
    extra: () => {
      const mode = context.runtime_mode;
      if (typeof mode !== "string")
        return declineHere("service.function.run: context.runtime_mode is not a string");
      // `"shared"` is the factory default; stating it would be noise.
      return mode === "shared"
        ? { entries: [], runtime: {} }
        : { entries: [["runtimeMode", lit(mode)]], runtime: { runtimeMode: mode } };
    },
  })(a);
};

/** Call-family decoders by stored name. */
export const CALL_DECODERS: ReadonlyMap<string, SpecialDecoder> = new Map<string, SpecialDecoder>([
  ["mvp:function", functionRunOrService],
  ["mvp:workspace_run_function", callDecoder({ path: "function.call", arg: "fn", idPath: "id" })],
  [
    "mvp:workspace_run_endpoint",
    callDecoder({ path: "api.call", arg: "api", idPath: "id", extra: apiCallExtra }),
  ],
  [
    "mvp:workspace_run_task",
    callDecoder({ path: "task.call", arg: "task", idPath: "id", takesInput: false }),
  ],
  ["mvp:workspace_run_tool", callDecoder({ path: "tool.call", arg: "tool", idPath: "id" })],
  [
    "mvp:workspace_run_trigger",
    callDecoder({ path: "trigger.call", arg: "trigger", idPath: "id" }),
  ],
  [
    "mvp:workspace_run_middleware",
    callDecoder({ path: "middleware.call", arg: "middleware", idPath: "id" }),
  ],
  ["mvp:workspace_run_addon", callDecoder({ path: "addon.call", arg: "addon", idPath: "id" })],
  [
    "mvp:action",
    callDecoder({ path: "action.call", arg: "action", idPath: "run_version.id", external: true }),
  ],
]);
