/**
 * Route-manifest emission (`sidestep routes <entry> --emit <path>`).
 *
 * "Derive paths from the defs, never hardcode them" is the SDK's central
 * frontend rule, and following it costs the whole core runtime: importing one
 * query def for its `getPath()` pulls the statement factories in with it,
 * because the `s.*`/`c.*` CALLS that build the def run at module load and cannot
 * be tree-shaken. Measured on a minimal Vite app, that is ~37 kB of minified JS
 * for a single path string — 48x the hand-written equivalent (issue #223).
 *
 * The documented escape hatch is a hand-typed `ROUTES` table, which is the exact
 * thing the rule exists to prevent: the strings rot silently when a def's `name`
 * changes, and the compile-time key checking is lost.
 *
 * This module removes the trade-off. Everything a frontend needs — the verb, the
 * resolved `/api:<canonical>/<name>` path, and the `{param}` names — is already
 * known at export time. Writing it out as plain data yields the same typed,
 * rename-safe contract at near-zero bundle cost.
 *
 * The emitted file imports NOTHING. It is generated TypeScript with an inline
 * interpolator, so the guarantee is structural rather than a tree-shaking hope:
 * there is no `@sidestep/core` specifier in it for a bundler to follow.
 *
 * Keyed by each query's real `name` — the same string the def carries — so no
 * identifier is invented from it, and a backend rename surfaces as a compile
 * error at every call site rather than a 404 at runtime.
 *
 * The realtime half (issue #233) is the same trade for sockets. `getUrl()` and
 * `getChannel()` carry the same derive-don't-hardcode rule and the same import
 * cost, and the socket's tenant form (`/ws/<tenant>:<canonical>`) is the one
 * address a frontend genuinely cannot reconstruct — the tenant is glued to the
 * canonical inside a single path segment, unlike the HTTP half's
 * `/tenant/<name>/api:<canonical>`. So the manifest carries the servers'
 * canonicals and the channels' paths too, and emits `socketUrl`/`channelPath`
 * over the same inlined interpolator `routePath` uses.
 */
import { parsePathParams } from "../kinds/path-params.js";
import type { HttpVerb } from "../kinds/query.js";

/** One endpoint, as the emitter needs it. */
export interface RouteEntry {
  /** The query's `name`, `{param}` markers intact — the manifest's key. */
  name: string;
  verb: HttpVerb;
  /** The api group's resolved canonical URL token. */
  canonical: string;
}

/** One realtime server, as the emitter needs it. */
export interface RealtimeServerEntry {
  /** The server's `name` — the manifest's key, and what `socketUrl` selects on. */
  name: string;
  /** The server's resolved canonical URL token (the socket's connection hash). */
  canonical: string;
}

/** One realtime channel, as the emitter needs it. */
export interface RealtimeChannelEntry {
  /** The channel path, `{param}` markers intact — the manifest's key. */
  name: string;
  /** The owning server's `name` (a key of {@link RealtimeServerEntry}). */
  server: string;
}

/** The realtime half of a manifest. Omitted entirely when a workspace has none. */
export interface RealtimeManifest {
  servers: readonly RealtimeServerEntry[];
  channels: readonly RealtimeChannelEntry[];
}

/** Emit-time failure: a route the manifest cannot describe. */
export class RouteManifestError extends Error {}

/** A TypeScript string literal for `value`, safe in single quotes. */
function literal(value: string): string {
  return JSON.stringify(value);
}

/**
 * An object literal body from already-rendered `  "key": …,` rows. Empty renders
 * as `{}` rather than a pair of braces around a blank line — reachable now that
 * a realtime-only workspace emits a manifest with no routes in it.
 */
function objectLiteral(rows: readonly string[]): string {
  return rows.length === 0 ? "{}" : `{\n${rows.join("\n")}\n}`;
}

/**
 * One `routePath`/`channelPath` overload per entry, so the params argument is
 * typed exactly — a missing key, a wrong key, or params on a static path are all
 * compile errors rather than runtime throws at request time.
 */
