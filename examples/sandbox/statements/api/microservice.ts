/**
 * `s.api.microservice` — call a container workload running alongside the
 * workspace.
 *
 * Address it by passing the `microservice()` def itself. The engine resolves
 * this field by NAME (a workspace-scoped lookup on the microservice's name, not
 * a guid), so `host` binds to `.name` — which means a rename in one place fixes
 * every call site at once, and SideStep can check the port before you deploy.
 *
 * `port` folds into `host` as the single `"name:port"` string the engine reads;
 * there is no separate port field on the wire. It is optional:
 *
 *  - a microservice exposing exactly ONE `servicePort` resolves to it, so the
 *    common case needs no port at all (Gate 1);
 *  - one exposing SEVERAL requires it, and rejects a port it does not expose
 *    (Gate 2) — the error names the ports it does.
 *
 * A plain string still works and is the only way to reach an INSTANCE-level
 * microservice (those live in instance settings, not the workspace, so there is
 * no def to pass). It carries its own port: `"legacy:80"` (Gate 3).
 */
import { c, defineFunction, ref, s } from "@sidestep/core";
import { echoService } from "../../kinds/microservice.js";

/**
 * Gate 1 — address the def; its single declared port is resolved for you.
 *
 * `echoService` exposes one `servicePort` ("8080"), so this emits
 * `host: "ex_kind_echo_service:8080"` without naming a port here.
 */
export const apiMicroservice = defineFunction({
  name: "ex_api_microservice",
  stack: [
    s.api.microservice({
      as: "result",
      host: echoService,
      path: c.text("/health"),
      method: "GET",
      params: c.obj({}),
      headers: [],
      timeout: c.int(10),
      follow_location: true,
    }),
  ],
  response: ref("result"),
});

/**
 * Gate 2 — name the port explicitly.
 *
 * Always valid, and required once a microservice exposes more than one port.
 * A number or a string is accepted; both serialize as text, matching how
 * `servicePort` is stored everywhere else.
 */
export const apiMicroservicePort = defineFunction({
  name: "ex_api_microservice_port",
  stack: [
    s.api.microservice({
      as: "result",
      host: echoService,
      port: 8080,
      path: c.text("/health"),
      method: "GET",
      params: c.obj({}),
      headers: [],
      timeout: c.int(10),
      follow_location: true,
    }),
  ],
  response: ref("result"),
});

/**
 * Gate 3 — a raw `"name:port"` string, for an instance-level microservice.
 *
 * Accepted, but reach for it only when there is no def to pass: nothing checks
 * the name or the port, so a typo here deploys clean and fails at request time.
 */
export const apiMicroserviceInstanceHost = defineFunction({
  name: "ex_api_microservice_instance_host",
  stack: [
    s.api.microservice({
      as: "result",
      host: "legacy:80",
      path: c.text("/status"),
      method: "GET",
      params: c.obj({}),
      headers: [],
      timeout: c.int(10),
      follow_location: true,
    }),
  ],
  response: ref("result"),
});
