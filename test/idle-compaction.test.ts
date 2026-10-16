import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import idleCompaction, {
	DEFAULT_IDLE_COMPACTION_SETTINGS,
	resolveIdleCompactionSettings,
	resolveKeepRecentTokens,
} from "../index.ts";

describe("settings", () => {
	it("falls back per field", () => {
		assert.deepEqual(resolveIdleCompactionSettings({}), { ...DEFAULT_IDLE_COMPACTION_SETTINGS, customInstructions: undefined });
		const s = resolveIdleCompactionSettings({ idleCompaction: { enabled: false, timeoutMs: -1, minTokens: 5, customInstructions: " x " } });
		assert.equal(s.enabled, false);
		assert.equal(s.timeoutMs, DEFAULT_IDLE_COMPACTION_SETTINGS.timeoutMs);
		assert.equal(s.minTokens, 5);
		assert.equal(s.customInstructions, "x");
	});

	it("resolves keepRecentTokens through model overrides", () => {
		const settings = { compaction: { keepRecentTokens: 1000, modelOverrides: { "p/m": { keepRecentTokens: 50 } } } };
		assert.equal(resolveKeepRecentTokens(settings, { provider: "p", id: "m" }), 50);
		assert.equal(resolveKeepRecentTokens(settings, { provider: "p", id: "other" }), 1000);
		assert.equal(resolveKeepRecentTokens({}, undefined), 20000);
	});
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function setup(settings: Record<string, unknown>, state: { idle?: boolean; tokens?: number | null; lastType?: string } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const compact = mock.fn((opts: { onComplete?: () => void }) => opts.onComplete?.());
	const pi = {
		on: (name: string, h: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), h]);
			return () => {};
		},
		getSettings: () => settings,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, command),
	};
	const ctx = {
		isIdle: () => state.idle ?? true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: state.tokens === undefined ? 100_000 : state.tokens, contextWindow: 200_000, percent: 50 }),
		sessionManager: { getBranch: () => [{ type: "message" }, { type: state.lastType ?? "message" }] },
		model: { provider: "p", id: "m" },
		compact,
		mode: "tui",
		ui: {
			notify: mock.fn(),
			// Mirrors pi: a custom UI is a UI prompt, so it emits ui_prompt_start/end around it.
			custom: async (factory: (...args: unknown[]) => { handleInput(data: string): void }) => {
				emit("ui_prompt_start");
				const component = factory({ requestRender() {} }, undefined, undefined, () => {});
				for (const key of panelKeys) component.handleInput(key);
				emit("ui_prompt_end");
			},
		},
	};
	let panelKeys: string[] = [];
	idleCompaction(pi as never);
	const emit = (name: string, event: unknown = {}) => (handlers.get(name) ?? []).map((h) => h(event, ctx));
	const runCommand = async (keys: string[]) => {
		panelKeys = keys;
		await commands.get("idle-compact")!.handler("", ctx);
	};
	return { emit, compact, runCommand };
}

describe("idle timer", () => {
	beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
	afterEach(() => mock.timers.reset());

	const settings = { idleCompaction: { timeoutMs: 1000 } };

	it("compacts after the idle timeout following a settled run", () => {
		const { emit, compact } = setup(settings);
		emit("agent_settled");
		mock.timers.tick(999);
		assert.equal(compact.mock.callCount(), 0);
		mock.timers.tick(1);
		assert.equal(compact.mock.callCount(), 1);
	});

	it("resets on activity", () => {
		const { emit, compact } = setup(settings);
		emit("session_start");
		mock.timers.tick(900);
		emit("input");
		mock.timers.tick(5000);
		assert.equal(compact.mock.callCount(), 0);
	});

	it("waits while a dialog is open", () => {
		const { emit, compact } = setup(settings);
		emit("agent_settled");
		emit("ui_prompt_start");
		mock.timers.tick(5000);
		assert.equal(compact.mock.callCount(), 0);
		emit("ui_prompt_end");
		mock.timers.tick(1000);
		assert.equal(compact.mock.callCount(), 1);
	});

	it("skips when disabled, busy, already compacted, or too small", () => {
		for (const [s, state] of [
			[{ idleCompaction: { enabled: false, timeoutMs: 1000 } }, {}],
			[settings, { idle: false }],
			[settings, { lastType: "compaction" }],
			[settings, { tokens: 10_000 }],
			[settings, { tokens: null }],
			[{ idleCompaction: { timeoutMs: 1000, minTokens: 200_000 } }, {}],
		] as const) {
			const { emit, compact } = setup(s, state);
			emit("agent_settled");
			mock.timers.tick(1000);
			assert.equal(compact.mock.callCount(), 0, JSON.stringify([s, state]));
		}
	});

	it("stops cache warming after an idle compaction until the next run", () => {
		const { emit } = setup(settings);
		assert.deepEqual(emit("cache_warming_decision"), [undefined]);
		emit("agent_settled");
		mock.timers.tick(1000);
		assert.deepEqual(emit("cache_warming_decision"), [{ action: "stop" }]);
		emit("agent_start");
		assert.deepEqual(emit("cache_warming_decision"), [undefined]);
	});

	it("applies and saves changes from /idle-compact", async () => {
		const dir = mkdtempSync(join(tmpdir(), "idle-compact-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		after(() => {
			delete process.env.PI_CODING_AGENT_DIR;
			rmSync(dir, { recursive: true, force: true });
		});
		initTheme("dark");
		const { emit, compact, runCommand } = setup(settings);
		// Second item (timeout) cycles from the custom 1 sec value to 5 min.
		await runCommand(["\x1b[B", "\r"]);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")), {
			idleCompaction: { timeoutMs: 300_000 },
		});
		// Applies immediately, although pi.getSettings() still returns the old value.
		await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
		emit("agent_settled");
		mock.timers.tick(1000);
		assert.equal(compact.mock.callCount(), 0);
		mock.timers.tick(299_000);
		assert.equal(compact.mock.callCount(), 1);
	});

	it("clears on shutdown", () => {
		const { emit, compact } = setup(settings);
		emit("agent_settled");
		emit("session_shutdown");
		mock.timers.tick(5000);
		assert.equal(compact.mock.callCount(), 0);
	});
});
