import { DynamicBorder, getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, type IdleCompactionSettings } from "./settings.ts";

const TIMEOUT_CHOICES_MS = [5, 10, 15, 30, 60, 120, 240].map((minutes) => minutes * 60_000);
const MIN_TOKENS_CHOICES = [0, 10_000, 25_000, 50_000, 100_000, 200_000];
const NO_INSTRUCTIONS = "none";

/** Choice labels, keeping a custom value from settings.json selectable. */
function choices<T extends number>(values: T[], current: T, format: (value: T) => string): Map<string, T> {
	const all = values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
	return new Map(all.map((value) => [format(value), value]));
}

function preview(text: string | undefined): string {
	if (!text) return NO_INSTRUCTIONS;
	return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** Single-line text submenu, laid out like pi's built-in settings submenus. */
class TextSubmenu extends Container implements Focusable {
	private readonly input = new Input();
	private _focused = false;

	constructor(theme: Theme, title: string, description: string, value: string, onSubmit: (value: string) => void, onCancel: () => void) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", description), 0, 0));
		this.addChild(new Spacer(1));
		this.input.setValue(value);
		this.input.onSubmit = onSubmit;
		this.input.onEscape = onCancel;
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to save · empty to clear · Esc to go back"), 0, 0));
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

export interface IdleCompactionSettingsPanelOptions {
	theme: Theme;
	settings: IdleCompactionSettings;
	/** Effective `compaction.keepRecentTokens`; smaller sessions are never compacted. */
	keepRecentTokens: number;
	onChange: (patch: Partial<IdleCompactionSettings>) => void;
	onClose: () => void;
	requestRender: () => void;
}

/** Settings screen for idle compaction, built from the same parts as pi's /settings. */
export class IdleCompactionSettingsPanel extends Container implements Focusable {
	private readonly list: SettingsList;
	private readonly requestRender: () => void;
	private submenu?: TextSubmenu;
	private _focused = false;

	constructor(options: IdleCompactionSettingsPanelOptions) {
		super();
		const { theme, settings, keepRecentTokens, onChange, onClose } = options;
		this.requestRender = options.requestRender;
		const timeouts = choices(TIMEOUT_CHOICES_MS, settings.timeoutMs, formatDuration);
		const minTokens = choices(MIN_TOKENS_CHOICES, settings.minTokens, formatTokens);
		let instructions = settings.customInstructions;

		const items: SettingItem[] = [
			{
				id: "enabled",
				label: "Idle compaction",
				description: "Compact the session after it has been idle, so the next prompt starts from a summary",
				currentValue: settings.enabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "timeout",
				label: "Idle timeout",
				description: "Time without prompts or agent activity before compacting",
				currentValue: formatDuration(settings.timeoutMs),
				values: [...timeouts.keys()],
			},
			{
				id: "min-tokens",
				label: "Minimum context",
				description: `Only compact sessions with at least this many context tokens (sessions within keepRecentTokens, ${formatTokens(keepRecentTokens)}, are always skipped)`,
				currentValue: formatTokens(settings.minTokens),
				values: [...minTokens.keys()],
			},
			{
				id: "instructions",
				label: "Summary instructions",
				description: "Focus instructions for the summary, as with /compact [instructions]",
				currentValue: preview(instructions),
				submenu: (_currentValue, done) => {
					this.submenu = new TextSubmenu(
						theme,
						"Summary instructions",
						"Focus instructions passed to idle compaction summaries",
						instructions ?? "",
						(value) => {
							instructions = value.trim() || undefined;
							onChange({ customInstructions: instructions });
							this.submenu = undefined;
							done(preview(instructions));
						},
						() => {
							this.submenu = undefined;
							done();
						},
					);
					this.submenu.focused = this._focused;
					return this.submenu;
				},
			},
		];

		this.list = new SettingsList(items, 10, getSettingsListTheme(), (id, value) => {
			switch (id) {
				case "enabled":
					onChange({ enabled: value === "true" });
					break;
				case "timeout": {
					const timeoutMs = timeouts.get(value);
					if (timeoutMs !== undefined) onChange({ timeoutMs });
					break;
				}
				case "min-tokens": {
					const tokens = minTokens.get(value);
					if (tokens !== undefined) onChange({ minTokens: tokens });
					break;
				}
			}
		}, onClose);

		this.addChild(new DynamicBorder());
		this.addChild(this.list);
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this._focused;
	}

	/** Propagate focus to the text input so IME candidate windows are positioned correctly. */
	set focused(value: boolean) {
		this._focused = value;
		if (this.submenu) this.submenu.focused = value;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.requestRender();
	}
}
