# pi-elapsed

How long did the agent **actually WORK** on your prompt?

`pi-elapsed` times each Pi agent turn from the moment the agent starts working
(`agent_start`) to the moment it fully settles (`agent_settled`), shows a live
timer in the footer while it runs, and reports the result when it's done —
**excluding the time Pi spent blocked waiting on you**.

Existing timer extensions (`pi-metrics`, `run-timer`, `pi-execution-time`,
`pi-timer`, …) all measure **plain wall-clock** time from prompt → settled.
None pause when Pi stops to ask you something. This one does.

## Why pause?

Pi frequently blocks mid-turn while **you** make a decision:

- **Permission-gate dialogs** — pi-defender's `patterns.yaml` prompt,
  pi-guardrails' "dangerous command" confirm (e.g. an `rm -rf …` the agent wants
  to run). These block inside a `tool_call` handler via `ctx.ui.confirm()` /
  `ctx.ui.custom()`.
- **`ctx.ui.select` / `ctx.ui.confirm` / `ctx.ui.input`** — any extension prompt
  that stops the agent for your input (branch selection, choose an option,
  "is this OK?").
- A **`codex_ask`** or similar select-style tool the agent calls, where the
  "tool" is really a question to the user.

Wall-clock time hides how long the agent *actually took*. `pi-elapsed` reports:

```
⏱ done: 12m 40s active · 3m 22s waiting on you (2×)
```

…so the headline number is the **working time** — the metric that says how long
the task took.

## Install

```bash
pi install ./elapsed        # registers in ~/.pi/agent/settings.json "packages"
# then restart Pi, or /reload
```

> ⚠️ A raw file copy into `~/.pi/agent/extensions/` is **not** loaded by pi ≥0.79
> (verified empirically on 0.84.1) — `pi install` is the only reliable path.

## Usage

No config needed. During a turn the footer shows a live timer
(`⏱ 3m 12s`); while Pi waits on you it flips to `⏸ waiting on you · 3m 12s worked`
(frozen). At turn end it shows the summary and a notification.

`/elapsed` re-shows the last completed turn's breakdown.

## What counts as "waiting on you" (the pause triggers)

| Trigger | Detected how |
|---|---|
| pi-defender / pi-guardrails permission gate | `tool_execution_start` on a risky bash command (rm -rf, sudo, chmod 777, kill -9, disk tools, chown) that hasn't finished after **1.2 s** → watchdog pauses. Resumes instantly when that exact tool finishes. Same heuristic as [pi-zed-notify](https://github.com/kevinsanchez/zed-pi-noti). |
| Any extension's `ctx.ui.*` prompt | Cooperative event-bus emit right before blocking (see below) |
| pi-guardrails' named event | `guardrails:action:prompted` → pause immediately |
| Agent restarts the loop (auto-retry / steer follow-up) | `agent_start` re-fires → resume (dialog must be closed) |
| New LLM call begins | `turn_start` → resume (only possible after the blocking batch finished) |
| User sends input | `input` → resume |

## Interop: tell `pi-elapsed` when YOUR extension blocks on a user prompt

If you write an extension that waits on the user, emit on the event bus right
before blocking, using either channel (aliases — both paused by `pi-elapsed`):

```ts
pi.events.emit("pi-elapsed:pause", { source: "my-ext", detail: "branch selection" });
// …or, for symmetry with the bell extension:
pi.events.emit("pi-zed-notify:attention", { source: "my-ext", detail: "branch selection" });
await ctx.ui.select("Pick a branch", branches);
```

`pi.events.emit` is a harmless no-op if `pi-elapsed` isn't installed, so the
call is safe to add unconditionally. (This mirrors the inter-extension pattern
in `pi-zed-notify`.)

## What about wall time?

The log still records it: `/tmp/pi-elapsed.log` lines like
`turn end — active 12m 40s, waiting 3m 22s across 2 pause(s) (wall 16m 2s)`.
The **wall** figure is total elapsed including pauses; **active** subtracts them.

## Diagnostics

- `/tmp/pi-elapsed.log` — appends every event (pause/resume with reasons,
  turn start/end with breakdowns)
- `/tmp/pi-elapsed.loaded` — load marker proving pi evaluated the module

## Limitations

- Pi exposes no generic "waiting for input" event. Per-extension dialogs
  (`ctx.ui.confirm()` / `ctx.ui.input()`) opened directly by other extensions
  won't pause **unless** the extension emits a cooperative channel first — the
  gate watchdog only covers risky-bash gates. When an unannounced dialog closes,
  the next `turn_start` un-pauses the timer.
- In print/RPC mode (no TUI) gates auto-deny and extensions can't block, so
  pauses are inert (watchdog guarded by `ctx.hasUI`).
- Resumes are event-driven: if a pause happens but no resume event ever fires
  (e.g. the user closes a dialog and no new LLM call happens before
  `agent_settled`), the leftover waiting time is simply counted as "waiting on
  you" rather than active.

## Design notes

- `agent_start → agent_settled` is one "run" — retries, auto-compaction,
  and queued steering/follow-ups all count as part of the same task, matching
  the semantics pi-metrics and run-timer use. (`turn_end` fires per provider
  round-trip and would fragment the count.)
- Zero runtime npm dependencies; `@earendil-works/pi-coding-agent` is a peer
  dependency provided by pi at runtime.
- Best-effort I/O: logs and status rendering can never throw pi.