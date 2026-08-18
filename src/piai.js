// dsh-plugin-subhub: reusable pi-ai-backed provider core.
//
// Every subscription provider added after the hand-written OpenAI adapter
// shares the same three pieces, built here on top of the harness's own
// provider library (`@earendil-works/pi-ai`, the same library the built-in
// llm-pi-ai adapter uses):
//
// 1. FileCredentialStore — the plugin-owned credential file per provider
//    (`~/.dsh-plugin-subhub/<provider>-auth.json` by default, 0600, deleted
//    on logout, honoring the section's `authFile` setting) implementing
//    pi-ai's CredentialStore contract, so pi-ai's login/refresh/toAuth
//    machinery reads and writes ONLY the plugin's own file.
// 2. createPiAiLoginController — the browser-side login API routes
//    (`/api/dsh-plugin-subhub/<provider>/login/{status,start,poll,logout}`
//    plus `/models`), which drive pi-ai's OAuth login through an
//    interaction shim: device-code facts surfaced to the page, polling
//    runs inside pi-ai, and the finished credential lands in the store.
// 3. createPiAiAdapter — an LlmAdapter translating harness requests into
//    pi-ai's context vocabulary and pi-ai's simple event stream back into
//    harness StreamChunks. The mapping mirrors the built-in PiAiAdapter's
//    toPiContext/toStreamChunks bridges.
//
// registerSubscriptionProvider wires all three plus the login-gated
// provider-directory registration, the locale-following display name, and
// the settings section, so a new provider is mostly a small spec object
// (see src/providers/xai.js for the first consumer).
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, CallId, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError } from "@deepseek-ai/dsh-llm";
import { deepEqualJson, installSettingsSection } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { createModels, getSupportedThinkingLevels, isContextOverflow } from "@earendil-works/pi-ai";
/** API prefix the client settings page talks to (same-origin fetch). */
const LOGIN_API_PATH = "/api/dsh-plugin-subhub";
/** Refresh locks older than this are stale leftovers from a crashed process. */
const STALE_LOCK_MS = 10 * 60 * 1000;
/** How long to wait for another process holding the refresh lock. */
const LOCK_WAIT_MS = 5000;
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Parse tool-call argument JSON; tolerate model malformations with {}. */
function parseArguments(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
	} catch {}
	return {};
}
//#region browser trust fence + locale hints (mirrors src/index.js)
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
 * hint — the exact language the shell renders in.
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
//#endregion
//#region credential store: plugin-owned file behind pi-ai's CredentialStore
/**
 * One plugin-owned credential file presented as pi-ai's CredentialStore
 * (read/modify/delete keyed by the pi-ai provider id). pi-ai's own login and
 * refresh machinery writes through this store, so subscription credentials
 * land exactly where the plugin's contract says: a 0600 JSON file under
 * `~/.dsh-plugin-subhub/`, deleted on logout, never another program's file.
 *
 * Writes are serialized per provider in-process (a promise chain, mirroring
 * pi-ai's InMemoryCredentialStore) AND guarded across processes by a lock
 * file with stale-lock reclamation, the same pattern the OpenAI token store
 * uses.
 */
