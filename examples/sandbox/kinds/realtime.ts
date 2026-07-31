/**
 * `realtimeServer({...})` / `realtimeChannel({...})` / `realtimeMessage({...})`
 * — the realtime (websocket) family, and the only three-level containment chain
 * in the SDK:
 *
 *   realtimeServer  ->  realtimeChannel  ->  realtimeMessage
 *   (api group       ->  … as a query would sit under a group, one level deeper)
 *
 * PARAM GATE: the tier. A server owns channels; a channel owns message handlers.
 *
 * Two things worth copying from this example:
 *
 *  1. Pass the HANDLE, not a name. `realtimeChannel({ server: chatServer })` and
 *     `realtimeMessage({ channel: roomChannel })` — a channel path is unique only
 *     within its server, so a handle is what makes the binding unambiguous. A
 *     message given a bare channel path must also be given a `server`.
 *
 *  2. A channel's `input` types its PATH parameters; a message's `input` types
 *     the message PAYLOAD. Both reach the stack as ordinary declared inputs, read
 *     with `inp()` — `inp("room_id")` for the channel's path param, `inp("body")`
 *     for the payload field. They are different schemas for different things —
 *     see `roomChannel` (path) vs `sendMessage` (payload), whose stack reads both.
 *
 *  3. DERIVE the client's socket URL and channel path from the defs —
 *     `chatServer.getUrl(baseUrl)` and `roomChannel.getChannel({ room_id })` —
 *     never hardcode them. See `CLIENT_SNIPPET` at the bottom.
 */
import {
  realtimeServer,
  realtimeChannel,
  realtimeMessage,
  realtimeServerTrigger,
  realtimeChannelTrigger,
  input,
  inp,
  s,
} from "@sidestep/core";

/** Gate 1 — the server: the canonical-addressed container. Off until enabled. */
export const chatServer = realtimeServer({
  name: "ex_kind_chat_server",
  description: "Team chat over websockets",
  enabled: true,
});

/** Gate 2a — a STATIC channel: one lobby everyone joins. */
export const lobbyChannel = realtimeChannel({
  name: "lobby",
  server: chatServer,
  description: "The single shared lobby",
  // Anyone authenticated may publish; presence tracks who is in the room.
  publish: { who: "authenticated" },
  presence: true,
});

/**
 * Gate 2b — a PARAMETERIZED channel: one channel per room. `{room_id}` is bound
 * and validated at join time from the joined path (`rooms/42` → `room_id = 42`),
 * exactly as a query's path params are. A literal segment beats a parameter, so
 * `lobby` and `rooms/{room_id}` coexist without conflict.
 */
export const roomChannel = realtimeChannel({
  name: "rooms/{room_id}",
  server: chatServer,
  description: "One channel per room",
  input: { room_id: input.int() },
  publish: { who: "authenticated" },
  // The client-visible TRANSCRIPT: at join the server PUSHES the last 50
  // messages back, unasked — `conversation_start`, then ordinary `message`
  // frames flagged `conversation: true`, then `conversation_end`. That IS the
  // frontend's hydration; do not write a "fetch recent messages" endpoint for
  // it. Log to a table only for durability/search beyond this window.
  // Distinct from `history`, which is execution history for debugging.
  conversation: { enabled: true, limit: 50 },
});

/**
 * Gate 3 — a message handler: the invocable unit, and the realtime analogue of a
 * query. `input` here is the message PAYLOAD; `stack` is the same statement
 * stack every other kind uses.
 */
export const sendMessage = realtimeMessage({
  name: "send",
  channel: roomChannel, // the handle carries the server too
  description: "Post a message to a room",
  input: { body: input.text({ required: true }) },
  // Everyone in the channel receives the result (the default). `sender` would
  // make it request/response over the socket; `others` excludes the sender.
  deliverTo: "channel",
  // BOTH input surfaces read the same way — `inp()`. `inp("body")` is this
  // message's payload; `inp("room_id")` is the CHANNEL's path param, bound once
  // when the client joined `rooms/42` and read from the connection thereafter
  // (never from the frame, so a sender cannot post into a room it did not join).
  // A persisting handler swaps the log for `s.db.add({ table, data: { ... } })`.
  stack: [s.debug.log({ value: inp("room_id") })],
  response: { room_id: inp("room_id"), body: inp("body") },
});

