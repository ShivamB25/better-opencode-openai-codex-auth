import type { InputItem } from "../../types.js";
import { SIZE_LIMITS } from "../../constants.js";

const OPENCODE_PROMPT_SIGNATURES = [
	"you are a coding agent running in the opencode",
	"you are opencode, an agent",
	"you are opencode, an interactive cli agent",
	"you are opencode, an interactive cli tool",
	"you are opencode, the best coding agent on the planet",
].map((signature) => signature.toLowerCase());

const OPENCODE_CONTEXT_MARKERS = [
	"here is some useful information about the environment you are running in:",
	"<env>",
	"instructions from:",
	"<instructions>",
].map((marker) => marker.toLowerCase());

export const getContentText = (item: InputItem): string => {
	if (typeof item.content === "string") {
		return item.content;
	}
	if (Array.isArray(item.content)) {
		return item.content
			.filter((c) => c.type === "input_text" && c.text)
			.map((c) => c.text)
			.join("\n");
	}
	return "";
};

const replaceContentText = (item: InputItem, contentText: string): InputItem => {
	if (typeof item.content === "string") {
		return { ...item, content: contentText };
	}
	if (Array.isArray(item.content)) {
		return {
			...item,
			content: [{ type: "input_text", text: contentText }],
		};
	}
	return { ...item, content: contentText };
};

const extractOpenCodeContext = (contentText: string): string | null => {
	const lower = contentText.toLowerCase();
	let earliestIndex = -1;

	for (const marker of OPENCODE_CONTEXT_MARKERS) {
		const index = lower.indexOf(marker);
		if (index >= 0 && (earliestIndex === -1 || index < earliestIndex)) {
			earliestIndex = index;
		}
	}

	if (earliestIndex === -1) return null;
	return contentText.slice(earliestIndex).trimStart();
};

export function isOpenCodeSystemPrompt(
	item: InputItem,
	cachedPrompt: string | null,
): boolean {
	const isSystemRole = item.role === "developer" || item.role === "system";
	if (!isSystemRole) return false;

	const contentText = getContentText(item);
	if (!contentText) return false;

	if (cachedPrompt) {
		const contentTrimmed = contentText.trim();
		const cachedTrimmed = cachedPrompt.trim();
		if (contentTrimmed === cachedTrimmed) {
			return true;
		}

		if (contentTrimmed.startsWith(cachedTrimmed)) {
			return true;
		}

		const contentPrefix = contentTrimmed.substring(0, 200);
		const cachedPrefix = cachedTrimmed.substring(0, 200);
		if (contentPrefix === cachedPrefix) {
			return true;
		}
	}

	const normalized = contentText.trimStart().toLowerCase();
	return OPENCODE_PROMPT_SIGNATURES.some((signature) =>
		normalized.startsWith(signature),
	);
}

export function filterOpenCodeSystemPromptsWithCachedPrompt(
	input: InputItem[] | undefined,
	cachedPrompt: string | null,
): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input.flatMap((item) => {
		if (item.role === "user") return [item];

		if (!isOpenCodeSystemPrompt(item, cachedPrompt)) {
			return [item];
		}

		const contentText = getContentText(item);
		const preservedContext = extractOpenCodeContext(contentText);
		if (preservedContext) {
			return [replaceContentText(item, preservedContext)];
		}

		return [];
	});
}

const getCallId = (item: InputItem): string | null => {
	if ("call_id" in item && typeof item.call_id === "string") {
		const trimmed = item.call_id.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return null;
};

const convertOrphanedOutputToMessage = (
	item: InputItem,
	callId: string | null,
): InputItem => {
	const toolName =
		"name" in item && typeof item.name === "string"
			? item.name
			: "tool";
	const labelCallId = callId ?? "unknown";
	let text: string;
	try {
		const out = "output" in item ? item.output : undefined;
		text = typeof out === "string" ? out : JSON.stringify(out);
	} catch {
		const out = "output" in item ? item.output : "";
		text = String(out ?? "");
	}
	if (text.length > SIZE_LIMITS.MAX_TOOL_OUTPUT_LENGTH) {
		text = text.slice(0, SIZE_LIMITS.MAX_TOOL_OUTPUT_LENGTH) + "\n...[truncated]";
	}
	return {
		type: "message",
		role: "assistant",
		content: `[Previous ${toolName} result; call_id=${labelCallId}]: ${text}`,
	} as InputItem;
};

const collectCallIds = (input: InputItem[]) => {
	const functionCallIds = new Set<string>();
	const localShellCallIds = new Set<string>();
	const customToolCallIds = new Set<string>();

	for (const item of input) {
		const callId = getCallId(item);
		if (!callId) continue;
		switch (item.type) {
			case "function_call":
				functionCallIds.add(callId);
				break;
			case "local_shell_call":
				localShellCallIds.add(callId);
				break;
			case "custom_tool_call":
				customToolCallIds.add(callId);
				break;
			default:
				break;
		}
	}

	return { functionCallIds, localShellCallIds, customToolCallIds };
};

export const normalizeOrphanedToolOutputs = (
	input: InputItem[],
): InputItem[] => {
	const { functionCallIds, localShellCallIds, customToolCallIds } =
		collectCallIds(input);

	return input.map((item) => {
		if (item.type === "function_call_output") {
			const callId = getCallId(item);
			const hasMatch =
				!!callId &&
				(functionCallIds.has(callId) || localShellCallIds.has(callId));
			if (!hasMatch) {
				return convertOrphanedOutputToMessage(item, callId);
			}
		}

		if (item.type === "custom_tool_call_output") {
			const callId = getCallId(item);
			const hasMatch = !!callId && customToolCallIds.has(callId);
			if (!hasMatch) {
				return convertOrphanedOutputToMessage(item, callId);
			}
		}

		if (item.type === "local_shell_call_output") {
			const callId = getCallId(item);
			const hasMatch = !!callId && localShellCallIds.has(callId);
			if (!hasMatch) {
				return convertOrphanedOutputToMessage(item, callId);
			}
		}

		return item;
	});
};
