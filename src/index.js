// dsh-plugin-subhub: use an OpenAI subscription account (ChatGPT OAuth) as an
// LLM provider in the DeepSeek Harness.
//
// The adapter follows the same shape as the official llm-deepseek adapter:
// it registers the `dsh-plugin-subhub-openai` provider route on ctx.llm,
// resolves credentials per request, and translates the Responses-API SSE
// stream into harness StreamChunks. Authentication is OAuth-token based:
// tokens are read from the plugin's own credential file
// (`~/.dsh-plugin-subhub/openai-auth.json` by default, written by the bundled
// login flow) and refreshed through auth.openai.com before they expire.
// Credentials of other programs (e.g. the official Codex CLI's auth file)
// are never read.
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, CallId, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { authFilePayload, exchangeAuthorizationCode, pollAuthorizationOnce, requestUserCode } from "./device-flow.js";
import { registerAnthropic } from "./providers/anthropic.js";
import { registerGithub } from "./providers/github.js";
import { registerGoogle } from "./providers/google.js";
import { registerKimi } from "./providers/kimi.js";
import { registerXai } from "./providers/xai.js";
/**
 * Reasoning-effort vocabulary the OpenAI backend advertises per model through
 * `supported_reasoning_levels`. The adapter does NOT hardcode the selection:
 * the picker shows exactly what the model's catalog entry offers, and the
 * wire value is the effort id itself. Fallback names are display-only.
 */
