/**
 * `apiGroup({...})` — an API group (payload key `app`) that endpoints publish
 * under. `canonical` is the URL slug; CORS and auth can be configured here.
 */
import { apiGroup } from "@sidestep/core";

export const publicApi = apiGroup({
  name: "ex_kind_public_api",
  canonical: "public",
  description: "Public, unauthenticated endpoints",
});
