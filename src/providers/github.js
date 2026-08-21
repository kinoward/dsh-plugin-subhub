// dsh-plugin-subhub: the GitHub Copilot subscription provider. Pure spec +
// fetchers consumed by the pi-ai-backed core in src/piai.js. pi-ai's
// bundled github-copilot OAuth owns the whole login flow (device code on
// github.com, the copilot_internal token exchange, per-model policy
// enabling, and the live model-id list), so this file only contributes the
// account catalog fetch, the settings section, and the display identity.
import { resolveRetryPolicy, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODELS_CACHE_TTL_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, registerSubscriptionProvider } from "../piai.js";
/**
 * Provider route this plugin owns. The id must stay unique: the harness's
 * built-in provider directory already declares "github-copilot" (api-key
 * BYO provider), so the subscription route uses its own
 * dsh-plugin-subhub-<provider> id with its own display name.
 */
const PROVIDER = "dsh-plugin-subhub-github";
/** URL slug inside the plugin's login API and credential file name. */
const SLUG = "github";
const NS = settingsNamespace("dsh-plugin-subhub-github");
/**
 * Chat proxy the Copilot extension talks to. pi-ai's OAuth toAuth derives
 * the credential-specific host from the token's proxy-ep claim, so this is
 * only the fallback when a credential carries none.
 */
const SUBSCRIPTION_BASE_URL = "https://api.individual.githubcopilot.com";
/**
 * Identity headers the Copilot endpoints expect from the official
 * extension. The chat protocol's dynamic headers (X-Initiator,
 * Openai-Intent, Copilot-Vision-Request) are added by pi-ai itself for the
 * github-copilot provider; these ride the catalog request and the chat
 * client defaults.
 */
const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat"
};
const Config = z.object({
	authFile: z.string(),
	baseURL: z.string(),
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
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("github: defaultContextWindow must be a positive integer");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`github: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const modelsCacheTtlMs = config.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
	if (!Number.isFinite(modelsCacheTtlMs) || modelsCacheTtlMs <= 0) throw new Error("github: modelsCacheTtlMs must be a positive finite number");
	return {
		authFile: config.authFile,
		baseURL: config.baseURL,
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		modelsCacheTtlMs,
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "github: retryPolicy")
	};
}
/** Pick the endpoint for subscription requests. */
function effectiveBaseURL(config) {
	return config.baseURL ?? SUBSCRIPTION_BASE_URL;
}
/**
 * Static fallback catalog built from pi-ai's shipped Copilot model data,
 * shown only while the live /models endpoint is unreachable. It never
 * merges into the live list.
 */
function fallbackDescriptors(piModels, piProvider) {
	return piModels.getModels(piProvider.id).map((model) => ({
		id: model.id,
		name: model.name ?? model.id,
		...Array.isArray(model.input) ? { inputModalities: model.input.filter((modality) => modality === "text" || modality === "image") } : {},
		...Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}
	}));
}
/** Whether the Copilot account can actually use this model in chat. */
function isSelectableCopilotModel(item) {
	const policy = item?.policy;
	const capabilities = item?.capabilities;
	const supports = capabilities?.supports;
	// `model_picker_enabled` is false even for chat-usable models on some
	// accounts, while `policy.state === "enabled"` marks exactly the models
	// the chat endpoint accepts (verified against the individual API: an
	// enabled model like gpt-4.1 answers chat requests; the old gate fell
	// back to the static list of stale ids the API rejects).
	return policy?.state === "enabled" && supports?.tool_calls !== false;
}
/**
 * Fetch the account's model catalog from the Copilot chat proxy. Only
 * picker-selectable models are listed; capabilities the endpoint does not
 * declare fall back to pi-ai's static model facts.
 * @returns catalog entries, or an empty array (the caller falls back to the
 *   static list).
 */
async function liveCatalog(config, apiKey, piProviderId, piModels) {
	const baseURL = effectiveBaseURL(config);
	const response = await fetch(`${baseURL}/models`, {
		headers: {
			"authorization": `Bearer ${apiKey}`,
			"accept": "application/json",
			...COPILOT_HEADERS,
			"X-GitHub-Api-Version": "2026-06-01"
		}
	});
	if (!response.ok) throw new Error(`github: model catalog request failed (HTTP ${response.status})`);
	const body = await response.json();
	const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
	return raw.filter((entry) => typeof entry?.id === "string" && isSelectableCopilotModel(entry)).map((entry) => {
		const known = piModels.getModel(piProviderId, entry.id);
		const limits = entry.capabilities?.limits;
		const supports = entry.capabilities?.supports;
		const endpoints = Array.isArray(entry.supported_endpoints) ? entry.supported_endpoints : [];
		// Known models keep pi-ai's wire protocol; unknown live ids pick the
		// protocol the endpoint declares (responses-only models cannot talk
		// completions).
		const api = known?.api ?? (endpoints.includes("/v1/messages") ? "anthropic-messages" : endpoints.includes("/responses") ? "openai-responses" : "openai-completions");
		const contextWindow = Number.isInteger(limits?.max_context_window_tokens) && limits.max_context_window_tokens > 0 ? limits.max_context_window_tokens : Number.isInteger(known?.contextWindow) && known.contextWindow > 0 ? known.contextWindow : void 0;
		return {
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			api,
			// Capability fields never fabricated: known models reuse pi-ai's
			// declared input modalities, unknown live ids follow the
			// endpoint's vision flag.
			...(known !== void 0 && Array.isArray(known.input) ? { inputModalities: known.input.filter((modality) => modality === "text" || modality === "image") } : supports?.vision === true ? { inputModalities: ["text", "image"] } : { inputModalities: ["text"] }),
			...contextWindow === void 0 ? {} : { contextWindow }
		};
	});
}
/**
 * Register the `dsh-plugin-subhub-github` provider route through the shared
 * pi-ai-backed core. The device flow targets the public github.com endpoint
 * (the blank answer to pi-ai's Enterprise-domain prompt); an Enterprise
 * deployment is a future setting.
 */
function registerGithub(ctx, config) {
	return registerSubscriptionProvider(ctx, config, {
		id: PROVIDER,
		slug: SLUG,
		settingsNs: NS,
		schema: Config,
		resolveOptions: resolveAdapterOptions,
		effectiveBaseURL,
		providerFactory: () => githubCopilotProvider(),
		fallbackDescriptors,
		liveCatalog,
		// Copilot chat models do not take a reasoning-effort parameter.
		reasoningEffort: false,
		// The chat client defaults mirror the official extension identity;
		// dynamic copilot headers come from pi-ai itself.
		modelHeaders: () => COPILOT_HEADERS,
		// pi-ai's login asks for a GitHub Enterprise domain before showing
		// the device code; blank means the public github.com endpoint.
		loginPrompt: async () => "",
		displayName: () => "GitHub Copilot"
	});
}
export { COPILOT_HEADERS, PROVIDER, SUBSCRIPTION_BASE_URL, fallbackDescriptors, isSelectableCopilotModel, liveCatalog, registerGithub, resolveAdapterOptions };
