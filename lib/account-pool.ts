import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AccountPoolEntry, AccountPoolStorage } from "./types.js";
import { ACCOUNT_FAILURE, RATE_LIMIT_TIERS } from "./constants.js";

const STORAGE_VERSION = 2 as const;
const DEFAULT_COOLDOWN_MS = 60_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;

function storagePath(): string {
	if (process.env.OPENAI_CODEX_ACCOUNTS_PATH) {
		return process.env.OPENAI_CODEX_ACCOUNTS_PATH;
	}
	return join(homedir(), ".opencode", "openai-codex-accounts.json");
}

function lockPath(path: string): string {
	return `${path}.lock`;
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
		// Preserve failure-tracking fields across save/load
		coolingDownUntil: entry.coolingDownUntil,
		consecutiveFailures: entry.consecutiveFailures,
		lastFailureAt: entry.lastFailureAt,
	};
}

function mergeAccountEntries(existing: AccountPoolEntry, incoming: AccountPoolEntry): AccountPoolEntry {
	const incomingIsOlder = incoming.expires < existing.expires;
	const nextAccess = incomingIsOlder ? existing.access : incoming.access;
	const nextRefresh = incomingIsOlder ? existing.refresh : incoming.refresh;
	const nextExpires = incomingIsOlder ? existing.expires : incoming.expires;

	return {
		...existing,
		...incoming,
		access: nextAccess,
		refresh: nextRefresh,
		expires: nextExpires,
		rateLimitedUntil: Math.max(existing.rateLimitedUntil ?? 0, incoming.rateLimitedUntil ?? 0) || undefined,
		coolingDownUntil: Math.max(existing.coolingDownUntil ?? 0, incoming.coolingDownUntil ?? 0) || undefined,
		consecutiveFailures: Math.max(existing.consecutiveFailures ?? 0, incoming.consecutiveFailures ?? 0) || undefined,
		lastFailureAt: Math.max(existing.lastFailureAt ?? 0, incoming.lastFailureAt ?? 0) || undefined,
		lastUsed: Math.max(existing.lastUsed ?? 0, incoming.lastUsed ?? 0) || undefined,
		email: existing.email ?? incoming.email,
	};
}

function dedupeAccounts(entries: AccountPoolEntry[]): AccountPoolEntry[] {
	const deduped: AccountPoolEntry[] = [];

	for (const entry of entries) {
		const normalized = normalizeEntry(entry);
		if (!normalized) continue;

		const idx = deduped.findIndex(
			(existing) =>
				existing.accountId === normalized.accountId ||
				(!!existing.email && !!normalized.email && existing.email === normalized.email),
		);

		if (idx >= 0) {
			const existing = deduped[idx];
			if (!existing) continue;
			deduped[idx] = mergeAccountEntries(existing, normalized);
		} else {
			deduped.push(normalized);
		}
	}

	return deduped;
}

