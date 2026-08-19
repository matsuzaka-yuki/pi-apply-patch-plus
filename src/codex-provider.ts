import {
	calculateCost,
	createAssistantMessageEventStream,
	getEnvApiKey,
	parseStreamingJson,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type Tool,
	type ToolCall,
} from "@mariozechner/pi-ai";
import { APPLY_PATCH_GRAMMAR } from "./apply-patch.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

interface CustomToolFormat {
	type: "grammar";
	syntax: "lark";
	definition: string;
}

interface CustomToolDefinition {
	type: "custom";
	name: string;
	description: string;
	format: CustomToolFormat;
}

interface FunctionToolDefinition {
	type: "function";
	name: string;
	description: string;
	parameters: unknown;
	strict: boolean | null;
}

export type CodexToolDefinition = CustomToolDefinition | FunctionToolDefinition;

interface ResponseUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: {
		cached_tokens?: number;
	};
}

interface ResponseCompletedEvent {
	type: "response.completed";
	response?: {
		status?: string;
		usage?: ResponseUsage;
	};
}

interface OutputItemDoneEvent {
	type: "response.output_item.done";
	item: Record<string, unknown>;
}

export function supportsCustomApplyPatchModel(modelId: string): boolean {
	return /^gpt-5\.(2|3)-codex/.test(modelId);
}

/**
 * Smart GPT detection: any GPT-family model id (gpt-*, case-insensitive)
 * gets the local apply_patch tool — e.g. gpt-5.6-sol, gpt-5.6-luna,
 * gpt-5.6-terra, and future gpt-* models — without a hardcoded list.
 * Codex models additionally get the CFG/freeform transport via
 * {@link supportsCustomApplyPatchModel}.
 */
export function supportsApplyPatchModel(modelId: string): boolean {
	return /^gpt-/i.test(modelId);
}

function isCustomApplyPatchToolCallId(id: string): boolean {
	const parts = id.split("|");
	return parts.length > 1 && parts[1]!.startsWith("ct_");
}

function shortHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i += 1) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

function makeFunctionToolCallId(callId: string, itemId?: string): string {
	const id = itemId && itemId.length > 0 ? itemId : `fc_${shortHash(callId)}`;
	return `${callId}|${id}`;
}

function makeCustomToolCallId(callId: string, itemId?: string): string {
	const id = itemId && itemId.length > 0 ? itemId : `ct_${shortHash(callId)}`;
	return `${callId}|ct_${id.replace(/^ct_/, "")}`;
}

function splitToolCallId(toolCallId: string): { callId: string; itemId?: string; custom: boolean } {
	const [callId, itemId] = toolCallId.split("|");
	return {
		callId: callId || toolCallId,
		itemId,
		custom: isCustomApplyPatchToolCallId(toolCallId),
	};
}

export function convertCodexTools(tools: Tool[], useCustomApplyPatch: boolean): CodexToolDefinition[] {
	return tools.map((tool) => {
		if (useCustomApplyPatch && tool.name === "apply_patch") {
			return {
				type: "custom",
				name: "apply_patch",
				description:
					"Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
				format: {
					type: "grammar",
					syntax: "lark",
					definition: APPLY_PATCH_GRAMMAR,
				},
			} satisfies CustomToolDefinition;
		}

		return {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: null,
		} satisfies FunctionToolDefinition;
	});
}

function clampReasoningEffort(modelId: string, effort: string): string {
	if (/^gpt-5\.(2|3)-/.test(modelId) && effort === "minimal") return "low";
	if (modelId === "gpt-5.1" && effort === "xhigh") return "high";
	return effort;
}

function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2) throw new Error("Invalid API token format");
	const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const payload = Buffer.from(padded, "base64").toString("utf8");
	return JSON.parse(payload) as Record<string, unknown>;
}

function extractChatgptAccountId(token: string): string {
	const payload = decodeJwtPayload(token);
	const authClaim = payload[OPENAI_AUTH_CLAIM] as { chatgpt_account_id?: string } | undefined;
	const accountId = authClaim?.chatgpt_account_id;
	if (!accountId) throw new Error("Unable to extract chatgpt_account_id from token");
	return accountId;
}