function overloadsFor(fn: string, rows: readonly { name: string; params: string[] }[]): string {
  return rows
    .map((r) =>
      r.params.length === 0
        ? `export function ${fn}(name: ${literal(r.name)}): string;`
        : `export function ${fn}(name: ${literal(r.name)}, params: { ${r.params
            .map((p) => `${literal(p)}: string | number`)
            .join("; ")} }): string;`,
    )
    .join("\n");
}

/**
 * The realtime section's source text — the servers' canonicals, the channels and
 * their owning server, and the typed `channelPath` overloads.
 *
 * Channels key on their path alone, which is what buys the compile-time key
 * checking, so two servers cannot both own a channel of the same path in one
 * manifest. That is refused here rather than silently resolved: qualifying the
 * key by server would rewrite every call site in the file the moment a second
 * server appears.
 */
function renderRealtime(realtime: RealtimeManifest): string {
  const servers = [...realtime.servers].sort((a, b) => a.name.localeCompare(b.name));
  const known = new Map(servers.map((s) => [s.name, s]));

  const seenServer = new Set<string>();
  for (const server of servers) {
    if (seenServer.has(server.name)) {
      throw new RouteManifestError(
        `Two realtime servers are both named "${server.name}". The manifest keys on the server ` +
          `name, so the names must be unique. Rename one.`,
      );
    }
    seenServer.add(server.name);
  }

  const seenChannel = new Map<string, string>();
  const channels = [...realtime.channels]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((channel) => {
      const clash = seenChannel.get(channel.name);
      if (clash !== undefined) {
        throw new RouteManifestError(
          `The channel path "${channel.name}" is owned by both realtime server "${clash}" and ` +
            `"${channel.server}". The route manifest keys channels on their path, so the paths must be ` +
            `unique across servers. Rename one channel.`,
        );
      }
      seenChannel.set(channel.name, channel.server);
      if (!known.has(channel.server)) {
        throw new RouteManifestError(
          `The channel "${channel.name}" names the realtime server "${channel.server}", which is not in ` +
            `this workspace. A channel's socket URL comes from its server's canonical, so the server must ` +
            `be registered too.`,
        );
      }
      return { ...channel, params: parsePathParams(`channel "${channel.name}"`, channel.name) };
    });

  const serverRows = servers.map(
    (s) => `  ${literal(s.name)}: { canonical: ${literal(s.canonical)} },`,
  );
  const channelRows = channels.map(
    (c) => `  ${literal(c.name)}: { server: ${literal(c.server)} },`,
  );

  return `
/** Every realtime server in this workspace, by name, with its resolved canonical. */
export const REALTIME_SERVERS = ${objectLiteral(serverRows)} as const;

/** Every realtime server name in this workspace. */
export type RealtimeServerName = keyof typeof REALTIME_SERVERS;

/** Every realtime channel in this workspace, by path, with its owning server. */
export const CHANNELS = ${objectLiteral(channelRows)} as const;

/** Every realtime channel path in this workspace. */
export type ChannelName = keyof typeof CHANNELS;

${overloadsFor("channelPath", channels)}
${REALTIME_IMPLEMENTATION}`;
}

/**
 * The generated module's source text.
 *
 * `routes` and `realtime` are expected pre-resolved (canonicals already looked
 * up) and are sorted here so the output is deterministic — the file is committed
 * and diffed, and a re-run that reorders it would show as spurious churn.
 *
 * The realtime section is emitted only for a workspace that has one, so a
 * query-only manifest is byte-identical to what it was before #233.
 */
