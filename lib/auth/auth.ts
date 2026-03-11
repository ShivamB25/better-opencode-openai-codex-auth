import { generatePKCE } from "@openauthjs/openauth/pkce";
import { randomBytes } from "node:crypto";
import type { PKCEPair, AuthorizationFlow, TokenResult, ParsedAuthInput, JWTPayload } from "../types.js";
import { DEVICE_AUTH } from "../constants.js";

// OAuth constants (from openai/codex)
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";

const refreshInFlight = new Map<string, Promise<TokenResult>>();

/**
 * Generate a random state value for OAuth flow
 * @returns Random hex string
 */
export function createState(): string {
	return randomBytes(16).toString("hex");
}

/**
 * Parse authorization code and state from user input
 * @param input - User input (URL, code#state, or just code)
 * @returns Parsed authorization data
 */
export function parseAuthorizationInput(input: string): ParsedAuthInput {
	const value = (input || "").trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: value };
}

/**
 * Exchange authorization code for access and refresh tokens.
 * Captures id_token when returned — it contains chatgpt_account_id as a
 * dedicated JWT claim, making account-ID extraction more reliable.
 *
 * @param code - Authorization code from OAuth flow
 * @param verifier - PKCE verifier
 * @param redirectUri - OAuth redirect URI
 * @returns Token result (includes id_token when available)
 */
export async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = REDIRECT_URI,
): Promise<TokenResult> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		console.error(`[openai-codex-plugin] code->token failed: ${res.status}`, text);
		return { type: "failed" };
	}
	const json = (await res.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		id_token?: string;
	};
	if (
		!json?.access_token ||
		!json?.refresh_token ||
		typeof json?.expires_in !== "number"
	) {
		console.error("[openai-codex-plugin] token response missing fields");
		return { type: "failed" };
	}
	return {
		type: "success",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
		id_token: json.id_token,
	};
}

/**
 * Decode a JWT token to extract payload
 * @param token - JWT token to decode
 * @returns Decoded payload or null if invalid
 */
export function decodeJWT(token: string): JWTPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1];
		if (!payload) return null;
		const decoded = Buffer.from(payload, "base64url").toString("utf-8");
		const parsed: unknown = JSON.parse(decoded);

		// Validate that the parsed payload is a non-null object
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}

		return parsed as JWTPayload;
	} catch {
		return null;
	}
}

/**
 * Extract the ChatGPT account ID from a JWT token string.
 * Checks (in priority order, matching first-party opencode CodexAuthPlugin):
 *   1. Root-level chatgpt_account_id claim
 *   2. Nested https://api.openai.com/auth.chatgpt_account_id claim
 *   3. organizations[0].id fallback
 *
 * @param token - JWT string (id_token or access_token)
 * @returns Account ID or undefined if not found
 */
export function extractAccountIdFromToken(token: string): string | undefined {
	if (!token) return undefined;
	const claims = decodeJWT(token);
	if (!claims) return undefined;

	// 1. Root-level claim (most authoritative)
	if (typeof claims.chatgpt_account_id === "string" && claims.chatgpt_account_id) {
		return claims.chatgpt_account_id;
	}

	// 2. Nested claim
	const nested = claims["https://api.openai.com/auth"] as
		| { chatgpt_account_id?: string }
		| undefined;
	if (nested?.chatgpt_account_id) {
		return nested.chatgpt_account_id;
	}

	// 3. Organizations fallback
	const orgs = claims.organizations;
	if (Array.isArray(orgs) && orgs[0]?.id) {
		return orgs[0].id;
	}

	return undefined;
}

/**
 * Extract account ID from a token-response object.
 * Tries id_token first (more authoritative), then access_token.
 *
 * @param tokens - Object with access_token and optional id_token
 * @returns Account ID or undefined
 */
export function extractAccountId(tokens: {
	access_token: string;
	id_token?: string;
}): string | undefined {
	if (tokens.id_token) {
		const fromIdToken = extractAccountIdFromToken(tokens.id_token);
		if (fromIdToken) return fromIdToken;
	}
	return extractAccountIdFromToken(tokens.access_token);
}