function buildHeaders(model: Model<any>, token: string, options?: SimpleStreamOptions): Headers {
	const headers = new Headers(model.headers ?? {});
	const accountId = extractChatgptAccountId(token);

	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("originator", "pi-codex-apply-patch-extension");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	for (const [key, value] of Object.entries(options?.headers ?? {})) {
		headers.set(key, value);
	}
	if (options?.sessionId) {
		headers.set("session_id", options.sessionId);
	}

	return headers;
}

export function convertContextToInput(model: Model<any>, context: Context): unknown[] {
	const input: unknown[] = [];
	let assistantTextIndex = 0;
	const pendingToolCalls = new Map<string, { custom: boolean; name: string }>();

	const flushPendingToolCalls = (reason: string) => {
		for (const [callId, pending] of pendingToolCalls) {
			const output = `(cancelled: ${pending.name} did not produce output because the previous turn was interrupted) ${reason}`;
			if (pending.custom) {
				input.push({
					type: "custom_tool_call_output",
					call_id: callId,
					output,
				});
			} else {
				input.push({
					type: "function_call_output",
					call_id: callId,
					output,
				});
			}
		}
		pendingToolCalls.clear();
	};

	for (const message of context.messages) {
		if (message.role === "user") {
			if (pendingToolCalls.size > 0) {
				flushPendingToolCalls("Recovered orphaned tool calls before continuing.");
			}

			if (typeof message.content === "string") {
				input.push({
					role: "user",
					content: [{ type: "input_text", text: message.content }],
				});
				continue;
			}

			const parts: Array<Record<string, unknown>> = [];
			for (const block of message.content) {
				if (block.type === "text") {
					parts.push({ type: "input_text", text: block.text });
				} else if (block.type === "image" && model.input.includes("image")) {
					parts.push({
						type: "input_image",
						detail: "auto",
						image_url: `data:${block.mimeType};base64,${block.data}`,
					});
				}
			}
			if (parts.length > 0) {
				input.push({ role: "user", content: parts });
			}
			continue;
		}

		if (message.role === "assistant") {
			if (pendingToolCalls.size > 0) {
				flushPendingToolCalls("Recovered orphaned tool calls before appending assistant output.");
			}

			for (const block of message.content) {
				if (block.type === "thinking" && block.thinkingSignature) {
					try {
						input.push(JSON.parse(block.thinkingSignature));
					} catch {
						// ignore invalid thinking signature
					}
					continue;
				}

				if (block.type === "text") {
					input.push({
						type: "message",
						role: "assistant",
						status: "completed",
						id: block.textSignature || `msg_${assistantTextIndex}`,
						content: [{ type: "output_text", text: block.text, annotations: [] }],
					});
					assistantTextIndex += 1;
					continue;
				}

				if (block.type === "toolCall") {
					const { callId, itemId, custom } = splitToolCallId(block.id);
					if (custom) {
						const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input : "";
						input.push({
							type: "custom_tool_call",
							call_id: callId,
							name: block.name,
							input: rawInput,
						});
					} else {
						input.push({
							type: "function_call",
							id: itemId,
							call_id: callId,
							name: block.name,
							arguments: JSON.stringify(block.arguments ?? {}),
						});
					}

					if (callId) {
						pendingToolCalls.set(callId, { custom, name: block.name });
					}
				}
			}
			continue;
		}

		if (message.role === "toolResult") {
			const { callId, custom } = splitToolCallId(message.toolCallId);
			const textResult = message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const hasImages = message.content.some((block) => block.type === "image");
			const output = textResult.length > 0 ? textResult : hasImages ? "(see attached image)" : "";

			if (custom) {
				input.push({
					type: "custom_tool_call_output",
					call_id: callId,
					output,
				});
			} else {
				input.push({
					type: "function_call_output",
					call_id: callId,
					output,
				});
			}

			pendingToolCalls.delete(callId);
		}
	}

	if (pendingToolCalls.size > 0) {
		flushPendingToolCalls("Recovered orphaned tool calls at end of context.");
	}

	return input;
}

async function* parseSseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		if (signal?.aborted) {
			throw new Error("Request was aborted");
		}

		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let chunkEnd = buffer.indexOf("\n\n");
		while (chunkEnd !== -1) {
			const chunk = buffer.slice(0, chunkEnd);
			buffer = buffer.slice(chunkEnd + 2);

			const data = chunk
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("\n")
				.trim();

			if (data.length > 0 && data !== "[DONE]") {
				try {
					yield JSON.parse(data) as Record<string, unknown>;
				} catch {
					// ignore parse errors from malformed SSE chunks
				}
			}

			chunkEnd = buffer.indexOf("\n\n");
		}
	}
}

