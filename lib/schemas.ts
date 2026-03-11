/**
 * Zod schemas for runtime validation
 * Replaces unsafe JSON.parse type assertions with validated parsing
 */
import { z } from "zod";

/**
 * Plugin configuration schema
 * Validates ~/.opencode/openai-codex-auth-config.json
 */
export const PluginConfigSchema = z.object({
	codexMode: z.boolean().optional(),
	accountSelectionStrategy: z.enum(["sticky", "round-robin"]).optional(),
	rateLimitCooldownMs: z.number().optional(),
});

export type ValidatedPluginConfig = z.infer<typeof PluginConfigSchema>;

/**
 * Account pool entry schema
 */
export const AccountPoolEntrySchema = z.object({
	accountId: z.string(),
	refresh: z.string(),
	access: z.string(),
	expires: z.number(),
	email: z.string().optional(),
	lastUsed: z.number().optional(),
	rateLimitedUntil: z.number().optional(),
});

export type ValidatedAccountPoolEntry = z.infer<typeof AccountPoolEntrySchema>;

/**
 * Account pool storage schema
 * Validates ~/.opencode/openai-codex-accounts.json
 */
export const AccountPoolStorageSchema = z.object({
	version: z.literal(1),
	activeIndex: z.number(),
	accounts: z.array(AccountPoolEntrySchema),
});

export type ValidatedAccountPoolStorage = z.infer<typeof AccountPoolStorageSchema>;

/**
 * Cache metadata schema
 * Validates cache metadata files
 */
export const CacheMetadataSchema = z.object({
	etag: z.string().nullable(),
	tag: z.string(),
	lastChecked: z.number(),
	url: z.string(),
});

export type ValidatedCacheMetadata = z.infer<typeof CacheMetadataSchema>;

/**
 * OpenCode cache metadata schema (extended)
 */
export const OpenCodeCacheMetaSchema = z.object({
	etag: z.string(),
	lastFetch: z.string().optional(),
	lastChecked: z.number(),
});

export type ValidatedOpenCodeCacheMeta = z.infer<typeof OpenCodeCacheMetaSchema>;

/**
 * Safe JSON parse with Zod validation
 * @param jsonString - JSON string to parse
 * @param schema - Zod schema to validate against
 * @param fallback - Fallback value if parsing/validation fails
 * @returns Parsed and validated data, or fallback
 */
export function safeParseJson<T>(
	jsonString: string,
	schema: z.ZodSchema<T>,
	fallback: T,
): T {
	try {
		const parsed = JSON.parse(jsonString);
		const result = schema.safeParse(parsed);
		if (result.success) {
			return result.data;
		}
		return fallback;
	} catch {
		return fallback;
	}
}

/**
 * Safe JSON parse with Zod validation (null on failure)
 * @param jsonString - JSON string to parse
 * @param schema - Zod schema to validate against
 * @returns Parsed and validated data, or null
 */
export function safeParseJsonOrNull<T>(
	jsonString: string,
	schema: z.ZodSchema<T>,
): T | null {
	try {
		const parsed = JSON.parse(jsonString);
		const result = schema.safeParse(parsed);
		if (result.success) {
			return result.data;
		}
		return null;
	} catch {
		return null;
	}
}
