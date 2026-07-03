---
name: monocle
description: Query the local Monocle room-memory prototype when the user asks what was just said, what the latest or last presentation was about, what action items came up, or invokes Monocle explicitly with phrases like /monocle, $monocle, or ask Monocle.
---

# Monocle

Use Monocle to answer questions from the local webcam/microphone room-memory recorder. It can answer from spoken transcripts and per-clip webcam frame summaries.

## Workflow

1. Treat the user's Monocle invocation text as the question. If it starts with `/monocle` or `$monocle`, remove that prefix.
2. Use this installed repository path:

```bash
__MONOCLE_REPO__
```

If this section still shows an unreplaced placeholder instead of a filesystem path, the skill was copied without running the README install command. Locate the local `monocle-room-memory-poc` checkout before continuing.

3. Run the query bridge from the prototype directory:

```bash
cd "__MONOCLE_REPO__"
npm run ask:monocle -- "$QUESTION"
```

4. Relay the answer and cited clips concisely.

If the command reports that the server is unavailable, start it:

```bash
screen -dmS monocle-room-memory-poc zsh -lc 'cd "__MONOCLE_REPO__" && npm start >> /tmp/monocle-room-memory-poc.log 2>&1'
```

Then rerun the query.

## Notes

- The recorder UI is at `http://localhost:5177`.
- The bridge reads the same memory as the app backend, currently `data/memory.jsonl`.
- Prefer `npm run ask:monocle -- --minutes 30 "$QUESTION"` if the user asks about an older portion of the session.
