/**
 * `s.realtime.publish` — originate a server-authored event onto a realtime channel
 * from an ordinary function stack.
 *
 * This is the push direction: a query, task, function, or trigger tells connected
 * clients something happened, with no client frame arriving first. "The auction
 * closed", "the import finished", "row 42 changed".
 *
 * Three things this example is shaped to teach:
 *
 *  1. DERIVE the channel path — `roomChannel.getChannel({ room_id })` — instead of
 *     concatenating `"rooms/" + id`. Publishing to a path no channel matches is not
 *     an error you will see (see 3), so the typed accessor is the only guard there is.
 *
 *  2. `authTable`/`authId` are ATTRIBUTION, not a credential. They stamp "this event
 *     is attributed to user 7" onto the frame so a client can render it. Nothing
 *     validates them and no auth gate consumes them — do NOT reach for them to grant
 *     a publish a channel's `publish.who` would refuse. This statement is
 *     server-authoritative and bypasses that gate outright, which is the whole point:
 *     it runs in YOUR stack, so YOUR stack is where the authorization belongs.
 *
 *  3. It is FAIL-SOFT and DELIVERY-ONLY. A missing or disabled server, or an
 *     unreachable bus, is swallowed engine-side — nothing throws and there is no
 *     result to check, so a mis-targeted publish is silent. And naming a `message`
 *     type does NOT invoke that message's handler; the payload is fanned out as-is.
 *     Only the two references SideStep can check (`server`, `channel`) fail loudly,
 *     at author time.
 */
import { defineFunction, s, c, obj, inp, input, auth } from "@sidestep/core";
import { users } from "../../_shared.js";
import { chatServer, roomChannel } from "../../kinds/realtime.js";

export const realtimePublish = defineFunction({
  name: "ex_realtime_publish",
  input: { room_id: input.int({ required: true }), body: input.text({ required: true }) },
  stack: [
    s.realtime.publish({
      // The server is named, not referenced by guid — the engine resolves it by
      // name within this workspace and branch. Pass the handle and the name comes
      // with it.
      server: chatServer,
      // The FILLED-IN path, not the `rooms/{room_id}` template.
      channel: c.text(roomChannel.getChannel({ room_id: 42 })),
      // Optional: the message TYPE stamped on the frame, so a client can route this
      // server-originated event the same way it routes a client-originated one.
      message: c.text("post"),
      data: obj({ body: inp("body"), room_id: inp("room_id") }),
      // Attribution only — see (2) above.
      authTable: users,
      authId: auth("id"),
    }),
  ],
});
