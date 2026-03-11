import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AccountPoolEntry, AccountPoolStorage } from "./types.js";

const STORAGE_VERSION = 1;
const DEFAULT_COOLDOWN_MS = 60_000;

function storagePath(): string {
	if (process.env.OPENAI_CODEX_ACCOUNTS_PATH) {
		return process.env.OPENAI_CODEX_ACCOUNTS_PATH;
	}
	return join(homedir(), ".opencode", "openai-codex-accounts.json");
}

function clampIndex(index: number, size: number): number {
	if (!Number.isFinite(index) || size <= 0) return 0;
	const n = Math.floor(index);
	if (n < 0) return 0;
	if (n >= size) return size - 1;
	return n;
}

function now(): number {
	return Date.now();
}

function normalizeEntry(entry: AccountPoolEntry): AccountPoolEntry | null {
	if (!entry.accountId || !entry.refresh || !entry.access || !Number.isFinite(entry.expires)) {
		return null;
	}
	return {
		accountId: entry.accountId,
		refresh: entry.refresh,
		access: entry.access,
		expires: Math.floor(entry.expires),
		email: entry.email,
		lastUsed: entry.lastUsed,
		rateLimitedUntil: entry.rateLimitedUntil,
	};
}

function parseStorage(raw: string): AccountPoolStorage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Partial<AccountPoolStorage>;
	const accounts = Array.isArray(obj.accounts)
		? obj.accounts
				.map((e) => normalizeEntry(e as AccountPoolEntry))
				.filter((e): e is AccountPoolEntry => e !== null)
		: [];
	return {
		version: STORAGE_VERSION,
		activeIndex: clampIndex(Number(obj.activeIndex ?? 0), accounts.length || 1),
		accounts,
	};
}

function normalizeCooldown(cooldownMs?: number): number {
	if (cooldownMs === undefined || !Number.isFinite(cooldownMs) || cooldownMs < 1000) {
		return DEFAULT_COOLDOWN_MS;
	}
	return Math.floor(cooldownMs);
}

function retryAfterFromHeaders(headers: Headers, fallbackMs: number): number {
	const maxRetryMs = 86_400_000;
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const parsed = Number.parseInt(retryAfterMs, 10);
		if (!Number.isNaN(parsed) && parsed > 0 && parsed <= maxRetryMs) return parsed;
	}
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseInt(retryAfter, 10);
		if (!Number.isNaN(seconds) && seconds > 0 && seconds * 1000 <= maxRetryMs) {
			return seconds * 1000;
		}
		const retryDateMs = Date.parse(retryAfter);
		if (!Number.isNaN(retryDateMs)) {
			const remaining = retryDateMs - now();
			if (remaining > 0 && remaining <= maxRetryMs) return remaining;
		}
	}
	const codexPrimary = headers.get("x-codex-primary-reset-after-seconds");
	if (codexPrimary) {
		const parsed = Number.parseInt(codexPrimary, 10);
		if (!Number.isNaN(parsed) && parsed > 0) return parsed * 1000;
	}
	return fallbackMs;
}

export class AccountPool {
	private accounts: AccountPoolEntry[] = [];
	private activeIndex = 0;

