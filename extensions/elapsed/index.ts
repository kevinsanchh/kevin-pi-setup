/**
 * pi-elapsed — how long did the agent actually WORK on your prompt?
 *
 * Times each agent turn from the moment the agent starts working
 * (`agent_start`) to the moment it fully settles (`agent_settled`), and shows
 * the result in the footer status bar plus a notification at the end of the
 * turn.
 *
 * The timer PAUSES while the agent is blocked waiting on YOU — the moments
 * pi-zed-notify identified as pi's "user has to pick/type/confirm" waits:
 *
 *   • permission-gate dialogs (pi-defender / pi-guardrails) that block inside
 *     a `tool_call` handler via ctx.ui.confirm()/custom() — detected with a
 *     `tool_execution_start` stall watchdog on risky bash commands, exactly
 *     like pi-zed-notify;
 *   • the cooperative event-bus channel `pi-zed-notify:attention`, which any
 *     extension can emit right before blocking on `ctx.ui.select/confirm/input`;
 *   • this extension's own alias channel `pi-elapsed:pause`;
 *   • pi-guardrails' explicit `guardrails:action:prompted` event.
 *
 * Time spent waiting on you is tracked separately and reported ("waiting on
 * you") so the headline number is ACTIVE working time — the metric that says
 * how long the agent actually took on a task, minus time it sat idle while you
 * answered a dialog.
 *
 * Install: `pi install ./elapsed` (registers in ~/.pi/agent/settings.json
 * "packages"). Diagnostics: /tmp/pi-elapsed.log, /tmp/pi-elapsed.loaded.
 */
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Diagnostics live in /tmp to avoid permission issues inside ~/.pi.
const LOG = "/tmp/pi-elapsed.log";
const LOADED = "/tmp/pi-elapsed.loaded";

/** Cooperative pause channel pi-zed-notify documents for bell requests. */
const ATTENTION_CHANNEL = "pi-zed-notify:attention";
/** pi-elapsed's own alias so extensions can opt into timing pauses only. */
const PAUSE_CHANNEL = "pi-elapsed:pause";
/** pi-guardrails announces its permission-gate dialog right before blocking. */
const GUARDRAILS_ACTION_PROMPTED = "guardrails:action:prompted";

/**
 * Same "risky bash" heuristic pi-zed-notify uses to detect gate dialogs.
 * A gate (pi-defender patterns.yaml, pi-guardrails permission prompt) blocks
 * INSIDE a tool_call handler; tool_execution_start is emitted BEFORE those
 * hooks run, so a matching bash command that stalls past the watchdog window
 * means a dialog is almost certainly open → pause the timer.
 */
const GATED_BASH_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-\S*[rf]\S*|--recursive|--force)/i, "recursive/force rm"],
  [/\bsudo\b/i, "sudo"],
  [/\b(chmod|chown)\b.*\b777\b/i, "permission 777"],
  [/\bkill\s+-9\b/i, "kill -9"],
  [/\b(dd|mkfs\.?\w*|fdisk|parted|shred)\b/i, "disk/partition tool"],
  [/\bchown\b/i, "chown"],
];

/** How long after a gated-looking bash call starts before we assume a dialog is open. */
const GATE_DETECT_MS = 1200;

function log(msg: string): void {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${msg}\n`);
  } catch {
    /* ignore */
  }
}

// Load-time marker: proves the module was actually loaded by pi.
try {
  fs.writeFileSync(LOADED, `${new Date().toISOString()}\n`);
} catch {
  /* ignore */
}

// ---------------------------------------------------------------------------
// Timer state
// ---------------------------------------------------------------------------

interface Task {
  /** Wall clock when the turn began (agent_start). */
  startWall: number;
  /** Accumulated ACTIVE ms (time the agent was working, not waiting on you). */
  accMs: number;
  /** Start of the current running segment (0 while paused). */
  segmentStart: number;
  state: "running" | "paused";
  /** Accumulated ms spent waiting on the user. */
  pausedAccMs: number;
  /** When the current pause began (0 while running). */
  pausedStart: number;
  /** How many user-wait interruptions happened this turn. */
  pauses: number;
  /**
   * toolCallId of the gated tool this pause is tied to (watchdog pauses).
   * Lets us resume the instant THAT tool finishes (dialog closed).
   */
  pauseToolCallId: string | null;
  /** Human reason for the resume log. */
  pauseReason: string | null;
}

let task: Task | null = null;
let at: NodeJS.Timeout | null = null;
const armedWatchdogs = new Map<string, NodeJS.Timeout>();

/** Freshest ctx that has UI (footer status / notify). Replaced per event. */
let uiCtx: ExtensionContext | null = null;
let lastResult: { activeMs: number; waitingMs: number; pauses: number } | null = null;

function activeMs(): number {
  if (!task) return 0;
  return task.accMs + (task.state === "running" && task.segmentStart > 0 ? Date.now() - task.segmentStart : 0);
}

function waitingMs(): number {
  if (!task) return 0;
  return task.pausedAccMs + (task.state === "paused" ? Date.now() - task.pausedStart : 0);
}

/** "3s" / "1m 23s" / "1h 4m 5s". */
function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m${r ? ` ${r}s` : ""}`;
}