class FileCredentialStore {
	constructor(filePath, logger) {
		this.filePath = filePath;
		this.logger = logger;
		this.chains = new Map();
	}
	/** Serialize store mutations per provider id. */
	enqueue(providerId, task) {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = (async () => {
			await previous.catch(() => {});
			return task();
		})();
		this.chains.set(providerId, next.catch(() => {}));
		return next;
	}
	/** Read the credential file without locking; cheap and cache-free. */
	readFileSync() {
		const path = this.filePath();
		try {
			const data = JSON.parse(readFileSync(path, "utf8"));
			if (data !== null && typeof data === "object" && typeof data.type === "string") return data;
		} catch {}
		return void 0;
	}
	/** Whether any usable credential is on disk (sync, for login gating). */
	hasCredentials() {
		return this.readFileSync() !== void 0;
	}
	persist(data) {
		const path = this.filePath();
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(data, void 0, 2) + "\n", { mode: 384 });
			// The write mode only applies to newly created files: re-tighten
			// the permissions so a pre-existing credential file can never
			// stay readable by others.
			chmodSync(path, 384);
			return true;
		} catch (error) {
			this.logger?.warn(`subhub: could not persist credentials to ${path}: ${error?.message ?? error}`);
			return false;
		}
	}
	async read(providerId) {
		return this.readFileSync();
	}
	/** Per-provider serialized update, cross-process locked. */
	modify(providerId, fn) {
		return this.enqueue(providerId, async () => {
			const path = this.filePath();
			const lockPath = `${path}.lock`;
			const deadline = Date.now() + LOCK_WAIT_MS;
			let lock;
			while (lock === void 0 && Date.now() < deadline) {
				try {
					lock = openSync(lockPath, "wx");
				} catch (error) {
					if (error?.code !== "EEXIST") throw error;
					// A crashed process can leave the lock file behind: reclaim
					// clearly stale locks and retry immediately.
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
				const current = this.readFileSync();
				const next = await fn(current);
				if (next !== void 0) this.persist(next);
				return next ?? current;
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
		});
	}
	async delete() {
		const path = this.filePath();
		try {
			rmSync(path, { force: true });
			// Drop a leftover refresh lock together with the file: a stale
			// lock would otherwise delay future refreshes.
			rmSync(`${path}.lock`, { force: true });
		} catch {}
	}
	/** Best-effort directory scan; pi-ai's own flows never call list(). */
	async list() {
		const entries = [];
		try {
			const dir = dirname(this.filePath());
			for (const entry of readdirSync(dir)) {
				if (!entry.endsWith("-auth.json")) continue;
				let data;
				try {
					data = JSON.parse(readFileSync(join(dir, entry), "utf8"));
				} catch {}
				entries.push({
					providerId: entry.slice(0, -"-auth.json".length),
					type: typeof data?.type === "string" ? data.type : "unknown"
				});
			}
		} catch {}
		return entries;
	}
}
/**
 * Non-secret identity of the credential file: path + modification time.
 * The client compares this value to invalidate its warm model-catalog cache
 * after a login or account switch; it carries no token material.
 */
function credentialFingerprint(filePath) {
	try {
		const file = filePath();
		return `${file}:${statSync(file).mtimeMs}`;
	} catch {
		return "none";
	}
}
//#endregion
//#region login controller: browser-side login API driving pi-ai's OAuth
/**
 * Interaction shim translating pi-ai's CLI-style login notifications into
 * facts the browser page can render. `device_code` notifications (xai,
 * kimi, github) surface as the verification URL + one-time code the
 * existing three-step panel already renders; `auth_url` notifications
 * (loopback flows such as anthropic) surface as an authorization link the
 * page opens and the host's loopback server completes.
 */
function createInteraction(state, signal, promptHandler) {
	return {
		signal,
		notify(event) {
			if (event === void 0 || event === null) return;
			if (event.type === "device_code" && state.facts === void 0) {
				state.facts = {
					verificationUrl: event.verificationUri,
					userCode: event.userCode,
					expiresAtMs: Date.now() + (Number.isFinite(event.expiresInSeconds) && event.expiresInSeconds > 0 ? event.expiresInSeconds : 15 * 60) * 1000
				};
				state.resolveFacts(state.facts);
			} else if (event.type === "auth_url" && state.facts === void 0) {
				state.facts = {
					verificationUrl: event.url,
					userCode: void 0,
					expiresAtMs: Date.now() + 15 * 60 * 1000
				};
				state.resolveFacts(state.facts);
			}
		},
		async prompt(input) {
			// Some flows ask a question before showing public facts (GitHub
			// Copilot asks for an Enterprise domain; loopback flows offer a
			// manual code paste). The spec supplies the answer; flows without
			// one keep the honest refusal.
			if (promptHandler !== void 0) return await promptHandler(input);
			throw new Error("interactive prompts are not available in the web login flow");
		}
	};
}
/** Map a pi-ai login rejection to a poll response the client understands. */
function loginFailureToStatus(error) {
	const message = error?.message ?? String(error);
	if (/timed out|expired|slow_down/i.test(message)) return { status: "expired" };
	return { status: "error", message };
}
/**
 * Owns the one pending login flow for a provider and answers the
 * third-party subscriptions page's login API. The browser only ever sees
 * public verification facts and plain status results; token values never
 * cross the wire. `onAuthChanged` runs after every login/logout so the
 * owning plugin can (un)register the provider route, and `onLanguageHint`
 * runs when a request reveals the harness UI language.
 */
function createPiAiLoginController({ slug, providerId, models, store, filePath, logger, onAuthChanged, listCatalog, onLanguageHint, promptHandler }) {
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
			logger?.warn(`${slug}: onAuthChanged failed: ${error?.message ?? error}`);
		}
	};
	/**
	 * Start (or reuse) the shared pi-ai login flow. pi-ai polls the device
	 * endpoint internally until the user approves or the code expires, and
	 * persists the finished credential through the plugin's own store.
	 */
	function startLogin() {
		if (pending !== void 0 && pending.result === void 0) return pending;
		const controller = new AbortController();
		const state = {
			facts: void 0,
			resolveFacts: void 0,
			result: void 0,
			controller
		};
		state.factsReady = new Promise((resolve) => {
			state.resolveFacts = resolve;
		});
		state.promise = models.login(providerId, "oauth", createInteraction(state, controller.signal, promptHandler)).then(() => {
			state.result = { status: "success" };
		}).catch((error) => {
			state.result = loginFailureToStatus(error);
		});
		pending = state;
		return state;
	}
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
				if (path === `${LOGIN_API_PATH}/${slug}/login/status` && req.method === "GET") {
					const loggedIn = store.hasCredentials();
					// The hub page polls this route while mounted. Treat a
					// changed login state as an auth change so that a login
					// performed out of band (a future bundled script) also
					// registers the provider — no restart required.
					if (loggedIn !== lastLoggedIn) {
						lastLoggedIn = loggedIn;
						notify();
					}
					sendJson(res, 200, {
						ok: true,
						loggedIn,
						authFile: filePath(),
						pending: pending !== void 0 && pending.result === void 0,
						fingerprint: credentialFingerprint(filePath)
					});
					return;
				}
				if (path === `${LOGIN_API_PATH}/${slug}/login/start` && req.method === "POST") {
					const state = startLogin();
					// Wait for either the public facts (device code / auth URL)
					// or an immediate failure, whichever comes first.
					await Promise.race([state.factsReady, state.promise]);
					if (state.result !== void 0 && state.facts === void 0) {
						// The flow settled before producing public facts (an
						// immediate failure, or a flow that skipped them).
						pending = void 0;
						sendJson(res, 200, state.result.status === "success" ? {
							ok: true,
							status: "success"
						} : state.result);
						return;
					}
					sendJson(res, 200, {
						ok: true,
						verificationUrl: state.facts.verificationUrl,
						...state.facts.userCode === void 0 ? {} : { userCode: state.facts.userCode },
						expiresAtMs: state.facts.expiresAtMs
					});
					return;
				}
				if (path === `${LOGIN_API_PATH}/${slug}/login/poll` && req.method === "POST") {
					if (pending === void 0) {
						sendJson(res, 200, {
							ok: false,
							code: "no-pending",
							message: "no login in progress"
						});
						return;
					}
					if (pending.result === void 0) {
						sendJson(res, 200, { status: "pending" });
						return;
					}
					const result = pending.result;
					pending = void 0;
					if (result.status === "success") {
						notify();
						sendJson(res, 200, {
							status: "success",
							authFile: filePath()
						});
						return;
					}
					sendJson(res, 200, result);
					return;
				}
				if (path === `${LOGIN_API_PATH}/${slug}/login/logout` && req.method === "POST") {
					if (pending !== void 0) {
						try {
							pending.controller.abort();
						} catch {}
						pending = void 0;
					}
					try {
						await models.logout(providerId);
					} catch {}
					await store.delete();
					notify();
					sendJson(res, 200, {
						ok: true,
						loggedIn: false,
						authFile: filePath()
					});
					return;
				}
				if (path === `${LOGIN_API_PATH}/${slug}/models` && req.method === "GET") {
					const modelsList = typeof listCatalog === "function" ? await listCatalog() : [];
					sendJson(res, 200, {
						ok: true,
						loggedIn: store.hasCredentials(),
						fingerprint: credentialFingerprint(filePath),
						models: Array.isArray(modelsList) ? modelsList : []
					});
					return;
				}
				sendJson(res, 404, {
					ok: false,
					code: "not-found",
					message: "not found"
				});
			} catch (error) {
				logger?.warn(`${slug}: login api failed: ${error?.message ?? error}`);
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
//#region context: harness request history -> pi-ai Context
/** Construct the zero usage value pi-ai expects on assistant history. */
function emptyPiUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
/**
 * Convert one harness assistant message into pi-ai history. Text and tool
 * calls map one to one; reasoning blocks become pi-ai thinking blocks;
 * assistant-produced images cannot be replayed inside an assistant message,
 * so they are re-homed as a following user image message (the same approach
 * the OpenAI adapter uses). The zero usage and stopReason are required:
 * pi-ai's context-token estimation reads `assistant.usage` unconditionally.
 */
function toPiAssistant(message) {
	const content = [];
	for (const block of message.content ?? []) {
		if (block.type === "text" && block.text.length > 0) content.push({ type: "text", text: block.text });
		else if (block.type === "reasoning" && block.text.length > 0) content.push({ type: "thinking", thinking: block.text });
		else if (block.type === "tool-call") content.push({
			type: "toolCall",
			id: block.id,
			name: block.name,
			arguments: parseArguments(block.arguments)
		});
	}
	return {
		role: "assistant",
		content,
		usage: emptyPiUsage(),
		stopReason: content.some((piece) => piece.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0
	};
}
/** Join the text blocks of a harness message. */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : "").join("");
}
/**
 * Resolve harness content blocks into pi-ai content: text blocks become
 * `{type:"text"}`, image blocks are read through the harness attachment
 * store and become inline `{type:"image", data, mimeType}` parts. When the
 * attachment store is missing the caller must have already refused image
 * input; a read failure degrades one image to a text placeholder so a
 * tool-result image never bricks the conversation.
 */
