import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PluginConfig } from "./types.js";

const CONFIG_PATH = join(homedir(), ".opencode", "openai-codex-auth-config.json");

/**
 * Default plugin configuration
 * CODEX_MODE is enabled by default for better Codex CLI parity
 */
const DEFAULT_CONFIG: PluginConfig = {
	codexMode: true,
	accountSelectionStrategy: "round-robin",
	rateLimitCooldownMs: 60_000,
};

/**
 * Load plugin configuration from ~/.opencode/openai-codex-auth-config.json
 * Falls back to defaults if file doesn't exist or is invalid
 *
 * @returns Plugin configuration
 */
export function loadPluginConfig(): PluginConfig {
	if (!existsSync(CONFIG_PATH)) {
		return DEFAULT_CONFIG;
	}

	try {
		const fileContent = readFileSync(CONFIG_PATH, "utf-8");
		const userConfig = JSON.parse(fileContent) as Partial<PluginConfig>;

		// Merge with defaults
		return {
			...DEFAULT_CONFIG,
			...userConfig,
		};
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		if (err.message.includes("EACCES") || err.message.includes("EPERM")) {
			console.error(
				`[openai-codex-plugin] Permission denied reading config from ${CONFIG_PATH}:`,
				err.message,
			);
		} else if (err instanceof SyntaxError) {
			console.warn(
				`[openai-codex-plugin] Invalid JSON in config file ${CONFIG_PATH}:`,
				err.message,
			);
		} else {
			console.warn(
				`[openai-codex-plugin] Failed to load config from ${CONFIG_PATH}:`,
				err.message,
			);
		}
		return DEFAULT_CONFIG;
	}
}

/**
 * Get the effective CODEX_MODE setting
 * Priority: environment variable > config file > default (true)
 *
 * @param pluginConfig - Plugin configuration from file
 * @returns True if CODEX_MODE should be enabled
 */
export function getCodexMode(pluginConfig: PluginConfig): boolean {
	// Environment variable takes precedence
	if (process.env.CODEX_MODE !== undefined) {
		return process.env.CODEX_MODE === "1";
	}

	// Use config setting (defaults to true)
	return pluginConfig.codexMode ?? true;
}
