/**
 * `microservice.request` — call a container workload running alongside the
 * workspace (`mvp:microservice_request`).
 *
 * Its own module rather than a member of the external-HTTP-request family: a
 * microservice is a first-class workspace object with its own def factory and
 * its own deploy path, and this statement shares nothing with `api.request`
 * beyond the `{request, response}` result envelope — no TLS/cert fields, no
 * `output` envelope, and a different required-field contract (see
 * {@link MICROSERVICE_DEFAULTS}).
 *
 * The bulk of what lives here is host/port resolution: `host` and `port` are an
 * authoring convenience that folds into the single `"name:port"` string the
 * engine actually reads, and everything provably wrong about that pairing is
 * thrown on at build time rather than left to fail at request time.
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import type { Value } from "../../values/value.js";
import { generated } from "../generated/factories.generated.js";
import type { StatementAnnotations } from "../statement.js";
import { declaredServicePorts, type MicroserviceDef } from "../../kinds/microservice.js";
import type { ApiRequestResult } from "./api-request.js";
import {
  type HttpMethod,
  isValue,
  coerceText,
  coerceObj,
  coerceArray,
  coerceInt,
  coerceBool,
} from "./coerce.js";

/** Host spellings `s.microservice.request` accepts. */
export type MicroserviceHost = MicroserviceDef | string | Value;

/**
 * Resolve `host` + `port` to the single `name:port` text field the engine reads.
 *
 * The engine splits `host` on the first `:`, resolves the name portion against
 * the microservice row, and passes the port through into the request URL — so
 * `port` is an authoring convenience that folds back into one string here, and
 * never reaches the encoder. Everything this function can prove wrong, it
 * throws on: an authored statement that names a port its own microservice does
 * not expose would deploy clean and fail only at request time.
 */
function resolveMicroserviceHost(
  host: MicroserviceHost,
  port: number | string | undefined,
): string | Value {
  // Order matters: a `Value` and a `MicroserviceDef` are both objects, so the
  // tagged-Value test has to run first and be the explicit discriminator.
  if (isValue(host)) {
    if (port !== undefined) {
      throw new Error(
        "microservice.request: `port` cannot be joined onto a dynamic `host` at build time. " +
          "Build the joined `\"name:port\"` string in the value itself instead.",
      );
    }
    return host;
  }

  if (typeof host === "string") {
    if (port !== undefined && host.includes(":")) {
      throw new Error(
        `microservice.request: \`host\` already carries a port ("${host}"), so \`port: ${String(port)}\` is ambiguous. ` +
          "Pass the port once — either joined into `host` or as `port`.",
      );
    }
    return port === undefined ? host : `${host}:${port}`;
  }

  const declared = declaredServicePorts(host);

  if (port !== undefined) {
    // A microservice declaring no ports (helm, or a builtin exposing nothing)
    // has nothing to contradict, so any port is allowed through.
    if (declared.length > 0 && !declared.includes(String(port))) {
      throw new Error(
        `microservice.request: microservice "${host.name}" does not expose port ${String(port)}. ` +
          `It declares: ${declared.join(", ")}.`,
      );
    }
    return `${host.name}:${port}`;
  }

  // One declared port is unambiguous — it is the only entry the dashboard's own
  // host dropdown would offer for this microservice.
  if (declared.length === 1) return `${host.name}:${declared[0]}`;
  // No declared ports: the engine routes a bare name to `http://name/path`.
  if (declared.length === 0) return host.name;

  throw new Error(
    `microservice.request: microservice "${host.name}" declares ${declared.length} ports ` +
      `(${declared.join(", ")}), so \`port\` is required to pick one.`,
  );
}

/**
 * The literal `servicePort`s a def declares, at the type level — the type-side
 * mirror of {@link declaredServicePorts}.
 */
type PortsOf<D> = D extends { deployment: { containers: readonly (infer C)[] } }
  ? C extends { ports: readonly (infer P)[] }
    ? P extends { servicePort: infer S extends string }
      ? S
      : never
    : never
  : never;

/** `"8080"` → `8080`, so a port may be written as a number. */
type AsNumber<S extends string> = S extends `${infer N extends number}` ? N : never;

/**
 * What `port` accepts for a given `host`.
 *
 * Constrained to the declared ports ONLY when they are known as literals. Two
 * cases deliberately fall back to the open type rather than narrowing to
 * `never`, because a false type error on valid code is worse than a missing
 * one: a def whose ports widened to `string` (annotated `MicroserviceDef`,
 * built dynamically), and a def that declares no ports at all (helm).
 */
type PortArg<D> = string extends PortsOf<D>
  ? number | string
  : [PortsOf<D>] extends [never]
    ? number | string
    : PortsOf<D> | AsNumber<PortsOf<D>>;

