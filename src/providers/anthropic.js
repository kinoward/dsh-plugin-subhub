// dsh-plugin-subhub: the Anthropic Claude subscription provider (Claude Pro
// / Claude Max). Pure spec + fetchers consumed by the pi-ai-backed core in
// src/piai.js. pi-ai's bundled anthropic OAuth owns the whole login flow
// (PKCE authorize at claude.ai, token exchange at platform.claude.com, and
// a localhost loopback callback server), so this file only contributes the
// catalog, the settings section, and the display identity.
import { resolveRetryPolicy, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS_CACHE_TTL_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, registerSubscriptionProvider } from "../piai.js";
/**
 * Provider route this plugin owns. The id must stay unique: the harness's
 * built-in provider directory already declares "anthropic" (api-key BYO
 * provider), so the subscription route uses its own
 * dsh-plugin-subhub-<provider> id with its own display name.
 */
const PROVIDER = "dsh-plugin-subhub-anthropic";
/** URL slug inside the plugin's login API and credential file name. */
const SLUG = "anthropic";
const NS = settingsNamespace("dsh-plugin-subhub-anthropic");
/**
 * Messages API the OAuth access token authenticates against. Whether the
 * account's Claude Pro/Max subscription quota bills on this host (versus
 * the claude.ai conversation endpoints) must be confirmed with a real
 * account; `baseURL` is the escape hatch either way.
 */
const SUBSCRIPTION_BASE_URL = "https://api.anthropic.com";
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
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 */
function resolveAdapterOptions(config) {
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("anthropic: defaultContextWindow must be a positive integer");
	if (config.defaultReasoningEffort !== void 0 && !EFFORT_LEVELS.has(config.defaultReasoningEffort)) throw new Error(`anthropic: defaultReasoningEffort must be one of ${[...EFFORT_LEVELS].join(", ")}`);
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`anthropic: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const modelsCacheTtlMs = config.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
	if (!Number.isFinite(modelsCacheTtlMs) || modelsCacheTtlMs <= 0) throw new Error("anthropic: modelsCacheTtlMs must be a positive finite number");
	return {
		authFile: config.authFile,
		baseURL: config.baseURL,
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		modelsCacheTtlMs,
		defaultReasoningEffort: config.defaultReasoningEffort,
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "anthropic: retryPolicy")
	};
}
/** Pick the endpoint for the subscription OAuth token. */
function effectiveBaseURL(config) {
	return config.baseURL ?? SUBSCRIPTION_BASE_URL;
}
/**
 * Anthropic has no per-account model catalog endpoint, so the canonical
 * pi-ai catalog (current-generation ids, dated aliases dropped) serves as
 * the picker list — the documented exception to the dynamic-catalog rule,
 * because nothing account-specific exists to fetch.
 */
function fallbackDescriptors(piModels, piProvider) {
	return piModels.getModels(piProvider.id).filter((model) => !/-\d{8}$/.test(model.id)).map((model) => ({
		id: model.id,
		name: model.name ?? model.id,
		...Array.isArray(model.input) ? { inputModalities: model.input.filter((modality) => modality === "text" || modality === "image") } : {},
		...Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}
	}));
}
/**
 * No online catalog exists for Anthropic subscriptions; returning an empty
 * list keeps the canonical catalog as the sole source.
 * @returns an empty array (the caller uses the canonical list).
 */
async function liveCatalog(_config, _apiKey, _piProviderId, _piModels) {
	return [];
}
/**
 * Register the `dsh-plugin-subhub-anthropic` provider route through the
 * shared pi-ai-backed core. The login is a loopback PKCE flow: the page
 * opens the claude.ai authorization URL, the user approves, and the
 * redirect lands on the host's localhost callback server that pi-ai owns —
 * so the browser must run on the same machine as the harness.
 */
function registerAnthropic(ctx, config) {
	return registerSubscriptionProvider(ctx, config, {
		id: PROVIDER,
		slug: SLUG,
		settingsNs: NS,
		schema: Config,
		resolveOptions: resolveAdapterOptions,
		effectiveBaseURL,
		providerFactory: () => anthropicProvider(),
		fallbackDescriptors,
		liveCatalog,
		// pi-ai's thinking levels already order Off first, then low to high;
		// the selected level maps onto the wire through the model's own map.
		reasoningEffort: true,
		// The manual-code prompt is never answered from the web UI: the
		// loopback callback captures the code. The handler hangs until the
		// login is cancelled so pi-ai's own prompt race does not abort the
		// flow, and cancelling (logout) tears the callback server down.
		loginPrompt: async (_input, signal) => await new Promise((_resolve, reject) => {
			const fail = () => reject(new Error("login cancelled"));
			if (signal.aborted) return fail();
			signal.addEventListener("abort", fail, { once: true });
		}),
		displayName: (lang) => lang === "en" ? "Claude subscription" : "Claude 订阅"
	});
}
export { PROVIDER, SUBSCRIPTION_BASE_URL, fallbackDescriptors, liveCatalog, registerAnthropic, resolveAdapterOptions };
