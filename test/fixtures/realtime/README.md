# Realtime fixtures — engine-captured

These five were **captured from a real Xano engine** and live in the main
`KIND_CORPUS`, alongside every other engine-persisted golden. They used to be
schema-derived — minted from SideStep's own encoders, and therefore self-consistent by
construction — because the workspace archive did not carry realtime sections and no
round-trip existed. It does now, so they were captured and promoted.

## What the first capture found

All five objects — the server, both channels, both messages — matched their
schema-derived predecessor **exactly** under `normalize()`. The encoders were already
right; the promotion changed the goldens from a restatement of that belief into
evidence for it.

The capture was not uneventful, though. It found a real bug one level up, in the
lifecycle **triggers**: the engine stores a uniform six-group `meta` skeleton on every
trigger type, and SideStep emitted only the owning group for realtime triggers (plus a
four-group skeleton, missing both realtime groups, for every other type). A comment in
`src/kinds/trigger.ts` had asserted the single-group shape was "verified against its
own record" — it was inferred, not verified. That is precisely the failure mode a
schema-derived golden cannot catch, and the reason this promotion was worth doing.

## The two lifecycle triggers are still schema-derived

`triggers/ex_kind_trigger_on_chat_connect.json` and
`triggers/ex_kind_trigger_on_room_join.json` stay in the annex table in
`test/conformance/kinds-corpus.test.ts` — for a specific reason, not as a pending
chore:

`normalize()` deliberately **preserves** a trigger's guid-string `obj_id`, because
that is what proves the trigger points at the right object. The ephemeral-environment
capture path **re-mints every guid** in the engine's own format
(`4bKT1A5av3h7xDOrCYgQp2ex2lY`) instead of preserving the md5 SideStep derives
(`md5("dbo:users")`), so a golden captured there would pin a guid the compiled side
can never produce — and the corpus would fail on a difference that is not a defect.

Capturing those two needs an import path that preserves supplied guids. Their `meta`
is engine-verified regardless; it came from the live capture.

## Re-capturing

1. The realtime objects and all three lifecycle triggers are registered in
   `examples/sandbox/_capture.ts` (`chatServer`, `lobbyChannel`, `roomChannel`,
   `sendMessage`, `typingMessage`, `onChatConnect`, `onRoomJoin`, `onRoomDeliver`).
2. `sidestep validate <capture> --capture` is the intended path — it preserves guids.
   When it is unavailable, `sidestep deploy` to a fresh ephemeral env plus
   `sidestep ephemeral export <name>` works for everything except guid-bearing
   comparisons (see above).
3. Diff against the current goldens under `normalize()` **before** overwriting, and
   make the comparison key-order-insensitive — a raw `JSON.stringify` reports key
   order as a difference and buries the real diffs in noise.
4. Treat each surviving diff as the usual fork (see the `xano-fixtures` skill): a
   missing `normalize()` strip rule, or a genuine encoder bug. Do NOT widen
   `normalize()` to make a diff disappear without deciding which it is — a strip rule
   that hides an encoder bug reproduces exactly the blindness this promotion removed.
5. While capturing, read the stored `input` of the `deliver` trigger. Whether a
   deliver event also supplies the message payload and a recipient identity distinct
   from the sender is the one part of that trigger's typed surface that was
   deliberately not guessed — see `src/kinds/trigger-inputs.ts`.