/** A second handler on the same channel — a channel owns N named message types. */
export const typingMessage = realtimeMessage({
  name: "typing",
  channel: roomChannel,
  description: "Ephemeral typing indicator",
  // Only the other participants need to know; echoing to the sender is noise.
  deliverTo: "others",
});

/** Server lifecycle trigger — fires on connect/disconnect. */
export const onChatConnect = realtimeServerTrigger({
  name: "ex_kind_trigger_on_chat_connect",
  realtimeServer: chatServer,
  actions: { connect: true, disconnect: true },
  stack: (t) => [s.debug.log({ value: t.action })],
});

/**
 * DERIVE THE CLIENT SIDE. Both halves of what a browser needs come off the
 * defs, so a rename or a re-minted canonical cannot desync the client:
 *
 *   chatServer.getUrl("https://x.dev.xano.io")      // wss://x.dev.xano.io/ws/<canonical>
 *   chatServer.getUrl("https://x/tenant/a-b-c")     // /ws/a-b-c:<canonical> — lifted from the URL
 *   chatServer.getUrl(base, { tenant: "a-b-c" })    // /ws/<tenant>:<canonical> — tenant DB
 *   roomChannel.getChannel({ room_id: 42 })         // "rooms/42" — the frame's `channel`
 *
 * `getUrl` accepts the instance base URL you already have (`https://…`) and
 * normalizes the scheme to `wss://`; a remote host must be `wss` (a `ws://`
 * socket fails as an opaque 1006).
 *
 * ON A TENANT INSTANCE, both halves of the client must name the tenant, and both
 * do it in the URL — but not in the same shape. The socket glues it on with a
 * colon inside ONE segment (`/ws/<tenant>:<canonical>`, `{ tenant }` above),
 * while HTTP gives it a segment of its own
 * (`/tenant/<tenant>/api:<canonical>/…`). No request header is required either
 * way. So
 * `getUrl` TRANSLATES a tenant base URL rather than concatenating it: pass the
 * `window.XANO_HOST` deploy injects (`https://<host>/tenant/<name>`) and the
 * tenant is lifted into the socket form with no `{ tenant }` needed; a
 * conflicting `{ tenant }` throws. A tenant on its OWN DOMAIN has nothing to
 * lift — pass `{ tenant }` there. Tokens are tenant-scoped, so one minted
 * through the instance workspace is rejected by the tenant's realtime server —
 * authenticate and dial through the same tenant.
 *
 * Auth is a bearer token passed as the
 * websocket SUBPROTOCOL — `new WebSocket(url, token)` — with no token meaning an
 * anonymous client. Join before you broadcast:
 *
 *   const ws = new WebSocket(chatServer.getUrl(BASE), TOKEN);
 *   const channel = roomChannel.getChannel({ room_id: 42 });
 *   ws.onopen = () => setTimeout(() => {
 *     ws.send(JSON.stringify({ action: "join", channel }));
 *     ws.send(JSON.stringify({ action: "broadcast", channel, type: "send", payload: { body: "hi" } }));
 *   }, 500); // the server finishes its handshake first; an early frame is refused
 *
 * A canonical is minted and frozen by `sidestep export --lock`, so these throw
 * (rather than guess) until one is pinned in code or in `xano.lock`.
 */

/** Channel lifecycle trigger — fires on join/leave of a specific channel. */
export const onRoomJoin = realtimeChannelTrigger({
  name: "ex_kind_trigger_on_room_join",
  channel: roomChannel,
  actions: { join: true },
  stack: (t) => [s.debug.log({ value: t.channel })],
});

/**
 * The channel's third action, and the one with a different posture: `deliver`
 * runs once per RECIPIENT of a message, not once per channel event.
 *
 * `join` gates the join and `leave` only observes, but `deliver` gates each
 * individual delivery — its return rewrites that recipient's copy of the payload,
 * drops the message for that recipient, or passes the original through. That makes
 * it the tool for per-viewer redaction ("hide the author's address from everyone
 * but the author"), and also the most expensive action here by a wide margin: a
 * stack per recipient per message.
 *
 * Kept as its own trigger rather than folded into `onRoomJoin` because the two
 * fire at unrelated moments and want unrelated stacks.
 */
export const onRoomDeliver = realtimeChannelTrigger({
  name: "ex_kind_trigger_on_room_deliver",
  channel: roomChannel,
  actions: { deliver: true },
  stack: (t) => [s.debug.log({ value: t.action })],
});