async function toPiContent(blocks, attachments, signal, degradeImages) {
	const content = [];
	for (const block of blocks) {
		if (block.type === "text") {
			if (block.text.length > 0) content.push({ type: "text", text: block.text });
			continue;
		}
		if (block.type !== "image") continue;
		if (attachments === void 0 || degradeImages) {
			content.push({ type: "text", text: `[image omitted]` });
			continue;
		}
		try {
			const { ref, data } = await attachments.readImage(block.attachment, signal);
			content.push({
				type: "image",
				data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"),
				mimeType: ref.mediaType ?? "image/png"
			});
		} catch {
			content.push({ type: "text", text: `[image omitted]` });
		}
	}
	return content;
}
/**
 * Assemble the request-level pi-ai context envelope: the harness system
 * prompt becomes `systemPrompt`, tools keep their JSON-schema shape, and
 * assistant tool-call names are tracked so tool results can carry the
 * matching `toolName`.
 */
async function toPiContext(options, attachments, signal) {
	const toolNames = new Map();
	const messages = [];
	for (const message of options.messages ?? []) {
		if (message.role === "system") {
			if (contentHasImage(message.content)) throw new LlmError("pi-ai cannot represent an image in an in-history system message", "UNSUPPORTED_CONTENT");
			messages.push({
				role: "user",
				content: flattenText(message.content),
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
			if (assistant.content.length > 0) messages.push(assistant);
			// Assistant-produced images ride as a following user message.
			for (const block of message.content ?? []) {
				if (block.type !== "image") continue;
				const parts = await toPiContent([block], attachments, signal, false);
				if (parts.length > 0) messages.push({
					role: "user",
					content: parts,
					timestamp: 0
				});
			}
			continue;
		}
		const text = flattenText(message.content);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (text.length > 0 || results.length === 0) {
			const parts = await toPiContent(message.content.filter((block) => block.type !== "tool-result"), attachments, signal, false);
			messages.push({
				role: "user",
				content: parts.length > 0 ? parts : text.length > 0 ? [{ type: "text", text }] : [{ type: "text", text: "" }],
				timestamp: 0
			});
		}
		for (const result of results) {
			const resultParts = await toPiContent(result.content, attachments, signal, false);
			if (resultParts.length === 0) resultParts.push({ type: "text", text: "(no output)" });
			messages.push({
				role: "toolResult",
				toolCallId: result.toolCallId,
				toolName: toolNames.get(result.toolCallId) ?? "unknown",
				content: resultParts,
				isError: result.isError ?? false,
				timestamp: 0
			});
		}
	}
	return {
		...options.system !== void 0 ? { systemPrompt: options.system } : {},
		messages,
		...Array.isArray(options.tools) && options.tools.length > 0 ? { tools: options.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		})) } : {}
	};
}
//#endregion
//#region stream: pi-ai simple events -> harness StreamChunks
/**
 * Map pi-ai usage (reasoning folded into output by pi-ai).
 * @returns harness counts; cache fields appear only when non-zero.
 */
