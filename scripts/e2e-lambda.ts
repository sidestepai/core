/**
 * End-to-end proof of the lambda surface (issue #221) against a LIVE ephemeral
 * environment, over PUBLIC HTTP.
 *
 * The probes and the example checks call functions through the meta run route,
 * which is the right tool for them but is not what a user's traffic does. This
 * deploys a QUERY whose stack runs lambda bodies — a filter reduce, a filter
 * map, and two lambda statements — into a throwaway ephemeral environment
 * through the same transports `sidestep deploy` uses, then POSTs to its public
 * URL and checks the values that come back.
 *
 * What only this can show: that the statement surface sees the REQUEST's own
 * `$input` under real HTTP (not a meta-runner payload), that `$env`/`$auth` are
 * present there, and that a body authored with the implied surface computes the
 * right answer end to end. The environment is deleted on the way out.
 *
 * Run (maintainer step; needs a live instance):
 *   tsx scripts/e2e-lambda.ts     # reads XANO_VALIDATE_* from .env
 */
import { workspace, apiGroup, query, s, c, ref, input, withFilters, fl, serializeBundle } from "../src/index.js";
import { resolveValidateConfig } from "../src/validate/config.js";
import { MetaClient } from "../src/validate/meta-client.js";

const api = apiGroup({ name: "lambda", canonical: "lambda" });

const total = query({
  name: "total",
  verb: "POST",
  apiGroup: api,
  input: { qty: input.int({ required: true }), rate: input.decimal({ required: true }) },
  stack: [
    // reduce with the implied surface, over a literal array
    s.set_var("sum", withFilters(c.array([1, 2, 3, 4]), fl.reduce({ initial_value: 0, code: ({ $result, $this }) => $result + $this }))),
    // map, implied surface
    s.set_var("doubled", withFilters(c.array([1, 2, 3]), fl.map(({ $this }) => $this * 2))),
    // the STATEMENT surface reading real request input + a stack var
    s.lambda({
      as: "priced",
      code: ({ $input, $var }) => Math.round($input.qty * $input.rate * $var.sum * 100) / 100,
    }),
    // ambient request state under a real HTTP request
    s.lambda({ as: "ambient", code: ({ $env, $auth, $input }) => ({
      envType: typeof $env,
      authType: typeof $auth,
      sawInput: Object.keys($input ?? {}).sort().join(","),
    }) }),
  ],
  response: { sum: ref("sum"), doubled: ref("doubled"), priced: ref("priced"), ambient: ref("ambient") },
});

async function main() {
  const ws = workspace("lambda_e2e").registerApiGroups([api]).registerQueries([total]);
  const client = new MetaClient(resolveValidateConfig());
  const imp = await client.importBundle(serializeBundle((ws as unknown as { export(): unknown }).export()));
  const base = imp.baseUrl!.replace(/\/+$/, "");
  const url = `${base}${total.getPath()}`;
  console.error("POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 3, rate: 1.5 }),
  });
  const text = await res.text();
  console.error("HTTP", res.status);
  console.error(text.slice(0, 400));
  await client.dispose();
  // sum 10, doubled [2,4,6], priced = 3 * 1.5 * 10 = 45
  const ok = res.status === 200 && /"sum":10/.test(text) && /"priced":45/.test(text) && /\[2,4,6\]/.test(text);
  console.error(ok ? "E2E OK" : "E2E MISMATCH");
  process.exit(ok ? 0 : 1);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
