/**
 * OpenAI ChatGPT (Codex) OAuth Authentication Plugin for opencode
 *
 * COMPLIANCE NOTICE:
 * This plugin uses OpenAI's official OAuth authentication flow (the same method
 * used by OpenAI's official Codex CLI at https://github.com/openai/codex).
 *
 * INTENDED USE: Personal development and coding assistance with your own
 * ChatGPT Plus/Pro subscription.
 *
 * NOT INTENDED FOR: Commercial resale, multi-user services, high-volume
 * automated extraction, or any use that violates OpenAI's Terms of Service.
 *
 * Users are responsible for ensuring their usage complies with:
 * - OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
 * - OpenAI Usage Policies: https://openai.com/policies/usage-policies/
 *
 * For production applications, use the OpenAI Platform API: https://platform.openai.com/
 *
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @author ShivamB25 (fork maintainer); originally by numman-ali
 * @repository https://github.com/ShivamB25/better-opencode-openai-codex-auth
 */

import os from "node:os";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
	createAuthorizationFlow,
	createDeviceAuthorizationFlow,
	extractAccountId,
	extractAccountIdFromToken,
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	refreshAccessTokenShared,
	REDIRECT_URI,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import { showAccountManager } from "./lib/auth/ui/account-menu.js";
import { getCodexMode, loadPluginConfig } from "./lib/config.js";
import {
	AUTH_LABELS,
	CODEX_BASE_URL,
	DUMMY_API_KEY,
	ERROR_MESSAGES,
	LOG_STAGES,
	MAX_RECOVERY_WAIT_MS,
	PLUGIN_NAME,
	PLUGIN_VERSION,
	PROVIDER_ID,
} from "./lib/constants.js";
import { logRequest, logDebug, logWarn } from "./lib/logger.js";
import {
	createCodexHeaders,
	extractRequestUrl,
	handleErrorResponse,
	handleSuccessResponse,
	rewriteUrlForCodex,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import type { RequestBody, UserConfig } from "./lib/types.js";
import { AccountPool } from "./lib/account-pool.js";
import { ProactiveRefreshQueue } from "./lib/refresh-queue.js";

/**
 * Parse a ChatGPT error code from a 429 response body.
 * Used for tiered cooldown durations (#10).
 */
async function parseErrorCode(response: Response): Promise<string | undefined> {
	try {
		const clone = response.clone();
		const text = await clone.text();
		if (!text) return undefined;
		const parsed = JSON.parse(text) as { error?: { code?: string; type?: string } };
		return (parsed?.error?.code ?? parsed?.error?.type) || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Build a 429 response when all accounts are rate-limited
 * @param retryAfterMs - Minimum retry-after time from pool, or null
 */
function buildAllRateLimitedResponse(retryAfterMs: number | null): Response {
	const retryAfterSeconds = retryAfterMs ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null;
	return new Response(
		JSON.stringify({
			error: {
				code: "usage_limit_reached",
				message: "All ChatGPT accounts are temporarily rate-limited",
			},
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				...(retryAfterSeconds
					? { "retry-after": String(retryAfterSeconds) }
					: {}),
			},
		},
	);
}

/**
 * OpenAI Codex OAuth authentication plugin for opencode
 */
export const OpenAIAuthPlugin: Plugin = async ({ client }: PluginInput) => {
	const buildManualOAuthFlow = (pkce: { verifier: string }, url: string) => ({
		url,
		method: "code" as const,
		instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
		callback: async (input: string) => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code) {
				return { type: "failed" as const };
			}
			const tokens = await exchangeAuthorizationCode(
				parsed.code,
				pkce.verifier,
				REDIRECT_URI,
			);
			if (tokens?.type !== "success") return { type: "failed" as const };
			return {
				...tokens,
				accountId: extractAccountId({
					access_token: tokens.access,
					id_token: tokens.id_token,
				}),
			};
		},
	});

	return {
		auth: {
			provider: PROVIDER_ID,

			/**
			 * Loader: validates OAuth auth, sets up per-account token management,
			 * starts proactive background refresh, and returns the custom fetch.
			 */
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				const auth = await getAuth();

				// Only handle OAuth auth type
				if (auth.type !== "oauth") {
					return {};
				}

				// Extract ChatGPT account ID — prefer stored accountId (#5), then id_token,
				// then decode access token (checks root + nested JWT claim locations)
				const authWithAccount = auth as typeof auth & { accountId?: string; id_token?: string };
				let accountId: string | undefined =
					authWithAccount.accountId ||
					(authWithAccount.id_token ? extractAccountIdFromToken(authWithAccount.id_token) : undefined) ||
					extractAccountIdFromToken(auth.access);

				if (!accountId) {
					logDebug(
						`[${PLUGIN_NAME}] ${ERROR_MESSAGES.NO_ACCOUNT_ID} (skipping plugin)`,
					);
					return {};
				}

				// Extract user configuration (global + per-model options)
				const providerConfig = provider as
					| { options?: Record<string, unknown>; models?: UserConfig["models"] }
					| undefined;
				const userConfig: UserConfig = {
					global: providerConfig?.options || {},
					models: providerConfig?.models || {},
				};

				// Load plugin configuration
				const pluginConfig = loadPluginConfig();
				const codexMode = getCodexMode(pluginConfig);
				const accountSelectionStrategy =
					pluginConfig.accountSelectionStrategy === "sticky" ? "sticky" : "round-robin";
				const rateLimitCooldownMs = pluginConfig.rateLimitCooldownMs;

				const accountPool = AccountPool.load();
				const savePool = () => {
					try {
						accountPool.save();
					} catch (error) {
						logWarn("Failed to persist account pool", error);
					}
				};

				// Sync current auth into pool
				accountPool.upsert({
					accountId,
					access: auth.access,
					refresh: auth.refresh,
					expires: auth.expires,
					email:
						typeof (auth as Record<string, unknown>).email === "string"
							? (auth as Record<string, unknown>).email as string
							: undefined,
				});
				savePool();

				// Start proactive background token refresh (#8)
				const refreshQueue = new ProactiveRefreshQueue(accountPool);
				refreshQueue.start();

				return {
					apiKey: DUMMY_API_KEY,
					baseURL: CODEX_BASE_URL,

					async fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response> {
						const latestAuth = await getAuth();
						const latestWithAccount = latestAuth as typeof latestAuth & {
							accountId?: string;
							id_token?: string;
						};

						if (latestAuth.type === "oauth") {
							// Re-extract account ID with the priority chain (#5)
							const latestAccountId =
								latestWithAccount.accountId ||
								(latestWithAccount.id_token
									? extractAccountIdFromToken(latestWithAccount.id_token)
									: undefined) ||
								extractAccountIdFromToken(latestAuth.access);

							if (latestAccountId) {
								accountId = latestAccountId;
								accountPool.upsert({
									accountId: latestAccountId,
									access: latestAuth.access,
									refresh: latestAuth.refresh,
									expires: latestAuth.expires,
								});
							}
						}

						// Step 1: Extract and rewrite URL for Codex backend (#7)
						const originalUrl = extractRequestUrl(input);
						const url = rewriteUrlForCodex(originalUrl);

						// Step 2: Transform request body
						let originalBody: Partial<RequestBody> = {};
						if (typeof init?.body === "string") {
							try {
								originalBody = JSON.parse(init.body) as Partial<RequestBody>;
							} catch {
								originalBody = {};
							}
						}
						const isStreaming = originalBody.stream === true;

						const transformation = await transformRequestForCodex(
							init,
							url,
							userConfig,
							codexMode,
						);
						const requestInit = transformation?.updatedInit ?? init;

						// Step 3: Retry loop — one attempt per account
						const attempts = Math.max(accountPool.count(), 1);
						let lastRateLimitResponse: Response | null = null;

						for (let i = 0; i < attempts; i++) {
							const selected = accountPool.next(accountSelectionStrategy);
							if (!selected) break;

							// Per-account token refresh when expired
							// (Background queue handles this proactively; this is the safety net)
							if (selected.expires < Date.now()) {
								const selectedRefreshBefore = selected.refresh;
								const refreshed = await refreshAccessTokenShared(
									selected.accountId,
									selected.refresh,
								);

								if (refreshed.type === "failed") {
									// Auth failure (revoked/invalid token) — track it (#9)
									logWarn("Token refresh failed for account, skipping", selected.accountId);
									accountPool.markAuthFailure(selected.accountId);
									savePool();
									continue;
								}

								// Clear failure counter on successful refresh
								accountPool.clearAuthFailures(selected.accountId);
								accountPool.replaceAuth(
									selected.accountId,
									refreshed.access,
									refreshed.refresh,
									refreshed.expires,
								);

								// Keep opencode's stored auth in sync for the primary account
								if (
									latestAuth.type === "oauth" &&
									(latestAuth.refresh === selectedRefreshBefore ||
										accountId === selected.accountId)
								) {
									try {
										await client.auth.set({
											path: { id: "openai" },
											body: {
												type: "oauth",
												access: refreshed.access,
												refresh: refreshed.refresh,
												expires: refreshed.expires,
											},
										});
									} catch (error) {
										logWarn("Failed to persist refreshed auth", error);
									}
								}
							}

							// Step 4: Build headers
							const headers = createCodexHeaders(
								requestInit,
								selected.accountId,
								selected.access,
								{
									model: transformation?.body.model,
									promptCacheKey: (transformation?.body as RequestBody | undefined)
										?.prompt_cache_key,
								},
							);

							// Step 5: Execute request
							const response = await fetch(url, {
								...requestInit,
								headers,
							});

							logRequest(LOG_STAGES.RESPONSE, {
								status: response.status,
								ok: response.ok,
								statusText: response.statusText,
								headers: Object.fromEntries(response.headers.entries()),
								accountId: selected.accountId,
								attempt: i + 1,
								totalAttempts: attempts,
							});

							// Step 6: Handle response
							if (!response.ok) {
								const mapped = await handleErrorResponse(response);

								if (mapped.status === 429) {
									// Parse error code for tiered cooldown (#10)
									const errorCode = await parseErrorCode(mapped);
									accountPool.markRateLimited(
										selected.accountId,
										mapped.headers,
										rateLimitCooldownMs,
										errorCode,
									);
									savePool();
									lastRateLimitResponse = mapped;
									continue;
								}

								savePool();
								return mapped;
							}

							// Success — clear any failure state
							accountPool.clearAuthFailures(selected.accountId);
							savePool();
							return await handleSuccessResponse(response, isStreaming);
						}

						// All accounts exhausted — wait for recovery if feasible (#11)
						const minWaitMs = accountPool.getMinRetryAfterMs();
						if (minWaitMs !== null && minWaitMs <= MAX_RECOVERY_WAIT_MS) {
							logDebug(
								`All accounts rate-limited. Waiting ${Math.ceil(minWaitMs / 1000)}s for recovery...`,
							);
							await new Promise<void>((r) => setTimeout(r, minWaitMs));

							// One recovery attempt with the now-unblocked account
							const recovered = accountPool.next(accountSelectionStrategy);
							if (recovered) {
								const recHeaders = createCodexHeaders(
									requestInit,
									recovered.accountId,
									recovered.access,
									{
										model: transformation?.body.model,
										promptCacheKey: (transformation?.body as RequestBody | undefined)
											?.prompt_cache_key,
									},
								);
								const recResponse = await fetch(url, { ...requestInit, headers: recHeaders });
								if (recResponse.ok) {
									accountPool.clearAuthFailures(recovered.accountId);
									savePool();
									return await handleSuccessResponse(recResponse, isStreaming);
								}
								const recMapped = await handleErrorResponse(recResponse);
								if (recMapped.status === 429) {
									const errorCode = await parseErrorCode(recMapped);
									accountPool.markRateLimited(
										recovered.accountId,
										recMapped.headers,
										rateLimitCooldownMs,
										errorCode,
									);
									lastRateLimitResponse = recMapped;
								} else {
									savePool();
									return recMapped;
								}
							}
						}

						savePool();
						if (lastRateLimitResponse) {
							return lastRateLimitResponse;
						}
						return buildAllRateLimitedResponse(accountPool.getMinRetryAfterMs());
					},
				};
			},

			methods: [
				// ── Account management (view / remove existing accounts) ───────────────
				{
					label: AUTH_LABELS.MANAGE_ACCOUNTS,
					type: "oauth" as const,
					authorize: async () => {
						const result = await showAccountManager();

						// If user wants to add or refresh a token, tell them to pick
						// an actual auth method from the list instead
						if (result.action === "add" || result.action === "refresh-token") {
							return {
								url: "",
								method: "code" as const,
								instructions:
									"Select one of the auth methods above (browser, manual, or headless) to add a new account.",
								callback: async () => ({ type: "failed" as const }),
							};
						}

						// User is done managing — nothing to store
						return {
							url: "",
							method: "code" as const,
							instructions: "Done. No new account was added. Restart opencode.",
							callback: async () => ({ type: "failed" as const }),
						};
					},
				},

				// ── Browser PKCE flow ──────────────────────────────────────────────────
				{
					label: AUTH_LABELS.OAUTH,
					type: "oauth" as const,
					authorize: async () => {
						const { pkce, state, url } = await createAuthorizationFlow();
						const serverInfo = await startLocalOAuthServer({ state });

						const browserOpened = openBrowserUrl(url);

						// Fall back immediately to manual paste when:
						//   - local callback server could not bind (port conflict)
						//   - browser could not be launched (headless / no DISPLAY)
						// This avoids a 60-second timeout before showing the user the URL.
						if (!serverInfo.ready || !browserOpened) {
							serverInfo.close();
							return buildManualOAuthFlow(pkce, url);
						}

						return {
							url,
							method: "auto" as const,
							instructions: AUTH_LABELS.INSTRUCTIONS,
							callback: async () => {
								const result = await serverInfo.waitForCode(state);
								serverInfo.close();

								if (!result) return { type: "failed" as const };

								const tokens = await exchangeAuthorizationCode(
									result.code,
									pkce.verifier,
									REDIRECT_URI,
								);
								if (tokens?.type !== "success") return { type: "failed" as const };

								// Return accountId so opencode stores it in auth — avoids JWT
								// decode on every request (#5)
								return {
									...tokens,
									accountId: extractAccountId({
										access_token: tokens.access,
										id_token: tokens.id_token,
									}),
								};
							},
						};
					},
				},

				// ── Manual URL paste ───────────────────────────────────────────────────
				{
					label: AUTH_LABELS.OAUTH_MANUAL,
					type: "oauth" as const,
					authorize: async () => {
						const { pkce, url } = await createAuthorizationFlow();
						return buildManualOAuthFlow(pkce, url);
					},
				},

				// ── Headless / device-code flow (#1) ──────────────────────────────────
				{
					label: AUTH_LABELS.OAUTH_DEVICE,
					type: "oauth" as const,
					authorize: async () => {
						const deviceFlow = await createDeviceAuthorizationFlow();

						return {
							url: deviceFlow.activateUrl,
							method: "auto" as const,
							instructions: `${AUTH_LABELS.INSTRUCTIONS_DEVICE}\n\nCode: ${deviceFlow.userCode}\nURL:  ${deviceFlow.activateUrl}`,
							callback: async () => {
								const tokens = await deviceFlow.poll();
								if (tokens?.type !== "success") return { type: "failed" as const };
								return {
									...tokens,
									accountId: extractAccountId({
										access_token: tokens.access,
										id_token: tokens.id_token,
									}),
								};
							},
						};
					},
				},

				// ── API Key ────────────────────────────────────────────────────────────
				{
					label: AUTH_LABELS.API_KEY,
					type: "api" as const,
				},
			],
		},

		/**
		 * chat.headers hook — injected before every LLM request (#2, #4, #6).
		 * Sets originator, User-Agent, and session_id using the platform session ID.
		 */
		"chat.headers": async (
			hookInput: {
				sessionID: string;
				model: { providerID: string };
			},
			output: { headers: Record<string, string> },
		) => {
			if (hookInput.model.providerID !== PROVIDER_ID) return;

			// #2: correct originator (not codex_cli_rs)
			output.headers["originator"] = "opencode";

			// #4: use the platform session ID (not a static random UUID)
			output.headers["session_id"] = hookInput.sessionID;

			// #6: proper User-Agent with version + OS info
			output.headers["User-Agent"] =
				`better-opencode-openai-codex-auth/${PLUGIN_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`;
		},
	};
};

export default OpenAIAuthPlugin;
