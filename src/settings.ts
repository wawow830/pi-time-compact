import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS, getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

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

/** Duration label in the style of pi's /settings ("30 sec", "5 min"). */
export function formatDuration(ms: number): string {
	const hours = ms / 3_600_000;
	if (Number.isInteger(hours)) return hours === 1 ? "1 hour" : `${hours} hours`;
	const minutes = ms / 60_000;
	if (Number.isInteger(minutes)) return `${minutes} min`;
	return `${ms / 1000} sec`;
}

export function formatTokens(tokens: number): string {
	if (tokens === 0) return "any";
	return tokens % 1000 === 0 ? `${tokens / 1000}k` : String(tokens);
}

/**
 * Patch `idleCompaction` in the global settings file (`<agent-dir>/settings.json`), where pi's own
 * /settings writes. Uses the same lock as pi's settings manager, and pi only rewrites the fields it
 * changed, so neither side clobbers the other. `undefined` values remove the field.
 */
export async function saveGlobalIdleCompactionSettings(
	patch: Partial<IdleCompactionSettings>,
	agentDir: string = getAgentDir(),
): Promise<void> {
	const path = join(agentDir, "settings.json");
	mkdirSync(dirname(path), { recursive: true });
	const release = await lockfile.lock(path, {
		realpath: false,
		retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
	});
	try {
		let current: string | undefined;
		try {
			current = readFileSync(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		// Refuse to rewrite a file we cannot parse, as pi does.
		const settings = current?.trim() ? (JSON.parse(current.replace(/^\uFEFF/, "")) as Record<string, unknown>) : {};
		const existing = settings[SETTINGS_KEY];
		const next: Record<string, unknown> = typeof existing === "object" && existing !== null ? { ...existing } : {};
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete next[key];
			else next[key] = value;
		}
		settings[SETTINGS_KEY] = next;
		writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
	} finally {
		await release();
	}
}