export function renderRouteManifest(
  routes: readonly RouteEntry[],
  realtime?: RealtimeManifest,
): string {
  const sorted = [...routes].sort(
    (a, b) => a.canonical.localeCompare(b.canonical) || a.name.localeCompare(b.name),
  );

  const seen = new Set<string>();
  const rows = sorted.map((route) => {
    if (seen.has(route.name)) {
      throw new RouteManifestError(
        `Two endpoints are both named "${route.name}". The route manifest keys on the endpoint ` +
          `name, so the names must be unique across api groups. Rename one.`,
      );
    }
    seen.add(route.name);
    const params = parsePathParams(`route "${route.name}"`, route.name);
    const path = `/api:${route.canonical}/${route.name.replace(/^\/+/, "")}`;
    return { ...route, params, path };
  });

  const entries = rows.map(
    (r) => `  ${literal(r.name)}: { verb: ${literal(r.verb)}, path: ${literal(r.path)} },`,
  );

  const realtimeSection =
    realtime && (realtime.servers.length > 0 || realtime.channels.length > 0)
      ? renderRealtime(realtime)
      : "";

  return `${HEADER}${FILL_PARAMS}
export const ROUTES = ${objectLiteral(entries)} as const;

/** Every endpoint name in this workspace. */
export type RouteName = keyof typeof ROUTES;

${overloadsFor("routePath", rows)}
${IMPLEMENTATION}${realtimeSection}`;
}

const HEADER = `/**
 * GENERATED by \`sidestep routes --emit\`. Do not edit.
 *
 * Plain data plus one interpolator — this file imports nothing, so a frontend
 * gets the typed path/verb (and socket) contract without pulling the SDK runtime
 * into its bundle. Regenerate after changing an endpoint's name, verb, or api
 * group, or a realtime server's or channel's name.
 */
`;

/**
 * The emitted interpolator — ONE copy, shared by `routePath` and `channelPath`.
 *
 * Mirrors \`fillPathParams\` rule for rule — unknown key, missing or empty value,
 * non-finite number, and a value containing \`/\` all throw. Inlined rather than
 * imported because importing it is the bundle cost this file exists to avoid;
 * the round-trip tests pin the emitted implementation to \`getPath()\` and
 * \`getChannel()\` alike. \`noun\` only names the thing in the error text — a route
 * and a channel address differently but interpolate identically.
 *
 * Emitted BEFORE the data, because an overload set must be immediately followed
 * by its own implementation.
 */
const FILL_PARAMS = `
function fillParams(
  label: string,
  noun: string,
  template: string,
  params?: Record<string, string | number>,
): string {
  const declared = [...template.matchAll(/\\{([^/{}]+)\\}/g)].map((m) => m[1]!);
  for (const key of Object.keys(params ?? {})) {
    if (!declared.includes(key)) {
      throw new Error(
        \`\${label}: \\\`\${key}\\\` is not a {param} of this \${noun}.\` +
          (declared.length ? \` Expected: \${declared.join(", ")}.\` : \` This \${noun} is static.\`),
      );
    }
  }
  return template.replace(/\\{([^/{}]+)\\}/g, (_all, key: string) => {
    const value = (params ?? {})[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(\`\${label}: missing a value for the path param \\\`\${key}\\\`.\`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(\`\${label}: the path param \\\`\${key}\\\` is \${value}.\`);
    }
    const text = String(value);
    if (text.includes("/")) {
      throw new Error(
        \`\${label}: the path param \\\`\${key}\\\` cannot contain "/" — \` +
          \`it would address a different \${noun}.\`,
      );
    }
    return text;
  });
}
`;

/** The emitted `routePath`, which must directly follow its overload signatures. */
const IMPLEMENTATION = `
export function routePath(name: RouteName, params?: Record<string, string | number>): string {
  // Read through a widened view: a workspace with no endpoints at all makes
  // \`RouteName\` \`never\`, which cannot index the literal type.
  const route = (ROUTES as Record<string, { verb: string; path: string } | undefined>)[name];
  if (!route) throw new Error(\`routePath: unknown route "\${String(name)}".\`);
  return fillParams(\`routePath("\${String(name)}")\`, "route", route.path, params);
}
`;

