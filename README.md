# self-compact

A Claude Code mod that lets Claude compact its own conversation at a breakpoint it chooses, and tells it how full the context is so it doesn't have to guess.

## What it adds

- **`compact` tool.** Claude calls it at a natural breakpoint with a `resume` note (and optional `instructions` for the summary). When the turn ends, the mod queues `/compact`, and once compaction finishes it starts a new turn with the note, so the work continues without input from you.
- **`context_usage` tool.** Reports tokens used against the auto-compact threshold and the full window, plus a short log of recent self-compact events.
- **Fill warnings.** Claude gets one hidden reminder each time the context crosses 50%, 70%, 85% or 95% of the auto-compact threshold. At 85% it is told to plan a compaction, and at 95% to compact at the very next breakpoint.
- **Status line.** Shows `ctx N%`, plus `· compact queued` while a compaction is pending.

If you interrupt the turn, a queued compaction is cancelled. Subagents can't compact the main conversation.

## Install

At the prompt of a terminal session:

```
/plugin install self-compact --marketplace Quiet-Wolfe/self-compact
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```bash
claude plugin install self-compact --marketplace Quiet-Wolfe/self-compact
```

## Notes

- `$.session.compact()` is refused while a turn is running, including from `turn.complete` hooks. The mod therefore queues the `/compact` command, which the engine runs once the session is idle, and the resume prompt waits in the queue behind it.
- Tested live in the Claude desktop app on Claude Code 2.1.304, where a session went from 144k to 97k tokens and resumed by itself.

## License

MIT
