/**
 * Idle compaction for pi.
 *
 * Compacts the session after it has been idle for a configurable time, so the
 * next prompt after a break starts from a summary instead of resending a long
 * transcript whose prompt cache has most likely expired.
 *
 * Configure in ~/.pi/agent/settings.json or <project>/.pi/settings.json:
 *
 * ```json
 * { "idleCompaction": { "enabled": true, "timeoutMs": 1800000, "minTokens": 0 } }
 * ```
 */
import {
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const SETTINGS_KEY = "idleCompaction";

export interface IdleCompactionSettings {
	/** Compact idle sessions. Default `true`. */
	enabled: boolean;
	/** Idle time before compacting, in milliseconds. Default 30 minutes. */
	timeoutMs: number;
	/** Skip sessions whose context is smaller than this many tokens. Default `0`. */
	minTokens: number;
	/** Optional focus instructions for the summary, as with `/compact [instructions]`. */
	customInstructions?: string;
}

export const DEFAULT_IDLE_COMPACTION_SETTINGS: IdleCompactionSettings = {
	enabled: true,
	timeoutMs: 30 * 60 * 1000,
	minTokens: 0,
};

const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Resolve extension settings from pi's merged settings, falling back per field like pi does. */
export function resolveIdleCompactionSettings(settings: Record<string, unknown>): IdleCompactionSettings {
	const raw = settings[SETTINGS_KEY];
	const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const defaults = DEFAULT_IDLE_COMPACTION_SETTINGS;
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
		timeoutMs: isNonNegativeInteger(value.timeoutMs) && value.timeoutMs > 0 ? value.timeoutMs : defaults.timeoutMs,
		minTokens: isNonNegativeInteger(value.minTokens) ? value.minTokens : defaults.minTokens,
		customInstructions:
			typeof value.customInstructions === "string" && value.customInstructions.trim()
				? value.customInstructions.trim()
				: undefined,
	};
}

/** `compaction.keepRecentTokens`, honoring `compaction.modelOverrides` the same way pi resolves it. */
export function resolveKeepRecentTokens(
	settings: Record<string, unknown>,
	model: { provider: string; id: string } | undefined,
): number {
	const compaction = (settings.compaction ?? {}) as {
		keepRecentTokens?: unknown;
		modelOverrides?: Record<string, { keepRecentTokens?: unknown } | undefined>;
	};
	const override = model ? compaction.modelOverrides?.[`${model.provider}/${model.id}`]?.keepRecentTokens : undefined;
	if (isNonNegativeInteger(override)) return override;
	if (isNonNegativeInteger(compaction.keepRecentTokens)) return compaction.keepRecentTokens;
	return DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
}

export default function idleCompaction(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let openPrompts = 0;
	/** Set after an idle compaction so pi stops warming the now-stale prompt cache entry. */
	let stopCacheWarming = false;

	const disarm = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const readSettings = () => pi.getSettings() as unknown as Record<string, unknown>;

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
		const settings = resolveIdleCompactionSettings(readSettings());
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