function mapUsage(usage) {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
		...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
	};
}
function classifyPiAiError(message) {
	if (/\b(?:401|403)\b/.test(message)) return "AUTH";
	if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
	if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
	if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
	if (/\b5\d\d\b/.test(message)) return "SERVER";
	if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
	if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return "TRANSPORT";
	return "PI_AI_ERROR";
}
/**
 * Map a terminal pi-ai event to the harness finish reason. Recognized error
 * text, usage-based overflow detection, and a `stop` with no content blocks
 * map to error reasons; `length` becomes max-tokens; `toolUse` becomes
 * tool-calls.
 */
function mapStopReason(message, contextWindow) {
	const piAiOverflow = isContextOverflow(message, contextWindow);
	const harnessOverflow = message.stopReason === "error" && message.errorMessage !== void 0 && isContextWindowExceededError(message.errorMessage);
	if (piAiOverflow || harnessOverflow) return {
		kind: "error",
		failure: {
			message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
			code: CONTEXT_WINDOW_EXCEEDED_CODE
		}
	};
	switch (message.stopReason) {
		case "stop":
			if (message.content.length === 0) return {
				kind: "error",
				failure: {
					message: `model "${message.model}" returned a completed response with no content`,
					code: EMPTY_RESPONSE_CODE
				}
			};
			return { kind: "stop" };
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: message.errorMessage ?? "pi-ai stream aborted",
				code: "ABORTED"
			}
		};
		case "error": {
			const text = message.errorMessage ?? "pi-ai stream error";
			return {
				kind: "error",
				failure: {
					message: text,
					code: classifyPiAiError(text)
				}
			};
		}
		default: return { kind: "stop" };
	}
}
/**
 * Translate the pi-ai simple event stream into StreamChunks. pi-ai never
 * throws mid-stream — failures arrive as terminal `error` events, which
 * become error/aborted `finish` chunks. Throws `LlmError` (STREAM_CLOSED)
 * if the source ends without a terminal event.
 */