/**
 * The emitted realtime accessors.
 *
 * \`channelPath\` reuses the same \`fillParams\` the routes use — one interpolator
 * in the file, so the two addressing rules cannot drift apart.
 *
 * \`socketPath\`/\`socketUrl\` mirror \`realtimeServer().getPath()\`/\`getUrl()\` rule
 * for rule: the scheme is normalized to \`ws\`/\`wss\` (a scheme-less host is
 * assumed secure), a \`/tenant/<name>\` prefix on the base URL is LIFTED into the
 * socket's \`<tenant>:<canonical>\` form rather than concatenated, and an explicit
 * \`tenant\` that disagrees with the one the base URL names throws instead of
 * picking a winner. That lift is the whole reason the realtime half is in the
 * manifest — the socket's colon form is not derivable from the HTTP URL a
 * frontend already holds.
 */
const REALTIME_IMPLEMENTATION = `
export function channelPath(name: ChannelName, params?: Record<string, string | number>): string {
  if (!(CHANNELS as Record<string, unknown>)[name]) {
    throw new Error(\`channelPath: unknown channel "\${String(name)}".\`);
  }
  return fillParams(\`channelPath("\${String(name)}")\`, "channel", String(name), params);
}

/** Reject a tenant name that would break the \\\`<tenant>:<canonical>\\\` split. */
function assertTenant(tenant: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(tenant)) {
    throw new Error(
      \`socketUrl: invalid \\\`tenant\\\` \${JSON.stringify(tenant)} — a tenant name is alphanumeric with \` +
        \`dashes (e.g. "xxxx-xxxx-xxxx"). It rides as a "<tenant>:<canonical>" prefix, so ":" and "/" \` +
        "cannot appear in it.",
    );
  }
  return tenant;
}

/** The websocket PATH — \\\`/ws/<canonical>\\\`, or \\\`/ws/<tenant>:<canonical>\\\`. */
export function socketPath(server: RealtimeServerName, opts?: { tenant?: string }): string {
  const entry = REALTIME_SERVERS[server];
  if (!entry) throw new Error(\`socketPath: unknown realtime server "\${String(server)}".\`);
  const prefix = opts?.tenant ? \`\${assertTenant(opts.tenant)}:\` : "";
  return \`/ws/\${prefix}\${entry.canonical}\`;
}

/** The absolute websocket URL — \\\`baseUrl\\\` + {@link socketPath}, scheme normalized to ws/wss. */
export function socketUrl(
  server: RealtimeServerName,
  baseUrl: string,
  opts?: { tenant?: string },
): string {
  if (!REALTIME_SERVERS[server]) {
    throw new Error(\`socketUrl: unknown realtime server "\${String(server)}".\`);
  }
  const base = (baseUrl ?? "").trim().replace(/\\/+$/, "");
  if (!base) throw new Error('socketUrl: needs a base URL (e.g. "https://x.dev.xano.io").');
  const socketBase = /^wss?:\\/\\//i.test(base)
    ? base
    : /^https?:\\/\\//i.test(base)
      ? base.replace(/^http/i, "ws")
      : \`wss://\${base}\`;
  // A tenant base URL names its tenant as its own path segment; the socket glues
  // it to the canonical inside one segment. Translate rather than concatenate —
  // the concatenated form never upgrades at all.
  const lifted = /^(wss?:\\/\\/[^/]+)\\/tenant\\/([^/]+)(\\/.*)?$/i.exec(socketBase);
  let origin = socketBase;
  let tenant = opts?.tenant;
  if (lifted) {
    const fromBase = lifted[2]!;
    if (tenant !== undefined && tenant !== fromBase) {
      throw new Error(
        \`socketUrl: given tenant \${JSON.stringify(tenant)} but the base URL names \` +
          \`\${JSON.stringify(fromBase)} (".../tenant/\${fromBase}"). Refusing to guess which one you \` +
          "meant — pass the matching tenant, or a base URL without the \\"/tenant/<name>\\" prefix.",
      );
    }
    origin = \`\${lifted[1]!}\${lifted[3] ?? ""}\`;
    tenant = assertTenant(fromBase);
  }
  return \`\${origin}\${socketPath(server, { tenant })}\`;
}
`;
