/**
 * Author-time refusal of a `name` the engine cannot STORE.
 *
 * Most kinds take any text. Four do not: an API `query`, a realtime `channel`,
 * a `tool`, and a realtime `message` each declare a character whitelist on the
 * stored field, and a name outside it is not saved.
 *
 * The failure is silent, which is the whole reason this module exists. The
 * write of `name` fails, but on the import path that failure is swallowed and
 * the field lands as NULL — the rest of the object persists intact. Nothing
 * reports it: deploy succeeds, the bundle round-trips, and the object shows up
 * in listings. It simply has no name, so for a query or channel the route key
 * degenerates to `"|<verb>"` and every request 404s `Unable to locate request.`
 *
 * This is one of the few places SideStep refuses input the *router* would serve
 * — the router is dot-tolerant and scans `{param}` anywhere. Refusing here is
 * refusing silent data loss, and the rule is the engine's own stored charset,
 * not a stricter invention. It is the same pattern the editor puts on these
 * name boxes, so a SideStep-authored object stays in step with a UI-authored
 * one.
 *
 * Verified live (#227): a six-name matrix deployed to a fresh env. `export_zip`
 * served 200; `export.zip`, `export.csv`, `export.xyz`, `ex.port` and
 * `dir.d/leaf` all persisted with `name: null` and 404'd. So it is not file
 * extensions, not static-asset handling, and not the router.
 */

/** Longest name the engine stores for these fields. */
const NAME_MAX = 200;

/**
 * The two whitelists in play, as the set of non-alphanumeric characters each
 * one adds. Route-shaped names take `/` (path separator) and `{}` (a param
 * marker); a plain name takes neither.
 */
export type StoredNameShape = "route" | "plain";

const EXTRA: Record<StoredNameShape, string> = {
  route: "_-{}/",
  plain: "_-",
};

const PATTERN: Record<StoredNameShape, RegExp> = {
  route: /^[A-Za-z0-9_\-{}/]+$/,
  plain: /^[A-Za-z0-9_-]+$/,
};

const DESCRIPTION: Record<StoredNameShape, string> = {
  route: 'only letters, digits, "_", "-", "/", and the "{}" of a path param',
  plain: 'only letters, digits, "_" and "-"',
};

/**
 * Throw unless `name` is one the engine will actually persist.
 *
 * `context` names the object in the error the way the rest of the kind layer
 * does (`query "export.zip"`), so the message points at the line the author
 * wrote rather than at a stage of export.
 */
export function assertStoredName(context: string, name: string, shape: StoredNameShape): void {
  if (name.length > NAME_MAX) {
    throw new Error(
      `${context}: the name is ${name.length} characters — the engine stores at most ${NAME_MAX}, and a ` +
        `longer one is dropped rather than truncated, leaving the object with an empty name. Shorten it.`,
    );
  }
  if (PATTERN[shape].test(name)) return;

  const allowed = new Set([...EXTRA[shape]]);
  const bad = [...new Set([...name])].filter(
    (ch) => !/[A-Za-z0-9]/.test(ch) && !allowed.has(ch),
  );
  const list = bad.map((ch) => JSON.stringify(ch)).join(", ");
  const hint = bad.includes(".")
    ? ` A "." is the one authors reach for: an endpoint that serves a file wants "export_zip" or ` +
      `"export/zip", not "export.zip" — the extension belongs in the response headers.`
    : "";
  throw new Error(
    `${context}: the name contains ${list}, which the engine cannot store. This name holds ` +
      `${DESCRIPTION[shape]}.${hint} Xano does not reject the write — it saves the object with an EMPTY ` +
      `name, so it deploys clean and then 404s "Unable to locate request." on every request.`,
  );
}