async function* toStreamChunks(events, contextWindow) {
	const toolIds = new Map();
	for await (const event of events) switch (event.type) {
		case "start": break;
		case "text_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
			break;
		case "text_delta":
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "text_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "text",
					text: event.content
				}
			};
			break;
		case "thinking_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
			break;
		case "thinking_delta":
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "thinking_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content
				}
			};
			break;
		case "toolcall_start": {
			const partial = event.partial?.content?.[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id : "";
			const name = partial?.type === "toolCall" ? partial.name : "";
			toolIds.set(event.contentIndex, {
				id,
				name
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
			break;
		}
		case "toolcall_delta": {
			const known = toolIds.get(event.contentIndex);
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: CallId(known?.id ?? ""),
				...known?.name !== void 0 && known.name.length > 0 ? { name: known.name } : {},
				argumentsDelta: event.delta
			};
			break;
		}
		case "toolcall_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "tool-call",
					id: CallId(event.toolCall.id),
					name: event.toolCall.name,
					arguments: JSON.stringify(event.toolCall.arguments)
				}
			};
			break;
		case "done":
			yield {
				type: "usage",
				usage: mapUsage(event.message.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.message, contextWindow)
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.error, contextWindow)
			};
			return;
	}
	throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");
}
//#endregion
//#region adapter: pi-ai-backed LlmAdapter for one subscription provider
/** Escalation order used to sort selectable reasoning levels low to high. */
const LEVEL_RANK = {
	off: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6
};
/**
 * Tool-result images that the conversation UI has not shown yet. The shell's
 * tool-result cards render text only and drop image blocks, so an image a
 * tool returned (generate_image, read_image) is visible to the model but not
 * to the user. The adapter echoes those images into the next assistant
 * message — whose renderer does display images — tracking what has already
 * been echoed through the attachment ids present in assistant history.
 * @param messages - the harness conversation, in order.
 * @returns attachment refs (from the most recent tool result that still has
 *   an un-echoed image), in block order.
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
 * One pi-ai-backed subscription provider route. The adapter keeps pi-ai's
 * static model catalog as its capability source (context windows, input
 * modalities, thinking levels) while the live account catalog — fetched by
 * the spec's `liveCatalog` — wins for what the picker shows, exactly like
 * the OpenAI adapter's online-first/static-fallback contract.
 */
