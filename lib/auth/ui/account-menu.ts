/**
 * Account pool management UI for the Codex OAuth plugin.
 *
 * Shown when the user runs `opencode auth login` and existing accounts
 * are already in the pool.  Provides TTY-interactive menu on terminals;
 * falls back to a plain readline prompt on headless/non-TTY environments.
 *
 * Inspired by NoeFabris/opencode-antigravity-auth ui/auth-menu.ts.
 */

import { createInterface } from "node:readline/promises";
import { ANSI, isTTY } from "./ansi.js";
import { select } from "./select.js";
import { confirm } from "./confirm.js";
import type { AccountPoolEntry } from "../../types.js";
import { AccountPool } from "../../account-pool.js";

export type AccountStatus = "active" | "rate-limited" | "cooling-down" | "expired" | "unknown";

export interface DisplayAccount {
	entry: AccountPoolEntry;
	index: number;
	status: AccountStatus;
}

/**
 * Derive a human-readable status from pool entry timestamps.
 */
export function getAccountStatus(entry: AccountPoolEntry): AccountStatus {
	const now = Date.now();
	if (entry.rateLimitedUntil && entry.rateLimitedUntil > now) return "rate-limited";
	if (entry.coolingDownUntil && entry.coolingDownUntil > now) return "cooling-down";
	if (entry.expires < now) return "expired";
	return "active";
}

function statusBadge(status: AccountStatus): string {
	switch (status) {
		case "active": return `${ANSI.green}[active]${ANSI.reset}`;
		case "rate-limited": return `${ANSI.yellow}[rate-limited]${ANSI.reset}`;
		case "cooling-down": return `${ANSI.yellow}[cooling-down]${ANSI.reset}`;
		case "expired": return `${ANSI.red}[expired]${ANSI.reset}`;
		default: return `${ANSI.dim}[unknown]${ANSI.reset}`;
	}
}

function relativeTime(ts: number | undefined): string {
	if (!ts) return "never";
	const diff = Date.now() - ts;
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(ts).toLocaleDateString();
}

function countdownTime(until: number | undefined): string {
	if (!until) return "";
	const ms = until - Date.now();
	if (ms <= 0) return "";
	const secs = Math.ceil(ms / 1000);
	if (secs < 60) return ` (${secs}s)`;
	return ` (${Math.ceil(secs / 60)}m)`;
}

// ---------------------------------------------------------------------------
// TTY interactive menu
// ---------------------------------------------------------------------------

type MainAction =
	| { type: "add" }
	| { type: "select"; account: DisplayAccount }
	| { type: "delete-all" }
	| { type: "cancel" };

type AccountAction = "back" | "delete" | "refresh-token" | "cancel";

async function showMainMenu(accounts: DisplayAccount[]): Promise<MainAction> {
	const items: import("./select.js").MenuItem<MainAction>[] = [
		{ label: "Actions", value: { type: "cancel" }, kind: "heading" },
		{ label: "Add another account", value: { type: "add" }, color: "cyan" },
		{ label: "", value: { type: "cancel" }, separator: true },
		{ label: `Accounts (${accounts.length})`, value: { type: "cancel" }, kind: "heading" },

		...accounts.map((acc) => {
			const label = acc.entry.email || `Account ${acc.index + 1}`;
			const badge = statusBadge(acc.status);
			const countdown = acc.status !== "active" ? countdownTime(acc.entry.rateLimitedUntil ?? acc.entry.coolingDownUntil) : "";
			return {
				label: `${acc.index + 1}. ${label} ${badge}${countdown}`,
				hint: acc.entry.lastUsed ? relativeTime(acc.entry.lastUsed) : "",
				value: { type: "select" as const, account: acc },
			} satisfies import("./select.js").MenuItem<MainAction>;
		}),

		{ label: "", value: { type: "cancel" }, separator: true },
		{ label: "Danger zone", value: { type: "cancel" }, kind: "heading" },
		{ label: "Delete all accounts", value: { type: "delete-all" }, color: "red" },
	];

	while (true) {
		const result = await select(items, {
			message: "OpenAI Codex accounts",
			subtitle: "Select an action or account",
			clearScreen: true,
		});

		if (!result) return { type: "cancel" };

		if (result.type === "delete-all") {
			const confirmed = await confirm("Delete ALL accounts? This cannot be undone.");
			if (!confirmed) continue;
		}

		return result;
	}
}

async function showAccountDetail(acc: DisplayAccount): Promise<AccountAction> {
	const label = acc.entry.email || `Account ${acc.index + 1}`;
	const badge = statusBadge(acc.status);

	while (true) {
		const result = await select(
			[
				{ label: "Back", value: "back" as const },
				{ label: "Refresh token (re-authenticate)", value: "refresh-token" as const, color: "cyan" as const },
				{ label: "Delete this account", value: "delete" as const, color: "red" as const },
			],
			{
				message: `${label} ${badge}`,
				subtitle: [
					`ID: ${acc.entry.accountId}`,
					`Last used: ${relativeTime(acc.entry.lastUsed)}`,
					`Expires: ${new Date(acc.entry.expires).toLocaleString()}`,
				].join("  |  "),
				clearScreen: true,
			},
		);

		if (result === "delete") {
			const confirmed = await confirm(`Delete ${label}?`);
			if (!confirmed) continue;
		}
		if (result === "refresh-token") {
			const confirmed = await confirm(`Re-authenticate ${label}? You will be redirected to log in again.`);
			if (!confirmed) continue;
		}

		return result ?? "cancel";
	}
}

