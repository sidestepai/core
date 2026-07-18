/**
 * Small flag→env→saved→default resolvers shared by the `login` and `push`
 * command modules, so both agree on how the instance, auth host, and scope are
 * chosen. Pure; no I/O.
 */
import type { ParsedArgs } from "../emit/cli.js";
import { DEFAULT_AUTH_HOST, DEFAULT_SCOPE } from "./oauth.js";

/** Target instance origin: `--instance` → `$XANO_INSTANCE` → saved. May be undefined. */
export function resolveInstance(args: ParsedArgs, saved?: string): string | undefined {
  return args.instance ?? process.env.XANO_INSTANCE ?? saved;
}

/** cloud-master OAuth host: `--auth-host` → `$XANO_AUTH_HOST` → saved → default. */
export function resolveAuthHost(args: ParsedArgs, saved?: string): string {
  return args.authHost ?? process.env.XANO_AUTH_HOST ?? saved ?? DEFAULT_AUTH_HOST;
}

/** Requested scopes: `--scope` → the built-in default set. */
export function resolveScope(args: ParsedArgs): string {
  return args.scope ?? DEFAULT_SCOPE;
}

/**
 * Reject a non-https origin before any token or auth code crosses it. Plain
 * http is permitted only for loopback hosts (local dev). Also surfaces a clear
 * error for a scheme-less value instead of a bare "Invalid URL" deep in a fetch.
 */
export function assertHttpsOrigin(origin: string, label: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`${label} is not a valid URL: "${origin}" (expected e.g. https://your-instance.xano.io).`);
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(`${label} must use https:// (got "${origin}"). Plain http is allowed only for localhost.`);
  }
}
