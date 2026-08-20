// dsh-plugin-subhub: the plan-key provider. Volcengine Ark Coding Plan is a
// genuine subscription plan (monthly coding quota) consumed through its
// plan-specific OpenAI-compatible endpoint, authenticated with a plan key
// pasted in the hub. The harness does not ship a Volcengine route, so the
// plugin builds a minimal pi-ai provider for it. (MiniMax, Alibaba Bailian
// Token Plan and OpenRouter were considered and rejected: the harness's own
// Models page already ships minimax-cn / qwen-token-plan-cn / openrouter as
// built-in API-key routes, so re-integrating them here would duplicate.)
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS_CACHE_TTL_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, registerSubscriptionProvider } from "../piai.js";
/** Reasoning-level vocabulary the backends accept. */
const EFFORT_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Shared settings schema for API-key providers. */
function makeConfig() {
	return z.object({
		authFile: z.string(),
		baseURL: z.string(),
		defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
		modelsCacheTtlMs: z.number().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODELS_CACHE_TTL_MS),
		defaultReasoningEffort: z.union(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
		streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
		retryPolicy: RetryPolicySchema
	});
}
function makeResolveOptions(label) {
	return function resolveAdapterOptions(config) {
		if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error(`${label}: defaultContextWindow must be a positive integer`);
		if (config.defaultReasoningEffort !== void 0 && !EFFORT_LEVELS.has(config.defaultReasoningEffort)) throw new Error(`${label}: defaultReasoningEffort must be one of ${[...EFFORT_LEVELS].join(", ")}`);
		const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
		if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`${label}: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
		const modelsCacheTtlMs = config.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
		if (!Number.isFinite(modelsCacheTtlMs) || modelsCacheTtlMs <= 0) throw new Error(`${label}: modelsCacheTtlMs must be a positive finite number`);
		return {
			authFile: config.authFile,
			baseURL: config.baseURL,
			defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
			modelsCacheTtlMs,
			defaultReasoningEffort: config.defaultReasoningEffort,
			streamIdleTimeoutMs,
			retryPolicy: resolveRetryPolicy(config.retryPolicy, `${label}: retryPolicy`)
		};
	};
}
/** Resolve the stored API key for one request (no rotation for keys). */
async function resolveApiKey({ store, providerId, label }) {
	const credential = await store.read(providerId);
	if (credential?.type !== "api_key" || typeof credential.key !== "string" || credential.key.length === 0) throw new LlmError(`${label}: no API key found; save one from the "Third-party subscriptions" settings page`, "MISSING_CREDENTIAL");
	return credential.key;
}
/**
 * Standard OpenAI-compatible live catalog: GET {base}/models with the
 * Bearer key, model ids from data[]/models[]. Known models reuse pi-ai's
 * declared input modalities; unknown live ids stay text-only.
 */
function openAICompatLiveCatalog(label, defaultBaseURL) {
	return async function liveCatalog(config, apiKey, piProviderId, piModels) {
		const baseURL = config.baseURL ?? defaultBaseURL;
		const response = await fetch(`${baseURL}/models`, {
			headers: {
				"authorization": `Bearer ${apiKey}`
			}
		});
		if (!response.ok) throw new Error(`${label}: model catalog request failed (HTTP ${response.status})`);
		const body = await response.json();
		const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
		return raw.filter((entry) => typeof entry?.id === "string").map((entry) => {
			const known = piModels.getModel(piProviderId, entry.id);
			return {
				id: entry.id,
				name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
				api: known?.api ?? "openai-completions",
				...(known !== void 0 && Array.isArray(known.input) ? { inputModalities: known.input.filter((modality) => modality === "text" || modality === "image") } : { inputModalities: ["text"] }),
				...Number.isInteger(entry.context_window) && entry.context_window > 0 ? { contextWindow: entry.context_window } : Number.isInteger(known?.contextWindow) && known.contextWindow > 0 ? { contextWindow: known.contextWindow } : {}
			};
		});
	};
}
/**
 * Probe a pasted key against the catalog endpoint. Only an explicit auth
 * refusal (HTTP 401/403) rejects the key: a missing or unreachable catalog
 * endpoint (404/405/5xx/network) says nothing about key validity, so the key
 * is persisted as-is — the same posture as a provider with no catalog to
 * probe (some plan endpoints serve no /models route at all).
 */
function makeValidate(label, liveCatalog) {
	return async function validateApiKey(key, helpers) {
		try {
			await liveCatalog(helpers.options(), key, helpers.piProviderId, helpers.piModels);
		} catch (error) {
			const message = String(error?.message ?? error);
			if (!/HTTP (401|403)\b/.test(message)) return;
			throw error;
		}
	};
}
/** Shared registration for one API-key provider. */
function registerApiKeyProvider(ctx, config, { id, slug, label, defaultBaseURL, providerFactory, fallbackFilter, liveCatalog, validate, reasoningEffort, displayName }) {
	return registerSubscriptionProvider(ctx, config, {
		id,
		slug,
		settingsNs: settingsNamespace(id),
		schema: makeConfig(),
		resolveOptions: makeResolveOptions(label),
		effectiveBaseURL: (resolved) => resolved.baseURL ?? defaultBaseURL,
		providerFactory,
		fallbackDescriptors: (piModels, piProvider) => piModels.getModels(piProvider.id).filter((model) => fallbackFilter(model)).map((model) => ({
			id: model.id,
			name: model.name ?? model.id,
			...Array.isArray(model.input) ? { inputModalities: model.input.filter((modality) => modality === "text" || modality === "image") } : {},
			...Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}
		})),
		liveCatalog,
		reasoningEffort,
		resolveApiKey: ({ store, providerId }) => resolveApiKey({ store, providerId, label }),
		// The plan-key provider accepts a pasted key; the spec's validator
		// probes it against the backend when one exists, otherwise the key is
		// persisted as-is.
		saveApiKey: async (key, helpers) => {
			if (validate !== void 0) await validate(key, helpers);
		},
		displayName
	});
}
//#region Volcengine Ark (custom provider: pi-ai ships no volcengine route)
const VOLCENGINE_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
/** pi-ai has no Volcengine provider; a minimal one carries the wire protocol. */
function volcengineProvider() {
	return createProvider({
		id: "volcengine-subhub",
		name: "Volcengine Ark",
		baseUrl: VOLCENGINE_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Volcengine Ark API key", []) },
		models: [
			{ id: "auto", name: "Auto", api: "openai-completions", input: ["text"] },
			{ id: "doubao-seed-code", name: "Doubao Seed Code", api: "openai-completions", input: ["text"] },
			{ id: "doubao-seed-2.0-pro", name: "Doubao Seed 2.0 Pro", api: "openai-completions", input: ["text"] },
			{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", api: "openai-completions", input: ["text"] },
			{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", api: "openai-completions", input: ["text"] },
			{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code", api: "openai-completions", input: ["text"] },
			{ id: "glm-5.2", name: "GLM 5.2", api: "openai-completions", input: ["text"] }
		],
		api: openAICompletionsApi()
	});
}
function registerVolcengine(ctx, config) {
	return registerApiKeyProvider(ctx, config, {
		id: "dsh-plugin-subhub-volcengine",
		slug: "volcengine",
		label: "volcengine",
		defaultBaseURL: VOLCENGINE_BASE_URL,
		providerFactory: volcengineProvider,
		fallbackFilter: () => true,
		liveCatalog: openAICompatLiveCatalog("volcengine", VOLCENGINE_BASE_URL),
		validate: makeValidate("volcengine", openAICompatLiveCatalog("volcengine", VOLCENGINE_BASE_URL)),
		reasoningEffort: false,
		displayName: (lang) => lang === "en" ? "Volcengine Ark" : "火山方舟"
	});
}
//#endregion
export { registerVolcengine };