// ---------------------------------------------------------------------------
// Fallback for non-TTY (headless server)
// ---------------------------------------------------------------------------

async function showMenuFallback(accounts: DisplayAccount[]): Promise<ManageResult> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write("\n");
		process.stdout.write(`  OpenAI Codex accounts (${accounts.length})\n`);
		process.stdout.write("  ─────────────────────────────\n");
		for (const acc of accounts) {
			const label = acc.entry.email || `Account ${acc.index + 1}`;
			const status = acc.status;
			process.stdout.write(`  ${acc.index + 1}. ${label}  [${status}]  last used: ${relativeTime(acc.entry.lastUsed)}\n`);
		}
		process.stdout.write("\n");

		while (true) {
			const answer = await rl.question("  (a)dd account  (d)elete <n>  (da) delete all  (q)uit: ");
			const parts = answer.trim().toLowerCase().split(/\s+/);
			const cmd = parts[0] ?? "";

			if (cmd === "a" || cmd === "add") return { action: "add" };
			if (cmd === "q" || cmd === "quit" || cmd === "") return { action: "done" };
			if ((cmd === "da" || cmd === "delete-all")) {
				const confirm = await rl.question("  Delete ALL accounts? (yes/no): ");
				if (confirm.trim().toLowerCase() === "yes") return { action: "delete-all" };
				continue;
			}
			if (cmd === "d" || cmd === "delete") {
				const idxStr = parts[1];
				const idx = idxStr ? parseInt(idxStr, 10) - 1 : NaN;
				if (Number.isNaN(idx) || idx < 0 || idx >= accounts.length) {
					process.stdout.write("  Usage: d <account number>\n");
					continue;
				}
				const label = accounts[idx]!.entry.email || `Account ${idx + 1}`;
				const confirmStr = await rl.question(`  Delete ${label}? (yes/no): `);
				if (confirmStr.trim().toLowerCase() === "yes") {
					return { action: "delete-one", index: idx };
				}
				continue;
			}
			process.stdout.write("  Unknown command. Try: a | d <n> | da | q\n");
		}
	} finally {
		rl.close();
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ManageResult =
	| { action: "add" }
	| { action: "delete-one"; index: number }
	| { action: "delete-all" }
	| { action: "refresh-token"; index: number }
	| { action: "done" };

/**
 * Show the account management menu.
 *
 * Loads the current pool, displays it with live status, and applies the
 * user's chosen action (delete, refresh-token, delete-all, or add).
 *
 * Returns the final `ManageResult` after the user is done. Callers should
 * loop as long as `action !== "done"` && `action !== "add"`.
 */
export async function showAccountManager(): Promise<ManageResult> {
	const pool = AccountPool.load();
	const accounts = pool.getAccounts();

	if (accounts.length === 0) {
		process.stdout.write("\n  No accounts in pool — proceeding to add one.\n\n");
		return { action: "add" };
	}

	const displayAccounts: DisplayAccount[] = accounts.map((entry, index) => ({
		entry,
		index,
		status: getAccountStatus(entry),
	}));

	if (!isTTY()) {
		return showMenuFallback(displayAccounts);
	}

	// TTY interactive loop
	while (true) {
		const mainAction = await showMainMenu(displayAccounts);

		if (mainAction.type === "cancel") return { action: "done" };
		if (mainAction.type === "add") return { action: "add" };

		if (mainAction.type === "delete-all") {
			// Remove all accounts from pool and save
			for (let i = accounts.length - 1; i >= 0; i--) {
				accounts.splice(i, 1);
			}
			pool.save();
			process.stdout.write("\n  All accounts removed.\n\n");
			return { action: "add" };
		}

		if (mainAction.type === "select") {
			const detail = await showAccountDetail(mainAction.account);

			if (detail === "back") continue;

			if (detail === "delete") {
				return { action: "delete-one", index: mainAction.account.index };
			}

			if (detail === "refresh-token") {
				return { action: "refresh-token", index: mainAction.account.index };
			}
		}
	}
}

/**
 * Apply a ManageResult to the pool and persist.
 * Returns true if the caller should proceed to add a new account.
 */
export function applyManageResult(result: ManageResult, pool: AccountPool): boolean {
	const accounts = pool.getAccounts();

	if (result.action === "delete-one") {
		accounts.splice(result.index, 1);
		pool.save();
		const label = accounts[result.index]?.email || `Account ${result.index + 1}`;
		process.stdout.write(`\n  Account removed.\n\n`);
		return false;
	}

	if (result.action === "delete-all") {
		accounts.splice(0, accounts.length);
		pool.save();
		process.stdout.write("\n  All accounts removed.\n\n");
		return true; // proceed to add
	}

	if (result.action === "add" || result.action === "refresh-token") {
		return true;
	}

	return false;
}
