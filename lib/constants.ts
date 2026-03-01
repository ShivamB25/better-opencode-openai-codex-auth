/**
 * Constants used throughout the plugin
 * Centralized for easy maintenance and configuration
 */

/** Plugin identifier for logging and error messages */
export const PLUGIN_NAME = "openai-codex-plugin";

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
	ORIGINATOR_CODEX: "codex_cli_rs",
} as const;

/** URL path segments */
export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
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
	OAUTH: "ChatGPT Plus/Pro (Codex Subscription)",
	OAUTH_MANUAL: "ChatGPT Plus/Pro (Manual URL Paste)",
	API_KEY: "Manually enter API Key",
	INSTRUCTIONS:
		"A browser window should open. If it doesn't, copy the URL and open it manually.",
	INSTRUCTIONS_MANUAL:
		"After logging in, copy the full redirect URL and paste it here.",
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