const WIRE_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const EFFORT_DISPLAY_NAMES = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "X-High",
	max: "Max",
	ultra: "Ultra"
};
//#region serialize: harness messages -> Responses API input
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Sniff the raster format from magic bytes, or undefined when unknown. */
function detectImageMediaType(data) {
	if (data.length >= 8 && data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return "image/png";
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (data.length >= 12 && data[0] === 82 && data[1] === 73 && data[2] === 70 && data[3] === 70 && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return "image/webp";
	if (data.length >= 6 && data.toString("ascii", 0, 6) === "GIF87a" || data.length >= 6 && data.toString("ascii", 0, 6) === "GIF89a") return "image/gif";
	return void 0;
}
/** Coerce a provider-declared media type into the attachment-store vocabulary. */
function normalizeImageMediaType(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const lower = value.toLowerCase();
	if (lower === "image/png" || lower === "image/jpeg" || lower === "image/webp" || lower === "image/gif") return lower;
	if (lower.includes("png")) return "image/png";
	if (lower.includes("jpeg") || lower.includes("jpg")) return "image/jpeg";
	if (lower.includes("webp")) return "image/webp";
	if (lower.includes("gif")) return "image/gif";
	return void 0;
}
/**
 * Pull inline base64 image bytes out of a backend image payload. The
 * Responses API image_generation output arrives in provider-shaped objects
 * (`b64_json`, a base64 `bytes` string, or a data URL); the exact field set
 * has changed across backend revisions, so every known carrier is tried.
 * Returns undefined when the payload carries only a file reference.
 */
function extractGeneratedImage(payload, fallbackMediaType) {
	if (payload === void 0 || payload === null || typeof payload !== "object") return void 0;
	let b64;
	if (typeof payload.b64_json === "string") b64 = payload.b64_json;
	else if (typeof payload.base64 === "string") b64 = payload.base64;
	else if (typeof payload.b64 === "string") b64 = payload.b64;
	else if (typeof payload.bytes === "string" && payload.bytes.length > 0) b64 = payload.bytes;
	else if (typeof payload.data === "string" && payload.data.startsWith("data:")) {
		const comma = payload.data.indexOf(",");
		if (comma > 0) b64 = payload.data.slice(comma + 1);
	} else if (typeof payload.image_url === "string" && payload.image_url.startsWith("data:")) {
		const comma = payload.image_url.indexOf(",");
		if (comma > 0) b64 = payload.image_url.slice(comma + 1);
	}
	if (b64 === void 0 || b64 === "") return void 0;
	let data;
	try {
		data = Buffer.from(b64, "base64");
	} catch {
		return void 0;
	}
	if (data.length === 0) return void 0;
	const mediaType = detectImageMediaType(data) ?? normalizeImageMediaType(payload.mime_type ?? payload.mediaType ?? payload.media_type ?? fallbackMediaType);
	if (mediaType === void 0) return void 0;
	return {
		data,
		mediaType,
		...typeof payload.filename === "string" && payload.filename.length > 0 ? { name: payload.filename } : {}
	};
}
/** Encode one stored attachment as a data URL for the wire. */
function imageDataUrl(ref, data) {
	return `data:${ref.mediaType};base64,${Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64")}`;
}
/**
 * Resolve user-content blocks into Responses API content parts. Text becomes
 * `input_text`; image attachments are read through the harness attachment
 * store and become `input_image` parts with an inline data URL (the OpenAI
 * backend accepts a string URL there, not the chat-completions object form).
 */
async function imageContentParts(blocks, attachments, signal) {
	const parts = [];
	for (const block of blocks) {
		if (block.type === "text") parts.push({ type: "input_text", text: block.text });
		else if (block.type === "image") {
			if (attachments === void 0) throw new LlmError("Image input requires the harness attachment store, which is not available in this profile.", "UNSUPPORTED_CONTENT");
			const { ref, data } = await attachments.readImage(block.attachment, signal);
			parts.push({ type: "input_image", image_url: imageDataUrl(ref, data) });
		}
	}
	return parts;
}
/** Human-readable placeholder for a tool-result image that cannot ride the wire. */
function imagePlaceholderText(attachment) {
	const att = attachment ?? {};
	const mediaType = typeof att.mediaType === "string" && att.mediaType.length > 0 ? att.mediaType : "image";
	const dims = Number.isInteger(att.width) && Number.isInteger(att.height) ? ` ${att.width}x${att.height}` : "";
	const bytes = Number.isInteger(att.bytes) && att.bytes > 0 ? ` ${att.bytes} bytes` : "";
	return `[image omitted: ${mediaType}${dims}${bytes}]`;
}
/**
 * Encode one tool result into Responses API `function_call_output` output
 * parts. Text becomes `input_text`; image blocks are read through the
 * harness attachment store and become `input_image` parts with an inline
 * data URL, so the model can actually see what a tool like `read_image`
 * returned. When `degradeImages` is set — or the attachment store is
 * missing / the read fails — each image degrades to a text placeholder
 * instead of throwing: a tool-result image must never brick the
 * conversation.
 */
async function toolResultContentParts(blocks, attachments, signal, degradeImages) {
	const parts = [];
	for (const block of blocks) {
		if (block.type === "text") parts.push({ type: "input_text", text: block.text });
		else if (block.type === "image") {
			if (degradeImages) {
				parts.push({ type: "input_text", text: imagePlaceholderText(block.attachment) });
				continue;
			}
			try {
				if (attachments === void 0) throw new Error("attachment store unavailable");
				const { ref, data } = await attachments.readImage(block.attachment, signal);
				parts.push({ type: "input_image", image_url: imageDataUrl(ref, data) });
			} catch {
				parts.push({ type: "input_text", text: imagePlaceholderText(block.attachment) });
			}
		}
	}
	return parts;
}
/** Validate the adapter-owned reasoning effort before putting it on the wire. */
function reasoningEffort(effort) {
	if (WIRE_EFFORT_VALUES.has(effort)) return effort;
	throw new LlmError(`OpenAI models do not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
/**
 * Map a harness-facing effort id to the Responses API wire value. The model
 * catalog advertises "ultra" as a capability level, but the wire endpoint
 * rejects it (valid: none/minimal/low/medium/high/xhigh/max) — the official
 * official Codex CLI maps Ultra to Max on the wire, and this adapter does the same.
 */
function wireReasoningEffort(effort) {
	const valid = reasoningEffort(effort);
	return valid === "ultra" ? "max" : valid;
}
/**
 * Serialize the conversation into Responses API input items. Assistant text
 * becomes a message item and every assistant tool call becomes its own flat
 * `function_call` item (the OpenAI backend rejects the public API's embedded
 * `tool_calls` array); every tool result becomes a `function_call_output`
 * item correlated by `call_id`. User images become `input_image` content
 * parts whose bytes are read from the harness attachment store; tool-result
 * images ride inside the `function_call_output` output parts the same way
 * (results without images keep the plain-string form, so untouched requests
 * stay byte-for-byte identical). Assistant-produced images (the
 * image_generation tool's output) have no replay form inside assistant
 * items, so each is re-homed as a user `input_image` part — the model keeps
 * seeing its own output across turns, and OpenAI's edit flow picks the first
 * input image as the edit source. The harness `system` field is handled by
 * the caller through `instructions`. Reasoning blocks from history are
 * dropped: OpenAI reasoning is model-internal and cannot be replayed.
 * Assistant turns that produced neither text nor tool calls contribute no
 * item. When `degradeToolResultImages` is true, tool-result images become
 * text placeholders (the single retry form used after the backend rejects
 * `input_image` there).
 * @param messages - the harness conversation, in order.
 * @param attachments - the harness attachment store, or undefined.
 * @param signal - cancellation for attachment reads.
 * @param degradeToolResultImages - replace tool-result images with text.
 * @returns the wire input items.
 */
async function serializeInput(messages, attachments, signal, degradeToolResultImages) {
	const items = [];
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			const text = flattenText(message.content);
			const toolCalls = message.content.filter((block) => block.type === "tool-call");
			const images = message.content.filter((block) => block.type === "image");
			if (text.length > 0) items.push({
				role: "assistant",
				content: [{ type: "output_text", text }]
			});
			for (const call of toolCalls) items.push({
				type: "function_call",
				name: call.name,
				arguments: call.arguments,
				call_id: call.id
			});
			for (const image of images) {
				const parts = [];
				if (attachments !== void 0) try {
					const { ref, data } = await attachments.readImage(image.attachment, signal);
					parts.push({ type: "input_image", image_url: imageDataUrl(ref, data) });
				} catch {}
				if (parts.length === 0) parts.push({ type: "input_text", text: imagePlaceholderText(image.attachment) });
				items.push({
					role: "user",
					content: parts
				});
			}
			continue;
		}
		const parts = await imageContentParts(message.content, attachments, signal);
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		if (parts.length > 0 || toolResults.length === 0) items.push({
			role: "user",
			content: parts.length > 0 ? parts : [{ type: "input_text", text: "" }]
		});
		for (const result of toolResults) {
			const outputParts = await toolResultContentParts(result.content, attachments, signal, degradeToolResultImages);
			if (outputParts.some((part) => part.type === "input_image")) {
				items.push({
					type: "function_call_output",
					call_id: result.toolCallId,
					output: outputParts
				});
				continue;
			}
			// No image part: keep the historical plain-string form. Join the
			// text parts we produced rather than re-flattening the raw blocks,
			// so placeholders survive when an image degraded to text.
			const text = outputParts.map((part) => part.text ?? "").join("");
			items.push({
				type: "function_call_output",
				call_id: result.toolCallId,
				output: text.length > 0 ? text : "(no output)"
			});
		}
	}
	return items;
}
/**
 * Build the full Responses API request. Always streaming. The OpenAI backend
 * accepts neither stop sequences nor an output token cap (the official CLI
 * sends neither), so `options.stop` and `options.maxTokens` are deliberately
 * ignored; runaway output is bounded by the harness's own timeout policies.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param attachments - the harness attachment store, or undefined.
 * @param signal - cancellation for attachment reads.
 * @param degradeToolResultImages - replace tool-result images with text.
 * @param includeImageTool - append the server-side `image_generation` tool so
 * the model can generate or edit images directly in the conversation.
 * @returns the Responses API request body.
 */
async function serializeRequest(options, attachments, signal, degradeToolResultImages, includeImageTool) {
	const tools = options.tools?.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	})) ?? [];
	// The image_generation tool is executed by the OpenAI backend itself, so
	// it never becomes a harness tool-call block: translate() converts its
	// server-side output into assistant image blocks instead.
	if (includeImageTool) tools.push({ type: "image_generation" });
	return {
		model: options.model,
		stream: true,
		// The OpenAI backend rejects requests without an explicit store value.
		store: false,
		...options.system !== void 0 ? { instructions: options.system } : {},
		input: await serializeInput(options.messages, attachments, signal, degradeToolResultImages),
		...tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.reasoningEffort !== void 0 ? { reasoning: { effort: wireReasoningEffort(options.reasoningEffort) } } : {}
	};
}
/** Whether any tool result in the conversation carries an image block. */
function hasToolResultImages(messages) {
	return messages.some((message) => message.role !== "assistant" && message.role !== "system" && message.content.some((block) => block.type === "tool-result" && contentHasImage(block.content)));
}
/**
 * Whether a non-OK reply plausibly rejects `input_image` parts inside a
 * `function_call_output`. Used only as the gate for the single
 * degrade-and-retry, and only after {@link hasToolResultImages} was true.
 */
function indicatesImageToolResultRejection(status, providerError) {
	if (status !== 400 && status !== 422) return false;
	const text = [providerError?.code, providerError?.message].filter(Boolean).join(" ").toLowerCase();
	return /function_call_output|function call output/.test(text) || (/image|input_image/.test(text) && /content|part|output|tool/.test(text));
}
/**
 * Whether a non-OK reply plausibly rejects the `image_generation` tool
 * itself (unknown/unsupported tool, or a model without image output). Gates
 * the one-time tool-off retry: afterwards the adapter stops injecting the
 * tool until the process restarts.
 */
function indicatesImageGenerationToolRejection(status, providerError) {
	if (status !== 400 && status !== 422) return false;
	const text = [providerError?.code, providerError?.message].filter(Boolean).join(" ").toLowerCase();
	return /image_generation|image generation/.test(text) || (/image/.test(text) && /unsupported|unknown|invalid|not support/.test(text) && /tool/.test(text));
}
/**
 * Read the provider-facing error object from a non-OK Responses API reply.
 * Never throws: a malformed body degrades to undefined.
 */
async function responseProviderError(response) {
	try {
		const body = await response.json();
		return body?.error ?? (body?.detail !== void 0 ? { message: typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail) } : void 0);
	} catch {
		return void 0;
	}
}
//#endregion
//#region sse: byte stream -> JSON payload stream
/**
 * Parse an SSE byte stream into data payloads. Unlike chat completions, the
 * Responses API ends the stream without a `[DONE]` sentinel; a sentinel is
 * still tolerated if one appears. Whether the stream ended *successfully* is
 * judged by the terminal event inside {@link translate}.
 * @param stream - raw SSE bytes.
 * @param onComment - optional transport-activity callback.
 * @returns each event's data payload in arrival order.
 */
async function* parseSse(stream, onComment) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
	for await (const { data } of events) {
		if (data === "[DONE]") return;
		// Keep-alive/ping events carry no payload: JSON.parse would throw on
		// them and kill the whole stream, so they are skipped outright.
		if (typeof data !== "string" || data === "") continue;
		yield data;
	}
}
//#endregion
//#region translate: Responses API events -> harness StreamChunks
/** One-shot guard: log the "model made no image call" diagnostic once per process. */
let imageToolNoCallLogged = false;
/**
 * Append one diagnostic line to the plugin-owned debug log (next to the
 * credential file). Console output is not always visible to the user (the
 * web server may run detached), so image-tool diagnostics are also persisted
 * where both the user and the agent can read them. Never throws.
 */
function appendImageDebug(path, message) {
	if (path === void 0 || path === "") return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `[${new Date().toISOString()}] ${message}\n`);
	} catch {}
}
/** Map Responses API usage fields to the harness's disjoint TokenUsage counts. */
function mapUsage(usage) {
	const cacheRead = usage.input_tokens_details?.cached_tokens;
	const reasoning = usage.output_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.input_tokens - (cacheRead ?? 0),
		outputTokens: usage.output_tokens,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/**
 * Consume Responses API SSE payloads and yield harness StreamChunks. One
 * harness block tracks each response output item: message items accumulate
 * `output_text.delta` events, function-call items accumulate
 * `function_call_arguments.delta` events. The server-side `image_generation`
 * tool is special: its call never becomes a harness tool-call (the backend
 * executes it itself), and its `function_call_output` / `image` output items
 * become assistant image blocks persisted through the attachment store, so
 * the shell renders them like any other image. Output items that arrive only
 * inside a terminal event's `response.output` (some backends skip the
 * streamed item events) are harvested there as a fallback. Usage and finish
 * are deferred to the terminal event (`response.completed` /
 * `response.incomplete` / `response.failed`); a stream that ends without one
 * is untrusted and throws.
 * @param payloads - SSE data payloads from {@link parseSse}.
 * @param attachments - the harness attachment store, or undefined.
 * @param logger - optional host logger for one-shot diagnostics.
 * @param imageToolIncluded - whether this request carried the image_generation tool.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` last.
 */
async function* translate(payloads, attachments, logger, imageToolIncluded) {
	let nextIndex = 0;
	const items = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	/** Distinct SSE event type names observed, for diagnostics. */
	const eventTypes = /* @__PURE__ */ new Set();
	/** Output item kinds observed (function_call, message, image, ...). */
	const outputItemTypes = /* @__PURE__ */ new Set();
	/** Content part kinds observed on response.content_part.added. */
	const contentPartTypes = /* @__PURE__ */ new Set();
	/** Item ids of server-side image_generation calls (never tool-call blocks). */
	const imageGenCalls = /* @__PURE__ */ new Set();
	/** Output item ids whose image/text content has already been emitted. */
	const handledImageItems = /* @__PURE__ */ new Set();
	function open(itemId, kind, itemName, callId) {
		const block = {
			index: nextIndex++,
			itemId,
			kind,
			text: "",
			name: itemName ?? "",
			callId,
			closed: false
		};
		order.push(block);
		items.set(itemId, block);
		return block;
	}
	/** Emit one closed text block with the given content. */
	function* textBlock(text) {
		const index = nextIndex++;
		order.push({
			index,
			kind: "text",
			closed: true
		});
		yield {
			type: "block-start",
			index,
			blockType: "text"
		};
		yield {
			type: "text-delta",
			index,
			text
		};
		yield {
			type: "block-end",
			index,
			block: {
				type: "text",
				text
			}
		};
	}
	/** Persist generated bytes and emit one closed assistant image block. */
	async function* imageBlock(extracted) {
		if (extracted === void 0) {
			yield* textBlock("[generated image unavailable (no inline bytes)]");
			return;
		}
		try {
			if (attachments === void 0) throw new Error("attachment store unavailable");
			const ref = await attachments.saveImage({
				data: extracted.data,
				mediaType: extracted.mediaType,
				...extracted.name !== void 0 ? { name: extracted.name } : {}
			});
			const index = nextIndex++;
			order.push({
				index,
				kind: "image",
				closed: true
			});
			yield {
				type: "block-start",
				index,
				blockType: "image"
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "image",
					attachment: ref
				}
			};
		} catch (error) {
			yield* textBlock(`[generated image could not be stored: ${error?.message ?? error}]`);
		}
	}
	/**
	 * Emit the content of a server-side image_generation result item: text
	 * parts become text blocks, image parts become assistant image blocks.
	 * The provider shape varies across backend revisions (a
	 * `function_call_output` with `output_image`/`image` parts, or a bare
	 * `image` output item), so every carrier is probed defensively. The item
	 * is marked handled only after something was actually emitted, because
	 * the payload may arrive in either `output_item.added` or
	 * `output_item.done` depending on the backend revision.
	 */
	async function* emitImageGenerationOutput(item) {
		const id = item?.id;
		if (id !== void 0 && handledImageItems.has(id)) return;
		let emitted = false;
		const parts = item?.type === "function_call_output" && Array.isArray(item.output) ? item.output : item?.type === "function_call_output" && typeof item.output === "string" ? [{ type: "input_text", text: item.output }] : [];
		for (const part of parts) {
			if (part !== void 0 && part !== null && (part.type === "output_text" || part.type === "input_text") && typeof part.text === "string" && part.text !== "") {
				yield* textBlock(part.text);
				emitted = true;
			}
		}
		for (const part of parts) {
			if (part === void 0 || part === null) continue;
			if (part.type === "output_image" || part.type === "image" || part.type === "image_url") {
				emitted = true;
				yield* imageBlock(extractGeneratedImage(part.image ?? part, part.mime_type ?? part.mediaType));
			} else if (part.type === "input_image") {
				emitted = true;
				yield* imageBlock(extractGeneratedImage(part, part.mediaType));
			}
		}
		if (item?.type === "image") {
			emitted = true;
			yield* imageBlock(extractGeneratedImage(item.image ?? item, item.mime_type ?? item.mediaType));
		}
		if (id !== void 0 && emitted) handledImageItems.add(id);
	}
	/**
	 * Fallback for backends that report output items only inside a terminal
	 * event's `response.output` instead of streaming them: register any
	 * image_generation calls, then emit their outputs. Items already handled
	 * through streamed events are skipped by {@link emitImageGenerationOutput}.
	 */
	async function* harvestTerminalOutput(output) {
		if (!Array.isArray(output)) return;
		for (const item of output) {
			if (item?.type === "function_call" && item.name === "image_generation") imageGenCalls.add(item.id);
		}
		for (const item of output) {
			if (item?.type === "function_call_output" && imageGenCalls.has(item.call_id) || item?.type === "image") yield* emitImageGenerationOutput(item);
		}
	}
	for await (const payload of payloads) {
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		eventTypes.add(event.type);
		switch (event.type) {
			case "response.output_item.added": {
				const item = event.item;
				outputItemTypes.add(item?.type ?? "unknown");
				if (item?.type === "function_call") {
					// Server-side tool: the backend executes it and streams the
					// result back in this same response, so it must NOT become
					// a harness tool-call block.
					if (item.name === "image_generation") {
						imageGenCalls.add(item.id);
						break;
					}
					const block = open(item.id, "tool-call", item.name, item.call_id ?? item.id);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
					break;
				}
				if (item?.type === "function_call_output" && imageGenCalls.has(item.call_id) || item?.type === "image") {
					yield* emitImageGenerationOutput(item);
				}
				break;
			}
			case "response.output_text.delta": {
				if (typeof event.delta !== "string" || event.delta === "") break;
				let block = items.get(event.item_id);
				if (block === void 0) {
					block = open(event.item_id, "text");
					yield {
						type: "block-start",
						index: block.index,
						blockType: "text"
					};
				}
				block.text += event.delta;
				yield {
					type: "text-delta",
					index: block.index,
					text: event.delta
				};
				break;
			}
			case "response.function_call_arguments.delta": {
				const fragment = event.delta ?? "";
				if (imageGenCalls.has(event.item_id)) break;
				let block = items.get(event.item_id);
				if (block === void 0) {
					block = open(event.item_id, "tool-call", void 0, event.item_id);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(block.callId ?? event.item_id ?? ""),
					...block.name !== "" ? { name: block.name } : {},
					argumentsDelta: fragment
				};
				break;
			}
			case "response.output_item.done": {
				const item = event.item;
				if (imageGenCalls.has(item?.id)) break;
				if (item?.type === "function_call_output" && imageGenCalls.has(item.call_id) || item?.type === "image") {
					yield* emitImageGenerationOutput(item);
					break;
				}
				const block = items.get(item?.id);
				if (block === void 0 || block.closed) break;
				block.closed = true;
				if (block.kind === "tool-call") {
					if (item?.call_id !== void 0) block.callId = item.call_id;
					if (item?.name !== void 0 && item.name !== "") block.name = item.name;
					yield {
						type: "block-end",
						index: block.index,
						block: {
							type: "tool-call",
							id: CallId(block.callId ?? item.id ?? ""),
							name: block.name ?? "",
							arguments: block.text
						}
					};
				} else yield {
					type: "block-end",
					index: block.index,
					block: {
						type: "text",
						text: block.text
					}
				};
				break;
			}
			case "response.completed": {
				yield* harvestTerminalOutput(event.response?.output);
				pendingUsage = event.response?.usage !== void 0 ? mapUsage(event.response.usage) : void 0;
				pendingFinish = order.some((block) => block.kind === "tool-call") ? { kind: "tool-calls" } : { kind: "stop" };
				break;
			}
			case "response.incomplete": {
				yield* harvestTerminalOutput(event.response?.output);
				const reason = event.response?.incomplete_details?.reason;
				pendingFinish = reason === "max_output_tokens" ? { kind: "max-tokens" } : {
					kind: "error",
					failure: {
						message: `model stopped incomplete: ${reason ?? "unknown"}`,
						code: String(reason ?? "INCOMPLETE").toUpperCase()
					}
				};
				break;
			}
			case "response.failed": {
				yield* harvestTerminalOutput(event.response?.output);
				const error = event.response?.error;
				pendingFinish = {
					kind: "error",
					failure: {
						message: error?.message ?? "model call failed",
						code: error?.code ?? "FAILED"
					}
				};
				break;
			}
			case "error": {
				pendingFinish = {
					kind: "error",
					failure: {
						message: event.message ?? "provider error",
						code: event.code ?? "ERROR"
					}
				};
				break;
			}
			case "response.content_part.added": {
				contentPartTypes.add(event.part?.type ?? event.item?.type ?? "unknown");
				break;
			}
			default: break;
		}
	}
	// One-shot diagnostics: when the image tool was on the wire, tell the
	// console whether the model actually called it and which SSE event kinds
	// the backend sent — this distinguishes "backend silently ignores the
	// tool" from "image output arrived in an unhandled shape".
	if (imageToolIncluded && logger !== void 0) {
		const detail = [
			`output item types: ${[...outputItemTypes].sort().join(",") || "(none)"}`,
			`content part types: ${[...contentPartTypes].sort().join(",") || "(none)"}`
		].join("; ");
		if (imageGenCalls.size > 0) {
			logger.warn(`openai: image_generation call observed (${imageGenCalls.size}); sse events: ${[...eventTypes].sort().join(",")}; ${detail}`);
		} else if (!imageToolNoCallLogged) {
			imageToolNoCallLogged = true;
			logger.warn(`openai: image_generation tool was included but the model made no image call; sse events: ${[...eventTypes].sort().join(",")}; ${detail}`);
		}
	}
	if (pendingFinish === void 0) throw new LlmError("Responses API stream ended without a terminal event", "STREAM_CLOSED");
	for (const block of order) if (!block.closed) {
		if (block.kind === "tool-call") yield {
			type: "block-end",
			index: block.index,
			block: {
				type: "tool-call",
				id: CallId(block.callId ?? block.itemId ?? ""),
				name: block.name ?? "",
				arguments: block.text
			}
		}; else yield {
			type: "block-end",
			index: block.index,
			block: {
				type: "text",
				text: block.text
			}
		};
	}
	if (pendingUsage !== void 0) yield {
		type: "usage",
		usage: pendingUsage
	};
	const reason = pendingFinish.kind === "stop" && order.length === 0 ? {
		kind: "error",
		failure: {
			message: "model returned a completed response with no content",
			code: EMPTY_RESPONSE_CODE
		}
	} : pendingFinish;
	yield {
		type: "finish",
		reason
	};
}
//#endregion
//#region auth: OpenAI OAuth token store
/** OAuth application id shared by the official Codex CLI (login + refresh). */
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Token endpoint the official Codex CLI refreshes ChatGPT tokens through. */
const REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Refresh proactively this far before the access token's JWT expiry. */
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
/** How long to wait for another process holding the refresh lock. */
const REFRESH_LOCK_WAIT_MS = 5000;
/** Refresh locks older than this are stale leftovers from a crashed process. */
const STALE_LOCK_MS = 10 * 60 * 1000;
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Decode the `exp` claim of a JWT without verifying the signature. */
function decodeJwtExp(token) {
	const part = token.split(".")[1];
	if (part === void 0) return void 0;
	try {
		const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
		return typeof payload.exp === "number" ? payload.exp * 1000 : void 0;
	} catch {
		return void 0;
	}
}
function httpErrorCode(status, error) {
	if (status === 401 || status === 403) return "AUTH";
	const detail = [
		error?.code,
		error?.type,
		error?.message
	].filter(Boolean).join(" ");
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) {
		if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
function providerRetryAfterMs(value) {
	if (value === null) return void 0;
	if (/^\d+$/.test(value)) {
		const delay = Number(value) * 1e3;
		return Number.isFinite(delay) && delay > 0 ? delay : void 0;
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
/**
 * Owns one OpenAI credential source: an auth.json in the official Codex
 * CLI's shape (`auth_mode`, `OPENAI_API_KEY`, `tokens.{access_token, refresh_token,
 * id_token, account_id}`). Reads are cheap and cache-free; the only memory is
 * the single-flight refresh promise. When the access token nears expiry the
 * store re-reads the file (another process may already have refreshed it),
 * refreshes through auth.openai.com under a lock file, and persists the
 * rotated tokens back with mode 0600.
 */
class OpenAITokenStore {
	constructor(options, logger) {
		this.options = options;
		this.logger = logger;
		this.refreshing = void 0;
		this.catalog = void 0;
		this.catalogKey = void 0;
		this.catalogAt = 0;
		this.catalogFailureAt = 0;
	}
	/**
	 * The one credential file this plugin owns. It never reads another
	 * program's auth files (the Codex CLI's `~/.codex/auth.json` included)
	 * unless the user points `authFile` at one explicitly — installing this
	 * plugin must not silently reuse credentials the user granted to other
	 * software.
	 */
	authFilePath() {
		const config = this.options();
		if (config.authFile !== void 0 && config.authFile.trim() !== "") return config.authFile.trim();
		return join(homedir(), ".dsh-plugin-subhub", "openai-auth.json");
	}
	/** New logins land in the same plugin-owned file. */
	writeFilePath() {
		return this.authFilePath();
	}
	/** Whether any usable credential (tokens or API key) is on disk. */
	hasTokens() {
		const file = this.readFile(this.authFilePath());
		if (file === void 0) return false;
		if (typeof file.OPENAI_API_KEY === "string" && file.OPENAI_API_KEY.length > 0) return true;
		const tokens = file.tokens;
		return tokens !== void 0 && typeof tokens.access_token === "string" && tokens.access_token.length > 0;
	}
	readFile(path) {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return void 0;
		}
	}
	authHeaders(token, accountId) {
		return {
			"authorization": `Bearer ${token}`,
			...accountId !== void 0 && accountId !== "" ? { "chatgpt-account-id": accountId } : {},
			...attributionHeaders()
		};
	}
	/** Resolve one usable credential, refreshing the access token when needed. */
	async getToken() {
		const path = this.authFilePath();
		const file = this.readFile(path);
		if (file === void 0) throw new LlmError(`openai: no authentication found at ${path}; sign in from the "Third-party subscriptions" settings page or run the bundled login script (login.js)`, "MISSING_CREDENTIAL");
		const apiKey = file.OPENAI_API_KEY;
		if (typeof apiKey === "string" && apiKey.length > 0) return {
			token: apiKey,
			mode: "apikey",
			accountId: void 0
		};
		const tokens = file.tokens;
		if (tokens === void 0 || typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new LlmError(`openai: ${path} has no usable tokens; sign in from the "Third-party subscriptions" settings page or run the bundled login script`, "MISSING_CREDENTIAL");
		const exp = decodeJwtExp(tokens.access_token);
		if (exp === void 0 || exp - Date.now() > ACCESS_TOKEN_REFRESH_WINDOW_MS) return {
			token: tokens.access_token,
			mode: "chatgpt",
			accountId: typeof tokens.account_id === "string" ? tokens.account_id : void 0
		};
		const refreshed = await this.refreshLocked(path);
		return {
			token: refreshed.access_token,
			mode: "chatgpt",
			accountId: typeof refreshed.account_id === "string" ? refreshed.account_id : void 0
		};
	}
	/** Single-flight wrapper so concurrent requests share one refresh. */
	refreshLocked(path) {
		if (this.refreshing !== void 0) return this.refreshing;
		this.refreshing = this.refresh(path).finally(() => {
			this.refreshing = void 0;
		});
		return this.refreshing;
	}
	async refresh(path) {
		const lockPath = `${path}.lock`;
		const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
		let lock;
		while (lock === void 0 && Date.now() < deadline) {
			try {
				lock = openSync(lockPath, "wx");
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
				// A crashed process can leave the lock file behind; every
				// later refresh would then waste the full wait window forever.
				// Reclaim clearly stale locks (a live holder's lock is always
				// fresh) and retry immediately instead of sleeping.
				try {
					const stale = Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
					if (stale) {
						rmSync(lockPath, { force: true });
						continue;
					}
				} catch {}
				await sleep(150);
			}
		}
		try {
			const file = this.readFile(path);
			const tokens = file?.tokens;
			if (tokens === void 0) throw new LlmError(`openai: ${path} has no tokens; sign in again`, "MISSING_CREDENTIAL");
			const exp = decodeJwtExp(tokens.access_token);
			if (exp !== void 0 && exp - Date.now() > ACCESS_TOKEN_REFRESH_WINDOW_MS) return tokens;
			if (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length === 0) throw new LlmError(`openai: ${path} has no refresh token; sign in again`, "INVALID_CREDENTIAL");
			const response = await fetch(REFRESH_TOKEN_URL, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...attributionHeaders()
				},
				body: JSON.stringify({
					client_id: OAUTH_CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: tokens.refresh_token
				})
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new LlmError(`openai: token refresh failed (HTTP ${response.status}); sign in again from the "Third-party subscriptions" settings page`, "INVALID_CREDENTIAL", {
					status: response.status,
					cause: new Error(body.slice(0, 300))
				});
			}
			const next = await response.json();
			if (typeof next.access_token !== "string" || next.access_token.length === 0) throw new LlmError("openai: token refresh returned no access token", "INVALID_CREDENTIAL");
			const merged = {
				...tokens,
				access_token: next.access_token,
				...typeof next.refresh_token === "string" && next.refresh_token.length > 0 ? { refresh_token: next.refresh_token } : {},
				...typeof next.id_token === "string" && next.id_token.length > 0 ? { id_token: next.id_token } : {}
			};
			this.persist(path, {
				...file,
				tokens: merged,
				last_refresh: new Date().toISOString()
			});
			return merged;
		} finally {
			if (lock !== void 0) {
				try {
					closeSync(lock);
				} catch {}
				try {
					rmSync(lockPath, { force: true });
				} catch {}
			}
		}
	}
	persist(path, data) {
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(data, void 0, 2) + "\n", { mode: 384 });
			// The write mode only applies to newly created files: re-tighten
			// the permissions so a pre-existing credential file can never
			// stay readable by others (a no-op on platforms without chmod).
			chmodSync(path, 384);
			return true;
		} catch (error) {
			this.logger?.warn(`openai: could not persist tokens to ${path}: ${error?.message ?? error}`);
			return false;
		}
	}
	/**
	 * Fetch the account's model catalog. Cached for a TTL; failures are
	 * remembered briefly so an offline picker does not hammer the endpoint.
	 * @param config - resolved connection facts.
	 * @returns catalog entries in endpoint order.
	 */
	async listModels(config) {
		const now = Date.now();
		// The cache belongs to one credential identity: switching accounts
		// (or apikey <-> chatgpt) must invalidate it immediately, not after
		// the TTL. The key is a truncated in-memory hash, never logged.
		const { token, mode, accountId } = await this.getToken();
		const credentialKey = `${mode}|${accountId ?? ""}|${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
		if (this.catalog !== void 0 && this.catalogKey === credentialKey && now - this.catalogAt < config.modelsCacheTtlMs) return this.catalog;
		if (now - this.catalogFailureAt < 60000) return void 0;
		const baseURL = effectiveBaseURL(config, mode);
		const response = await fetch(`${baseURL}/models?client_version=0.0.0`, {
			headers: this.authHeaders(token, accountId)
		});
		if (!response.ok) {
			this.catalogFailureAt = now;
			throw new LlmError(`openai: model catalog request failed (HTTP ${response.status})`, httpErrorCode(response.status, void 0), { status: response.status });
		}
		const body = await response.json();
		const raw = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
		this.catalog = raw.filter((entry) => typeof entry?.slug === "string" || typeof entry?.id === "string").filter((entry) => entry.visibility !== "hide").map((entry) => {
			const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
			const efforts = levels.map((level) => typeof level === "string" ? { effort: level } : level).filter((level) => typeof level?.effort === "string" && WIRE_EFFORT_VALUES.has(level.effort)).map((level) => ({
				id: ReasoningEffortId(level.effort),
				name: EFFORT_DISPLAY_NAMES[level.effort] ?? level.effort,
				...typeof level.description === "string" && level.description !== "" ? { description: level.effort === "ultra" ? `${level.description}(按 max 推理执行,并注入主动委派指令)` : level.description } : {}
			}));
			const defaultLevel = entry.default_reasoning_level;
			const contextWindow = Number.isInteger(entry.context_window) && entry.context_window > 0 ? entry.context_window : void 0;
			const inputModalities = (Array.isArray(entry.input_modalities) ? entry.input_modalities : []).filter((modality) => modality === "text" || modality === "image");
			return {
				provider: PROVIDER,
				id: entry.slug ?? entry.id,
				name: entry.display_name ?? entry.name ?? entry.slug ?? entry.id,
				...typeof entry.description === "string" && entry.description !== "" ? { description: entry.description } : {},
				...inputModalities.length === 0 ? {} : { inputModalities },
				...contextWindow === void 0 ? {} : { contextWindow },
				...efforts.length === 0 ? {} : { reasoning: {
					efforts,
					...defaultLevel !== void 0 && efforts.some((effort) => effort.id === defaultLevel) ? { defaultEffort: ReasoningEffortId(defaultLevel) } : {}
				} }
			};
		});
		this.catalogAt = now;
		this.catalogKey = credentialKey;
		return this.catalog;
	}
	/**
	 * One catalog entry by exact model id, loading (or reusing the cached)
	 * catalog first. Never throws: failures degrade to `undefined`, so
	 * capability resolution always falls back to configured metadata.
	 */
	async catalogEntry(config, id) {
		try {
			const catalog = await this.listModels(config);
			return catalog?.find((entry) => entry.id === id);
		} catch {
			return void 0;
		}
	}
}
//#endregion
//#region adapter
/** Default maximum combined request/response context capacity in tokens. */
const DEFAULT_CONTEXT_WINDOW = 4e5;
/** Default catalog cache lifetime. */
const DEFAULT_MODELS_CACHE_TTL_MS = 3e5;
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** OpenAI backend the official Codex CLI talks to with ChatGPT OAuth tokens. */
const CHATGPT_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Public Responses API used when the credential is an API key. */
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
/** Provider route this plugin owns. */
// The provider id must stay unique: the harness's built-in provider
// directory already declares "openai" (api-key BYO provider), so the
// subscription route uses its own dsh-plugin-subhub-<provider> id with the
// same display name.
const PROVIDER = "dsh-plugin-subhub-openai";
const LOW_REASONING_EFFORT = ReasoningEffortId("low");
const MEDIUM_REASONING_EFFORT = ReasoningEffortId("medium");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
/**
 * Offline fallback efforts, used only while the live catalog (which carries
 * per-model supported_reasoning_levels) is unreachable.
 */
const REASONING_EFFORTS = [
	{
		id: LOW_REASONING_EFFORT,
		name: "Low"
	},
	{
		id: MEDIUM_REASONING_EFFORT,
		name: "Medium"
	},
	{
		id: HIGH_REASONING_EFFORT,
		name: "High"
	}
];
/**
 * Offline fallback catalog, shown only while the /models endpoint is
 * unreachable. It never merges into the live list: online, the picker shows
 * exactly what the account's catalog returns (internal aliases such as
 * `visibility: "hide"` entries are filtered out, mirroring the official codex
 * CLI). Context figures mirror the live endpoint's context_window values;
 * input modalities mirror the live `input_modalities` declarations (every
 * listed model accepts images except GPT-5.3-Codex-Spark, which is
 * text-only).
 */
const DEFAULT_MODELS = [
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6-Sol",
		contextWindow: 272000,
		inputModalities: ["text", "image"]
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6-Terra",
		contextWindow: 272000,
		inputModalities: ["text", "image"]
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6-Luna",
		contextWindow: 272000,
		inputModalities: ["text", "image"]
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		contextWindow: 272000,
		inputModalities: ["text", "image"]
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 272000,
		inputModalities: ["text", "image"]
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4-Mini",
		contextWindow: 272000,
		inputModalities: ["text", "image"]
	},
	{
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3-Codex-Spark",
		contextWindow: 128000,
		inputModalities: ["text"]
	}
];
/** Pick the endpoint for one credential mode. */
function effectiveBaseURL(config, mode) {
	if (mode === "apikey") return config.apiBaseURL ?? OPENAI_API_BASE_URL;
	return config.baseURL ?? CHATGPT_BACKEND_BASE_URL;
}
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		// Absent means unknown: never fabricate a negative image capability.
		...model.inputModalities === void 0 ? {} : { inputModalities: model.inputModalities }
	};
}
/**
 * Delegation directive injected whenever the agent carries delegation tools
 * (subagent / workflow — both mounted by the agent preset for every model and
 * effort, per the harness tool assembly, which never filters by model). Two
 * halves:
 *
 * 1. Result-collection discipline, applied at EVERY reasoning effort: a
 *    background subagent call returns only its id — never the result — and
 *    the child's output arrives later as follow-up messages. Models that
 *    treat the id as the answer continue past the step that needed the
 *    output, or sit idle while the report waits in the user-visible
 *    queued-messages dock. So the directive states the contract at the
 *    decision point: delegate in the foreground (run_in_background: false)
 *    when the next step depends on the result; reserve background children
 *    for work integrated after their follow-up messages arrive.
 *
 * 2. Under ultra effort, proactive delegation mirrors the official codex
 *    CLI's Ultra behavior (max reasoning + MultiAgentMode::Proactive): the
 *    runtime cannot split tasks itself, so the model is instructed to drive
 *    the harness's own delegation tools — the closest native equivalent.
 *
 * 3. Model-scope guidance: subagent children always run on the agent
 *    preset's default model, never on the session's currently selected
 *    model, so a session running this provider on a model that differs from
 *    the preset default gets an explicit warning — and, when the workflow
 *    tool is present, the override path that CAN pin a delegated worker to
 *    the current provider/model.
 *
 * The directive only references tools actually present in the request.
 * @param options - the harness request whose system prompt is extended.
 * @param presetDefault - the agent preset's default {provider, model}, or
 *   undefined when the settings source is unavailable; the model-scope
 *   guidance is skipped unless a real mismatch is known.
 */
function applyDelegationDirective(options, presetDefault) {
	if (!Array.isArray(options.tools)) return options;
	const hasSubagents = options.tools.some((tool) => tool.name === "subagent" || tool.name === "subagent_fork");
	const hasWorkflow = options.tools.some((tool) => tool.name === "workflow");
	if (!hasSubagents && !hasWorkflow) return options;
	const lines = [];
	if (options.reasoningEffort === "ultra") {
		lines.push(
			"ULTRA MODE — PROACTIVE TASK DELEGATION",
			"Reasoning depth is already at maximum. To make the most of it, delegate proactively:",
			"- Decompose the task into independent subtasks."
		);
		if (hasSubagents) lines.push("- For every subtask that can run autonomously, launch a subagent (subagent tool) with a complete, standalone prompt. Use background delegation (run_in_background: true) only when you can continue other work until the child's follow-up messages arrive; otherwise delegate in the foreground (run_in_background: false). Start independent background subagents in parallel.");
		if (hasWorkflow) lines.push("- For work that fans out over many independent pieces, use the workflow tool to run them concurrently.");
	}
	lines.push("DELEGATION RESULT COLLECTION");
	if (hasSubagents) lines.push(
		"- A background subagent call returns only its id, not the result: the child's output arrives later as follow-up messages, never inside the tool result.",
		"- If your next step depends on a subagent's result, call it with run_in_background: false and use the returned result directly.",
		"- Launch a background subagent only for work whose result you integrate after its follow-up messages arrive; never pass a decision point that needs that output before collecting it."
	);
	const modelMismatch = hasSubagents && typeof options.provider === "string" && typeof options.model === "string" && presetDefault !== void 0 && (presetDefault.provider !== options.provider || presetDefault.model !== options.model);
	if (modelMismatch) {
		lines.push(`- You are running on provider "${options.provider}" model "${options.model}", but subagent children always run on the agent preset's default model ("${presetDefault.provider}" / "${presetDefault.model}") — never assume a delegated child shares your model.`);
		if (hasWorkflow) lines.push(`- When a delegated task must run on your current model, use the workflow tool instead of the subagent tool and pass provider "${options.provider}" and model "${options.model}" to its agents.`);
	}
	lines.push(
		"- Verify every delegated result yourself; never delegate final integration, decisions, or the final answer.",
		"- Do not delegate subtasks that need the whole conversation context."
	);
	const directive = lines.join("\n");
	const system = options.system === void 0 || options.system === "" ? directive : `${options.system}\n\n${directive}`;
	return system === options.system ? options : { ...options, system };
}
/**
 * Image-generation directive injected while the image_generation tool rides
 * the wire. The harness system prompt enumerates only the coding tools, so
 * the model otherwise ignores the extra tool and text-claims success. This
 * makes the capability explicit — and forbids claiming an image that was
 * never actually returned.
 */
const IMAGE_TOOL_DIRECTIVE = [
	"IMAGE GENERATION CAPABILITY",
	"Beyond the coding tools listed above, you also have the server-side \"image_generation\" tool.",
	"- Call it whenever the user asks to generate, draw, create, design, or edit an image; put the full visual description into the tool call.",
	"- The generated image is returned as part of your response automatically — never say an image was generated unless the tool actually returned one.",
	"- To edit an image already in the conversation, describe the desired changes in the tool call; the first image in the conversation is the edit source."
].join("\n");
function applyImageGenerationDirective(options) {
	const system = options.system === void 0 || options.system === "" ? IMAGE_TOOL_DIRECTIVE : `${options.system}\n\n${IMAGE_TOOL_DIRECTIVE}`;
	return system === options.system ? options : { ...options, system };
}
/**
 * Tool-result images that the conversation UI has not shown yet. The shell's
 * tool-result cards render text only and drop image blocks, so an image a
 * tool returned (generate_image, read_image) is visible to the model but not
 * to the user. The adapter echoes those images into the next assistant
 * message — whose renderer does display images — tracking what has already
 * been echoed through the attachment ids present in assistant history.
 * @param messages - the harness conversation, in order.
 * @returns attachment refs (from the most recent tool result that still has
 * an un-echoed image), in block order.
 */
function lastUnEchoedToolResultImages(messages) {
	const echoed = new Set();
	for (const message of messages ?? []) {
		if (message.role !== "assistant") continue;
		for (const block of message.content ?? []) {
			if (block.type === "image" && block.attachment?.attachmentId !== void 0) echoed.add(block.attachment.attachmentId);
		}
	}
	for (let i = (messages ?? []).length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" || message.role === "system") continue;
		const refs = [];
		for (const block of message.content ?? []) {
			if (block.type !== "tool-result") continue;
			for (const part of block.content ?? []) {
				if (part.type === "image" && part.attachment?.attachmentId !== void 0 && !echoed.has(part.attachment.attachmentId)) refs.push(part.attachment);
			}
		}
		if (refs.length > 0) return refs;
	}
	return [];
}
/**
 * `OpenAIAdapter`: fetch + SSE against the OpenAI backend's Responses API,
 * emitting harness StreamChunks. Connection facts and the bearer token are
 * resolved once per operation, so auth rotation reaches the very next
 * request without restarting anything.
 */
var OpenAIAdapter = class extends LlmAdapter {
	constructor(config) {
		super();
		this.config = config;
		// "on" until the backend proves it rejects the image_generation tool;
		// a proven rejection turns it off for the process lifetime.
		this.imageToolState = "on";
	}
	/** Whether the current request should carry the image_generation tool. */
	includeImageTool() {
		const config = this.config.options();
		return this.imageToolState !== "off" && config.enableImageTool !== false;
	}
	/** Plugin-owned diagnostic log path beside the credential file. */
	imageDebugLogPath() {
		try {
			return join(dirname(this.config.tokenStore.authFilePath()), "openai-image-debug.log");
		} catch {
			return void 0;
		}
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.config.displayName()
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		const config = this.config.options();
		return this.config.tokenStore.listModels(config).catch((error) => {
			if (error?.code !== "MISSING_CREDENTIAL") {
				this.config.logger?.warn("openai: model catalog unavailable, using offline fallback models");
				this.config.logger?.warn(error);
			}
			return void 0;
		}).then((remote) => (remote !== void 0 && remote.length > 0 ? remote : DEFAULT_MODELS.map((model) => modelInfo(provider, model))));
	}
	resolveModel(provider, model) {
		const config = this.config.options();
		return this.config.tokenStore.catalogEntry(config, model).then((live) => {
			// Reasoning levels come from the model's own catalog entry; the
			// static three-step list is only an offline fallback.
			const efforts = live?.reasoning?.efforts ?? REASONING_EFFORTS;
			const configuredDefault = config.defaultReasoningEffort !== void 0 && efforts.some((effort) => effort.id === config.defaultReasoningEffort) ? ReasoningEffortId(config.defaultReasoningEffort) : void 0;
			const defaultEffort = configuredDefault ?? (live?.reasoning?.defaultEffort !== void 0 && efforts.some((effort) => effort.id === live.reasoning.defaultEffort) ? live.reasoning.defaultEffort : void 0);
			return {
				...live === void 0 ? modelInfo(provider, DEFAULT_MODELS.find((entry) => entry.id === model) ?? {
					id: model
				}) : modelInfo(provider, live),
				context: {
					contextWindow: live?.contextWindow ?? DEFAULT_MODELS.find((entry) => entry.id === model)?.contextWindow ?? config.defaultContextWindow
				},
				reasoning: {
					efforts,
					...defaultEffort !== void 0 ? { defaultEffort } : {}
				}
			};
		});
	}
	/**
	 * Bind exact model metadata and the eventual request dispatch to one
	 * adapter generation, so settings changes between preparation and
	 * dispatch cannot combine one generation's capabilities with another's
	 * endpoint. The harness runtime has called this on adapters since rc.8
	 * (the LlmAdapter base gained a default then); the method is defined
	 * here explicitly so the plugin keeps working when its peer dependency
	 * resolves to the pre-rc.8 base that lacks it.
	 */
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
	async *stream(options) {
		const connection = this.config.options();
		const auth = await this.config.tokenStore.getToken();
		const baseURL = effectiveBaseURL(connection, auth.mode);
		const dispatch = applyDelegationDirective(options, this.config.presetDefaultModel?.());
		// The server-side wire tool is only honored by the public API; the
		// chatgpt backend ignores it (the generate_image harness tool covers
		// that mode), so it rides the wire in API-key mode only.
		const includeWireImageTool = auth.mode === "apikey" && this.includeImageTool();
		const imageDispatch = includeWireImageTool ? applyImageGenerationDirective(dispatch) : dispatch;
		// The shell renders tool-result cards as text only, so images a tool
		// returned (generate_image, read_image) never reach the user's eyes
		// through the card. Echo un-echoed tool-result images as leading
		// assistant image blocks, which the conversation renderer displays.
		// Skipped for tool-less calls (the session-title request) so a title
		// stream never carries an image. The echoed blocks occupy the first
		// indexes; the model stream is re-indexed past them.
		const echoRefs = Array.isArray(options.tools) && options.tools.length > 0 ? lastUnEchoedToolResultImages(options.messages) : [];
		const echoOffset = echoRefs.length;
		for (let index = 0; index < echoRefs.length; index++) {
			yield {
				type: "block-start",
				index,
				blockType: "image"
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "image",
					attachment: echoRefs[index]
				}
			};
		}
		const consumer = new AbortController();
		const watchdog = idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT");
		const iterator = this.request(imageDispatch, watchdog.signal, baseURL, auth, () => {
			watchdog.pulse();
		}, includeWireImageTool)[Symbol.asyncIterator]();
		let exhausted = false;
		try {
			while (true) {
				const result = await watchdog.next(iterator);
				if (result.done) {
					exhausted = true;
					return;
				}
				const chunk = result.value;
				yield echoOffset > 0 && typeof chunk.index === "number" ? { ...chunk, index: chunk.index + echoOffset } : chunk;
			}
		} catch (error) {
			if (timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT") !== void 0) throw new LlmError(`OpenAI stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
			if (options.signal?.aborted) throw new LlmError("OpenAI request aborted by caller", "ABORTED", { cause: error });
			if (error instanceof LlmError) throw error;
			throw new LlmError(`OpenAI API stream from ${baseURL} failed`, "TRANSPORT", { cause: error });
		} finally {
			consumer.abort("OpenAI stream consumer stopped");
			if (!exhausted && iterator.return !== void 0) try {
				await iterator.return();
			} catch (_abortedTransportTeardown) {}
		}
	}
	async *request(options, signal, baseURL, auth, onComment, includeWireImageTool) {
		const attachments = this.config.resolveAttachments?.();
		const headers = {
			...this.config.tokenStore.authHeaders(auth.token, auth.accountId),
			"content-type": "application/json",
			"accept": "text/event-stream"
		};
		const debugPath = this.imageDebugLogPath();
		/** Console warn + plugin-owned debug file, so diagnostics survive detached consoles. */
		const diagnostic = (message) => {
			this.config.logger?.warn(`openai: ${message}`);
			appendImageDebug(debugPath, message);
		};
		const post = async (payload) => {
			try {
				return await fetch(`${baseURL}/responses`, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal
				});
			} catch (error) {
				if (signal.aborted) throw error;
				throw new LlmError(`OpenAI API request to ${baseURL} failed`, "TRANSPORT", { cause: error });
			}
		};
		let payload = await serializeRequest(options, attachments, signal, false, includeWireImageTool);
		let response = await post(payload);
		if (!response.ok) {
			// Bounded self-healing (at most two retries): degrade tool-result
			// images to text placeholders when the backend rejects them, and
			// stop injecting the image_generation tool when the backend
			// rejects it — neither condition may brick the conversation.
			for (let retry = 0; retry < 2; retry++) {
				const providerError = await responseProviderError(response);
				const detail = [providerError?.code, providerError?.message].filter(Boolean).join(" ");
				diagnostic(`non-ok HTTP ${response.status}: ${detail || "(no error detail)"}`);
				const degradeImages = hasToolResultImages(options.messages) && indicatesImageToolResultRejection(response.status, providerError);
				const disableImageTool = includeWireImageTool && this.imageToolState !== "off" && indicatesImageGenerationToolRejection(response.status, providerError);
				if (!degradeImages && !disableImageTool) break;
				if (disableImageTool) {
					this.imageToolState = "off";
					diagnostic("backend rejected the image_generation tool; image generation disabled until restart");
				}
				if (degradeImages) diagnostic("backend rejected tool-result image content; degrading to text placeholders");
				payload = await serializeRequest(options, attachments, signal, degradeImages, includeWireImageTool && this.includeImageTool());
				response = await post(payload);
			}
		}
		if (!response.ok) {
			const providerError = await responseProviderError(response);
			let message = `OpenAI API error (HTTP ${response.status})`;
			if (providerError?.message) message = providerError.message;
			const delay = providerRetryAfterMs(response.headers.get("retry-after"));
			const id = response.headers.get("x-request-id");
			throw new LlmError(message, httpErrorCode(response.status, providerError), {
				status: response.status,
				...delay === void 0 ? {} : { providerRetryAfterMs: delay },
				...id === null || id === "" ? {} : { requestId: ProviderRequestId(id) }
			});
		}
		if (!response.body) throw new LlmError("OpenAI API returned no response body", "EMPTY_RESPONSE");
		const imageToolIncluded = payload.tools?.some((tool) => tool.type === "image_generation") === true;
		yield* translate(parseSse(response.body, onComment), attachments, { warn: diagnostic }, imageToolIncluded);
	}
};
//#endregion
//#region login api: browser-side device login through the web server
/** API prefix the client settings page talks to (same-origin fetch). */
const LOGIN_API_PATH = "/api/dsh-plugin-subhub";
/** Browser-trust fence: same-origin requests only (DNS-rebinding + CSRF guard). */
function isTrustedRequest(req) {
	const host = req.headers.host ?? "";
	if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	let hostname;
	try {
		hostname = new URL(origin).hostname;
	} catch {
		return false;
	}
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
/**
 * Map a request's Accept-Language header to a zh/en hint. The hub page polls
 * these routes with the browser's own language, which is exactly what the
 * shell's locale service falls back to before the user picks one explicitly.
 */
function languageHint(req) {
	const header = req.headers["accept-language"];
	if (typeof header !== "string" || header.length === 0) return void 0;
	const first = header.split(",")[0].trim().toLowerCase();
	if (first.startsWith("zh")) return "zh";
	if (first.startsWith("en")) return "en";
	return void 0;
}
/**
 * The client carries the active harness UI language (locale snapshot) as a
 * `locale` query parameter on every plugin API call; this is the authoritative
 * hint — the exact language the shell renders in. Accept-Language only backs
 * it up for non-browser callers (e.g. curl diagnostics).
 */
function localeFromParam(url) {
	const value = url.searchParams.get("locale");
	if (typeof value !== "string") return void 0;
	const tag = value.trim().toLowerCase();
	if (tag.startsWith("en")) return "en";
	if (tag.startsWith("zh")) return "zh";
	return void 0;
}
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/**
 * Non-secret identity of the credential file: path + modification time.
 * The client compares this value to invalidate its warm model-catalog cache
 * after a login or account switch; it carries no token material.
 */
function credentialFingerprint(tokenStore) {
	try {
		const file = tokenStore.writeFilePath();
		return `${file}:${statSync(file).mtimeMs}`;
	} catch {
		return "none";
	}
}
/**
 * Owns the one pending device-login flow and answers the third-party
 * subscriptions page's login API. Token values never cross the wire: the
 * browser only ever sees the public verification URL / one-time code and
 * plain status results. `onAuthChanged` runs after every login/logout so the
 * owning plugin can (un)register the provider route. `onLanguageHint` runs
 * when a request reveals the harness UI language — the client's explicit
 * `locale` query parameter first, Accept-Language as a fallback — so the
 * provider display name can follow the shell language until the user picks
 * one explicitly.
 * `listCatalog` answers the read-only model catalog route for the Models
 * page card.
 */
function createLoginController(tokenStore, logger, onAuthChanged, listCatalog, onLanguageHint) {
	let pending;
	// Last login state observed by the status route; drives the polling
	// self-heal below.
	let lastLoggedIn = false;
	// Last language hint observed from requests.
	let lastLanguageHint;
	const notify = () => {
		try {
			onAuthChanged?.();
		} catch (error) {
			logger?.warn(`openai: onAuthChanged failed: ${error?.message ?? error}`);
		}
	};
	return {
		async handle(req, res) {
			if (!isTrustedRequest(req)) {
				sendJson(res, 403, {
					ok: false,
					code: "forbidden",
					message: "forbidden"
				});
				return;
			}
			const url = new URL(req.url ?? "/", "http://localhost");
			const path = url.pathname;
			const hint = localeFromParam(url) ?? languageHint(req);
			if (hint !== void 0 && hint !== lastLanguageHint) {
				lastLanguageHint = hint;
				try {
					onLanguageHint?.(hint);
				} catch {}
			}
			try {
				if (path === `${LOGIN_API_PATH}/login/status` && req.method === "GET") {
					const loggedIn = tokenStore.hasTokens();
					// The hub page polls this route while mounted. Treat a
					// changed login state as an auth change so that a login
					// performed out of band (the bundled login script) also
					// registers the provider — no restart required.
					if (loggedIn !== lastLoggedIn) {
						lastLoggedIn = loggedIn;
						notify();
					}
					sendJson(res, 200, {
						ok: true,
						loggedIn,
						authFile: tokenStore.writeFilePath(),
						pending: pending !== void 0
					});
					return;
				}
				if (path === `${LOGIN_API_PATH}/login/start` && req.method === "POST") {
					// A login may already be in progress from another tab:
					// reuse its flow instead of starting a second one, so the
					// code shown in every tab matches the shared server-side
					// poll state. Expired flows are replaced.
					if (pending === void 0 || Date.now() >= pending.expiresAtMs) {
						pending = await requestUserCode();
					}
					const flow = pending;
					sendJson(res, 200, {
						ok: true,
						verificationUrl: flow.verificationUrl,
						userCode: flow.userCode,
						expiresAtMs: flow.expiresAtMs
					});
					return;
				}
				if (path === `${LOGIN_API_PATH}/login/poll` && req.method === "POST") {
					if (pending === void 0) {
						sendJson(res, 200, {
							ok: false,
							code: "no-pending",
							message: "no login in progress"
						});
						return;
					}
					const poll = await pollAuthorizationOnce(pending.deviceAuthId, pending.userCode, pending.expiresAtMs);
					if (poll.status === "pending") {
						sendJson(res, 200, { status: "pending" });
						return;
					}
					if (poll.status === "expired") {
						pending = void 0;
						sendJson(res, 200, { status: "expired" });
						return;
					}
					const tokens = await exchangeAuthorizationCode(poll.authorizationCode, poll.codeVerifier);
					const target = tokenStore.writeFilePath();
					const saved = tokenStore.persist(target, authFilePayload(tokens));
					pending = void 0;
					if (!saved) {
						// The account granted the tokens but they could not be
						// written to disk: telling the browser "success" would
						// leave the UI and the on-disk state out of sync.
						sendJson(res, 500, {
							ok: false,
							code: "persist-failed",
							message: "credentials were received but could not be saved to disk"
						});
						return;
					}
					notify();
					sendJson(res, 200, {
						status: "success",
						authFile: target
					});
					return;
				}
				if (path === `${LOGIN_API_PATH}/login/logout` && req.method === "POST") {
					const target = tokenStore.writeFilePath();
					try {
						rmSync(target, { force: true });
						// Drop a leftover refresh lock together with the file:
						// a stale lock would otherwise delay future refreshes.
						rmSync(`${target}.lock`, { force: true });
					} catch {}
					pending = void 0;
					notify();
					sendJson(res, 200, {
						ok: true,
						loggedIn: false,
						authFile: target
					});
					return;
				}
				if (path === `${LOGIN_API_PATH}/models` && req.method === "GET") {
					const models = typeof listCatalog === "function" ? await listCatalog() : [];
					sendJson(res, 200, {
						ok: true,
						loggedIn: tokenStore.hasTokens(),
						// Non-secret identity of the credential file (path +
						// mtime): the client invalidates its warm catalog cache
						// when this changes after a login or account switch.
						fingerprint: credentialFingerprint(tokenStore),
						models: Array.isArray(models) ? models : []
					});
					return;
				}
				sendJson(res, 404, {
					ok: false,
					code: "not-found",
					message: "not found"
				});
			} catch (error) {
				logger?.warn(`openai: login api failed: ${error?.message ?? error}`);
				sendJson(res, 500, {
					ok: false,
					code: "error",
					message: error?.message ?? String(error)
				});
			}
		}
	};
}
//#endregion
//#region image tool: harness tool generating images through the account backend
/** Harness-facing tool name; distinct from the server-side image_generation wire tool. */
const IMAGE_TOOL_NAME = "generate_image";
/** Default Images-API model; overridable through `openai.imageModel`. */
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
/** POST one generation attempt; returns the parsed JSON payload or throws. */
async function postImageGeneration(url, body, headers, signal) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...headers
		},
		body: JSON.stringify(body),
		signal
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 200);
		throw new Error(`image endpoint failed (HTTP ${response.status})${detail.length > 0 ? `: ${detail}` : ""}`);
	}
	return await response.json();
}
/**
 * Decode provider image payloads into raw bytes. Covers inline `b64_json`,
 * the Images-API `data[]` envelope, and hosted `url`/`image_url` links (the
 * hosted variant is fetched with the account headers first, then without —
 * but credentials are only ever attached for OpenAI-owned hosts).
 */
