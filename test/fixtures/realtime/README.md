# Realtime fixtures — schema-derived, NOT engine-captured

Every other fixture directory here holds JSON a **real Xano engine persisted**,
sourced via `sidestep validate --capture`. These do not. They were minted from
SideStep's own encoders against the realtime object schemas.

That distinction is the whole point of this file, so it is worth stating plainly:

- **What these goldens prove.** That the realtime encoders are stable — a
  refactor that changes a stored key, a default, or a nested block shape fails
  loudly instead of silently changing the wire format.
- **What they do NOT prove.** That the engine agrees. A schema-derived golden
  compared against the encoder that produced it is self-consistent by
  construction. If an encoder has a field wrong, the golden has it wrong too and
  the test still passes.

They were minted rather than captured because the workspace archive did not carry
realtime sections at the time, so there was no way to round-trip a realtime object
through an engine and read back what it stored.

**That is no longer true.** The archive carries all three realtime objects and both
lifecycle trigger types now, so the round-trip below is possible today — these
goldens are stale, not blocked. The only thing standing between this file and its
deletion is a capture run.

## Re-capture and promote

Re-capture these against a real engine and delete this file:

1. Ensure the realtime objects are registered in `examples/sandbox/_capture.ts`
   (they already are: `chatServer`, `lobbyChannel`, `roomChannel`, `sendMessage`,
   `typingMessage`, and the three lifecycle triggers — `onChatConnect`,
   `onRoomJoin`, `onRoomDeliver`).
2. Run the capture against a disposable instance, per the `xano-fixtures` skill.
3. Replace these files with the captured JSON and move their rows in
   `test/conformance/kinds-corpus.test.ts` from the schema-derived block into the
   main `KIND_CORPUS` table.
4. Expect real diffs on the first capture — that is the check finally doing the
   job it cannot do today. Treat each one as the usual fork: a missing
   `normalize()` strip rule, or a genuine encoder bug. Do NOT widen `normalize()`
   to make a diff disappear without deciding which of the two it is — a strip rule
   that hides an encoder bug reproduces exactly the blindness this promotion is
   removing.
5. While capturing, read the stored `input` of the `deliver` trigger. Whether a
   deliver event also supplies the message payload and a recipient identity
   distinct from the sender is the one part of that trigger's typed surface that
   was deliberately not guessed — see `src/kinds/trigger-inputs.ts`.
