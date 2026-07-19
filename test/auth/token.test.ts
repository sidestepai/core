import { describe, it, expect } from "vitest";
import { isTransientRefreshError } from "../../src/auth/token.js";

describe("isTransientRefreshError", () => {
  // A refresh failure the CLI should retry (and NOT tell the user to run
  // `sidestep login` for): the request never reached the authorization server,
  // so it carries no OAuth error code. See issue #23.
  it("treats transport-level failures as transient", () => {
    expect(isTransientRefreshError(new Error("fetch failed"))).toBe(true);
    expect(isTransientRefreshError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientRefreshError(Object.assign(new Error("timeout"), { name: "AbortError" }))).toBe(true);
    expect(isTransientRefreshError("some string")).toBe(true);
  });

  // An OAuth error response is deterministic and auth-related — never retried,
  // and `sidestep login` (or its handled invalid_grant path) is the right fix.
  it("treats OAuth error responses as non-transient", () => {
    expect(isTransientRefreshError({ error: "invalid_grant" })).toBe(false);
    expect(isTransientRefreshError(Object.assign(new Error("x"), { error: "invalid_client" }))).toBe(false);
  });
});
