import { describe, it, expect, expectTypeOf } from "vitest";
import { input } from "../../src/inputs/input.js";
import { f } from "../../src/fields/catalog.js";
import { defineFunction } from "../../src/function/define.js";
import type { InferInput } from "../../src/inputs/infer.js";

/**
 * U2 — `InferInput` maps a def's declared `input` map to the request-payload
 * type. These are compile-time assertions (validated by `tsc`, which includes
 * `test/`); the `@ts-expect-error` cases prove the produced type actually
 * rejects wrong payloads.
 */

// A query-def-shaped literal. `typeof` preserves the value brands from U1.
const meQuery = {
  verb: "POST" as const,
  name: "me",
  input: {
    email: input.email({ required: true }),
    password: input.password({ required: true }),
  },
};

const mixed = {
  input: {
    id: input.int({ required: true }),
    nickname: input.text(), // optional
    tags: input.list(input.text()), // optional array
    status: input.enum(["active", "archived"], { required: true }),
    bio: input.text({ nullable: true }), // optional, nullable
    profile: input.object({ name: f.text({ required: true }), age: f.int() }),
  },
};

// A real defineFunction() call must preserve the input brands through the
// factory (not just a bare object literal), so InferInput resolves for functions
// exactly as it does for queries.
const someFn = defineFunction({
  name: "get_user",
  input: { id: input.int({ required: true }) },
});

// A no-input function likewise infers an empty payload (no index-signature leak).
const noInputFn = defineFunction({ name: "noop" });

const noInput = { verb: "GET" as const, name: "ping" };

describe("InferInput (type-level)", () => {
  it("both-required query → { email: string; password: string }", () => {
    expect(Object.keys(meQuery.input)).toEqual(["email", "password"]);
    expectTypeOf<InferInput<typeof meQuery>>().toEqualTypeOf<{
      email: string;
      password: string;
    }>();
  });

  it("mixed required/optional, nullable, list, enum, nested object", () => {
    expect(Object.keys(mixed.input)).toContain("profile");
    expectTypeOf<InferInput<typeof mixed>>().toEqualTypeOf<{
      id: number;
      status: "active" | "archived";
      nickname?: string;
      tags?: string[];
      bio?: string | null;
      profile?: { name: string; age?: number };
    }>();
  });

  it("a real defineFunction() preserves brands → InferInput resolves", () => {
    expect(someFn.name).toBe("get_user");
    expectTypeOf<InferInput<typeof someFn>>().toEqualTypeOf<{ id: number }>();
  });

  it("a no-input defineFunction() infers an empty payload (no index-signature leak)", () => {
    expect(noInputFn.name).toBe("noop");
    expectTypeOf<keyof InferInput<typeof noInputFn>>().toEqualTypeOf<never>();
    const empty: InferInput<typeof noInputFn> = {};
    void empty;
  });

  it("absent input → empty payload type (no required keys)", () => {
    expect(noInput.name).toBe("ping");
    // The payload type has no required keys, so `{}` assigns cleanly.
    const empty: InferInput<typeof noInput> = {};
    void empty;
    expectTypeOf<keyof InferInput<typeof noInput>>().toEqualTypeOf<never>();
  });

  it("accepts a well-typed payload, rejects wrong/missing fields", () => {
    // Well-typed payload assigns cleanly.
    const ok: InferInput<typeof meQuery> = { email: "j@x.com", password: "" };
    expectTypeOf(ok).toMatchTypeOf<{ email: string; password: string }>();

    // @ts-expect-error — password is required and missing.
    const missing: InferInput<typeof meQuery> = { email: "j@x.com" };
    void missing;

    // @ts-expect-error — email must be a string, not a number.
    const wrongType: InferInput<typeof meQuery> = { email: 1, password: "" };
    void wrongType;

    // @ts-expect-error — unknown key.
    const extra: InferInput<typeof meQuery> = { email: "j@x.com", password: "", nope: true };
    void extra;
  });

  it("an all-optional payload accepts {}", () => {
    const empty: InferInput<{ input: { a: ReturnType<typeof input.text> } }> = {};
    expectTypeOf(empty).toMatchTypeOf<{ a?: string }>();
  });
});