function acquireLock(path: string): () => void {
	const target = lockPath(path);
	const started = Date.now();

	while (true) {
		try {
			mkdirSync(target);
			return () => {
				try {
					rmSync(target, { recursive: true, force: true });
				} catch {}
			};
		} catch {
			if (Date.now() - started >= LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out acquiring account-pool lock: ${target}`);
			}

			const waitUntil = Date.now() + LOCK_RETRY_MS;
			while (Date.now() < waitUntil) {}
		}
	}
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
	const dedupedAccounts = dedupeAccounts(accounts);
	return {
		version: STORAGE_VERSION,
		activeIndex: clampIndex(Number(obj.activeIndex ?? 0), dedupedAccounts.length || 1),
		accounts: dedupedAccounts,
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

/**
 * Resolve the cooldown duration for a rate-limited account.
 *
 * Priority:
 *   1. Tiered duration from known ChatGPT error codes (#10)
 *   2. Server-supplied retry-after header
 *   3. Plugin-configured default or built-in 60s default
 */
function resolveCooldownMs(
	errorCode: string | undefined,
	headers: Headers,
	configDefault?: number,
): number {
	// Tiered duration for known ChatGPT quota/plan error codes
	if (errorCode && RATE_LIMIT_TIERS[errorCode] !== undefined) {
		return RATE_LIMIT_TIERS[errorCode] as number;
	}
	// Server-supplied header takes precedence over plugin default
	const fallback = normalizeCooldown(configDefault);
	return retryAfterFromHeaders(headers, fallback);
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
		const releaseLock = acquireLock(path);
		try {
			let latestAccounts: AccountPoolEntry[] = [];
			let latestActiveIndex = 0;
			if (existsSync(path)) {
				try {
					const raw = readFileSync(path, "utf8");
					const parsed = parseStorage(raw);
					if (parsed) {
						latestAccounts = parsed.accounts;
						latestActiveIndex = parsed.activeIndex;
					}
				} catch {}
			}

			const mergedAccounts = dedupeAccounts([...latestAccounts, ...this.accounts]);
			this.accounts = mergedAccounts;
			this.activeIndex = clampIndex(Math.max(this.activeIndex, latestActiveIndex), mergedAccounts.length || 1);

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
				if (process.platform !== "win32") {
					console.warn(`[openai-codex-plugin] Failed to chmod ${path}:`, chmodErr);
				}
			}
		} finally {
			releaseLock();
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
			this.accounts[idx] = mergeAccountEntries(existing, normalized);
		} else {
			this.accounts.push(normalized);
		}
		this.accounts = dedupeAccounts(this.accounts);
		this.activeIndex = clampIndex(this.activeIndex, this.accounts.length || 1);
	}

	count(): number {
		return this.accounts.length;
	}

	getAvailableCount(): number {
		const t = now();
		return this.accounts.filter(
			(a) =>
				(!a.rateLimitedUntil || a.rateLimitedUntil <= t) &&
				(!a.coolingDownUntil || a.coolingDownUntil <= t),
		).length;
	}

	getMinRetryAfterMs(): number | null {
		const t = now();
		let min: number | null = null;
		for (const account of this.accounts) {
			const limitRemaining = account.rateLimitedUntil && account.rateLimitedUntil > t
				? account.rateLimitedUntil - t
				: null;
			const coolRemaining = account.coolingDownUntil && account.coolingDownUntil > t
				? account.coolingDownUntil - t
				: null;
			// The soonest this account will be usable
			const remaining = limitRemaining !== null || coolRemaining !== null
				? Math.min(limitRemaining ?? Infinity, coolRemaining ?? Infinity)
				: null;
			if (remaining !== null && (min === null || remaining < min)) {
				min = remaining;
			}
		}
		return min;
	}

	/**
	 * Mark an account as rate-limited.
	 * Applies tiered cooldown based on the ChatGPT error code (#10):
	 *   - usage_limit_reached  → 4 hours
	 *   - usage_not_included   → 24 hours
	 *   - rate_limit_exceeded  → 60 seconds
	 *   - unknown / no code    → retry-after header or configured default
	 */
	markRateLimited(
		accountId: string,
		headers: Headers,
		cooldownMs?: number,
		errorCode?: string,
	): void {
		const account = this.accounts.find((a) => a.accountId === accountId);
		if (!account) return;
		const duration = resolveCooldownMs(errorCode, headers, cooldownMs);
		account.rateLimitedUntil = now() + duration;
	}

	/**
	 * Record an auth/token-refresh failure for an account (#9).
	 *
	 * Increments consecutiveFailures with a 2-hour TTL reset. After
	 * MAX_FAILURES consecutive failures the account is placed in cooldown
	 * for COOLDOWN_MS — during which it is skipped by next().
	 */
	markAuthFailure(accountId: string): void {
		const account = this.accounts.find((a) => a.accountId === accountId);
		if (!account) return;

		const t = now();
		const withinWindow =
			account.lastFailureAt !== undefined &&
			t - account.lastFailureAt < ACCOUNT_FAILURE.FAILURE_RESET_MS;

		const failures = withinWindow ? (account.consecutiveFailures ?? 0) + 1 : 1;
		account.consecutiveFailures = failures;
		account.lastFailureAt = t;

		if (failures >= ACCOUNT_FAILURE.MAX_FAILURES) {
			account.coolingDownUntil = t + ACCOUNT_FAILURE.COOLDOWN_MS;
			account.consecutiveFailures = 0; // reset so next cooldown window starts fresh
		}
	}

	/**
	 * Clear the failure counter and cooldown for an account (called on success).
	 */
	clearAuthFailures(accountId: string): void {
		const account = this.accounts.find((a) => a.accountId === accountId);
		if (!account) return;
		account.consecutiveFailures = 0;
		account.lastFailureAt = undefined;
		account.coolingDownUntil = undefined;
	}

	next(strategy: "sticky" | "round-robin"): AccountPoolEntry | null {
		if (this.accounts.length === 0) return null;
		this.clearExpiredStates();
		if (strategy === "sticky") {
			const current = this.accounts[this.activeIndex];
			if (current && !this.isUnavailable(current)) {
				current.lastUsed = now();
				return current;
			}
		}

		const start = strategy === "round-robin" ? (this.activeIndex + 1) % this.accounts.length : this.activeIndex;
		for (let i = 0; i < this.accounts.length; i++) {
			const idx = (start + i) % this.accounts.length;
			const candidate = this.accounts[idx];
			if (!candidate || this.isUnavailable(candidate)) continue;
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

	/** Returns all accounts (for use by ProactiveRefreshQueue) */
	getAccounts(): AccountPoolEntry[] {
		return this.accounts;
	}

	/** True if account is rate-limited OR in auth-failure cooldown */
	private isUnavailable(account: AccountPoolEntry): boolean {
		return this.isRateLimited(account) || this.isCoolingDown(account);
	}

	private isRateLimited(account: AccountPoolEntry): boolean {
		return !!account.rateLimitedUntil && account.rateLimitedUntil > now();
	}

	private isCoolingDown(account: AccountPoolEntry): boolean {
		return !!account.coolingDownUntil && account.coolingDownUntil > now();
	}

	/** Clear expired rate-limit and cooldown timestamps */
	private clearExpiredStates(): void {
		const t = now();
		for (const account of this.accounts) {
			if (account.rateLimitedUntil && account.rateLimitedUntil <= t) {
				delete account.rateLimitedUntil;
			}
			if (account.coolingDownUntil && account.coolingDownUntil <= t) {
				delete account.coolingDownUntil;
			}
		}
	}
}