var PiAiSubscriptionAdapter = class extends LlmAdapter {
	constructor(config) {
		super();
		this.config = config;
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
	/** One pi-ai model for a harness model id, with the subscription baseURL, provider request headers, and live catalog facts applied. */
	piModelFor(modelId) {
		const base = this.config.piModels.getModel(this.config.piProviderId, modelId);
		const live = this.config.getLiveEntry?.(modelId);
		const headers = this.config.modelHeaders?.() ?? {};
		// The account's catalog declares per-model reasoning levels; teach the
		// template's thinking-level map those levels so pi-ai's wire clamping
		// honors them instead of silently downgrading (e.g. xhigh -> high).
		const liveLevels = Array.isArray(live?.reasoningEfforts) && live.reasoningEfforts.length > 0 ? live.reasoningEfforts : void 0;
		const thinkingLevelMap = liveLevels === void 0 ? void 0 : {
			...((base ?? {}).thinkingLevelMap ?? {}),
			...Object.fromEntries(liveLevels.map((effort) => [effort.id, effort.id]))
		};
		const clone = (model, id, name) => ({
			...model,
			id,
			name,
			baseUrl: this.config.effectiveBaseURL(this.config.options()),
			...Number.isInteger(live?.contextWindow) ? { contextWindow: live.contextWindow } : {},
			...thinkingLevelMap !== void 0 ? { thinkingLevelMap } : {},
			...(Object.keys(headers).length > 0 ? { headers: { ...(model.headers ?? {}), ...headers } } : {})
		});
		if (base !== void 0) return clone(base, modelId, base.name ?? modelId);
		// A live-catalog id pi-ai does not ship (new model, alias): synthesize
		// a clone of a static model speaking the wire protocol the account's
		// catalog declares (`api_backend: "responses"` -> openai-responses),
		// so protocol dispatch still resolves.
		const defaults = this.config.piModels.getModels(this.config.piProviderId);
		const wanted = live?.api ?? "openai-completions";
		const template = defaults.find((model) => model.api === wanted) ?? defaults.find((model) => model.api === "openai-completions") ?? defaults[0];
		if (template === void 0) throw new LlmError(`${this.config.provider}: no pi-ai model template for "${modelId}"`, "UNKNOWN_MODEL");
		return clone(template, modelId, modelId);
	}
	/**
	 * Reasoning efforts for one model, sorted low to high with Off first
	 * when the backend offers an off/disabled mode (mirroring the deepseek
	 * design). The account's live catalog entry wins when it declares levels
	 * — the picker must show exactly what the backend accepts, so Off is
	 * only listed when the catalog itself declares it.
	 */
	effortsFor(modelId) {
		if (this.config.reasoningEffort === false) return [];
		const live = this.config.getLiveEntry?.(modelId);
		if (Array.isArray(live?.reasoningEfforts) && live.reasoningEfforts.length > 0) {
			return live.reasoningEfforts.map((effort) => ({
				id: ReasoningEffortId(effort.id),
				name: effort.name ?? `${effort.id.charAt(0).toUpperCase()}${effort.id.slice(1)}`
			})).sort((left, right) => (LEVEL_RANK[left.id] ?? 99) - (LEVEL_RANK[right.id] ?? 99));
		}
		const model = this.piModelFor(modelId);
		return getSupportedThinkingLevels(model).map((level) => ({
			id: ReasoningEffortId(level),
			name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`
		}));
	}
	/** The catalog-declared default effort for one model, when any. */
	defaultEffortFor(modelId) {
		const live = this.config.getLiveEntry?.(modelId);
		if (Array.isArray(live?.reasoningEfforts)) {
			const declared = live.reasoningEfforts.find((effort) => effort.default === true);
			if (typeof declared?.id === "string") return ReasoningEffortId(declared.id);
		}
		return void 0;
	}
	/** Harness model descriptor for one catalog id. */
	descriptor(modelId, entry) {
		const model = entry ?? {};
		return {
			provider: this.config.provider,
			id: modelId,
			name: model.name ?? modelId,
			...model.description === void 0 ? {} : { description: model.description },
			...model.inputModalities === void 0 ? {} : { inputModalities: model.inputModalities },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }
		};
	}
	listModels(provider) {
		return this.config.listCatalog().then((live) => live.map((model) => this.descriptor(model.id, model)));
	}
	resolveModel(provider, model) {
		const config = this.config.options();
		return this.config.listCatalog().then((catalog) => {
			const live = catalog.find((entry) => entry.id === model);
			const fallback = this.config.fallbackDescriptors.find((entry) => entry.id === model);
			const entry = live ?? fallback;
			const contextWindow = entry?.contextWindow ?? config.defaultContextWindow;
			const efforts = this.effortsFor(model);
			const configuredDefault = typeof config.defaultReasoningEffort === "string" && efforts.some((effort) => effort.id === config.defaultReasoningEffort) ? ReasoningEffortId(config.defaultReasoningEffort) : void 0;
			const catalogDefault = this.defaultEffortFor(model);
			const defaultEffort = configuredDefault ?? (catalogDefault !== void 0 && efforts.some((effort) => effort.id === catalogDefault) ? catalogDefault : void 0);
			return {
				provider,
				id: model,
				name: entry?.name ?? model,
				...entry?.description === void 0 ? {} : { description: entry.description },
				...entry?.inputModalities === void 0 ? {} : { inputModalities: entry.inputModalities },
				context: {
					contextWindow
				},
				...efforts.length === 0 ? {} : { reasoning: {
					efforts,
					...defaultEffort !== void 0 ? { defaultEffort } : {}
				} }
			};
		});
	}
	async *stream(options) {
		const connection = this.config.options();
		const model = this.piModelFor(options.model);
		const containsImage = (options.messages ?? []).some((message) => contentHasImage(message.content));
		if (containsImage && !(model.input ?? []).includes("image")) throw new LlmError(`${this.config.provider}: model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");
		const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;
		if (containsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the harness attachment store, which is not available in this profile.", "UNSUPPORTED_CONTENT");
		const context = await toPiContext(options, attachments, options.signal);
		// The shell renders tool-result cards as text only, so images a tool
		// returned (generate_image, read_image) never reach the user's eyes
		// through the card. Echo un-echoed tool-result images as leading
		// assistant image blocks, which the conversation renderer displays —
		// the same compensation the OpenAI adapter performs. Skipped for
		// tool-less calls (the session-title request) so a title stream never
		// carries an image. The echoed blocks occupy the first indexes; the
		// model stream is re-indexed past them.
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
		const effort = options.reasoningEffort !== void 0 && options.reasoningEffort !== "off" ? options.reasoningEffort : void 0;
		const iterator = toStreamChunks(this.config.piModels.streamSimple(model, context, {
			...effort !== void 0 && this.config.reasoningEffort !== false ? { reasoning: effort } : {},
			...options.temperature !== void 0 ? { temperature: options.temperature } : {},
			...options.maxTokens !== void 0 ? { maxTokens: options.maxTokens } : {},
			signal: watchdog.signal,
			headers: attributionHeaders()
		}), model.contextWindow)[Symbol.asyncIterator]();
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
			if (timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT") !== void 0) throw new LlmError(`${this.config.provider}: stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
			if (options.signal?.aborted) throw new LlmError(`${this.config.provider}: request aborted by caller`, "ABORTED", { cause: error });
			if (error instanceof LlmError) throw error;
			throw new LlmError(`${this.config.provider}: pi-ai stream failed`, "TRANSPORT", { cause: error });
		} finally {
			consumer.abort("pi-ai stream consumer stopped");
			if (!exhausted && iterator.return !== void 0) try {
				await iterator.return();
			} catch (_abortedTransportTeardown) {}
		}
	}
};
//#endregion
//#region registration: one spec -> a fully wired subscription provider
/** Default maximum combined request/response context capacity in tokens. */
const DEFAULT_CONTEXT_WINDOW = 4e5;
/** Default catalog cache lifetime. */
const DEFAULT_MODELS_CACHE_TTL_MS = 3e5;
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
 * Online-first catalog cache for one provider. The cache belongs to one
 * credential identity: switching accounts invalidates it immediately. A
 * failure is remembered briefly so an offline picker does not hammer the
 * endpoint; failures always fall back to the static list, which is never
 * merged into a successful online result.
 */
function createCatalogCache({ provider, logger, options, getAuth, liveCatalog, fallbackDescriptors, piProviderId, piModels }) {
	const cache = {
		at: 0,
		key: void 0,
		value: void 0,
		failureAt: 0
	};
	// Latest successful live entries by model id, kept in sync so request
	// dispatch can pick the wire protocol an account's catalog declares.
	const liveById = new Map();
	async function listCatalog() {
		const config = options();
		let apiKey;
		try {
			const auth = await getAuth();
			apiKey = auth?.auth?.apiKey;
		} catch {
			return fallbackDescriptors;
		}
		if (typeof apiKey !== "string" || apiKey.length === 0) return fallbackDescriptors;
		const now = Date.now();
		const key = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
		if (cache.value !== void 0 && cache.key === key && now - cache.at < config.modelsCacheTtlMs) return cache.value;
		if (now - cache.failureAt < 60000) return fallbackDescriptors;
		try {
			const live = await liveCatalog(config, apiKey, piProviderId, piModels);
			if (live.length > 0) {
				cache.value = live;
				cache.at = now;
				cache.key = key;
				liveById.clear();
				for (const entry of live) liveById.set(entry.id, entry);
				return live;
			}
			cache.failureAt = now;
			return fallbackDescriptors;
		} catch (error) {
			cache.failureAt = now;
			logger?.warn(`${provider}: model catalog unavailable, using offline fallback models`);
			logger?.warn(error);
			return fallbackDescriptors;
		}
	}
	return {
		listCatalog,
		getLiveEntry: (modelId) => liveById.get(modelId)
	};
}
/**
 * Register one pi-ai-backed subscription provider end to end: settings
 * section, login-gated directory + adapter registration (with the same four
 * triggers the OpenAI provider uses), locale-following display name, and the
 * browser login API. The spec describes everything provider-specific; the
 * provider id must stay globally unique (`dsh-plugin-subhub-<provider>`).
 */
function registerSubscriptionProvider(ctx, config, spec) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = spec.resolveOptions(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error(`${spec.slug}: keeping the last good configuration after an invalid settings section`);
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const filePath = () => {
		const resolved = options();
		if (resolved.authFile !== void 0 && resolved.authFile.trim() !== "") return resolved.authFile.trim();
		return join(homedir(), ".dsh-plugin-subhub", `${spec.slug}-auth.json`);
	};
	const store = new FileCredentialStore(filePath, ctx.logger);
	const piModels = createModels({
		credentials: store
	});
	const piProvider = spec.providerFactory();
	piModels.setProvider(piProvider);
	// Provider display name follows the harness language: an explicit choice
	// in the `locale` settings namespace wins; until the user picks one, the
	// shell follows the browser language, which the host learns from the
	// locale query parameter / Accept-Language header of the hub page's API
	// calls. Unset with no hint falls back to Chinese.
	const localePreference = () => {
		const settings = ctx.get("settings");
		if (settings === void 0) return void 0;
		const locale = settings.get("locale");
		const preference = locale !== null && typeof locale === "object" ? locale.preference : void 0;
		return typeof preference === "string" && preference.length > 0 ? preference : void 0;
	};
	let inferredLocale;
	const displayName = () => spec.displayName((localePreference() ?? inferredLocale) === "en" ? "en" : "zh");
	// The harness attachment store can mount after this row: keep the value
	// reactive and re-read on demand, the same pattern the harness's own
	// adapters use.
	let attachments = ctx.get("attachments");
	ctx.inject(["attachments"], (attachmentCtx) => {
		attachments = attachmentCtx.attachments;
	});
	const catalogCache = createCatalogCache({
		provider: spec.id,
		logger: ctx.logger,
		options,
		getAuth: () => piModels.getAuth(piProvider.id),
		liveCatalog: spec.liveCatalog,
		fallbackDescriptors: spec.fallbackDescriptors(piModels, piProvider),
		piProviderId: piProvider.id,
		piModels
	});
	const adapter = new PiAiSubscriptionAdapter({
		provider: spec.id,
		options,
		displayName,
		effectiveBaseURL: spec.effectiveBaseURL,
		piModels,
		piProviderId: piProvider.id,
		reasoningEffort: spec.reasoningEffort,
		modelHeaders: spec.modelHeaders,
		getLiveEntry: catalogCache.getLiveEntry,
		fallbackDescriptors: spec.fallbackDescriptors(piModels, piProvider),
		resolveAttachments: () => attachments ?? ctx.get("attachments"),
		listCatalog: catalogCache.listCatalog
	});
	// The provider only becomes visible in the Models page and the model
	// picker after the user authenticated through the plugin's own login
	// flow. Login and logout (un)register both; the pages refresh on
	// `llm/adapters-updated`.
	let directoryHandle;
	let registration;
	let registeredPolicy;
	const syncRegistration = () => {
		const shouldRegister = store.hasCredentials();
		if (shouldRegister) {
			if (directoryHandle === void 0) directoryHandle = ctx.llm.registerConfigurableProviders([{
				provider: spec.id,
				displayName: displayName(),
				settingsNs: spec.settingsNs,
				settingsPath: []
			}]);
			if (registration === void 0) {
				registration = ctx.llm.registerAdapter([spec.id], adapter);
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
	};
	syncRegistration();
	const syncDisplayName = () => {
		if (directoryHandle === void 0) return;
		directoryHandle.replace([{
			provider: spec.id,
			displayName: displayName(),
			settingsNs: spec.settingsNs,
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
		registration.replace([spec.id]);
		registeredPolicy = policy;
	};
	// Settings may arrive after this row mounts (and can change authFile), so
	// the gating re-evaluates whenever the settings source wires or changes.
	installSettingsSection(ctx, spec.settingsNs, spec.schema, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {
			ensureRegistrationFacts();
			syncRegistration();
		}
	});
	syncRegistration();
	const login = createPiAiLoginController({
		slug: spec.slug,
		providerId: piProvider.id,
		models: piModels,
		store,
		filePath,
		logger: ctx.logger,
		onAuthChanged: syncRegistration,
		listCatalog: () => adapter.listModels(spec.id),
		promptHandler: spec.loginPrompt,
		onLanguageHint: (lang) => {
			inferredLocale = lang;
			syncDisplayName();
		}
	});
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: `${LOGIN_API_PATH}/${spec.slug}`,
			handler: (req, res) => void login.handle(req, res)
		}), `${spec.slug}: login api route`);
	});
	return {
		adapter,
		store,
		options,
		filePath,
		piModels
	};
}
//#endregion
export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS_CACHE_TTL_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, FileCredentialStore, LOGIN_API_PATH, PiAiSubscriptionAdapter, classifyPiAiError, createPiAiLoginController, lastUnEchoedToolResultImages, mapStopReason, registerSubscriptionProvider, toPiContext, toStreamChunks };
