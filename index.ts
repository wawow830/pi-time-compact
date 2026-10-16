/**
 * Idle compaction for pi.
 *
 * Compacts the session after it has been idle for a configurable time, so the
 * next prompt after a break starts from a summary instead of resending a long
 * transcript whose prompt cache has most likely expired.
 *
 * Configure with /idle-compact, or in ~/.pi/agent/settings.json or <project>/.pi/settings.json:
 *
 * ```json
 * { "idleCompaction": { "enabled": true, "timeoutMs": 1800000, "minTokens": 0 } }
 * ```
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IdleCompactionSettingsPanel } from "./src/settings-panel.ts";
import {
	formatDuration,
	formatTokens,
	type IdleCompactionSettings,
	resolveIdleCompactionSettings,
	resolveKeepRecentTokens,
	saveGlobalIdleCompactionSettings,
} from "./src/settings.ts";

export * from "./src/settings.ts";

export default function idleCompaction(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let openPrompts = 0;
	/** Set after an idle compaction so pi stops warming the now-stale prompt cache entry. */
	let stopCacheWarming = false;
	/**
	 * Changes saved from /idle-compact. `pi.getSettings()` only rereads settings files on /reload,
	 * so they are applied on top until then. Kept across session switches within this runtime.
	 */
	let changes: Partial<IdleCompactionSettings> = {};
	let saving = Promise.resolve();

	const readSettings = () => pi.getSettings() as unknown as Record<string, unknown>;
	const currentSettings = (): IdleCompactionSettings => ({
		...resolveIdleCompactionSettings(readSettings()),
		...changes,
	});

	const disarm = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	/** Whether compacting now would actually summarize something worthwhile. */
	const worthCompacting = (ctx: ExtensionContext, settings: IdleCompactionSettings): boolean => {
		const branch = ctx.sessionManager.getBranch();
		if (branch.length === 0 || branch[branch.length - 1]?.type === "compaction") return false;
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens == null) return false;
		const keepRecentTokens = resolveKeepRecentTokens(readSettings(), ctx.model);
		return tokens > keepRecentTokens && tokens >= settings.minTokens;
	};

	const arm = (ctx: ExtensionContext) => {
		disarm();
		if (openPrompts > 0) return;
		const settings = currentSettings();
		if (!settings.enabled) return;

		timer = setTimeout(() => {
			timer = undefined;
			// Re-check at fire time: a run, queued message, or dialog may have started since arming.
			if (openPrompts > 0 || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			if (!worthCompacting(ctx, settings)) return;
			// pi renders progress, result, cancellation (Escape), and errors for compaction itself.
			ctx.compact({
				customInstructions: settings.customInstructions,
				onComplete: () => {
					stopCacheWarming = true;
				},
			});
		}, settings.timeoutMs);
		// Never keep the process alive just to compact.
		timer.unref?.();
	};

	const applyChange = (ctx: ExtensionContext, patch: Partial<IdleCompactionSettings>) => {
		changes = { ...changes, ...patch };
		saving = saving
			.then(() => saveGlobalIdleCompactionSettings(patch))
			.catch((error: unknown) => {
				ctx.ui.notify(`Failed to save idle compaction settings: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
	};

	pi.registerCommand("idle-compact", {
		description: "Configure idle compaction",
		handler: async (_args, ctx) => {
			const settings = currentSettings();
			if (ctx.mode !== "tui") {
				const state = settings.enabled ? `after ${formatDuration(settings.timeoutMs)} idle` : "off";
				ctx.ui.notify(
					`Idle compaction: ${state}, minimum context ${formatTokens(settings.minTokens)}. Configure "idleCompaction" in settings.json.`,
					"info",
				);
				return;
			}
			// The panel is a UI prompt, so the idle timer pauses while it is open and re-arms with the
			// new settings when it closes.
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new IdleCompactionSettingsPanel({
						theme,
						settings,
						keepRecentTokens: resolveKeepRecentTokens(readSettings(), ctx.model),
						onChange: (patch) => applyChange(ctx, patch),
						onClose: () => done(),
						requestRender: () => tui.requestRender(),
					}),
			);
			await saving;
		},
	});

	// Idle starts when a session opens and whenever a run has fully settled.
	pi.on("session_start", (_event, ctx) => arm(ctx));
	pi.on("agent_settled", (_event, ctx) => arm(ctx));

	// Activity resets the clock.
	pi.on("input", () => disarm());
	pi.on("agent_start", () => {
		disarm();
		stopCacheWarming = false;
	});
	pi.on("user_bash", (_event, ctx) => {
		if (ctx.isIdle()) arm(ctx);
	});
	pi.on("ui_prompt_start", () => {
		openPrompts++;
		disarm();
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		openPrompts = Math.max(0, openPrompts - 1);
		if (ctx.isIdle()) arm(ctx);
	});

	// Any compaction (including a manual /compact) satisfies this idle period.
	pi.on("session_compact", () => disarm());

	// After an idle compaction the cached prefix no longer matches the context; don't pay to keep it warm.
	pi.on("cache_warming_decision", () => (stopCacheWarming ? { action: "stop" as const } : undefined));

	pi.on("session_shutdown", () => {
		disarm();
		openPrompts = 0;
		stopCacheWarming = false;
	});
}
