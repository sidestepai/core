/**
 * Compile-checked consumer example — mirrors the README's "Consuming a query as
 * a contract" section and the original feature request (a frontend importing a
 * sidestep query def). It is NOT a test file (no `.test` suffix) so vitest ignores
 * it, but `tsc --noEmit` type-checks it (test/ is in the tsconfig include), so
 * the documented usage cannot rot.
 */
import { query, apiGroup, input, type InferInput } from "../../src/index.js";

const auth = apiGroup({ name: "auth", canonical: "auth" });

export const meQuery = query({
  name: "me",
  verb: "POST",
  apiGroup: auth,
  input: {
    email: input.email({ required: true }),
    password: input.password({ required: true }),
  },
});

const BASE = "https://x8ki-letl-twmt.n7.xano.io";

// The request-payload type is derived from the query's inputs.
export type MePayload = InferInput<typeof meQuery>; // { email: string; password: string }

export function login(email: string, password: string): Promise<Response> {
  const payload = { email, password } satisfies MePayload;
  return fetch(BASE + meQuery.getPath(), {
    method: meQuery.verb,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// A GET query carries its inputs in the query string, not a JSON body.
export const getSnippet = query({
  name: "get_snippet",
  verb: "GET",
  apiGroup: auth,
  input: { id: input.int({ required: true }) },
});

export type GetSnippetPayload = InferInput<typeof getSnippet>; // { id: number }

export function fetchSnippet(id: number): Promise<Response> {
  const params = { id } satisfies GetSnippetPayload;
  // `query.toSearchParams` is the GET transport counterpart to `InferInput`.
  return fetch(`${BASE}${getSnippet.getPath()}?${query.toSearchParams(params)}`);
}
