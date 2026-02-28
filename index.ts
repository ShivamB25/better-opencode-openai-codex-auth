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
 * @author numman-ali
 * @repository https://github.com/numman-ali/opencode-openai-codex-auth
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
	createAuthorizationFlow,
	decodeJWT,
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	refreshAccessToken,
	REDIRECT_URI,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import { getCodexMode, loadPluginConfig } from "./lib/config.js";
import {
	AUTH_LABELS,
	CODEX_BASE_URL,
	DUMMY_API_KEY,
	ERROR_MESSAGES,
	JWT_CLAIM_PATH,
	LOG_STAGES,
	PLUGIN_NAME,
	PROVIDER_ID,
} from "./lib/constants.js";
import { logRequest, logDebug } from "./lib/logger.js";
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

/**
 * OpenAI Codex OAuth authentication plugin for opencode
 *
 * This plugin enables opencode to use OpenAI's Codex backend via ChatGPT Plus/Pro
 * OAuth authentication, allowing users to leverage their ChatGPT subscription
 * instead of OpenAI Platform API credits.
 *
 * @example
 * ```json
 * {
 *   "plugin": ["opencode-openai-codex-auth"],
 *   "model": "openai/gpt-5-codex"
 * }
 * ```
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
			return tokens?.type === "success" ? tokens : { type: "failed" as const };
		},
	});
	return {
		auth: {
			provider: PROVIDER_ID,
			/**
			 * Loader function that configures OAuth authentication and request handling
			 *
			 * This function:
			 * 1. Validates OAuth authentication
			 * 2. Extracts ChatGPT account ID from access token
			 * 3. Loads user configuration from opencode.json
			 * 4. Fetches Codex system instructions from GitHub (cached)
			 * 5. Returns SDK configuration with custom fetch implementation
			 *
			 * @param getAuth - Function to retrieve current auth state
			 * @param provider - Provider configuration from opencode.json
			 * @returns SDK configuration object or empty object for non-OAuth auth
			 */
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				const auth = await getAuth();

				// Only handle OAuth auth type, skip API key auth
				if (auth.type !== "oauth") {
					return {};
				}

				// Extract ChatGPT account ID from JWT access token
				const decoded = decodeJWT(auth.access);
				const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;

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

				// Load plugin configuration and determine CODEX_MODE
				// Priority: CODEX_MODE env var > config file > default (true)
				const pluginConfig = loadPluginConfig();
				const codexMode = getCodexMode(pluginConfig);
				const accountSelectionStrategy =
					pluginConfig.accountSelectionStrategy === "sticky" ? "sticky" : "round-robin";
				const rateLimitCooldownMs = pluginConfig.rateLimitCooldownMs;

				const accountPool = AccountPool.load();
				accountPool.upsert({
					accountId,
					access: auth.access,
					refresh: auth.refresh,
					expires: auth.expires,
					email:
						typeof decoded?.email === "string"
							? decoded.email
							: undefined,
				});
				accountPool.save();

				// Return SDK configuration
				return {
					apiKey: DUMMY_API_KEY,
					baseURL: CODEX_BASE_URL,
					/**
					 * Custom fetch implementation for Codex API
					 *
					 * Handles:
					 * - Token refresh when expired
					 * - URL rewriting for Codex backend
					 * - Request body transformation
					 * - OAuth header injection
					 * - SSE to JSON conversion for non-tool requests
					 * - Error handling and logging
					 *
					 * @param input - Request URL or Request object
					 * @param init - Request options
					 * @returns Response from Codex API
					 */
					async fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response> {
						const latestAuth = await getAuth();
						if (latestAuth.type === "oauth") {
							const latestDecoded = decodeJWT(latestAuth.access);
							const latestAccountId = latestDecoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
							if (latestAccountId) {
								accountPool.upsert({
									accountId: latestAccountId,
									access: latestAuth.access,
									refresh: latestAuth.refresh,
									expires: latestAuth.expires,
									email:
										typeof latestDecoded?.email === "string"
											? latestDecoded.email
											: undefined,
								});
							}
						}

						// Step 2: Extract and rewrite URL for Codex backend
						const originalUrl = extractRequestUrl(input);
						const url = rewriteUrlForCodex(originalUrl);

						// Step 3: Transform request body with model-specific Codex instructions
						// Instructions are fetched per model family (codex-max, codex, gpt-5.1)
						// Capture original stream value before transformation
						// generateText() sends no stream field, streamText() sends stream=true
						const originalBody = init?.body ? JSON.parse(init.body as string) : {};
						const isStreaming = originalBody.stream === true;

						const transformation = await transformRequestForCodex(
							init,
							url,
							userConfig,
							codexMode,
						);
						const requestInit = transformation?.updatedInit ?? init;

						const attempts = Math.max(accountPool.count(), 1);
						let lastRateLimitResponse: Response | null = null;
						for (let i = 0; i < attempts; i++) {
							const selected = accountPool.next(accountSelectionStrategy);
							if (!selected) {
								break;
							}

							if (selected.expires < Date.now()) {
								const refreshed = await refreshAccessToken(selected.refresh);
								if (refreshed.type === "failed") {
									accountPool.markRateLimited(
										selected.accountId,
										new Headers(),
										rateLimitCooldownMs,
									);
									accountPool.save();
									continue;
								}
								accountPool.replaceAuth(
									selected.accountId,
									refreshed.access,
									refreshed.refresh,
									refreshed.expires,
								);
								if (latestAuth.type === "oauth" && latestAuth.refresh === selected.refresh) {
									await client.auth.set({
										path: { id: "openai" },
										body: {
											type: "oauth",
											access: refreshed.access,
											refresh: refreshed.refresh,
											expires: refreshed.expires,
										},
									});
								}
							}

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

							if (!response.ok) {
								const mapped = await handleErrorResponse(response);
								if (mapped.status === 429) {
									accountPool.markRateLimited(
										selected.accountId,
										mapped.headers,
										rateLimitCooldownMs,
									);
									accountPool.save();
									lastRateLimitResponse = mapped;
									continue;
								}
								accountPool.save();
								return mapped;
							}

							accountPool.save();
							return await handleSuccessResponse(response, isStreaming);
						}

						accountPool.save();
						if (lastRateLimitResponse) {
							return lastRateLimitResponse;
						}
						throw new Error("No available ChatGPT account in account pool");
					},
				};
			},
				methods: [
					{
						label: AUTH_LABELS.OAUTH,
						type: "oauth" as const,
					/**
					 * OAuth authorization flow
					 *
					 * Steps:
					 * 1. Generate PKCE challenge and state for security
					 * 2. Start local OAuth callback server on port 1455
					 * 3. Open browser to OpenAI authorization page
					 * 4. Wait for user to complete login
					 * 5. Exchange authorization code for tokens
					 *
					 * @returns Authorization flow configuration
					 */
					authorize: async () => {
						const { pkce, state, url } = await createAuthorizationFlow();
						const serverInfo = await startLocalOAuthServer({ state });

						// Attempt to open browser automatically
						openBrowserUrl(url);

						if (!serverInfo.ready) {
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

								if (!result) {
									return { type: "failed" as const };
								}

								const tokens = await exchangeAuthorizationCode(
									result.code,
									pkce.verifier,
									REDIRECT_URI,
								);

								return tokens?.type === "success"
									? tokens
									: { type: "failed" as const };
							},
						};
					},
					},
					{
						label: AUTH_LABELS.OAUTH_MANUAL,
						type: "oauth" as const,
						authorize: async () => {
							const { pkce, url } = await createAuthorizationFlow();
							return buildManualOAuthFlow(pkce, url);
						},
					},
					{
						label: AUTH_LABELS.API_KEY,
						type: "api" as const,
					},
			],
		},
	};
};

export default OpenAIAuthPlugin;