function mapStopReason(status: string | undefined): StopReason {
	switch (status) {
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		default:
			return "stop";
	}
}

function getEventType(event: Record<string, unknown>): string | undefined {
	const type = event.type;
	return typeof type === "string" ? type : undefined;
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function normalizeCodexEvent(event: Record<string, unknown>): Record<string, unknown> {
	const type = getEventType(event);
	if (type === "response.done") {
		const response = (event.response ?? {}) as Record<string, unknown>;
		return {
			type: "response.completed",
			response: {
				...response,
				status: typeof response.status === "string" ? response.status : undefined,
			},
		};
	}
	return event;
}

function parseResponseUsage(event: ResponseCompletedEvent): ResponseUsage | undefined {
	return event.response?.usage;
}

export function streamSimpleCodexWithCustomApplyPatch(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses",
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let currentTextIndex: number | null = null;
		let currentThinkingIndex: number | null = null;
		let currentToolIndex: number | null = null;
		let currentToolKind: "function" | "custom" | null = null;
		let currentToolArgs = "";

		try {
			if (model.api !== "openai-codex-responses") {
				throw new Error(
					`streamSimpleCodexWithCustomApplyPatch only supports openai-codex-responses, got: ${model.api}`,
				);
			}

			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const useCustomApplyPatch = supportsCustomApplyPatchModel(model.id);
			const tools = context.tools ? convertCodexTools(context.tools, useCustomApplyPatch) : undefined;
			const input = convertContextToInput(model, context);

			const body: Record<string, unknown> = {
				model: model.id,
				store: false,
				stream: true,
				instructions: context.systemPrompt,
				input,
				tool_choice: "auto",
				parallel_tool_calls: true,
				text: { verbosity: "medium" },
				include: ["reasoning.encrypted_content"],
				prompt_cache_key: options?.sessionId,
			};

			if (tools && tools.length > 0) {
				body.tools = tools;
			}

			if (options?.reasoning) {
				body.reasoning = {
					effort: clampReasoningEffort(model.id, options.reasoning),
					summary: "auto",
				};
			}

			if (typeof options?.temperature === "number") {
				body.temperature = options.temperature;
			}

			options?.onPayload?.(body);

			const response = await fetch(resolveCodexUrl(model.baseUrl), {
				method: "POST",
				headers: buildHeaders(model, apiKey, options),
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Codex request failed (${response.status}): ${text || response.statusText}`);
			}

			if (!response.body) {
				throw new Error("Codex response had no body");
			}

			stream.push({ type: "start", partial: output });

			for await (const rawEvent of parseSseEvents(response, options?.signal)) {
				const event = normalizeCodexEvent(rawEvent);
				const type = getEventType(event);
				if (!type) continue;

				if (type === "error") {
					throw new Error(asString(event.message, "Codex stream error"));
				}

				if (type === "response.failed") {
					const errorMessage =
						((event.response as { error?: { message?: string } } | undefined)?.error?.message ??
							"Codex response failed");
					throw new Error(errorMessage);
				}

				if (type === "response.output_item.added") {
					const item = (event.item ?? {}) as Record<string, unknown>;
					const itemType = asString(item.type);
					if (itemType === "message") {
						output.content.push({ type: "text", text: "" });
						currentTextIndex = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex: currentTextIndex, partial: output });
					} else if (itemType === "reasoning") {
						output.content.push({ type: "thinking", thinking: "" });
						currentThinkingIndex = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: currentThinkingIndex, partial: output });
					} else if (itemType === "function_call") {
						const callId = asString(item.call_id);
						const itemId = asString(item.id);
						const name = asString(item.name);
						const toolCallId = makeFunctionToolCallId(callId, itemId);
						const argsString = asString(item.arguments, "{}");
						const args = parseStreamingJson(argsString);
						output.content.push({ type: "toolCall", id: toolCallId, name, arguments: args });
						currentToolIndex = output.content.length - 1;
						currentToolKind = "function";
						currentToolArgs = argsString;
						stream.push({ type: "toolcall_start", contentIndex: currentToolIndex, partial: output });
					} else if (itemType === "custom_tool_call") {
						const callId = asString(item.call_id);
						const itemId = asString(item.id);
						const name = asString(item.name);
						const rawInput = asString(item.input);
						const toolCallId = makeCustomToolCallId(callId, itemId);
						output.content.push({
							type: "toolCall",
							id: toolCallId,
							name,
							arguments: { input: rawInput },
						});
						currentToolIndex = output.content.length - 1;
						currentToolKind = "custom";
						currentToolArgs = rawInput;
						stream.push({ type: "toolcall_start", contentIndex: currentToolIndex, partial: output });
					}
					continue;
				}

				if (type === "response.output_text.delta" || type === "response.refusal.delta") {
					if (currentTextIndex === null || output.content[currentTextIndex]?.type !== "text") {
						output.content.push({ type: "text", text: "" });
						currentTextIndex = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex: currentTextIndex, partial: output });
					}
					const delta = asString(event.delta);
					const block = output.content[currentTextIndex]!;
					if (block.type === "text") {
						block.text += delta;
						stream.push({ type: "text_delta", contentIndex: currentTextIndex, delta, partial: output });
					}
					continue;
				}

				if (type === "response.reasoning_summary_text.delta") {
					if (currentThinkingIndex === null || output.content[currentThinkingIndex]?.type !== "thinking") {
						output.content.push({ type: "thinking", thinking: "" });
						currentThinkingIndex = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: currentThinkingIndex, partial: output });
					}
					const delta = asString(event.delta);
					const block = output.content[currentThinkingIndex]!;
					if (block.type === "thinking") {
						block.thinking += delta;
						stream.push({ type: "thinking_delta", contentIndex: currentThinkingIndex, delta, partial: output });
					}
					continue;
				}

				if (type === "response.function_call_arguments.delta") {
					if (
						currentToolIndex !== null &&
						currentToolKind === "function" &&
						output.content[currentToolIndex]?.type === "toolCall"
					) {
						const delta = asString(event.delta);
						currentToolArgs += delta;
						const block = output.content[currentToolIndex]!;
						if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(currentToolArgs);
							stream.push({ type: "toolcall_delta", contentIndex: currentToolIndex, delta, partial: output });
						}
					}
					continue;
				}

				if (type === "response.function_call_arguments.done") {
					if (
						currentToolIndex !== null &&
						currentToolKind === "function" &&
						output.content[currentToolIndex]?.type === "toolCall"
					) {
						const doneArgs = asString(event.arguments, currentToolArgs || "{}");
						currentToolArgs = doneArgs;
						const block = output.content[currentToolIndex]!;
						if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(doneArgs);
						}
					}
					continue;
				}

				if (type === "response.custom_tool_call_input.delta") {
					if (
						currentToolIndex !== null &&
						currentToolKind === "custom" &&
						output.content[currentToolIndex]?.type === "toolCall"
					) {
						const delta = asString(event.delta);
						currentToolArgs += delta;
						const block = output.content[currentToolIndex]!;
						if (block.type === "toolCall") {
							block.arguments = { input: currentToolArgs };
							stream.push({ type: "toolcall_delta", contentIndex: currentToolIndex, delta, partial: output });
						}
					}
					continue;
				}

				if (type === "response.custom_tool_call_input.done") {
					if (
						currentToolIndex !== null &&
						currentToolKind === "custom" &&
						output.content[currentToolIndex]?.type === "toolCall"
					) {
						const doneInput = asString(event.input, currentToolArgs);
						currentToolArgs = doneInput;
						const block = output.content[currentToolIndex]!;
						if (block.type === "toolCall") {
							block.arguments = { input: doneInput };
						}
					}
					continue;
				}

				if (type === "response.output_item.done") {
					const doneEvent = event as unknown as OutputItemDoneEvent;
					const item = doneEvent.item;
					const itemType = asString(item.type);

					if (itemType === "message") {
						if (currentTextIndex === null || output.content[currentTextIndex]?.type !== "text") {
							output.content.push({ type: "text", text: "" });
							currentTextIndex = output.content.length - 1;
							stream.push({ type: "text_start", contentIndex: currentTextIndex, partial: output });
						}
						const text = Array.isArray(item.content)
							? (item.content as Array<{ type?: string; text?: string; refusal?: string }>)
									.map((part) => part.text ?? part.refusal ?? "")
									.join("")
							: asString(item.text, "");
						const block = output.content[currentTextIndex]!;
						if (block.type === "text") {
							block.text = text;
							block.textSignature = asString(item.id, block.textSignature);
							stream.push({
								type: "text_end",
								contentIndex: currentTextIndex,
								content: text,
								partial: output,
							});
						}
						currentTextIndex = null;
						continue;
					}

					if (itemType === "reasoning") {
						if (currentThinkingIndex === null || output.content[currentThinkingIndex]?.type !== "thinking") {
							output.content.push({ type: "thinking", thinking: "" });
							currentThinkingIndex = output.content.length - 1;
							stream.push({ type: "thinking_start", contentIndex: currentThinkingIndex, partial: output });
						}
						const summaryText = Array.isArray(item.summary)
							? (item.summary as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n\n")
							: asString(item.text, "");
						const block = output.content[currentThinkingIndex]!;
						if (block.type === "thinking") {
							block.thinking = summaryText;
							try {
								block.thinkingSignature = JSON.stringify(item);
							} catch {
								// ignore JSON stringify failure
							}
							stream.push({
								type: "thinking_end",
								contentIndex: currentThinkingIndex,
								content: summaryText,
								partial: output,
							});
						}
						currentThinkingIndex = null;
						continue;
					}

					if (itemType === "function_call") {
						const callId = asString(item.call_id);
						const itemId = asString(item.id);
						const name = asString(item.name);
						const argumentsString = asString(item.arguments, currentToolArgs || "{}");
						const argumentsObject = parseStreamingJson(argumentsString);

						if (currentToolIndex === null || output.content[currentToolIndex]?.type !== "toolCall") {
							const toolCallId = makeFunctionToolCallId(callId, itemId);
							output.content.push({ type: "toolCall", id: toolCallId, name, arguments: argumentsObject });
							currentToolIndex = output.content.length - 1;
							stream.push({ type: "toolcall_start", contentIndex: currentToolIndex, partial: output });
						}

						const block = output.content[currentToolIndex]!;
						if (block.type === "toolCall") {
							const toolCall: ToolCall = {
								type: "toolCall",
								id: makeFunctionToolCallId(callId, itemId),
								name,
								arguments: argumentsObject,
							};
							block.id = toolCall.id;
							block.name = toolCall.name;
							block.arguments = toolCall.arguments;
							stream.push({ type: "toolcall_end", contentIndex: currentToolIndex, toolCall, partial: output });
						}
						currentToolIndex = null;
						currentToolKind = null;
						currentToolArgs = "";
						continue;
					}

					if (itemType === "custom_tool_call") {
						const callId = asString(item.call_id);
						const itemId = asString(item.id);
						const name = asString(item.name);
						const rawInput = asString(item.input, currentToolArgs);

						if (currentToolIndex === null || output.content[currentToolIndex]?.type !== "toolCall") {
							const toolCallId = makeCustomToolCallId(callId, itemId);
							output.content.push({ type: "toolCall", id: toolCallId, name, arguments: { input: rawInput } });
							currentToolIndex = output.content.length - 1;
							stream.push({ type: "toolcall_start", contentIndex: currentToolIndex, partial: output });
						}

						const block = output.content[currentToolIndex]!;
						if (block.type === "toolCall") {
							const toolCall: ToolCall = {
								type: "toolCall",
								id: makeCustomToolCallId(callId, itemId),
								name,
								arguments: { input: rawInput },
							};
							block.id = toolCall.id;
							block.name = toolCall.name;
							block.arguments = toolCall.arguments;
							stream.push({ type: "toolcall_end", contentIndex: currentToolIndex, toolCall, partial: output });
						}
						currentToolIndex = null;
						currentToolKind = null;
						currentToolArgs = "";
					}
					continue;
				}

				if (type === "response.completed") {
					const completed = event as unknown as ResponseCompletedEvent;
					const usage = parseResponseUsage(completed);
					const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
					output.usage = {
						input: (usage?.input_tokens ?? 0) - cached,
						output: usage?.output_tokens ?? 0,
						cacheRead: cached,
						cacheWrite: 0,
						totalTokens:
							typeof usage?.total_tokens === "number"
								? usage.total_tokens
								: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					calculateCost(model, output.usage);
					output.stopReason = mapStopReason(completed.response?.status);
				}
			}

			if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