const OPENAI_IMAGE_HOSTS = ["api.openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com"];
function isOpenAiHost(hostname) {
	return OPENAI_IMAGE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}
async function imageBytesFromPayload(payload, headers, signal) {
	if (payload === void 0 || payload === null || typeof payload !== "object") return void 0;
	for (const key of ["b64_json", "base64"]) {
		if (typeof payload[key] === "string" && payload[key].length > 0) {
			const data = Buffer.from(payload[key], "base64");
			const mediaType = detectImageMediaType(data) ?? "image/png";
			return { data, mediaType };
		}
	}
	if (Array.isArray(payload.data)) {
		for (const item of payload.data) {
			const inner = await imageBytesFromPayload(item, headers, signal);
			if (inner !== void 0) return inner;
		}
	}
	for (const key of ["url", "image_url"]) {
		const url = payload[key];
		if (typeof url !== "string" || !/^https?:\/\//.test(url)) continue;
		let hostname;
		try {
			hostname = new URL(url).hostname;
		} catch {
			continue;
		}
		// Send the account credentials only to OpenAI-owned hosts; foreign
		// hosts are fetched unauthenticated from the start. No download size
		// limit is applied: generated images are provider-controlled.
		const credentialed = headers !== void 0 && isOpenAiHost(hostname);
		let response;
		if (credentialed) {
			try {
				response = await fetch(url, { headers, signal });
			} catch (error) {
				if (signal?.aborted) throw error;
				response = await fetch(url, { signal });
			}
		} else {
			response = await fetch(url, { signal });
		}
		if (response.ok) {
			const data = Buffer.from(await response.arrayBuffer());
			const mediaType = detectImageMediaType(data) ?? "image/png";
			return { data, mediaType };
		}
	}
	return void 0;
}
/**
 * Ask the account backend for one image. The chatgpt backend ignores the
 * Responses-API `image_generation` tool, so generation runs through this
 * harness tool against the backend's Images API —
 * `chatgpt.com/backend-api/codex/images/generations` with ChatGPT OAuth,
 * `api.openai.com/v1/images/generations` with an API key — with a legacy
 * `synthesize` fallback for backend variants that only expose the web
 * synthesis route.
 */
async function requestGeneratedImage(tokenStore, config, auth, prompt, size, quality, signal) {
	const model = typeof config.imageModel === "string" && config.imageModel.length > 0 ? config.imageModel : DEFAULT_IMAGE_MODEL;
	const headers = tokenStore.authHeaders(auth.token, auth.accountId);
	const attempts = auth.mode === "apikey" ? [{
		url: `${config.apiBaseURL ?? OPENAI_API_BASE_URL}/images/generations`,
		body: { model, prompt, ...size !== void 0 ? { size } : {}, ...quality !== void 0 ? { quality } : {} }
	}] : [{
		url: `${config.baseURL ?? CHATGPT_BACKEND_BASE_URL}/images/generations`,
		body: { model, prompt, ...size !== void 0 ? { size } : {}, ...quality !== void 0 ? { quality } : {} }
	}, {
		url: "https://chatgpt.com/backend-api/synthesize",
		body: { prompt, image_generation_mode: model, ...size !== void 0 ? { size } : {}, ...quality !== void 0 ? { quality } : {} }
	}];
	let lastError;
	for (const attempt of attempts) {
		try {
			const payload = await postImageGeneration(attempt.url, attempt.body, headers, signal);
			const extracted = await imageBytesFromPayload(payload, headers, signal);
			if (extracted === void 0) throw new Error(`image endpoint ${attempt.url} returned no inline image bytes`);
			return {
				...extracted,
				name: `generated-${Date.now()}.${extracted.mediaType === "image/jpeg" ? "jpg" : extracted.mediaType.split("/")[1] ?? "png"}`
			};
		} catch (error) {
			lastError = error;
			if (signal?.aborted) throw error;
		}
	}
	throw lastError ?? new Error("no image endpoint available");
}
/**
 * Scan the live session log backwards for the most recent image the
 * conversation carries — a user upload, a generated image nested in a tool
 * result, or an echoed assistant image block. Used as the automatic source
 * for image edits.
 * @param session - the executing agent's live session, or undefined.
 * @returns the newest image attachment ref, or undefined.
 */
function latestConversationImageRef(session) {
	const events = session?.events;
	if (events === void 0) return void 0;
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.type === "user/message") {
			for (const block of event.data?.content ?? []) {
				if (block?.type === "image" && block.attachment !== void 0) return block.attachment;
				if (block?.type === "tool-result") {
					for (const part of block.content ?? []) {
						if (part?.type === "image" && part.attachment !== void 0) return part.attachment;
					}
				}
			}
			continue;
		}
		if (event?.type === "tool/result") {
			// Tool results are surface events carrying the result message; a
			// generated image lives inside its tool-result blocks.
			for (const block of event.data?.message?.content ?? []) {
				if (block?.type !== "tool-result") continue;
				for (const part of block.content ?? []) {
					if (part?.type === "image" && part.attachment !== void 0) return part.attachment;
				}
			}
			continue;
		}
		if (event?.type === "assistant/message") {
			// Echoed tool-result images ride as assistant image blocks.
			for (const block of event.data?.message?.content ?? []) {
				if (block?.type === "image" && block.attachment !== void 0) return block.attachment;
			}
		}
	}
	return void 0;
}
/**
 * Ask the account backend to EDIT one source image. The chatgpt backend's
 * edit route expects a JSON `images` parameter (its own protocol — the
 * multipart form and the singular `image` field are both rejected), so the
 * request walks candidate shapes for that field and records every rejection:
 * data-URL strings, `image_url`/`url` objects, raw base64, `b64_json`
 * objects, then multipart as a last resort. The public API (API-key mode)
 * keeps the documented multipart form first. The first attempt that returns
 * inline image bytes wins.
 */
