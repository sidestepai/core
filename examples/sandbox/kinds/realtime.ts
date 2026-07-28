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
 *     the message PAYLOAD. Both reach the stack. They are different schemas for
 *     different things — see `roomChannel` (path) vs `sendMessage` (payload).
 */
import {
  realtimeServer,
  realtimeChannel,
  realtimeMessage,
  realtimeServerTrigger,
  channelTrigger,
  input,
  s,
  c,
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
  // The client-visible TRANSCRIPT: a rejoining client is sent the last 50
  // messages. Distinct from `history`, which is execution history for debugging.
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
  stack: [s.debug.log({ value: c.text("message received") })],
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

/** Channel lifecycle trigger — fires on join/leave of a specific channel. */
export const onRoomJoin = channelTrigger({
  name: "ex_kind_trigger_on_room_join",
  channel: roomChannel,
  actions: { join: true },
  stack: (t) => [s.debug.log({ value: t.channel })],
});
