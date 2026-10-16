import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { IdleCompactionSettingsPanel } from "../src/settings-panel.ts";
import {
	DEFAULT_IDLE_COMPACTION_SETTINGS,
	formatDuration,
	formatTokens,
	saveGlobalIdleCompactionSettings,
} from "../src/settings.ts";

describe("formatting", () => {
	it("formats durations like pi's /settings", () => {
		assert.equal(formatDuration(30_000), "30 sec");
		assert.equal(formatDuration(300_000), "5 min");
		assert.equal(formatDuration(3_600_000), "1 hour");
		assert.equal(formatDuration(7_200_000), "2 hours");
		assert.equal(formatDuration(5_400_000), "90 min");
	});

	it("formats token counts", () => {
		assert.equal(formatTokens(0), "any");
		assert.equal(formatTokens(25_000), "25k");
		assert.equal(formatTokens(12_345), "12345");
	});
});

describe("saveGlobalIdleCompactionSettings", () => {
	const withDir = async (fn: (dir: string) => Promise<void>) => {
		const dir = mkdtempSync(join(tmpdir(), "idle-compact-"));
		try {
			await fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const read = (dir: string) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));

	it("creates the file", () =>
		withDir(async (dir) => {
			await saveGlobalIdleCompactionSettings({ timeoutMs: 60_000 }, dir);
			assert.deepEqual(read(dir), { idleCompaction: { timeoutMs: 60_000 } });
		}));

	it("patches only its own fields and keeps other settings", () =>
		withDir(async (dir) => {
			writeFileSync(
				join(dir, "settings.json"),
				`\uFEFF${JSON.stringify({ theme: "dark", idleCompaction: { minTokens: 5, customInstructions: "x" } })}`,
			);
			await saveGlobalIdleCompactionSettings({ enabled: false, customInstructions: undefined }, dir);
			assert.deepEqual(read(dir), { theme: "dark", idleCompaction: { minTokens: 5, enabled: false } });
		}));

	it("refuses to overwrite an unparsable file", () =>
		withDir(async (dir) => {
			writeFileSync(join(dir, "settings.json"), "{ broken");
			await assert.rejects(saveGlobalIdleCompactionSettings({ enabled: false }, dir));
			assert.equal(readFileSync(join(dir, "settings.json"), "utf-8"), "{ broken");
		}));
});

describe("IdleCompactionSettingsPanel", () => {
	initTheme("dark");
	const create = (settings = DEFAULT_IDLE_COMPACTION_SETTINGS) => {
		const onChange = mock.fn((_patch: object) => {});
		const onClose = mock.fn();
		const panel = new IdleCompactionSettingsPanel({
			theme: undefined as never,
			settings,
			keepRecentTokens: 20_000,
			onChange,
			onClose,
			requestRender: () => {},
		});
		return { panel, onChange, onClose };
	};
	const DOWN = "\x1b[B";

	it("renders every setting", () => {
		const text = create().panel.render(120).join("\n");
		for (const label of ["Idle compaction", "Idle timeout", "30 min", "Minimum context", "Summary instructions"]) {
			assert.match(text, new RegExp(label));
		}
	});

	it("cycles values and reports patches", () => {
		const { panel, onChange } = create();
		panel.handleInput("\r");
		panel.handleInput(DOWN);
		panel.handleInput("\r");
		assert.deepEqual(
			onChange.mock.calls.map((call) => call.arguments[0]),
			[{ enabled: false }, { timeoutMs: 3_600_000 }],
		);
	});

	it("keeps a custom timeout from settings.json selectable", () => {
		const { panel } = create({ ...DEFAULT_IDLE_COMPACTION_SETTINGS, timeoutMs: 45 * 60_000 });
		assert.match(panel.render(120).join("\n"), /45 min/);
	});

	it("closes on escape", () => {
		const { panel, onClose } = create();
		panel.handleInput("\x1b");
		assert.equal(onClose.mock.callCount(), 1);
	});
});
