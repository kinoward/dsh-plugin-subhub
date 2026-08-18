// dsh-plugin-subhub: the Kimi Code subscription provider (Moonshot's
// coding plan). Pure spec + fetchers consumed by the pi-ai-backed core in
// src/piai.js. pi-ai's bundled kimi-coding OAuth owns the whole login flow
// (device authorization at auth.kimi.com, token exchange and refresh), and
// its Anthropic-Messages protocol covers chat, so this file only
// contributes the catalog, the settings section, and the display identity.
import { resolveRetryPolicy, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS_CACHE_TTL_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, registerSubscriptionProvider } from "../piai.js";
/**
 * Provider route this plugin owns. The id must stay unique: the harness's
 * built-in provider directory already declares "kimi-coding" (api-key BYO
 * provider), so the subscription route uses its own
 * dsh-plugin-subhub-<provider> id with its own display name.
 */
const PROVIDER = "dsh-plugin-subhub-kimi";
/** URL slug inside the plugin's login API and credential file name. */
const SLUG = "kimi";
const NS = settingsNamespace("dsh-plugin-subhub-kimi");
/** Chat endpoint the subscription OAuth token authenticates against. */
const SUBSCRIPTION_BASE_URL = "https://api.kimi.com/coding";
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
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("kimi: defaultContextWindow must be a positive integer");
	if (config.defaultReasoningEffort !== void 0 && !EFFORT_LEVELS.has(config.defaultReasoningEffort)) throw new Error(`kimi: defaultReasoningEffort must be one of ${[...EFFORT_LEVELS].join(", ")}`);
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`kimi: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const modelsCacheTtlMs = config.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
	if (!Number.isFinite(modelsCacheTtlMs) || modelsCacheTtlMs <= 0) throw new Error("kimi: modelsCacheTtlMs must be a positive finite number");
	return {
		authFile: config.authFile,
		baseURL: config.baseURL,
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		modelsCacheTtlMs,
		defaultReasoningEffort: config.defaultReasoningEffort,
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "kimi: retryPolicy")
	};
}
function effectiveBaseURL(config) {
	return config.baseURL ?? SUBSCRIPTION_BASE_URL;
}
/**
 * Static fallback catalog built from pi-ai's shipped Kimi Code model data,
 * shown only while the live /models endpoint is unreachable.
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
 * Fetch the account's model catalog from the coding endpoint when it
 * serves one; a missing or unparsable catalog keeps the static list as the
 * source (the documented no-account-catalog exception).
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
	if (!response.ok) throw new Error(`kimi: model catalog request failed (HTTP ${response.status})`);
	const body = await response.json();
	const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
	return raw.filter((entry) => typeof entry?.id === "string").map((entry) => {
		const known = piModels.getModel(piProviderId, entry.id);
		return {
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			api: known?.api ?? "anthropic-messages",
			...(known !== void 0 && Array.isArray(known.input) ? { inputModalities: known.input.filter((modality) => modality === "text" || modality === "image") } : { inputModalities: ["text"] }),
			...Number.isInteger(entry.context_window) && entry.context_window > 0 ? { contextWindow: entry.context_window } : Number.isInteger(known?.contextWindow) && known.contextWindow > 0 ? { contextWindow: known.contextWindow } : {}
		};
	});
}
/**
 * Register the `dsh-plugin-subhub-kimi` provider route through the shared
 * pi-ai-backed core. The login is pi-ai's bundled device-code flow, which
 * the existing three-step panel already renders.
 */
function registerKimi(ctx, config) {
	return registerSubscriptionProvider(ctx, config, {
		id: PROVIDER,
		slug: SLUG,
		settingsNs: NS,
		schema: Config,
		resolveOptions: resolveAdapterOptions,
		effectiveBaseURL,
		providerFactory: () => kimiCodingProvider(),
		fallbackDescriptors,
		liveCatalog,
		// pi-ai's thinking levels come from each model's own map; models
		// without an Off mapping keep their declared levels only.
		reasoningEffort: true,
		displayName: (lang) => lang === "en" ? "Kimi Code subscription" : "Kimi Code 订阅"
	});
}
export { PROVIDER, SUBSCRIPTION_BASE_URL, fallbackDescriptors, liveCatalog, registerKimi, resolveAdapterOptions };
