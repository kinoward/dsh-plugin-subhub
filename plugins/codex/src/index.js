// kino-codex: use a Codex subscription account (ChatGPT OAuth) as an LLM
// provider in the DeepSeek Harness.
//
// The adapter follows the same shape as the official llm-deepseek adapter:
// it registers the `codex` provider route on ctx.llm, resolves credentials
// per request, and translates the Responses-API SSE stream into harness
// StreamChunks. Authentication is OAuth-token based: tokens are read from
// `~/.codex/auth.json` (written by the official codex CLI) or from
// `~/.kino-dsh/codex-auth.json` (written by the bundled login script), and
// are refreshed through auth.openai.com before they expire.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, CallId, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { authFilePayload, exchangeAuthorizationCode, pollAuthorizationOnce, requestUserCode } from "./device-flow.js";
//#region serialize: harness messages -> Responses API input
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The Codex adapter does not support image content.", "UNSUPPORTED_CONTENT");
}
/** Validate the adapter-owned reasoning effort before putting it on the wire. */
function reasoningEffort(effort) {
	if (effort === "low" || effort === "medium" || effort === "high") return effort;
	throw new LlmError(`Codex models do not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
/**
 * Serialize the conversation into Responses API input items. Assistant text
 * becomes a message item and every assistant tool call becomes its own flat
 * `function_call` item (the Codex backend rejects the public API's embedded
 * `tool_calls` array); every tool result becomes a `function_call_output`
 * item correlated by `call_id`. The harness `system` field is handled by the
 * caller through `instructions`. Reasoning blocks from history are dropped:
 * Codex reasoning is model-internal and cannot be replayed. Assistant turns
 * that produced neither text nor tool calls contribute no item.
 * @param messages - the harness conversation, in order.
 * @returns the wire input items.
 */
function serializeInput(messages) {
	const items = [];
	for (const message of messages) {
		assertTextOnly(message.content);
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			const text = flattenText(message.content);
			const toolCalls = message.content.filter((block) => block.type === "tool-call");
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
			continue;
		}
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const text = flattenText(message.content);
		if (text.length > 0 || toolResults.length === 0) items.push({
			role: "user",
			content: [{ type: "input_text", text }]
		});
		for (const result of toolResults) items.push({
			type: "function_call_output",
			call_id: result.toolCallId,
			output: flattenText(result.content) || "(no output)"
		});
	}
	return items;
}
/**
 * Build the full Responses API request. Always streaming. The Codex backend
 * accepts neither stop sequences nor an output token cap (the official CLI
 * sends neither), so `options.stop` and `options.maxTokens` are deliberately
 * ignored; runaway output is bounded by the harness's own timeout policies.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @returns the Responses API request body.
 */
function serializeRequest(options) {
	const tools = options.tools?.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	return {
		model: options.model,
		stream: true,
		// The Codex backend rejects requests without an explicit store value.
		store: false,
		...options.system !== void 0 ? { instructions: options.system } : {},
		input: serializeInput(options.messages),
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.reasoningEffort !== void 0 ? { reasoning: { effort: reasoningEffort(options.reasoningEffort) } } : {}
	};
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
		yield data;
	}
}
//#endregion
//#region translate: Responses API events -> harness StreamChunks
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
 * `function_call_arguments.delta` events. Usage and finish are deferred to
 * the terminal event (`response.completed` / `response.incomplete` /
 * `response.failed`); a stream that ends without one is untrusted and throws.
 * @param payloads - SSE data payloads from {@link parseSse}.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` last.
 */
async function* translate(payloads) {
	let nextIndex = 0;
	const items = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
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
	for await (const payload of payloads) {
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		switch (event.type) {
			case "response.output_item.added": {
				const item = event.item;
				if (item?.type === "function_call") {
					const block = open(item.id, "tool-call", item.name, item.call_id ?? item.id);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
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
				pendingUsage = event.response?.usage !== void 0 ? mapUsage(event.response.usage) : void 0;
				pendingFinish = order.some((block) => block.kind === "tool-call") ? { kind: "tool-calls" } : { kind: "stop" };
				break;
			}
			case "response.incomplete": {
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
			default: break;
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
//#region auth: Codex OAuth token store
/** OAuth application id shared by the official codex CLI (login + refresh). */
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Token endpoint the official codex CLI refreshes ChatGPT tokens through. */
const REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Refresh proactively this far before the access token's JWT expiry. */
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
/** How long to wait for another process holding the refresh lock. */
const REFRESH_LOCK_WAIT_MS = 5000;
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
 * Owns one Codex credential source: an auth.json in the official codex CLI
 * shape (`auth_mode`, `OPENAI_API_KEY`, `tokens.{access_token, refresh_token,
 * id_token, account_id}`). Reads are cheap and cache-free; the only memory is
 * the single-flight refresh promise. When the access token nears expiry the
 * store re-reads the file (another process may already have refreshed it),
 * refreshes through auth.openai.com under a lock file, and persists the
 * rotated tokens back with mode 0600.
 */
class CodexTokenStore {
	constructor(options, logger) {
		this.options = options;
		this.logger = logger;
		this.refreshing = void 0;
		this.catalog = void 0;
		this.catalogAt = 0;
		this.catalogFailureAt = 0;
	}
	/**
	 * The one credential file this plugin owns. It never reads another
	 * program's auth files (the codex CLI's `~/.codex/auth.json` included)
	 * unless the user points `authFile` at one explicitly — installing this
	 * plugin must not silently reuse credentials the user granted to other
	 * software.
	 */
	authFilePath() {
		const config = this.options();
		if (config.authFile !== void 0 && config.authFile.trim() !== "") return config.authFile.trim();
		return join(homedir(), ".kino-dsh", "codex-auth.json");
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
		if (file === void 0) throw new LlmError(`codex: no authentication found at ${path}; sign in with "codex login" or run the bundled login script (plugins/codex/login.js)`, "MISSING_CREDENTIAL");
		const apiKey = file.OPENAI_API_KEY;
		if (typeof apiKey === "string" && apiKey.length > 0) return {
			token: apiKey,
			mode: "apikey",
			accountId: void 0
		};
		const tokens = file.tokens;
		if (tokens === void 0 || typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new LlmError(`codex: ${path} has no usable tokens; sign in with "codex login" or run the bundled login script`, "MISSING_CREDENTIAL");
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
				await sleep(150);
			}
		}
		try {
			const file = this.readFile(path);
			const tokens = file?.tokens;
			if (tokens === void 0) throw new LlmError(`codex: ${path} has no tokens; sign in again`, "MISSING_CREDENTIAL");
			const exp = decodeJwtExp(tokens.access_token);
			if (exp !== void 0 && exp - Date.now() > ACCESS_TOKEN_REFRESH_WINDOW_MS) return tokens;
			if (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length === 0) throw new LlmError(`codex: ${path} has no refresh token; sign in again`, "INVALID_CREDENTIAL");
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
				throw new LlmError(`codex: token refresh failed (HTTP ${response.status}); sign in again with "codex login"`, "INVALID_CREDENTIAL", {
					status: response.status,
					cause: new Error(body.slice(0, 300))
				});
			}
			const next = await response.json();
			if (typeof next.access_token !== "string" || next.access_token.length === 0) throw new LlmError("codex: token refresh returned no access token", "INVALID_CREDENTIAL");
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
		} catch (error) {
			this.logger?.warn(`codex: could not persist refreshed tokens to ${path}: ${error?.message ?? error}`);
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
		if (this.catalog !== void 0 && now - this.catalogAt < config.modelsCacheTtlMs) return this.catalog;
		if (now - this.catalogFailureAt < 60000) return void 0;
		const { token, mode, accountId } = await this.getToken();
		const baseURL = effectiveBaseURL(config, mode);
		const response = await fetch(`${baseURL}/models?client_version=0.0.0`, {
			headers: this.authHeaders(token, accountId)
		});
		if (!response.ok) {
			this.catalogFailureAt = now;
			throw new LlmError(`codex: model catalog request failed (HTTP ${response.status})`, httpErrorCode(response.status, void 0), { status: response.status });
		}
		const body = await response.json();
		const raw = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
		this.catalog = raw.filter((entry) => typeof entry?.slug === "string" || typeof entry?.id === "string").map((entry) => ({
			provider: PROVIDER,
			id: entry.slug ?? entry.id,
			name: entry.display_name ?? entry.name ?? entry.slug ?? entry.id,
			...typeof entry.description === "string" && entry.description !== "" ? { description: entry.description } : {},
			inputModalities: ["text"]
		}));
		this.catalogAt = now;
		return this.catalog;
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
/** Codex backend the official codex CLI talks to with ChatGPT OAuth tokens. */
const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Public Responses API used when the credential is an API key. */
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
/** Provider route this plugin owns. */
const PROVIDER = "codex";
const LOW_REASONING_EFFORT = ReasoningEffortId("low");
const MEDIUM_REASONING_EFFORT = ReasoningEffortId("medium");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
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
/** Static fallback catalog used when the endpoint cannot be reached. */
const DEFAULT_MODELS = [
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6-Sol",
		contextWindow: DEFAULT_CONTEXT_WINDOW
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6-Terra",
		contextWindow: DEFAULT_CONTEXT_WINDOW
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		contextWindow: DEFAULT_CONTEXT_WINDOW
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: DEFAULT_CONTEXT_WINDOW
	},
	{
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3-Codex-Spark",
		contextWindow: DEFAULT_CONTEXT_WINDOW
	}
];
/** Pick the endpoint for one credential mode. */
function effectiveBaseURL(config, mode) {
	if (mode === "apikey") return config.apiBaseURL ?? OPENAI_API_BASE_URL;
	return config.baseURL ?? CHATGPT_CODEX_BASE_URL;
}
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: ["text"]
	};
}
/**
 * `CodexAdapter`: fetch + SSE against the Codex backend's Responses API,
 * emitting harness StreamChunks. Connection facts and the bearer token are
 * resolved once per operation, so auth rotation reaches the very next
 * request without restarting anything.
 */
var CodexAdapter = class extends LlmAdapter {
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "OpenAI 订阅"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		const config = this.config.options();
		return this.config.tokenStore.listModels(config).then((remote) => {
			const merged = [...(remote ?? [])];
			const seen = new Set(merged.map((model) => model.id));
			for (const model of config.models) if (!seen.has(model.id)) merged.push(modelInfo(provider, model));
			return merged;
		}).catch((error) => {
			if (error?.code !== "MISSING_CREDENTIAL") {
				this.config.logger?.warn("codex: model catalog unavailable, using configured models");
				this.config.logger?.warn(error);
			}
			return config.models.map((model) => modelInfo(provider, model));
		});
	}
	resolveModel(provider, model) {
		const config = this.config.options();
		const configured = config.models.find((entry) => entry.id === model);
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : modelInfo(provider, configured),
			context: {
				contextWindow: configured?.contextWindow ?? config.defaultContextWindow
			},
			reasoning: {
				efforts: REASONING_EFFORTS,
				...config.defaultReasoningEffort !== void 0 ? { defaultEffort: ReasoningEffortId(config.defaultReasoningEffort) } : {}
			}
		});
	}
	async *stream(options) {
		const connection = this.config.options();
		const auth = await this.config.tokenStore.getToken();
		const baseURL = effectiveBaseURL(connection, auth.mode);
		const consumer = new AbortController();
		const watchdog = idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT");
		const iterator = this.request(options, watchdog.signal, baseURL, auth, () => {
			watchdog.pulse();
		})[Symbol.asyncIterator]();
		let exhausted = false;
		try {
			while (true) {
				const result = await watchdog.next(iterator);
				if (result.done) {
					exhausted = true;
					return;
				}
				yield result.value;
			}
		} catch (error) {
			if (timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT") !== void 0) throw new LlmError(`Codex stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
			if (options.signal?.aborted) throw new LlmError("Codex request aborted by caller", "ABORTED", { cause: error });
			if (error instanceof LlmError) throw error;
			throw new LlmError(`Codex API stream from ${baseURL} failed`, "TRANSPORT", { cause: error });
		} finally {
			consumer.abort("Codex stream consumer stopped");
			if (!exhausted && iterator.return !== void 0) try {
				await iterator.return();
			} catch (_abortedTransportTeardown) {}
		}
	}
	async *request(options, signal, baseURL, auth, onComment) {
		const body = serializeRequest(options);
		const headers = {
			...this.config.tokenStore.authHeaders(auth.token, auth.accountId),
			"content-type": "application/json",
			"accept": "text/event-stream"
		};
		let response;
		try {
			response = await fetch(`${baseURL}/responses`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal
			});
		} catch (error) {
			if (signal.aborted) throw error;
			throw new LlmError(`Codex API request to ${baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (!response.ok) {
			let message = `Codex API error (HTTP ${response.status})`;
			let providerError;
			try {
				const body = await response.json();
				providerError = body?.error ?? (body?.detail !== void 0 ? { message: typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail) } : void 0);
				if (providerError?.message) message = providerError.message;
			} catch {}
			const delay = providerRetryAfterMs(response.headers.get("retry-after"));
			const id = response.headers.get("x-request-id");
			throw new LlmError(message, httpErrorCode(response.status, providerError), {
				status: response.status,
				...delay === void 0 ? {} : { providerRetryAfterMs: delay },
				...id === null || id === "" ? {} : { requestId: ProviderRequestId(id) }
			});
		}
		if (!response.body) throw new LlmError("Codex API returned no response body", "EMPTY_RESPONSE");
		yield* translate(parseSse(response.body, onComment));
	}
};
//#endregion
//#region login api: browser-side device login through the web server
/** API prefix the client settings page talks to (same-origin fetch). */
const LOGIN_API_PATH = "/api/kino-codex";
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
/** Read a small JSON body, rejecting oversized or malformed input. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 65536) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
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
 * Owns the one pending device-login flow and answers the third-party
 * subscriptions page's login API. Token values never cross the wire: the
 * browser only ever sees the public verification URL / one-time code and
 * plain status results. `onAuthChanged` runs after every login/logout so the
 * owning plugin can (un)register the provider route.
 */
function createLoginController(tokenStore, logger, onAuthChanged) {
	let pending;
	const notify = () => {
		try {
			onAuthChanged?.();
		} catch (error) {
			logger?.warn(`codex: onAuthChanged failed: ${error?.message ?? error}`);
		}
	};
	return {
		hasPending: () => pending !== void 0,
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
			try {
				if (path === `${LOGIN_API_PATH}/login/status` && req.method === "GET") {
					sendJson(res, 200, {
						ok: true,
						loggedIn: tokenStore.hasTokens(),
						authFile: tokenStore.writeFilePath(),
						pending: pending !== void 0
					});
					return;
				}
				if (path === `${LOGIN_API_PATH}/login/start` && req.method === "POST") {
					const flow = await requestUserCode();
					pending = flow;
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
					tokenStore.persist(target, authFilePayload(tokens));
					pending = void 0;
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
				sendJson(res, 404, {
					ok: false,
					code: "not-found",
					message: "not found"
				});
			} catch (error) {
				logger?.warn(`codex: login api failed: ${error?.message ?? error}`);
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
//#region plugin: register the provider route
const name = "codex";
const inject = ["llm"];
const NS = settingsNamespace("codex");
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1)
});
const Config = z.object({
	authFile: z.string(),
	baseURL: z.string(),
	apiBaseURL: z.string(),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	modelsCacheTtlMs: z.number().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODELS_CACHE_TTL_MS),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	defaultReasoningEffort: z.union(["low", "medium", "high"]),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
/** Validate the configured catalog entries. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		if (model.id.length === 0) throw new Error("codex: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`codex: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`codex: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (seen.has(model.id)) throw new Error(`codex: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }
		};
	});
}
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
function resolveAdapterOptions(config) {
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("codex: defaultContextWindow must be a positive integer");
	if (config.defaultReasoningEffort !== void 0 && config.defaultReasoningEffort !== "low" && config.defaultReasoningEffort !== "medium" && config.defaultReasoningEffort !== "high") throw new Error("codex: defaultReasoningEffort must be low, medium, or high");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`codex: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const modelsCacheTtlMs = config.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
	if (!Number.isFinite(modelsCacheTtlMs) || modelsCacheTtlMs <= 0) throw new Error("codex: modelsCacheTtlMs must be a positive finite number");
	return {
		authFile: config.authFile,
		baseURL: config.baseURL,
		apiBaseURL: config.apiBaseURL,
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		modelsCacheTtlMs,
		models: resolveModels(config.models),
		defaultReasoningEffort: config.defaultReasoningEffort,
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "codex: retryPolicy")
	};
}
/**
 * Register the `codex` provider route on `ctx.llm`. Connection facts resolve
 * per request from the optional `codex:` settings section (hot-reloaded, what
 * the web Models page writes) over the composition entry, and the OAuth
 * access token resolves through the CodexTokenStore, so a refreshed login
 * reaches the very next request without restarting anything.
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
			ctx.logger.error("codex: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const tokenStore = new CodexTokenStore(options, ctx.logger);
	const adapter = new CodexAdapter({
		options,
		tokenStore,
		logger: ctx.logger
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "OpenAI 订阅",
		settingsNs: NS,
		settingsPath: []
	}]);
	// The provider route only appears once the user authenticated through the
	// plugin's own login flow: registering the adapter is what puts the
	// provider into the model picker and the Models page (both refresh on
	// `llm/adapters-updated`), so login and logout gate visibility directly.
	let registration;
	let registeredPolicy;
	const syncRegistration = () => {
		const shouldRegister = tokenStore.hasTokens();
		if (shouldRegister && registration === void 0) {
			registration = ctx.llm.registerAdapter([PROVIDER], adapter);
			registeredPolicy = options().retryPolicy;
		} else if (!shouldRegister && registration !== void 0) {
			registration();
			registration = void 0;
			registeredPolicy = void 0;
		}
	};
	syncRegistration();
	const ensureRegistrationFacts = () => {
		if (registration === void 0) return;
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
	// Browser-side login API (web profiles only): the third-party
	// subscriptions page drives the device-code flow through these routes.
	// The webserver service can mount after this row, so the route rides its
	// own inject scope and appears whenever the service does.
	const login = createLoginController(tokenStore, ctx.logger, syncRegistration);
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: LOGIN_API_PATH,
			handler: (req, res) => void login.handle(req, res)
		}), "codex: login api route");
	});
}
//#endregion
export { CHATGPT_CODEX_BASE_URL, CodexAdapter, CodexTokenStore, Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS, OPENAI_API_BASE_URL, PROVIDER, REASONING_EFFORTS, apply, inject, name, resolveAdapterOptions };
