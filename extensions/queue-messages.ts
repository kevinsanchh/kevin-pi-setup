import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key, type EditorTheme, type TUI, matchesKey } from "@earendil-works/pi-tui";

/**
 * A Pi editor that mirrors Codex's composer behavior:
 *
 * - Tab queues the current draft as a follow-up while the agent is working.
 * - Tab submits normally when Pi is idle, so a draft is never dropped.
 * - Tab with an empty draft keeps Pi's normal autocomplete behavior.
 *
 * Coexistence with other TUI extensions (e.g. alps-pi):
 *
 * `ctx.ui.setEditorComponent` is a single slot — whoever calls it last on
 * `session_start` replaces the previous editor. Instead of replacing, we
 * wrap the currently-installed factory via `getEditorComponent()`, so our
 * Tab handling composes with alps-pi's beautified/fixed editor rather than
 * destroying it. We only intercept Tab inside the editor instance's
 * `handleInput` (never via a global `onTerminalInput` consumer), so alps-pi's
 * own raw-input shortcuts and Pi's built-in autocomplete keep working.
 */
class QueueMessagesEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly queueDraft: () => boolean,
	) {
		super(tui, theme, keybindings);
	}

	handleInput(data: string): void {
		// When Pi has a completion menu open, Tab belongs to the menu. Let the
		// editor accept the selected slash-command or @-file completion instead
		// of queueing/submitting the draft.
		if (matchesKey(data, Key.tab) && this.isShowingAutocomplete()) {
			super.handleInput(data);
			return;
		}

		if (matchesKey(data, Key.tab) && this.queueDraft()) {
			return;
		}

		super.handleInput(data);
	}
}

// Latest session's re-assert callback; refreshed per session_start and used on
// turn_end so another extension re-installing an editor never silently wins.
let activeAssert: (() => void) | undefined;

// Editor instances we've already patched, so wrapping stays idempotent across
// repeated factory invocations or turn_end re-asserts.
const wrappedInstances = new WeakSet<object>();

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tab-queue", {
		description: "Check whether Tab message queueing is active",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Tab queue extension is active for this session.", "info");
		},
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setStatus("tab-queue", "Tab queue: on");
		ctx.ui.notify("Tab queue enabled: Tab queues drafts while Pi is busy.", "info");

		const queueDraft = (): boolean => {
			const draft = ctx.ui.getEditorText();

			// Preserve Tab's normal autocomplete behavior for an empty draft.
			if (!draft.trim()) {
				return false;
			}

			// Clear the draft before handing it to Pi, just like the built-in submit path.
			ctx.ui.setEditorText("");

			try {
				if (ctx.isIdle()) {
					// Codex treats Tab like Enter when no task is running.
					pi.sendUserMessage(draft);
					ctx.ui.notify("Submitted draft", "info");
				} else {
					// While working, wait until the current task is completely finished.
					pi.sendUserMessage(draft, { deliverAs: "followUp" });
					ctx.ui.notify("Queued follow-up", "info");
				}
			} catch (error) {
				// Restore the draft if Pi rejected the submission.
				ctx.ui.setEditorText(draft);
				ctx.ui.notify(
					`Could not queue message: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}

			return true;
		};

		// The single editor-slot type (EditorFactory|undefined), derived from the ui
		// API so we don't depend on an exact export path.
		type EditorSlot = Parameters<typeof ctx.ui.setEditorComponent>[0];

		let currentWrapper: EditorSlot;

		// Wrap the current editor factory (alps-pi's, or the default) instead of
		// replacing it. The instance-level handleInput patch keeps both extensions'
		// input handling alive, no matter which loaded first.
		const wrapCurrent = () => {
			const prev = ctx.ui.getEditorComponent();
			// Only skip when we already installed this exact wrapper; on the first
			// call prev and currentWrapper are both undefined and we must install.
			if (currentWrapper !== undefined && prev === currentWrapper) return;

			const wrapper: NonNullable<EditorSlot> = (tui, theme, keybindings) => {
				if (!prev) {
					return new QueueMessagesEditor(tui, theme, keybindings, queueDraft);
				}

				const base = prev(tui, theme, keybindings);
				if (!base) {
					return new QueueMessagesEditor(tui, theme, keybindings, queueDraft);
				}

				// Patch the live instance (alps-pi style) so we don't fight whoever
				// created it. Only wrap once per instance.
				if (typeof base.handleInput === "function" && !wrappedInstances.has(base)) {
					const originalHandleInput = base.handleInput.bind(base);
					const isShowingAutocomplete = (base as { isShowingAutocomplete?: () => boolean })
						.isShowingAutocomplete;
					base.handleInput = (data: string) => {
						// Completion menus own Tab. This is especially important for
						// slash-command and @-file suggestions, whose selected item is
						// inserted by the original editor handler.
						if (
							matchesKey(data, Key.tab) &&
							isShowingAutocomplete?.call(base)
						) {
							originalHandleInput(data);
							return;
						}
						if (matchesKey(data, Key.tab) && queueDraft()) return;
						originalHandleInput(data);
					};
					wrappedInstances.add(base);
				}
				return base;
			};

			currentWrapper = wrapper;
			ctx.ui.setEditorComponent(wrapper);
		};

		activeAssert = wrapCurrent;
		wrapCurrent();
	});

	// Re-assert after every turn. If alps-pi (or anything else) re-installs its
	// editor mid-session (e.g. via an /alps beautified-input toggle), the slot is
	// replaced; this re-wraps it so Tab queueing survives.
	pi.on("turn_end", () => {
		activeAssert?.();
	});

	pi.on("session_shutdown", () => {
		activeAssert = undefined;
	});
}