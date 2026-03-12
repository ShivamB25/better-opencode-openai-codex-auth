/**
 * Constants used throughout the plugin
 * Centralized for easy maintenance and configuration
 */

/** Plugin identifier for logging and error messages */
export const PLUGIN_NAME = "openai-codex-plugin";

/** Plugin version — keep in sync with package.json */
export const PLUGIN_VERSION = "0.1.5";

/** Base URL for ChatGPT backend API */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** Dummy API key used for OpenAI SDK (actual auth via OAuth) */
export const DUMMY_API_KEY = "chatgpt-oauth";

/** Provider ID for opencode configuration */
export const PROVIDER_ID = "openai";

/** HTTP Status Codes */
export const HTTP_STATUS = {
	OK: 200,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
	TOO_MANY_REQUESTS: 429,
} as const;

/** OpenAI-specific headers */
export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
} as const;

/** OpenAI-specific header values */
export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	/** Match the first-party opencode CodexAuthPlugin — do not spoof codex_cli_rs */
	ORIGINATOR_CODEX: "opencode",
} as const;

/** URL path segments */
export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
	/** Alternate path opencode may use (chat completions compat layer) */
	CHAT_COMPLETIONS: "/chat/completions",
} as const;

/** JWT claim path for ChatGPT account ID */
export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

/** Error messages */
export const ERROR_MESSAGES = {
	NO_ACCOUNT_ID: "Failed to extract accountId from token",
	TOKEN_REFRESH_FAILED: "Failed to refresh token, authentication required",
	REQUEST_PARSE_ERROR: "Error parsing request",
} as const;

/** Log stages for request logging */
export const LOG_STAGES = {
	BEFORE_TRANSFORM: "before-transform",
	AFTER_TRANSFORM: "after-transform",
	RESPONSE: "response",
	ERROR_RESPONSE: "error-response",
} as const;

/** Platform-specific browser opener commands */
export const PLATFORM_OPENERS = {
	darwin: "open",
	win32: "start",
	linux: "xdg-open",
} as const;

/** OAuth authorization labels */
export const AUTH_LABELS = {
	MANAGE_ACCOUNTS: "Manage accounts (view / remove)",
	OAUTH: "ChatGPT Plus/Pro (browser)",
	OAUTH_MANUAL: "ChatGPT Plus/Pro (manual URL paste)",
	/** Headless device-code flow — no browser required */
	OAUTH_DEVICE: "ChatGPT Plus/Pro (headless / device code)",
	API_KEY: "Manually enter API Key",
	INSTRUCTIONS:
		"A browser window should open. If it doesn't, copy the URL and open it manually.",
	INSTRUCTIONS_MANUAL:
		"After logging in, copy the full redirect URL and paste it here.",
	INSTRUCTIONS_DEVICE:
		"Go to the URL shown and enter the code to authenticate without a browser.",
} as const;

/** OAuth callback server configuration */
export const OAUTH_SERVER = {
	/** Polling interval in milliseconds when waiting for OAuth callback */
	POLL_INTERVAL_MS: 100,
	/** Maximum number of polling iterations (600 × 100ms = 60 seconds) */
	MAX_POLL_ITERATIONS: 600,
	/** Port for local OAuth callback server */
	PORT: 1455,
} as const;

/** Device authorization flow configuration (headless auth) */
export const DEVICE_AUTH = {
	/** Endpoint to request a user code */
	USERCODE_URL: "https://auth.openai.com/api/accounts/deviceauth/usercode",
	/** Endpoint to poll for token after user completes device auth */
	TOKEN_URL: "https://auth.openai.com/api/accounts/deviceauth/token",
	/** URL the user visits to enter the code */
	ACTIVATE_URL: "https://auth.openai.com/codex/device",
	/** redirect_uri for device-flow token exchange */
	REDIRECT_URI: "https://auth.openai.com/deviceauth/callback",
	/** Extra milliseconds added to the server-supplied poll interval (safety margin) */
	POLL_SAFETY_MARGIN_MS: 3_000,
} as const;

/** Stream and output size limits */
export const SIZE_LIMITS = {
	/** Maximum SSE stream size in bytes before rejecting (50MB) */
	MAX_SSE_STREAM_BYTES: 50 * 1024 * 1024,
	/** Maximum tool output length in characters before truncation */
	MAX_TOOL_OUTPUT_LENGTH: 16_000,
} as const;

/** Regex pattern for detecting usage limit errors in API responses */
export const USAGE_LIMIT_PATTERN = /usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/i;

/** Cache TTL configuration */
export const CACHE_TTL = {
	/** GitHub cache time-to-live in minutes */
	MINUTES: 15,
	/** GitHub cache time-to-live in milliseconds (15 minutes) */
	MS: 15 * 60 * 1000,
} as const;

/**
 * Consecutive-failure tracking for per-account auth cooldown.
 * After MAX_FAILURES consecutive failures, the account is skipped for COOLDOWN_MS.
 * The failure counter resets if no failure occurred in the last FAILURE_RESET_MS.
 */
export const ACCOUNT_FAILURE = {
	MAX_FAILURES: 5,
	/** How long to skip a failing account (ms) */
	COOLDOWN_MS: 30_000,
	/** Window after which the consecutive-failure counter resets (ms) */
	FAILURE_RESET_MS: 7_200_000, // 2 hours
} as const;

/**
 * Tiered rate-limit cooldown durations keyed by ChatGPT error code.
 *
 * - usage_limit_reached   → billing quota exhausted → 4-hour cooldown
 * - usage_not_included    → plan doesn't include Codex → 24-hour cooldown
 * - rate_limit_exceeded   → RPM/TPM throttle → 60-second cooldown
 * - default               → honour retry-after header, or fall back to 60 s
 */
export const RATE_LIMIT_TIERS: Record<string, number> = {
	usage_limit_reached: 4 * 60 * 60 * 1000,   // 4 hours
	usage_not_included: 24 * 60 * 60 * 1000,    // 24 hours
	rate_limit_exceeded: 60_000,                 // 60 seconds
};

/**
 * Maximum time to wait for any account to recover from rate-limiting before
 * giving up and returning a 429 to the caller (#11 wait-for-recovery).
 */
export const MAX_RECOVERY_WAIT_MS = 5 * 60 * 1000; // 5 minutes
