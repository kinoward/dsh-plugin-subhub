// dsh-plugin-subhub: the xAI Grok (SuperGrok / X Premium+) subscription
// provider. Pure spec + fetchers consumed by the pi-ai-backed core in
// src/piai.js — this file holds nothing but the provider's own facts.
import { resolveRetryPolicy, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS_CACHE_TTL_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, registerSubscriptionProvider } from "../piai.js";
/**
 * Provider route this plugin owns. The id must stay unique: the harness's
 * built-in provider directory already declares "xai" (api-key BYO provider),
 * so the subscription route uses its own dsh-plugin-subhub-<provider> id
 * with its own display name.
 */
const PROVIDER = "dsh-plugin-subhub-xai";
/** URL slug inside the plugin's login API and credential file name. */
const SLUG = "xai";
const NS = settingsNamespace("dsh-plugin-subhub-xai");
/**
 * Chat proxy the official grok-build CLI uses for subscription OAuth tokens
 * (scope `grok-cli:access`), OpenAI-compatible under /v1. The public API
 * host (`https://api.x.ai/v1`, scope `api:access`) is kept as the
 * `apiBaseURL` escape hatch; which host the account's subscription quota
 * bills against must be confirmed against a real account.
 */
const SUBSCRIPTION_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const API_BASE_URL = "https://api.x.ai/v1";
/**
 * The cli-chat-proxy backend gates requests on the official Grok CLI's
 * client fingerprint: `x-grok-client-version` (HTTP 426 when absent or too
 * old), the proxy auth middleware pair, a client mode, and a matching
 * User-Agent. The official CLI carries these values in its default headers;
 * the subscription bridge sends the same vocabulary. Bump the version when
 * the proxy raises its floor (the reviewed upstream revision shipped 0.2.5).
 */
const GROK_CLIENT_VERSION = "0.2.5";
const GROK_OS = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
const GROK_ARCH = process.arch === "arm64" ? "aarch64" : process.arch;
function grokProxyHeaders() {
	return {
		"x-grok-client-identifier": "grok-shell",
		"x-grok-client-version": GROK_CLIENT_VERSION,
		"x-grok-client-mode": "headless",
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-authenticateresponse": "authenticate-response",
		"User-Agent": `grok-shell/${GROK_CLIENT_VERSION} (${GROK_OS}; ${GROK_ARCH})`
	};
}
const Config = z.object({
	authFile: z.string(),
	baseURL: z.string(),
	apiBaseURL: z.string(),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	modelsCacheTtlMs: z.number().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODELS_CACHE_TTL_MS),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 */
function resolveAdapterOptions(config) {
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("xai: defaultContextWindow must be a positive integer");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`xai: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const modelsCacheTtlMs = config.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
	if (!Number.isFinite(modelsCacheTtlMs) || modelsCacheTtlMs <= 0) throw new Error("xai: modelsCacheTtlMs must be a positive finite number");
	return {
		authFile: config.authFile,
		baseURL: config.baseURL,
		apiBaseURL: config.apiBaseURL,
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		modelsCacheTtlMs,
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "xai: retryPolicy")
	};
}
/** Pick the endpoint for the subscription OAuth token. */
function effectiveBaseURL(config) {
	return config.baseURL ?? SUBSCRIPTION_BASE_URL;
}
/**
 * Static fallback catalog built from pi-ai's shipped xai model data, shown
 * only while the live /models-v2 endpoint is unreachable. It never merges
 * into the live list.
 */
function fallbackDescriptors(piModels, piProvider) {
	return piModels.getModels(piProvider.id).map((model) => ({
		id: model.id,
		name: model.name ?? model.id,
		...Array.isArray(model.input) ? { inputModalities: model.input.filter((modality) => modality === "text" || modality === "image") } : {},
		...Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}
	}));
}
/**
 * Fetch the account's model catalog from the subscription chat proxy.
 * @returns catalog entries in endpoint order, or an empty array (the caller
 *   falls back to the static list).
 */
async function liveCatalog(config, apiKey, _piProviderId, _piModels) {
	const baseURL = effectiveBaseURL(config);
	const headers = {
		"authorization": `Bearer ${apiKey}`,
		...grokProxyHeaders()
	};
	// The OAuth catalog route is /models-v2; the older /models shape is kept
	// as a fallback for backend revisions that still serve it.
	let response = await fetch(`${baseURL}/models-v2`, { headers });
	if (!response.ok) {
		response = await fetch(`${baseURL}/models`, { headers });
	}
	if (!response.ok) throw new Error(`xai: model catalog request failed (HTTP ${response.status})`);
	const body = await response.json();
	const raw = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
	return raw.filter((entry) => typeof entry?.id === "string").map((entry) => ({
		id: entry.id,
		name: typeof entry.display_name === "string" && entry.display_name.length > 0 ? entry.display_name : typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
		// The proxy serves accounts whose models speak the Responses API
		// (`api_backend: "responses"`, e.g. grok-4.6); unknown live ids are
		// dispatched through the matching pi-ai wire protocol.
		api: entry.api_backend === "responses" ? "openai-responses" : "openai-completions",
		...Number.isInteger(entry.context_window) && entry.context_window > 0 ? { contextWindow: entry.context_window } : {},
		...(Array.isArray(entry.input_modalities) ? { inputModalities: entry.input_modalities.filter((modality) => modality === "text" || modality === "image") } : { inputModalities: ["text", "image"] })
	}));
}
/**
 * Register the `dsh-plugin-subhub-xai` provider route through the shared
 * pi-ai-backed core. Everything provider-specific lives above; the core
 * owns the login API, the credential file, the settings section, and the
 * login-gated directory + adapter registration.
 */
function registerXai(ctx, config) {
	return registerSubscriptionProvider(ctx, config, {
		id: PROVIDER,
		slug: SLUG,
		settingsNs: NS,
		schema: Config,
		resolveOptions: resolveAdapterOptions,
		effectiveBaseURL,
		providerFactory: () => xaiProvider(),
		fallbackDescriptors,
		liveCatalog,
		// The cli-chat-proxy version gate (HTTP 426) and auth middleware read
		// these headers off every subscription request.
		modelHeaders: grokProxyHeaders,
		// Reasoning effort stays off until a real account confirms the
		// subscription proxy accepts (and the account quota honors) the
		// reasoning_effort parameter pi-ai would send.
		reasoningEffort: false,
		displayName: (lang) => lang === "en" ? "xAI Grok subscription" : "xAI Grok 订阅"
	});
}
export { API_BASE_URL, PROVIDER, SUBSCRIPTION_BASE_URL, fallbackDescriptors, grokProxyHeaders, liveCatalog, registerXai, resolveAdapterOptions };
