// dsh-plugin-subhub: the Google Gemini subscription provider (Google AI Pro
// / Google AI Ultra). Pure spec + fetchers consumed by the pi-ai-backed core
// in src/piai.js. pi-ai's google provider is API-key only, so this spec
// carries its own loopback OAuth: the same Authorization Code + PKCE flow
// the official gemini-cli uses, with its public client id/secret, token
// exchange, refresh, and Bearer auth against the Generative Language API.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS_CACHE_TTL_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, registerSubscriptionProvider } from "../piai.js";
/**
 * Provider route this plugin owns. The id must stay unique: the harness's
 * built-in provider directory already declares "google" (api-key BYO
 * provider), so the subscription route uses its own
 * dsh-plugin-subhub-<provider> id with its own display name.
 */
const PROVIDER = "dsh-plugin-subhub-google";
/** URL slug inside the plugin's login API and credential file name. */
const SLUG = "google";
const NS = settingsNamespace("dsh-plugin-subhub-google");
/**
 * Generative Language API the subscription OAuth token authenticates
 * against (the same host the official gemini-cli uses for subscription
 * accounts).
 */
const SUBSCRIPTION_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/**
 * OAuth client of the official gemini-cli, public in its source. The
 * client id ships verbatim; the client secret is read from the
 * environment because this repository's push protection forbids
 * committing it — the public value lives in the official gemini-cli
 * source (packages/core/src/code_assist/oauth2.ts). The subscription
 * token it mints only ever rides the requests above.
 */
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
function oauthClientSecret() {
	const secret = process.env.GEMINI_OAUTH_CLIENT_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
	if (typeof secret !== "string" || secret.length === 0) throw new LlmError("google: GEMINI_OAUTH_CLIENT_SECRET is not set; export the public client secret from the official gemini-cli source (packages/core/src/code_assist/oauth2.ts)", "MISSING_CREDENTIAL");
	return secret;
}
const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_SCOPES = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
const OAUTH_CALLBACK_PATH = "/oauth2callback";
/** Login flows live at most this long before their servers close. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
/** Refresh slightly before the reported expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Reasoning-level vocabulary the backend accepts. */
const EFFORT_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const Config = z.object({
	authFile: z.string(),
	baseURL: z.string(),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	modelsCacheTtlMs: z.number().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODELS_CACHE_TTL_MS),
	defaultReasoningEffort: z.union(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
function resolveAdapterOptions(config) {
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("google: defaultContextWindow must be a positive integer");
	if (config.defaultReasoningEffort !== void 0 && !EFFORT_LEVELS.has(config.defaultReasoningEffort)) throw new Error(`google: defaultReasoningEffort must be one of ${[...EFFORT_LEVELS].join(", ")}`);
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`google: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const modelsCacheTtlMs = config.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
	if (!Number.isFinite(modelsCacheTtlMs) || modelsCacheTtlMs <= 0) throw new Error("google: modelsCacheTtlMs must be a positive finite number");
	return {
		authFile: config.authFile,
		baseURL: config.baseURL,
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		modelsCacheTtlMs,
		defaultReasoningEffort: config.defaultReasoningEffort,
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "google: retryPolicy")
	};
}
function effectiveBaseURL(config) {
	return config.baseURL ?? SUBSCRIPTION_BASE_URL;
}
/** base64url helpers for PKCE. */
function b64url(value) {
	return Buffer.from(value).toString("base64url");
}
const OAUTH_SUCCESS_HTML = "<!doctype html><meta charset=\"utf-8\"><title>Gemini</title><p>Google authentication completed. You can close this window.</p>";
const OAUTH_FAILURE_HTML = "<!doctype html><meta charset=\"utf-8\"><title>Gemini</title><p>Google authentication did not complete. You can close this window.</p>";
/**
 * One loopback callback server on an ephemeral port. Resolves with the
 * authorization result once the browser redirect lands; the abort signal
 * or a 15-minute deadline closes it.
 */
function startCallbackServer(signal) {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			let url;
			try {
				url = new URL(req.url ?? "/", "http://127.0.0.1");
			} catch {
				res.writeHead(400).end();
				return;
			}
			if (url.pathname !== OAUTH_CALLBACK_PATH) {
				res.writeHead(404).end();
				return;
			}
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(error === null ? OAUTH_SUCCESS_HTML : OAUTH_FAILURE_HTML);
			settle({ code, error });
		});
		let settled = false;
		let settle;
		const wait = new Promise((resolveWait) => {
			settle = (result) => {
				if (settled) return;
				settled = true;
				resolveWait(result);
			};
		});
		const timer = setTimeout(() => settle({ code: null, error: "timed out" }), LOGIN_TIMEOUT_MS);
		const onAbort = () => settle({ code: null, error: "aborted" });
		signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			try {
				server.close();
			} catch {}
		};
		server.on("error", (error) => {
			cleanup();
			reject(error);
		});
		server.listen(0, "127.0.0.1", () => {
			resolve({
				port: server.address().port,
				wait: wait.finally(cleanup)
			});
		});
	});
}
/** Exchange one authorization code for tokens. */
async function exchangeCode(code, redirectUri, verifier, signal) {
	const response = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: OAUTH_CLIENT_ID,
			client_secret: oauthClientSecret(),
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
			code_verifier: verifier
		}).toString(),
		signal
	});
	if (!response.ok) throw new Error(`google token exchange failed (HTTP ${response.status})`);
	const tokens = await response.json();
	if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") throw new Error("google token exchange returned an unexpected payload");
	return {
		type: "oauth",
		access: tokens.access_token,
		refresh: tokens.refresh_token,
		expires: Date.now() + (Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? tokens.expires_in : 3600) * 1000 - REFRESH_SKEW_MS
	};
}
/** The spec-supplied login: PKCE authorize in the browser, loopback callback. */
async function loginGoogle(interaction) {
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	const { port, wait } = await startCallbackServer(interaction.signal);
	const redirectUri = `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`;
	const params = new URLSearchParams({
		client_id: OAUTH_CLIENT_ID,
		response_type: "code",
		scope: OAUTH_SCOPES,
		access_type: "offline",
		prompt: "consent",
		redirect_uri: redirectUri,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier
	});
	interaction.notify({
		type: "auth_url",
		url: `${OAUTH_AUTHORIZE_URL}?${params.toString()}`,
		instructions: "Complete login in your browser."
	});
	const result = await wait;
	if (result.code === null || result.code === void 0) throw new Error(`google oauth login failed: ${result.error ?? "no code"}`);
	return await exchangeCode(result.code, redirectUri, verifier, interaction.signal);
}
/** Rotate an expiring subscription access token. */
async function refreshGoogle(credential) {
	if (typeof credential?.refresh !== "string" || credential.refresh.length === 0) throw new LlmError("google: no refresh token; sign in again", "INVALID_CREDENTIAL");
	const response = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: OAUTH_CLIENT_ID,
			client_secret: oauthClientSecret(),
			refresh_token: credential.refresh
		}).toString()
	});
	if (!response.ok) throw new LlmError(`google: token refresh failed (HTTP ${response.status}); sign in again from the "Third-party subscriptions" settings page`, "INVALID_CREDENTIAL");
	const tokens = await response.json();
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new LlmError("google: token refresh returned no access token", "INVALID_CREDENTIAL");
	return {
		...credential,
		access: tokens.access_token,
		expires: Date.now() + (Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? tokens.expires_in : 3600) * 1000 - REFRESH_SKEW_MS,
		...typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0 ? { refresh: tokens.refresh_token } : {}
	};
}
/**
 * Resolve one usable access token for a request: read the plugin-owned
 * credential, rotate it when the expiry approaches, and persist the
 * rotation through the store's locked modify.
 */
async function resolveApiKey({ store, providerId }) {
	const credential = await store.read(providerId);
	if (credential === void 0 || typeof credential?.access !== "string" || credential.access.length === 0) throw new LlmError("google: no authentication found; sign in from the \"Third-party subscriptions\" settings page", "MISSING_CREDENTIAL");
	if (Number.isFinite(credential.expires) && credential.expires > Date.now()) return credential.access;
	const next = await store.modify(providerId, async (current) => {
		if (current === void 0 || typeof current?.access !== "string") throw new LlmError("google: no authentication found; sign in again", "MISSING_CREDENTIAL");
		if (Number.isFinite(current.expires) && current.expires > Date.now()) return void 0;
		return await refreshGoogle(current);
	});
	const rotated = next ?? credential;
	return rotated.access;
}
/**
 * Static fallback catalog built from pi-ai's shipped Gemini data, curated
 * to stable generation ids (preview/dated/alias entries dropped), shown
 * only while the live /models endpoint is unreachable.
 */
function fallbackDescriptors(piModels, piProvider) {
	return piModels.getModels(piProvider.id).filter((model) => !/preview|-\d{8}$|-latest$|deep-research|computer-use/.test(model.id) && !model.id.startsWith("gemma")).map((model) => ({
		id: model.id,
		name: model.name ?? model.id,
		...Array.isArray(model.input) ? { inputModalities: model.input.filter((modality) => modality === "text" || modality === "image") } : {},
		...Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}
	}));
}
/**
 * Fetch the account's model catalog from the Generative Language API.
 * Gemini lists every model the subscription token can generate with; the
 * context window is the input + output token limits.
 * @returns catalog entries, or an empty array (the caller falls back to the
 *   static list).
 */
async function liveCatalog(config, apiKey, piProviderId, piModels) {
	const baseURL = effectiveBaseURL(config);
	const response = await fetch(`${baseURL}/models`, {
		headers: {
			"authorization": `Bearer ${apiKey}`
		}
	});
	if (!response.ok) throw new Error(`google: model catalog request failed (HTTP ${response.status})`);
	const body = await response.json();
	const raw = Array.isArray(body?.models) ? body.models : [];
	return raw.filter((entry) => typeof entry?.name === "string" && Array.isArray(entry.supportedGenerationMethods) && entry.supportedGenerationMethods.includes("generateContent")).map((entry) => {
		const id = entry.name.replace(/^models\//, "");
		const known = piModels.getModel(piProviderId, id);
		const contextWindow = Number.isInteger(entry.inputTokenLimit) && Number.isInteger(entry.outputTokenLimit) && entry.inputTokenLimit > 0 && entry.outputTokenLimit > 0 ? entry.inputTokenLimit + entry.outputTokenLimit : Number.isInteger(known?.contextWindow) && known.contextWindow > 0 ? known.contextWindow : void 0;
		return {
			id,
			name: typeof entry.displayName === "string" && entry.displayName.length > 0 ? entry.displayName : id,
			api: known?.api ?? "google-generative-ai",
			// Known models reuse pi-ai's declared input modalities; unknown
			// live ids stay text-only rather than fabricating vision.
			...(known !== void 0 && Array.isArray(known.input) ? { inputModalities: known.input.filter((modality) => modality === "text" || modality === "image") } : { inputModalities: ["text"] }),
			...contextWindow === void 0 ? {} : { contextWindow }
		};
	});
}
/**
 * Register the `dsh-plugin-subhub-google` provider route through the shared
 * pi-ai-backed core with a spec-supplied login (loopback PKCE) and a
 * spec-supplied access-token resolver.
 */
function registerGoogle(ctx, config) {
	return registerSubscriptionProvider(ctx, config, {
		id: PROVIDER,
		slug: SLUG,
		settingsNs: NS,
		schema: Config,
		resolveOptions: resolveAdapterOptions,
		effectiveBaseURL,
		providerFactory: () => googleProvider(),
		fallbackDescriptors,
		liveCatalog,
		// pi-ai's thinking levels order Off first, then low to high; our
		// adapter omits the parameter for Off, which disables thinking.
		reasoningEffort: true,
		login: loginGoogle,
		resolveApiKey,
		displayName: (lang) => lang === "en" ? "Gemini subscription" : "Gemini 订阅"
	});
}
export { PROVIDER, SUBSCRIPTION_BASE_URL, fallbackDescriptors, liveCatalog, registerGoogle, resolveAdapterOptions };