async function requestEditedImage(tokenStore, config, auth, sourceRef, sourceData, prompt, size, quality, signal, debug) {
	const model = typeof config.imageModel === "string" && config.imageModel.length > 0 ? config.imageModel : DEFAULT_IMAGE_MODEL;
	const headers = tokenStore.authHeaders(auth.token, auth.accountId);
	const mediaType = sourceRef.mediaType ?? "image/png";
	const base64 = Buffer.from(sourceData.buffer, sourceData.byteOffset, sourceData.byteLength).toString("base64");
	const dataUrl = `data:${mediaType};base64,${base64}`;
	const extras = { ...size !== void 0 ? { size } : {}, ...quality !== void 0 ? { quality } : {} };
	const base = auth.mode === "apikey" ? config.apiBaseURL ?? OPENAI_API_BASE_URL : config.baseURL ?? CHATGPT_BACKEND_BASE_URL;
	const url = `${base}/images/edits`;
	const buildMultipart = () => {
		const form = new FormData();
		form.set("model", model);
		form.set("prompt", prompt);
		form.set("image", new Blob([sourceData], { type: mediaType }), sourceRef.name ?? "source.png");
		if (size !== void 0) form.set("size", size);
		if (quality !== void 0) form.set("quality", quality);
		return form;
	};
	const imageShapes = [[{ image_url: dataUrl }], [{ image_url: { url: dataUrl } }], [{ image: dataUrl }], [{ file: dataUrl }]];
	const attempts = auth.mode === "apikey" ? [{ kind: "multipart" }, ...imageShapes.map((images) => ({ kind: "json", body: { model, prompt, images, ...extras } }))] : [...imageShapes.map((images) => ({ kind: "json", body: { model, prompt, images, ...extras } })), { kind: "multipart" }];
	let lastError;
	for (let index = 0; index < attempts.length; index++) {
		const attempt = attempts[index];
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: attempt.kind === "json" ? { "content-type": "application/json", ...headers } : headers,
				body: attempt.kind === "json" ? JSON.stringify(attempt.body) : buildMultipart(),
				signal
			});
			if (!response.ok) {
				const detail = (await response.text().catch(() => "")).slice(0, 300);
				throw new Error(`HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`);
			}
			const payload = await response.json();
			const extracted = await imageBytesFromPayload(payload, headers, signal);
			if (extracted === void 0) throw new Error("no inline image bytes in response");
			return {
				...extracted,
				name: `edited-${Date.now()}.${extracted.mediaType === "image/jpeg" ? "jpg" : extracted.mediaType.split("/")[1] ?? "png"}`
			};
		} catch (error) {
			lastError = error;
			const shape = attempt.body?.images?.[0] ?? "multipart";
			debug?.(`image edit attempt ${index + 1}/${attempts.length} (${attempt.kind}, ${typeof shape === "string" ? "string" : "object"}) failed: ${error?.message ?? error}`);
			if (signal?.aborted) throw error;
		}
	}
	throw lastError ?? new Error("image edit endpoint unavailable");
}
/**
 * Build the `generate_image` harness tool. Unlike the wire-level
 * image_generation tool (which the chatgpt backend ignores), this tool is
 * registered in the harness tool registry, so the model's prompt enumerates
 * it and the shell executes it natively. The result content carries an image
 * block persisted through the attachment store — the same shape read_image
 * uses, so the conversation UI renders it and the adapter replays it as an
 * input_image part on later turns.
 */
