/**
 * Interactive keyboard-driven selection menu for CLI.
 * Ported from NoeFabris/opencode-antigravity-auth with minor adaptations.
 */

import { ANSI, isTTY, parseKey } from "./ansi.js";

export interface MenuItem<T = string> {
	label: string;
	value: T;
	hint?: string;
	disabled?: boolean;
	separator?: boolean;
	kind?: "heading";
	color?: "red" | "green" | "yellow" | "cyan";
}

export interface SelectOptions {
	message: string;
	subtitle?: string;
	help?: string;
	clearScreen?: boolean;
}

const ESCAPE_TIMEOUT_MS = 50;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const ANSI_LEADING_REGEX = /^\x1b\[[0-9;]*m/;

function stripAnsi(s: string): string {
	return s.replace(ANSI_REGEX, "");
}

function truncateAnsi(s: string, max: number): string {
	if (max <= 0) return "";
	const visible = stripAnsi(s);
	if (visible.length <= max) return s;
	const suffix = max >= 3 ? "..." : ".".repeat(max);
	const keep = Math.max(0, max - suffix.length);
	let out = "";
	let i = 0;
	let kept = 0;
	while (i < s.length && kept < keep) {
		if (s[i] === "\x1b") {
			const m = s.slice(i).match(ANSI_LEADING_REGEX);
			if (m) { out += m[0]; i += m[0].length; continue; }
		}
		out += s[i]; i++; kept++;
	}
	return (out.includes("\x1b[") ? `${out}${ANSI.reset}` : out) + suffix;
}

function colorCode(color: MenuItem["color"]): string {
	switch (color) {
		case "red": return ANSI.red;
		case "green": return ANSI.green;
		case "yellow": return ANSI.yellow;
		case "cyan": return ANSI.cyan;
		default: return "";
	}
}

export async function select<T>(items: MenuItem<T>[], opts: SelectOptions): Promise<T | null> {
	if (!isTTY()) throw new Error("Interactive select requires a TTY terminal");
	if (!items.length) throw new Error("No menu items");

	const selectable = (i: MenuItem<T>) => !i.disabled && !i.separator && i.kind !== "heading";
	const enabled = items.filter(selectable);
	if (!enabled.length) throw new Error("All items disabled");
	if (enabled.length === 1) return enabled[0]!.value;

	const { stdin, stdout } = process;
	let cursor = items.findIndex(selectable);
	if (cursor === -1) cursor = 0;
	let escTimeout: ReturnType<typeof setTimeout> | null = null;
	let cleaned = false;
	let rendered = 0;

	const render = () => {
		const cols = stdout.columns ?? 80;
		const rows = stdout.rows ?? 24;
		const prev = rendered;
		if (opts.clearScreen) {
			stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
		} else if (prev > 0) {
			stdout.write(ANSI.up(prev));
		}
		let lines = 0;
		const wl = (line: string) => { stdout.write(`${ANSI.clearLine}${line}\n`); lines++; };
		const subtitleLines = opts.subtitle ? 3 : 0;
		const maxVisible = Math.max(1, Math.min(items.length, rows - 1 - subtitleLines - 3));
		let winStart = 0;
		let winEnd = items.length;
		if (items.length > maxVisible) {
			winStart = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), items.length - maxVisible));
			winEnd = winStart + maxVisible;
		}
		wl(`${ANSI.dim}┌  ${ANSI.reset}${truncateAnsi(opts.message, Math.max(1, cols - 4))}`);
		if (opts.subtitle) {
			wl(`${ANSI.dim}│${ANSI.reset}`);
			wl(`${ANSI.cyan}◆${ANSI.reset}  ${truncateAnsi(opts.subtitle, Math.max(1, cols - 4))}`);
			wl("");
		}
		for (let i = winStart; i < winEnd; i++) {
			const item = items[i];
			if (!item) continue;
			if (item.separator) { wl(`${ANSI.dim}│${ANSI.reset}`); continue; }
			if (item.kind === "heading") {
				wl(`${ANSI.cyan}│${ANSI.reset}  ${truncateAnsi(`${ANSI.dim}${ANSI.bold}${item.label}${ANSI.reset}`, Math.max(1, cols - 6))}`);
				continue;
			}
			const sel = i === cursor;
			const cc = colorCode(item.color);
			let label: string;
			if (item.disabled) {
				label = `${ANSI.dim}${item.label} (unavailable)${ANSI.reset}`;
			} else if (sel) {
				label = cc ? `${cc}${item.label}${ANSI.reset}` : item.label;
				if (item.hint) label += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
			} else {
				label = cc ? `${ANSI.dim}${cc}${item.label}${ANSI.reset}` : `${ANSI.dim}${item.label}${ANSI.reset}`;
				if (item.hint) label += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
			}
			label = truncateAnsi(label, Math.max(1, cols - 8));
			if (sel) {
				wl(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.green}●${ANSI.reset} ${label}`);
			} else {
				wl(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}○${ANSI.reset} ${label}`);
			}
		}
		const windowHint = items.length > winEnd - winStart ? ` (${winStart + 1}-${winEnd}/${items.length})` : "";
		const help = truncateAnsi((opts.help ?? `↑↓ navigate  Enter confirm  Esc cancel`) + windowHint, Math.max(1, cols - 6));
		wl(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}${help}${ANSI.reset}`);
		wl(`${ANSI.cyan}└${ANSI.reset}`);
		if (!opts.clearScreen && prev > lines) {
			for (let i = 0; i < prev - lines; i++) wl("");
		}
		rendered = lines;
	};

	return new Promise((resolve) => {
		const wasRaw = stdin.isRaw ?? false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			if (escTimeout) { clearTimeout(escTimeout); escTimeout = null; }
			try {
				stdin.removeListener("data", onKey);
				stdin.setRawMode(wasRaw);
				stdin.pause();
				stdout.write(ANSI.show);
			} catch {}
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
		};
		const onSignal = () => { cleanup(); resolve(null); };
		const finish = (v: T | null) => { cleanup(); resolve(v); };
		const nextSel = (from: number, dir: 1 | -1): number => {
			let n = from;
			do { n = (n + dir + items.length) % items.length; }
			while (items[n]?.disabled || items[n]?.separator || items[n]?.kind === "heading");
			return n;
		};
		const onKey = (data: Buffer) => {
			if (escTimeout) { clearTimeout(escTimeout); escTimeout = null; }
			const action = parseKey(data);
			switch (action) {
				case "up": cursor = nextSel(cursor, -1); render(); return;
				case "down": cursor = nextSel(cursor, 1); render(); return;
				case "enter": finish(items[cursor]?.value ?? null); return;
				case "escape": finish(null); return;
				case "escape-start":
					escTimeout = setTimeout(() => finish(null), ESCAPE_TIMEOUT_MS);
					return;
			}
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
		try {
			stdin.setRawMode(true);
		} catch {
			cleanup();
			resolve(null);
			return;
		}
		stdin.resume();
		stdout.write(ANSI.hide);
		render();
		stdin.on("data", onKey);
	});
}
