import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountPool } from "../lib/account-pool.js";

const testPath = join(tmpdir(), "opencode-openai-codex-auth-account-pool-test.json");

function cleanup(): void {
	if (existsSync(testPath)) {
		rmSync(testPath, { force: true });
	}
}

describe("AccountPool", () => {
	beforeEach(() => {
		process.env.OPENAI_CODEX_ACCOUNTS_PATH = testPath;
		cleanup();
	});

	afterEach(() => {
		cleanup();
		delete process.env.OPENAI_CODEX_ACCOUNTS_PATH;
	});

	it("rotates accounts in round-robin mode", () => {
		const pool = AccountPool.load();
		pool.upsert({
			accountId: "a1",
			access: "access-1",
			refresh: "refresh-1",
			expires: Date.now() + 60_000,
		});
		pool.upsert({
			accountId: "a2",
			access: "access-2",
			refresh: "refresh-2",
			expires: Date.now() + 60_000,
		});

		const one = pool.next("round-robin");
		const two = pool.next("round-robin");
		const three = pool.next("round-robin");

		expect(one?.accountId).toBe("a2");
		expect(two?.accountId).toBe("a1");
		expect(three?.accountId).toBe("a2");
	});

	it("keeps same account in sticky mode when available", () => {
		const pool = AccountPool.load();
		pool.upsert({
			accountId: "a1",
			access: "access-1",
			refresh: "refresh-1",
			expires: Date.now() + 60_000,
		});
		pool.upsert({
			accountId: "a2",
			access: "access-2",
			refresh: "refresh-2",
			expires: Date.now() + 60_000,
		});

		const current = pool.next("sticky");
		const next = pool.next("sticky");

		expect(current?.accountId).toBeDefined();
		expect(next?.accountId).toBe(current?.accountId);
	});

	it("skips rate-limited account and picks another", () => {
		const pool = AccountPool.load();
		pool.upsert({
			accountId: "a1",
			access: "access-1",
			refresh: "refresh-1",
			expires: Date.now() + 60_000,
		});
		pool.upsert({
			accountId: "a2",
			access: "access-2",
			refresh: "refresh-2",
			expires: Date.now() + 60_000,
		});

		pool.markRateLimited("a2", new Headers({ "retry-after": "60" }));
		const selected = pool.next("round-robin");

		expect(selected?.accountId).toBe("a1");
	});
});