export interface MicroserviceArgs<H extends MicroserviceHost = MicroserviceHost>
  extends StatementAnnotations {
  /** Capture the response into this stack variable. */
  as?: string;
  /**
   * Target microservice — the `microservice()` def to call.
   *
   * A plain string is also accepted, and is the only way to reach an
   * instance-level microservice (those live in instance settings, not the
   * workspace, so there is no def to pass). It carries its own port:
   * `"legacy:80"`.
   */
  host: H;
  /**
   * Port to call, folded into `host` as `name:port`.
   *
   * Optional: a microservice declaring exactly one `servicePort` resolves to it.
   * One declaring several requires this field, and rejects a port it does not
   * expose — as a TYPE error when the def's ports are known as literals, and as
   * a build-time throw otherwise. Serialized as text, matching how
   * `servicePort` is stored.
   */
  port?: H extends MicroserviceDef ? PortArg<H> : number | string;
  /** Request path. */
  path: string | Value;
  /** HTTP verb — the 7 engine verbs are suggested; any string or dynamic `Value` is accepted. Defaults to `"GET"`. */
  method?: HttpMethod | (string & {}) | Value;
  /** Request params — a key/value object. Defaults to `{}`. */
  params?: object | Value;
  /** Headers — an array of full header-line strings. Defaults to `[]`. */
  headers?: readonly string[] | Value;
  /** Request timeout in seconds. Defaults to `10`. */
  timeout?: number | Value;
  /** Follow HTTP redirects. Defaults to `true`. */
  follow_location?: boolean | Value;
}

/**
 * Defaults for the five request fields a caller may omit.
 *
 * These MIRROR the engine's own declared defaults for this statement rather
 * than inventing SideStep ones, so an omitted field produces exactly the bytes
 * a fully-specified statement produces — and exactly what the Xano editor
 * stores, since it saves the whole form.
 *
 * They are applied rather than omitted because this statement's block schema
 * declares all five REQUIRED (no `?`), unlike its `api.request` sibling, which
 * declares them optional-with-defaults and so may leave them out. Emitting a
 * microservice call without them is rejected as a missing required argument.
 *
 * Restating a third party's defaults means they can drift. Kept in one place so
 * a drift is a one-line fix.
 */
const MICROSERVICE_DEFAULTS = {
  method: "GET",
  params: {},
  headers: [] as readonly string[],
  timeout: 10,
  follow_location: true,
} as const;

/**
 * `microservice.request` — call an in-cluster microservice
 * (`mvp:microservice_request`). Typed over the generated factory; no TLS/cert
 * fields (the engine schema omits them).
 *
 * Only `host` and `path` are required. `method`, `params`, `headers`, `timeout`,
 * and `follow_location` default to the engine's own values
 * ({@link MICROSERVICE_DEFAULTS}) and are always EMITTED — this statement's
 * block schema requires them, so they cannot simply be left out:
 *
 * ```ts
 * s.microservice.request({ as: "result", host: echoService, path: "/health" })
 * ```
 *
 * Address it by passing the `microservice()` def itself — its declared ports are
 * then checked at the authoring site, and a rename fixes every call site at once:
 *
 * ```ts
 * s.microservice.request({ host: echoService, path: "/health", ... })
 * ```
 *
 * `host` binds by NAME, not by guid — deliberately, because the engine resolves
 * this field by name too (a workspace-scoped lookup on the microservice's name).
 * A guid here would not be merely unconventional; it would be wrong.
 */
export function microserviceRequest<
  const As extends string = "",
  const H extends MicroserviceHost = MicroserviceHost,
>(
  a: MicroserviceArgs<H> & { as?: As },
): Statement & AsShapeBrand<As, ApiRequestResult> {
  return generated.microservice.request({
    as: a.as,
    host: coerceText(resolveMicroserviceHost(a.host, a.port))!,
    path: coerceText(a.path)!,
    // `??` (not `||`) so an explicit `false`/`0`/`""` is honored, not defaulted.
    method: coerceText(a.method ?? MICROSERVICE_DEFAULTS.method)!,
    params: coerceObj(a.params ?? MICROSERVICE_DEFAULTS.params)!,
    headers: coerceArray(a.headers ?? MICROSERVICE_DEFAULTS.headers)!,
    timeout: coerceInt(a.timeout ?? MICROSERVICE_DEFAULTS.timeout)!,
    follow_location: coerceBool(a.follow_location ?? MICROSERVICE_DEFAULTS.follow_location)!,
    disabled: a.disabled,
    description: a.description,
  }) as Statement & AsShapeBrand<As, ApiRequestResult>;
}