	static load(): AccountPool {
		const pool = new AccountPool();
		const path = storagePath();
		if (!existsSync(path)) return pool;
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = parseStorage(raw);
			if (!parsed) return pool;
			pool.accounts = parsed.accounts;
			pool.activeIndex = clampIndex(parsed.activeIndex, parsed.accounts.length || 1);
			return pool;
		} catch {
			return pool;
		}
	}

	save(): void {
		const path = storagePath();
		const dir = dirname(path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const payload: AccountPoolStorage = {
			version: STORAGE_VERSION,
			activeIndex: clampIndex(this.activeIndex, this.accounts.length || 1),
			accounts: this.accounts,
		};
		const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
		writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(tempPath, path);
		try {
			chmodSync(path, 0o600);
		} catch (chmodErr) {
			// chmod may fail on some platforms (e.g., Windows) - file was already created with 0o600 mode
			if (process.platform !== "win32") {
				console.warn(`[openai-codex-plugin] Failed to chmod ${path}:`, chmodErr);
			}
		}
	}

	upsert(entry: AccountPoolEntry): void {
		const normalized = normalizeEntry(entry);
		if (!normalized) return;
		const byAccount = this.accounts.findIndex((a) => a.accountId === normalized.accountId);
		const byEmail =
			normalized.email && byAccount < 0
				? this.accounts.findIndex((a) => a.email && a.email === normalized.email)
				: -1;
		const idx = byAccount >= 0 ? byAccount : byEmail;
		if (idx >= 0) {
			const existing = this.accounts[idx];
			if (!existing) return;
			const incomingIsOlder = normalized.expires < existing.expires;
			const nextAccess = incomingIsOlder ? existing.access : normalized.access;
			const nextRefresh = incomingIsOlder ? existing.refresh : normalized.refresh;
			const nextExpires = incomingIsOlder ? existing.expires : normalized.expires;
			this.accounts[idx] = {
				...existing,
				...normalized,
				access: nextAccess,
				refresh: nextRefresh,
				expires: nextExpires,
				rateLimitedUntil: existing.rateLimitedUntil,
			};
		} else {
			this.accounts.push(normalized);
		}
		this.activeIndex = clampIndex(this.activeIndex, this.accounts.length || 1);
	}

	count(): number {
		return this.accounts.length;
	}

	getAvailableCount(): number {
		const t = now();
		return this.accounts.filter((a) => !a.rateLimitedUntil || a.rateLimitedUntil <= t).length;
	}

	getMinRetryAfterMs(): number | null {
		const t = now();
		let min: number | null = null;
		for (const account of this.accounts) {
			if (!account.rateLimitedUntil || account.rateLimitedUntil <= t) continue;
			const remaining = account.rateLimitedUntil - t;
			if (min === null || remaining < min) {
				min = remaining;
			}
		}
		return min;
	}

	markRateLimited(accountId: string, headers: Headers, cooldownMs?: number): void {
		const account = this.accounts.find((a) => a.accountId === accountId);
		if (!account) return;
		const fallback = normalizeCooldown(cooldownMs);
		const retryAfter = retryAfterFromHeaders(headers, fallback);
		account.rateLimitedUntil = now() + retryAfter;
	}

	next(strategy: "sticky" | "round-robin"): AccountPoolEntry | null {
		if (this.accounts.length === 0) return null;
		this.clearExpiredLimits();
		if (strategy === "sticky") {
			const current = this.accounts[this.activeIndex];
			if (current && !this.isLimited(current)) {
				current.lastUsed = now();
				return current;
			}
		}

		const start = strategy === "round-robin" ? (this.activeIndex + 1) % this.accounts.length : this.activeIndex;
		for (let i = 0; i < this.accounts.length; i++) {
			const idx = (start + i) % this.accounts.length;
			const candidate = this.accounts[idx];
			if (!candidate || this.isLimited(candidate)) continue;
			this.activeIndex = idx;
			candidate.lastUsed = now();
			return candidate;
		}
		return null;
	}

	replaceAuth(accountId: string, access: string, refresh: string, expires: number): void {
		const account = this.accounts.find((a) => a.accountId === accountId);
		if (!account) return;
		account.access = access;
		account.refresh = refresh;
		account.expires = expires;
	}

	private isLimited(account: AccountPoolEntry): boolean {
		return !!account.rateLimitedUntil && account.rateLimitedUntil > now();
	}

	private clearExpiredLimits(): void {
		const t = now();
		for (const account of this.accounts) {
			if (account.rateLimitedUntil && account.rateLimitedUntil <= t) {
				delete account.rateLimitedUntil;
			}
		}
	}
}