function renderStatus(): void {
  if (!uiCtx?.hasUI || !task) return;
  const label =
    task.state === "paused"
      ? `⏸ waiting on you · ${fmt(activeMs())} worked`
      : `⏱ ${fmt(activeMs())}`;
  try {
    uiCtx.ui.setStatus("elapsed", label);
  } catch {
    /* ignore */
  }
}

function startTicker(): void {
  if (at) return;
  at = setInterval(() => renderStatus(), 1000);
  if (at.unref) at.unref(); // never keep the process alive just for the footer
}

function stopTicker(): void {
  if (at) {
    clearInterval(at);
    at = null;
  }
}

function startTask(): void {
  if (task) return;
  task = {
    startWall: Date.now(),
    accMs: 0,
    segmentStart: Date.now(),
    state: "running",
    pausedAccMs: 0,
    pausedStart: 0,
    pauses: 0,
    pauseToolCallId: null,
    pauseReason: null,
  };
  log("turn start");
  startTicker();
  renderStatus();
}

function pauseTask(reason: string, toolCallId: string | null = null): void {
  if (!task) return;
  if (task.state === "paused") return; // already waiting on the user
  task.accMs += Date.now() - task.segmentStart;
  task.segmentStart = 0;
  task.state = "paused";
  task.pausedStart = Date.now();
  task.pauses += 1;
  task.pauseToolCallId = toolCallId;
  task.pauseReason = reason;
  log(`pause — ${reason} (worked so far ${fmt(activeMs())})`);
  renderStatus();
}

function resumeTask(reason: string): void {
  if (!task || task.state !== "paused") return;
  task.pausedAccMs += Date.now() - task.pausedStart;
  task.pausedStart = 0;
  task.state = "running";
  task.segmentStart = Date.now();
  task.pauseToolCallId = null;
  task.pauseReason = null;
  log(`resume — ${reason} (waited ${fmt(waitingMs())})`);
  renderStatus();
}

