# pi-time-compact

A [pi](https://pi.dev) extension that compacts the session after it has been idle for a configurable time.

After a break, the provider's prompt cache has usually expired, so the next prompt resends the whole transcript at full price. Compacting while you are away means you come back to a short summary plus recent messages instead.

## Install

```bash
pi install git:github.com/wawow830/pi-time-compact
# or try it for one run
pi -e git:github.com/wawow830/pi-time-compact
```

## Configure

Add an `idleCompaction` key to `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`. Every field is optional:

```json
{
  "idleCompaction": {
    "enabled": true,
    "timeoutMs": 1800000,
    "minTokens": 0,
    "customInstructions": "Focus on open tasks"
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `enabled` | `true` | Compact idle sessions. |
| `timeoutMs` | `1800000` (30 min) | Idle time before compacting. |
| `minTokens` | `0` | Skip sessions whose context is smaller than this. |
| `customInstructions` | — | Focus instructions for the summary, as in `/compact [instructions]`. |

Global and project settings merge like pi's own settings. Changes apply when the next idle period starts.

## Behavior

- The idle clock starts when a session opens and when a run has fully settled (`agent_settled`). That means no retry, auto-compaction, or queued message is still pending.
- Submitting a prompt, running a `!` command, or an open extension dialog resets the clock.
- When the clock runs out, pi's own compaction runs. You get the same progress indicator, summary, Escape to cancel, `session_before_compact` hooks, and `compaction` settings as `/compact`.
- It skips sessions that were just compacted and sessions whose context is not larger than `compaction.keepRecentTokens`, including per-model overrides, because there is nothing to summarize.
- It works independently of `compaction.enabled`, which only controls pi's context-threshold compaction.
- With `cacheWarming: "idle"`, it stops pi from warming the stale pre-compaction prompt after an idle compaction, until the next prompt.

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e ./index.ts
```