function generateImageToolDefinition(tokenStore, config, resolveAttachments, resolveDebugPath) {
	return defineTool({
		name: IMAGE_TOOL_NAME,
		description: "Generate or edit an image with the connected ChatGPT/OpenAI account (gpt-image model). Call this whenever the user asks to generate, draw, create, or design an image; to EDIT an existing image (change colors, style, or details while keeping the rest), set edit_latest_image to true — the tool then uses the most recent image already in the conversation as the source. The image is returned as part of this tool's result — never claim an image was generated or edited unless this tool actually returned one.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Detailed visual description. For a new image: the full subject, style, composition, lighting, palette. For an edit: describe only the desired changes and what must stay unchanged. Write it in the user's language when possible."
			},
			edit_latest_image: {
				type: "boolean",
				description: "Set to true to edit the most recent image already in the conversation (image-to-image): only the described changes are applied and everything else is kept. Requires an image in the conversation; leave unset for a brand-new image."
			},
			size: {
				type: "string",
				enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
				description: "Output size; omit or use auto for the model default."
			},
			quality: {
				type: "string",
				enum: ["low", "medium", "high", "auto"],
				description: "Output quality; omit or use auto for the model default."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					prompt: {
						type: "string",
						required: true
					},
					ref: {
						type: "json",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Generated image (${value.ref.mediaType ?? "image"}, ${value.ref.width ?? "?"}x${value.ref.height ?? "?"}, ${value.ref.bytes ?? "?"} bytes).`
			}, {
				type: "image",
				attachment: value.ref
			}]
		},
		timeoutMs: 180000,
		isConcurrencySafe: () => false,
		execute: async (args, exec) => {
			const store = resolveAttachments();
			if (store === void 0) throw new Error("the harness attachment store is unavailable; generated images cannot be stored");
			const prompt = String(args.prompt ?? "").trim();
			if (prompt.length === 0) throw new Error("prompt must be a non-empty string");
			const auth = await tokenStore.getToken();
			const options = config();
			const edit = args.edit_latest_image === true;
			let extracted;
			if (edit) {
				const sourceRef = latestConversationImageRef(exec.agent?.session);
				if (sourceRef === void 0) throw new Error("edit_latest_image was requested but the conversation carries no image yet; ask the user to upload an image first, or generate one");
				const source = await store.readImage(sourceRef, exec.signal);
				const debugPath = resolveDebugPath?.();
				extracted = await requestEditedImage(tokenStore, options, auth, sourceRef, source.data, prompt, args.size, args.quality, exec.signal, (message) => {
					if (debugPath !== void 0) appendImageDebug(debugPath, message);
				});
			} else {
				extracted = await requestGeneratedImage(tokenStore, options, auth, prompt, args.size, args.quality, exec.signal);
			}
			const ref = await store.saveImage({
				data: extracted.data,
				mediaType: extracted.mediaType,
				name: extracted.name
			});
			return {
				prompt,
				ref
			};
		}
	});
}
//#endregion
//#region plugin: register the provider route
const name = "dsh-plugin-subhub";
const inject = ["llm"];
const NS = settingsNamespace("dsh-plugin-subhub-openai");
const Config = z.object({
	authFile: z.string(),
	baseURL: z.string(),
	apiBaseURL: z.string(),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	modelsCacheTtlMs: z.number().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODELS_CACHE_TTL_MS),
	defaultReasoningEffort: z.union(["low", "medium", "high", "xhigh", "max", "ultra"]),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	// Whether requests may carry the server-side image_generation tool.
	enableImageTool: z.boolean().default(true),
	// Images-API model used by the generate_image harness tool.
	imageModel: z.string(),
	retryPolicy: RetryPolicySchema
});
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
function resolveAdapterOptions(config) {
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("openai: defaultContextWindow must be a positive integer");
	if (config.defaultReasoningEffort !== void 0 && !WIRE_EFFORT_VALUES.has(config.defaultReasoningEffort)) throw new Error(`openai: defaultReasoningEffort must be one of ${[...WIRE_EFFORT_VALUES].join(", ")}`);
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`openai: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const modelsCacheTtlMs = config.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
	if (!Number.isFinite(modelsCacheTtlMs) || modelsCacheTtlMs <= 0) throw new Error("openai: modelsCacheTtlMs must be a positive finite number");
	return {
		authFile: config.authFile,
		baseURL: config.baseURL,
		apiBaseURL: config.apiBaseURL,
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		modelsCacheTtlMs,
		defaultReasoningEffort: config.defaultReasoningEffort,
		streamIdleTimeoutMs,
		enableImageTool: config.enableImageTool ?? true,
		imageModel: config.imageModel,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "openai: retryPolicy")
	};
}
/**
 * Register the `dsh-plugin-subhub-openai` provider route on `ctx.llm`.
 * Connection facts resolve per request from the optional
 * `dsh-plugin-subhub-openai:` settings section (hot-reloaded, what the web
 * Models page writes) over the composition entry, and the OAuth access token
 * resolves through the OpenAITokenStore, so a refreshed login reaches the
 * very next request without restarting anything.
 */
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("openai: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const tokenStore = new OpenAITokenStore(options, ctx.logger);
	// The harness loader mounts entries concurrently, so an apply-time
	// `ctx.get("attachments")` can race the attachment store's mount and
	// capture undefined forever. Keep the value reactive (ctx.inject
	// re-delivers whenever the service appears) and re-read on demand, the
	// same pattern the harness's own adapters use.
	let attachments = ctx.get("attachments");
	ctx.inject(["attachments"], (attachmentCtx) => {
		attachments = attachmentCtx.attachments;
	});
	// Provider display name follows the harness language: an explicit choice
	// in the `locale` settings namespace wins; until the user picks one, the
	// shell follows the browser language, which the host learns from the
	// Accept-Language header of the hub page's API calls (see onLanguageHint
	// below). Unset with no hint falls back to Chinese.
	const localePreference = () => {
		const settings = ctx.get("settings");
		if (settings === void 0) return void 0;
		const locale = settings.get("locale");
		const preference = locale !== null && typeof locale === "object" ? locale.preference : void 0;
		return typeof preference === "string" && preference.length > 0 ? preference : void 0;
	};
	let inferredLocale;
	const providerDisplayName = () => (localePreference() ?? inferredLocale) === "en" ? "OpenAI subscription" : "OpenAI 订阅";
	// The agent preset's default model, read on demand for the delegation
	// directive's model-scope guidance (subagent children always resolve
	// against this default, never against the session's selected model).
	const presetDefaultModel = () => {
		const settings = ctx.get("settings");
		if (settings === void 0) return void 0;
		const raw = settings.get("agent-default-model");
		if (raw === null || typeof raw !== "object") return void 0;
		return typeof raw.provider === "string" && typeof raw.model === "string" ? { provider: raw.provider, model: raw.model } : void 0;
	};
	const adapter = new OpenAIAdapter({
		options,
		tokenStore,
		resolveAttachments: () => attachments ?? ctx.get("attachments"),
		displayName: providerDisplayName,
		presetDefaultModel,
		logger: ctx.logger
	});
	// The provider only becomes visible in the Models page and the model
	// picker after the user authenticated through the plugin's own login
	// flow. BOTH registrations are gated: the configurable-provider directory
	// entry is what the Models page's provider list renders (the adapter only
	// flips its `active` flag), and the adapter registration is what puts
	// models into the picker. Login and logout (un)register both; the pages
	// refresh on `llm/adapters-updated`.
	let directoryHandle;
	let registration;
	let registeredPolicy;
	// The generate_image harness tool follows the same login gate as the
	// provider: it exists only while credentials are on disk, and the tools
	// service may mount after this row, so the registration rides the same
	// reactive inject pattern as the attachment store below.
	let toolsService = ctx.get("tools");
	let unregisterImageTool;
	const syncImageTool = () => {
		const shouldRegister = tokenStore.hasTokens();
		if (shouldRegister && toolsService !== void 0) {
			if (unregisterImageTool === void 0) unregisterImageTool = toolsService.register(generateImageToolDefinition(tokenStore, options, () => attachments ?? ctx.get("attachments"), () => adapter.imageDebugLogPath()));
		} else if (!shouldRegister && unregisterImageTool !== void 0) {
			unregisterImageTool();
			unregisterImageTool = void 0;
		}
	};
	ctx.inject(["tools"], (toolCtx) => {
		toolsService = toolCtx.tools;
		syncImageTool();
	});
	const syncRegistration = () => {
		const shouldRegister = tokenStore.hasTokens();
		if (shouldRegister) {
			if (directoryHandle === void 0) directoryHandle = ctx.llm.registerConfigurableProviders([{
				provider: PROVIDER,
				displayName: providerDisplayName(),
				settingsNs: NS,
				settingsPath: []
			}]);
			if (registration === void 0) {
				registration = ctx.llm.registerAdapter([PROVIDER], adapter);
				registeredPolicy = options().retryPolicy;
			}
		} else {
			if (registration !== void 0) {
				registration();
				registration = void 0;
				registeredPolicy = void 0;
			}
			if (directoryHandle !== void 0) {
				directoryHandle();
				directoryHandle = void 0;
			}
		}
		syncImageTool();
	};
	syncRegistration();
	const syncDisplayName = () => {
		if (directoryHandle === void 0) return;
		directoryHandle.replace([{
			provider: PROVIDER,
			displayName: providerDisplayName(),
			settingsNs: NS,
			settingsPath: []
		}]);
	};
	ctx.on("settings/updated", (ns) => {
		if (ns === "locale") syncDisplayName();
	});
	const ensureRegistrationFacts = () => {
		if (registration === void 0) return;
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	// Settings may arrive after this row mounts (and can change authFile), so
	// the gating re-evaluates whenever the settings source wires or changes.
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {
			ensureRegistrationFacts();
			syncRegistration();
		}
	});
	syncRegistration();
	// Browser-side login API (web profiles only): the third-party
	// subscriptions page drives the device-code flow through these routes.
	// The webserver service can mount after this row, so the route rides its
	// own inject scope and appears whenever the service does.
	const login = createLoginController(tokenStore, ctx.logger, syncRegistration, () => adapter.listModels(PROVIDER), (lang) => {
		inferredLocale = lang;
		syncDisplayName();
	});
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: LOGIN_API_PATH,
			handler: (req, res) => void login.handle(req, res)
		}), "openai: login api route");
	});
	// Additional subscription providers ride the shared pi-ai-backed core
	// (src/piai.js). Each spec owns its provider-specific facts; the core
	// owns the login API, the credential file, the settings section, and
	// the login-gated directory + adapter registration, with the same four
	// registration triggers the OpenAI provider uses.
	registerXai(ctx, config);
	registerGithub(ctx, config);
	registerAnthropic(ctx, config);
	registerGoogle(ctx, config);
	registerKimi(ctx, config);
}
//#endregion
export { CHATGPT_BACKEND_BASE_URL, OpenAIAdapter, OpenAITokenStore, Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS, OPENAI_API_BASE_URL, PROVIDER, REASONING_EFFORTS, apply, applyDelegationDirective, applyImageGenerationDirective, inject, latestConversationImageRef, name, registerAnthropic, registerGithub, registerGoogle, registerKimi, registerXai, resolveAdapterOptions };