/**
 * Refresh access token using refresh token.
 * Captures id_token when returned by the server.
 *
 * @param refreshToken - Refresh token
 * @returns Token result
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			console.error(
				`[openai-codex-plugin] Token refresh failed: ${response.status}`,
				text,
			);
			return { type: "failed" };
		}

		const json = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			id_token?: string;
		};
		if (
			!json?.access_token ||
			typeof json?.expires_in !== "number"
		) {
			console.error(
				"[openai-codex-plugin] Token refresh response missing fields",
			);
			return { type: "failed" };
		}

		return {
			type: "success",
			access: json.access_token,
			refresh: json.refresh_token || refreshToken,
			expires: Date.now() + json.expires_in * 1000,
			id_token: json.id_token,
		};
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		console.error("[openai-codex-plugin] Token refresh error:", err.message);
		return { type: "failed" };
	}
}

export function refreshAccessTokenShared(
	accountKey: string,
	refreshToken: string,
): Promise<TokenResult> {
	const key = `${accountKey}:${refreshToken}`;
	const existing = refreshInFlight.get(key);
	if (existing) {
		return existing;
	}

	const promise = refreshAccessToken(refreshToken).finally(() => {
		refreshInFlight.delete(key);
	});
	refreshInFlight.set(key, promise);
	return promise;
}

/**
 * Create OAuth authorization flow (browser PKCE)
 * @returns Authorization flow details
 */
export async function createAuthorizationFlow(): Promise<AuthorizationFlow> {
	const pkce = (await generatePKCE()) as PKCEPair;
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	// Use "opencode" — matching the first-party opencode CodexAuthPlugin (#2 fix)
	url.searchParams.set("originator", "opencode");

	return { pkce, state, url: url.toString() };
}

/**
 * Device authorization flow result
 */
export interface DeviceAuthorizationFlow {
	/** URL the user visits to enter the code */
	activateUrl: string;
	/** Short code the user types on the device page */
	userCode: string;
	/** Poll interval in milliseconds (server-controlled + safety margin) */
	pollIntervalMs: number;
	/** Poll for completion and exchange for tokens */
	poll: () => Promise<TokenResult>;
}

/**
 * Create a headless/device-code authorization flow.
 *
 * This flow requires no browser on the machine running opencode. The user
 * visits a URL on any device and enters a short code to authenticate.
 * Matches the "headless" method in the first-party opencode CodexAuthPlugin.
 *
 * @returns Device authorization flow details
 */
export async function createDeviceAuthorizationFlow(): Promise<DeviceAuthorizationFlow> {
	const response = await fetch(DEVICE_AUTH.USERCODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
	});

	if (!response.ok) {
		throw new Error(
			`[openai-codex-plugin] Device auth usercode request failed: ${response.status}`,
		);
	}

	const data = (await response.json()) as {
		device_auth_id: string;
		user_code: string;
		interval: string;
	};

	const serverIntervalMs = Math.max(parseInt(data.interval) || 5, 1) * 1000;
	const pollIntervalMs = serverIntervalMs + DEVICE_AUTH.POLL_SAFETY_MARGIN_MS;

	const poll = async (): Promise<TokenResult> => {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const tokenResponse = await fetch(DEVICE_AUTH.TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					device_auth_id: data.device_auth_id,
					user_code: data.user_code,
				}),
			});

			if (tokenResponse.ok) {
				const tokenData = (await tokenResponse.json()) as {
					authorization_code: string;
					code_verifier: string;
				};

				// Exchange the authorization_code for final tokens
				return exchangeAuthorizationCode(
					tokenData.authorization_code,
					tokenData.code_verifier,
					DEVICE_AUTH.REDIRECT_URI,
				);
			}

			// 403 / 404 = still waiting for user to complete auth
			if (tokenResponse.status !== 403 && tokenResponse.status !== 404) {
				console.error(
					`[openai-codex-plugin] Device token poll failed: ${tokenResponse.status}`,
				);
				return { type: "failed" };
			}

			// Wait before next poll
			await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
		}
	};

	return {
		activateUrl: DEVICE_AUTH.ACTIVATE_URL,
		userCode: data.user_code,
		pollIntervalMs,
		poll,
	};
}