function finishTask(): void {
  if (!task) return;
  const active = activeMs();
  const waiting = waitingMs();
  const pauses = task.pauses;
  lastResult = { activeMs: active, waitingMs: waiting, pauses };
  log(
    `turn end — active ${fmt(active)}` +
      (pauses ? `, waiting ${fmt(waiting)} across ${pauses} pause(s)` : "") +
      ` (wall ${fmt(Date.now() - task.startWall)})`,
  );
  task = null;
  stopTicker();
  if (!uiCtx?.hasUI) return;
  const summary = pauses
    ? `⏱ done: ${fmt(active)} active · ${fmt(waiting)} waiting on you (${pauses}×)`
    : `⏱ done: ${fmt(active)}`;
  try {
    uiCtx.ui.setStatus("elapsed", summary);
    uiCtx.ui.notify(summary, "info");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Gate-dialog watchdog (mirrors pi-zed-notify)
// ---------------------------------------------------------------------------

function disarmWatchdog(toolCallId: string): void {
  const t = armedWatchdogs.get(toolCallId);
  if (t) {
    clearTimeout(t);
    armedWatchdogs.delete(toolCallId);
  }
}

function clearWatchdogs(): void {
  for (const t of armedWatchdogs.values()) clearTimeout(t);
  armedWatchdogs.clear();
}

function armWatchdog(toolCallId: string, label: string): void {
  disarmWatchdog(toolCallId);
  armedWatchdogs.set(
    toolCallId,
    setTimeout(() => {
      armedWatchdogs.delete(toolCallId);
      if (!task) {
        log(`gate watchdog fired (${label}) but no active task — ignoring`);
        return;
      }
      pauseTask(`gate dialog: ${label}`, toolCallId);
    }, GATE_DETECT_MS),
  );
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  log("pi-elapsed loaded");

  const adoptCtx = (ctx: ExtensionContext | undefined): void => {
    if (ctx?.hasUI) uiCtx = ctx;
  };

  // A turn is the busy period agent_start → agent_settled. agent_start also
  // covers restored/queued runs that reached the loop without a visible input,
  // and re-fires mid-turn (retries, auto-compaction, steer follow-ups).
  // If it re-fires while paused, the blocking dialog must be closed — resume.
  pi.on("agent_start", (_event, ctx) => {
    adoptCtx(ctx);
    if (!task) startTask();
    else if (task.state === "paused") resumeTask("agent_start (loop restarted)");
  });

  // New user message (or steer mid-run). Only meaningful here as a resume
  // signal: if the user typed something, the agent is no longer blocked on a
  // dialog. A steer while running does not reset timing.
  pi.on("input", (_event, ctx) => {
    adoptCtx(ctx);
    if (task?.state === "paused") resumeTask("user input");
  });

  // agent_settled = no retry/compaction/follow-up left → the turn is truly over.
  pi.on("agent_settled", () => {
    clearWatchdogs();
    finishTask();
  });

  // Cooperative pauses (attention/guardrails channels) are not pinned to a
  // toolCallId; their reliable "dialog closed" signal is a fresh LLM call, since
  // turn_start can only fire after the blocking tool batch finished. Watchdog
  // pauses resume earlier on their own tool_execution_end.
  // (Also covers plain ctx.ui.select/confirm/input dialogs from other
  // extensions that never emit a cooperative channel — if one closes while the
  // timer is paused, the next turn_start un-pauses it.)

  // A new LLM call started ⇒ any gate dialog is surely closed.
  pi.on("turn_start", () => {
    clearWatchdogs();
    if (task?.state === "paused") resumeTask("turn_start");
  });

  pi.on("tool_execution_start", (event, ctx) => {
    adoptCtx(ctx);
    if (!ctx?.hasUI || event.toolName !== "bash") return;
    const command = String((event.args as { command?: unknown } | undefined)?.command ?? "");
    const hit = GATED_BASH_PATTERNS.find(([re]) => re.test(command));
    if (hit) {
      log(`tool_execution_start ${event.toolCallId} bash (${hit[1]}) — arming gate watchdog`);
      armWatchdog(event.toolCallId, hit[1]);
    }
  });

  pi.on("tool_execution_end", (event) => {
    disarmWatchdog(event.toolCallId);
    // If this is the exact gated tool we paused for, the dialog closed — resume
    // the instant it finishes instead of waiting for the next turn_start.
    if (task?.state === "paused" && task.pauseToolCallId === event.toolCallId) {
      resumeTask(`${task.pauseReason ?? "gated tool"} completed`);
    }
  });

  // Cooperative channels — any extension that blocks on ctx.ui.* can ping
  // these right before blocking (pi.events.on is harmless even if the emitting
  // extension is not installed, and vice versa).
  const unsubAttention = pi.events.on(ATTENTION_CHANNEL, (data: unknown) => {
    const { source, detail } = (data ?? {}) as { source?: string; detail?: string };
    log(`cooperative pause via ${ATTENTION_CHANNEL} (source=${source ?? "?"}${detail ? `, detail=${detail}` : ""})`);
    pauseTask(`cooperative: ${source ?? detail ?? "extension"}`);
  });
  const unsubPause = pi.events.on(PAUSE_CHANNEL, (data: unknown) => {
    const { source, detail } = (data ?? {}) as { source?: string; detail?: string };
    log(`cooperative pause via ${PAUSE_CHANNEL} (source=${source ?? "?"}${detail ? `, detail=${detail}` : ""})`);
    pauseTask(`cooperative: ${source ?? detail ?? "extension"}`);
  });
  const unsubGuardrails = pi.events.on(GUARDRAILS_ACTION_PROMPTED, (data: unknown) => {
    const { feature, reason } = (data ?? {}) as { feature?: string; reason?: string };
    log(`guardrails gate (feature=${feature ?? "?"})`);
    pauseTask(`guardrails: ${feature ?? reason ?? "gate"}`);
  });

  pi.registerCommand("elapsed", {
    description: "Show the last completed turn: working time vs. time spent waiting on you",
    handler: async (_args, ctx) => {
      if (!lastResult) {
        ctx.ui.notify("No completed turn recorded yet this session.", "info");
        return;
      }
      const { activeMs: a, waitingMs: w, pauses } = lastResult;
      const msg = pauses
        ? `Last turn: ${fmt(a)} active · ${fmt(w)} waiting on you (${pauses}×)`
        : `Last turn: ${fmt(a)} active`;
      ctx.ui.notify(msg, "info");
    },
  });

  pi.on("session_shutdown", () => {
    clearWatchdogs();
    stopTicker();
    if (task) {
      log("session shutdown with task in-flight — discarding");
      task = null;
    }
    unsubAttention();
    unsubPause();
    unsubGuardrails();
    uiCtx = null;
  });
}