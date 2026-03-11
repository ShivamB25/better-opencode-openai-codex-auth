/**
 * Proactive Token Refresh Queue (#8)
 *
 * Runs as a background timer and refreshes OAuth tokens that are approaching
 * expiry. This ensures user requests are never blocked by an in-flight token
 * refresh — the pool always has fresh credentials ready.
 *
 * Adapted from the LLM-API-Key-Proxy pattern used in
 * NoeFabris/opencode-antigravity-auth, stripped of Google-specific logic.
 *
 * Key properties:
 * - Non-blocking: runs independently of the request path
 * - Serialized: only one refresh pass runs at a time (no concurrent storms)
 * - Per-account: skips expired or already-up-to-date tokens
 * - Configurable: buffer window and check interval are tunable
 */

import type { AccountPool } from "./account-pool.js";
import { refreshAccessTokenShared } from "./auth/auth.js";
import { logDebug, logWarn } from "./logger.js";

/** Configuration for the proactive refresh queue */
export interface ProactiveRefreshConfig {
	/** Enable proactive token refresh (default: true) */
	enabled: boolean;
	/** Seconds before expiry to trigger proactive refresh (default: 1800 = 30 min) */
	bufferSeconds: number;
	/** Interval between refresh checks in seconds (default: 300 = 5 min) */
	checkIntervalSeconds: number;
}

export const DEFAULT_PROACTIVE_REFRESH_CONFIG: ProactiveRefreshConfig = {
	enabled: true,
	bufferSeconds: 1800,       // 30 minutes before expiry
	checkIntervalSeconds: 300, // check every 5 minutes
};

/**
 * Proactive Token Refresh Queue.
 *
 * Usage:
 *   const queue = new ProactiveRefreshQueue(accountPool);
 *   queue.start();
 *   // ... plugin runs ...
 *   queue.stop(); // optional, on process exit
 */
export class ProactiveRefreshQueue {
	private readonly config: ProactiveRefreshConfig;
	private readonly pool: AccountPool;

	private isRunning = false;
	private isRefreshing = false;
	private intervalHandle: ReturnType<typeof setInterval> | null = null;

	constructor(pool: AccountPool, config?: Partial<ProactiveRefreshConfig>) {
		this.pool = pool;
		this.config = { ...DEFAULT_PROACTIVE_REFRESH_CONFIG, ...config };
	}

	/**
	 * Start the background refresh loop.
	 * An initial check runs 5 s after start (letting things settle).
	 */
	start(): void {
		if (this.isRunning || !this.config.enabled) return;
		this.isRunning = true;

		// Initial check after a short settling delay
		setTimeout(() => {
			if (this.isRunning) {
				this.runRefreshCheck().catch((err: unknown) => {
					logWarn("ProactiveRefreshQueue: initial check failed", err);
				});
			}
		}, 5_000);

		// Periodic checks
		const intervalMs = this.config.checkIntervalSeconds * 1000;
		this.intervalHandle = setInterval(() => {
			this.runRefreshCheck().catch((err: unknown) => {
				logWarn("ProactiveRefreshQueue: periodic check failed", err);
			});
		}, intervalMs);

		logDebug("ProactiveRefreshQueue started", {
			checkIntervalSeconds: this.config.checkIntervalSeconds,
			bufferSeconds: this.config.bufferSeconds,
		});
	}

	stop(): void {
		if (!this.isRunning) return;
		this.isRunning = false;
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
		logDebug("ProactiveRefreshQueue stopped");
	}

	/** Whether the queue is currently running */
	get running(): boolean {
		return this.isRunning;
	}

	// ---------------------------------------------------------------------------

	private needsRefresh(account: { expires?: number }): boolean {
		if (!account.expires) return false;
		const bufferMs = this.config.bufferSeconds * 1000;
		return account.expires <= Date.now() + bufferMs;
	}

	private isAlreadyExpired(account: { expires?: number }): boolean {
		if (!account.expires) return false;
		return account.expires <= Date.now();
	}

	private async runRefreshCheck(): Promise<void> {
		if (this.isRefreshing) return; // previous pass still running

		this.isRefreshing = true;
		try {
			const accounts = this.pool.getAccounts().filter((a) => {
				// Skip accounts that are already expired — let the main fetch loop handle those
				if (this.isAlreadyExpired(a)) return false;
				return this.needsRefresh(a);
			});

			if (accounts.length === 0) return;

			logDebug(`ProactiveRefreshQueue: refreshing ${accounts.length} account(s)`);

			// Refresh serially — prevents concurrent refresh storms
			for (const account of accounts) {
				if (!this.isRunning) break; // stopped mid-pass

				try {
					const result = await refreshAccessTokenShared(account.accountId, account.refresh);
					if (result.type === "success") {
						this.pool.replaceAuth(
							account.accountId,
							result.access,
							result.refresh,
							result.expires,
						);
						try {
							this.pool.save();
						} catch {
							// Non-fatal — token is already updated in memory
						}
						logDebug("ProactiveRefreshQueue: refreshed account", {
							accountId: account.accountId,
						});
					} else {
						logWarn("ProactiveRefreshQueue: refresh failed for account", {
							accountId: account.accountId,
						});
					}
				} catch (err) {
					logWarn("ProactiveRefreshQueue: unexpected error refreshing account", {
						accountId: account.accountId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		} finally {
			this.isRefreshing = false;
		}
	}
}
