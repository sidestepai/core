/**
 * `s.microservice.request` — the in-cluster microservice call.
 *
 * Split out of the api-request suite when microservices were promoted to a
 * top-level feature: this statement shares only the `{request, response}`
 * result envelope with the external-HTTP family, and everything interesting
 * about it (host/port folding, the def-addressing gates, the always-emitted
 * defaults) is its own.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import "../../src/index.js"; // register all statements
import { s } from "../../src/statements/s.js";
import { inp, ref } from "../../src/values/value.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { query } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { microservice, type MicroserviceDef } from "../../src/kinds/microservice.js";
import type { InferResponse } from "../../src/responses/infer.js";
import type { ApiRequestResult } from "../../src/statements/special/api-request.js";

/** Pull an input entry `{value, tag}` by name from an encoded statement. */
function field(encoded: ReturnType<typeof encodeStatement>, name: string) {
  const entry = (encoded.input as Array<{ name: string; value: unknown; tag: string }>).find(
    (e) => e.name === name,
  );
  return entry && { value: entry.value, tag: entry.tag };
}

describe("s.api.microservice", () => {
  it("encodes host/path and coerces required fields", () => {
    const encoded = encodeStatement(
      s.api.microservice({
        as: "m1",
        host: "svc",
        path: "/health",
        method: "GET",
        params: {},
        headers: [],
        timeout: 3,
        follow_location: true,
      }),
    );
    expect(encoded.name).toBe("mvp:microservice_request");
    expect(field(encoded, "host")).toEqual({ value: "svc", tag: "const" });
    expect(field(encoded, "params")).toEqual({ value: "{}", tag: "const:obj" });
    expect(field(encoded, "follow_location")).toEqual({ value: "true", tag: "const:bool" });
  });

  it("needs only host and path, and still emits all seven fields", () => {
    // The block schema declares method/params/headers/timeout/follow_location
    // REQUIRED (unlike api.request's, which defaults them), so they cannot be
    // omitted from the wire — they are defaulted to the engine's own values.
    const minimal = encodeStatement(s.api.microservice({ as: "m", host: "svc", path: "/health" }));
    const explicit = encodeStatement(
      s.api.microservice({
        as: "m",
        host: "svc",
        path: "/health",
        method: "GET",
        params: {},
        headers: [],
        timeout: 10,
        follow_location: true,
      }),
    );
    expect(minimal.input).toEqual(explicit.input);
    expect((minimal.input as Array<{ name: string }>).map((e) => e.name)).toEqual([
      "host",
      "path",
      "method",
      "params",
      "headers",
      "timeout",
      "follow_location",
    ]);
    expect(field(minimal, "method")).toEqual({ value: "GET", tag: "const" });
    expect(field(minimal, "params")).toEqual({ value: "{}", tag: "const:obj" });
    expect(field(minimal, "headers")).toEqual({ value: "[]", tag: "const:array" });
    expect(field(minimal, "timeout")).toEqual({ value: "10", tag: "const:int" });
    expect(field(minimal, "follow_location")).toEqual({ value: "true", tag: "const:bool" });
  });

  it("honors an explicit falsy override rather than defaulting it", () => {
    // `??`, not `||` — `false` and `0`-ish values are real choices, not absences.
    const encoded = encodeStatement(
      s.api.microservice({ host: "svc", path: "/p", follow_location: false, timeout: 1 }),
    );
    expect(field(encoded, "follow_location")).toEqual({ value: "false", tag: "const:bool" });
    expect(field(encoded, "timeout")).toEqual({ value: "1", tag: "const:int" });
  });

  it("addresses a microservice() def by name (U1)", () => {
    const svc = microservice({
      name: "echo_svc",
      deployment: { containers: [{ name: "c", image: "i", ports: [{ servicePort: "8080" }] }] },
    });
    const base = { path: "/health", method: "GET", params: {}, headers: [], timeout: 3 } as const;

    // A single declared port resolves without `port`, and an explicit port —
    // number or string — produces byte-identical output.
    const implicit = encodeStatement(s.api.microservice({ host: svc, ...base, follow_location: true }));
    const num = encodeStatement(s.api.microservice({ host: svc, port: 8080, ...base, follow_location: true }));
    const str = encodeStatement(s.api.microservice({ host: svc, port: "8080", ...base, follow_location: true }));

    expect(field(implicit, "host")).toEqual({ value: "echo_svc:8080", tag: "const" });
    expect(field(num, "host")).toEqual(field(implicit, "host"));
    expect(field(str, "host")).toEqual(field(implicit, "host"));
    // The rest of the envelope is untouched by the new field.
    expect(num.input).toEqual(implicit.input);
  });

  it("joins a port onto a string host (U1)", () => {
    const base = { path: "/p", method: "GET", params: {}, headers: [], timeout: 3, follow_location: true } as const;
    expect(field(encodeStatement(s.api.microservice({ host: "echo", port: 5678, ...base })), "host")).toEqual({
      value: "echo:5678",
      tag: "const",
    });
    // An already-joined string is the instance-level spelling — passed through.
    expect(field(encodeStatement(s.api.microservice({ host: "legacy:80", ...base })), "host")).toEqual({
      value: "legacy:80",
      tag: "const",
    });
  });

  it("rejects a port it cannot join (U1)", () => {
    const base = { path: "/p", method: "GET", params: {}, headers: [], timeout: 3, follow_location: true } as const;
    // Doubled port — ambiguous which one wins.
    expect(() => s.api.microservice({ host: "echo:5678", port: 5678, ...base })).toThrow(/already carries a port/);
    // A dynamic host cannot be joined at build time.
    expect(() => s.api.microservice({ host: inp("h"), port: 9000, ...base })).toThrow(/dynamic `host`/);
    // ...but a dynamic host on its own still passes straight through.
    const dyn = encodeStatement(s.api.microservice({ host: inp("h"), ...base }));
    expect(field(dyn, "host")?.tag).toBe("input");
  });

  it("guards `port` against the def's declared ports (U2)", () => {
    const one = microservice({
      name: "one_port",
      deployment: { containers: [{ name: "c", image: "i", ports: [{ servicePort: "8080" }] }] },
    });
    const two = microservice({
      name: "two_port",
      deployment: {
        containers: [
          { name: "a", image: "i", ports: [{ servicePort: "8080" }] },
          { name: "b", image: "i", ports: [{ servicePort: "9090" }] },
        ],
      },
    });
    const base = { path: "/p", method: "GET", params: {}, headers: [], timeout: 3, follow_location: true } as const;

    // A port the microservice does not expose is caught twice: as a type error
    // (the literal ports are known), and as a throw naming the real ones.
    // @ts-expect-error 9000 is not one of one_port's declared servicePorts
    expect(() => s.api.microservice({ host: one, port: 9000, ...base })).toThrow(/does not expose port 9000.*8080/s);
    // Ambiguous without a port, resolvable with one.
    expect(() => s.api.microservice({ host: two, ...base })).toThrow(/declares 2 ports \(8080, 9090\)/);
    expect(field(encodeStatement(s.api.microservice({ host: two, port: 9090, ...base })), "host")).toEqual({
      value: "two_port:9090",
      tag: "const",
    });
  });

  it("allows any port when the def declares none (U2)", () => {
    const helm = microservice({ name: "helm_svc", kind: "helm", chart: { ref: "oci://x/y" } });
    const portless = microservice({
      name: "bare_svc",
      deployment: { containers: [{ name: "c", image: "i" }] },
    });
    const base = { path: "/p", method: "GET", params: {}, headers: [], timeout: 3, follow_location: true } as const;

    // Nothing declared, nothing to contradict: bare name, or any port asked for.
    expect(field(encodeStatement(s.api.microservice({ host: helm, ...base })), "host")).toEqual({
      value: "helm_svc",
      tag: "const",
    });
    expect(field(encodeStatement(s.api.microservice({ host: helm, port: 9000, ...base })), "host")).toEqual({
      value: "helm_svc:9000",
      tag: "const",
    });
    expect(field(encodeStatement(s.api.microservice({ host: portless, ...base })), "host")).toEqual({
      value: "bare_svc",
      tag: "const",
    });
  });

  it("types `port` against the def's declared ports (U5)", () => {
    const one = microservice({
      name: "one_port",
      deployment: { containers: [{ name: "c", image: "i", ports: [{ servicePort: "8080" }] }] },
    });
    const two = microservice({
      name: "two_port",
      deployment: {
        containers: [
          { name: "a", image: "i", ports: [{ servicePort: "8080" }] },
          { name: "b", image: "i", ports: [{ servicePort: "9090" }] },
        ],
      },
    });
    const helm = microservice({ name: "helm_svc", kind: "helm", chart: { ref: "oci://x/y" } });
    // A def annotated with the wide type — its ports are `string`, not literals.
    const widened: MicroserviceDef = one;
    const base = { path: "/p", method: "GET", params: {}, headers: [], timeout: 3, follow_location: true } as const;

    // Declared ports accept both spellings; a third is rejected.
    expect(() => s.api.microservice({ host: one, port: 8080, ...base })).not.toThrow();
    expect(() => s.api.microservice({ host: one, port: "8080", ...base })).not.toThrow();
    expect(() => s.api.microservice({ host: two, port: 8080, ...base })).not.toThrow();
    expect(() => s.api.microservice({ host: two, port: 9090, ...base })).not.toThrow();
    // @ts-expect-error 7070 is declared by neither container
    expect(() => s.api.microservice({ host: two, port: 7070, ...base })).toThrow(/does not expose/);

    // Nothing declared and nothing inferable both fall back to the open type,
    // so valid code never trips a false type error.
    expect(() => s.api.microservice({ host: helm, port: 9000, ...base })).not.toThrow();
    expect(() => s.api.microservice({ host: widened, port: 8080, ...base })).not.toThrow();
    expect(() => s.api.microservice({ host: "legacy", port: 80, ...base })).not.toThrow();

    // ...and where the type gave up, the runtime guard still holds the line —
    // which is why U2 stays even with inference in place. No @ts-expect-error
    // here: the widened type genuinely permits this, and only the throw catches it.
    expect(() => s.api.microservice({ host: widened, port: 9000, ...base })).toThrow(/does not expose/);
  });
});

describe("s.microservice.request result typing (InferResponse)", () => {
  it("binds the same {request, response} envelope as api.request", () => {
    const grp = apiGroup({ name: "g", canonical: "ms-oracle" });
    const ms = query({
      verb: "GET",
      apiGroup: grp,
      name: "ms",
      stack: [s.api.microservice({ host: "svc", path: "/p", as: "r" })],
      response: ref("r"),
    });
    expect(ms).toBeDefined();
    expectTypeOf<InferResponse<typeof ms>>().toEqualTypeOf<ApiRequestResult>();
  });
});
