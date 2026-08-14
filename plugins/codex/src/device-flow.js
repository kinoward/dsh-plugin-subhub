// Shared ChatGPT device-code login flow for the kino-codex plugin.
//
// Implements the same flow the official codex CLI uses (`codex login`):
// request a device code from auth.openai.com, show the user the verification
// URL + one-time code, poll until the user approves in the browser, then
// exchange the authorization code for OAuth tokens. Used by both the host
// plugin's login API (`plugins/codex/src/index.js`) and the standalone
// script (`plugins/codex/login.js`).
const ISSUER = "https://auth.openai.com";
const DEVICE_VERIFY_URL = `${ISSUER}/codex/device`;
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
/** Same OAuth app the official codex CLI logs in through (login + refresh). */
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Device codes live 15 minutes. */
const DEVICE_CODE_LIFETIME_MS = 15 * 60 * 1000;
/** Lowest supported polling cadence, whatever the server suggests. */
const MIN_POLL_INTERVAL_MS = 1000;
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function postJson(url, body) {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
}
/** Decode a JWT payload without verifying the signature. */
function decodeJwtPayload(token) {
	const part = token.split(".")[1];
	if (part === void 0) return void 0;
	return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}
/** The ChatGPT account id lives in the id_token's openai auth claims. */
function accountIdFromIdToken(idToken) {
	try {
		const auth = decodeJwtPayload(idToken)?.["https://api.openai.com/auth"];
		if (typeof auth?.chatgpt_account_id === "string") return auth.chatgpt_account_id;
		if (typeof auth?.chatgpt_user_id === "string") return auth.chatgpt_user_id;
	} catch {}
	return void 0;
}
/**
 * Ask auth.openai.com for a device code.
 * @param clientId - OAuth client id (defaults to the codex CLI app).
 * @returns the device-auth session facts; `intervalMs` is the server's
 *   suggested poll cadence, clamped to a sane floor.
 */
async function requestUserCode(clientId = OAUTH_CLIENT_ID) {
	const response = await postJson(`${ISSUER}/api/accounts/deviceauth/usercode`, { client_id: clientId });
	if (response.status === 404) throw new Error("device login is not enabled for this Codex server; run `codex login` instead");
	if (!response.ok) throw new Error(`device code request failed (HTTP ${response.status})`);
	const userCode = await response.json();
	if (typeof userCode.device_auth_id !== "string" || typeof userCode.user_code !== "string") throw new Error("unexpected device code response");
	const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, (Number.parseInt(String(userCode.interval ?? "5"), 10) || 5) * 1000);
	return {
		deviceAuthId: userCode.device_auth_id,
		userCode: userCode.user_code,
		intervalMs,
		verificationUrl: DEVICE_VERIFY_URL,
		expiresAtMs: Date.now() + DEVICE_CODE_LIFETIME_MS
	};
}
/**
 * One poll of the device-auth token endpoint.
 * @returns `{status: "pending"}` while the user has not approved yet,
 *   `{status: "success", authorizationCode, codeVerifier}` once approved,
 *   or throws for a hard failure. `{status: "expired"}` when the deadline
 *   passed before polling.
 */
async function pollAuthorizationOnce(deviceAuthId, userCode, expiresAtMs) {
	if (Date.now() >= expiresAtMs) return { status: "expired" };
	const response = await postJson(`${ISSUER}/api/accounts/deviceauth/token`, {
		device_auth_id: deviceAuthId,
		user_code: userCode
	});
	if (response.status === 403 || response.status === 404) return { status: "pending" };
	if (!response.ok) throw new Error(`device auth failed (HTTP ${response.status})`);
	const code = await response.json();
	if (typeof code.authorization_code !== "string" || typeof code.code_verifier !== "string") throw new Error("unexpected token response");
	return {
		status: "success",
		authorizationCode: code.authorization_code,
		codeVerifier: code.code_verifier
	};
}
/**
 * Exchange an approved authorization code for OAuth tokens.
 * @returns `{idToken, accessToken, refreshToken, accountId}`.
 */
async function exchangeAuthorizationCode(authorizationCode, codeVerifier) {
	const form = new URLSearchParams({
		grant_type: "authorization_code",
		code: authorizationCode,
		redirect_uri: REDIRECT_URI,
		client_id: OAUTH_CLIENT_ID,
		code_verifier: codeVerifier
	});
	const exchangeResponse = await fetch(`${ISSUER}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form.toString()
	});
	if (!exchangeResponse.ok) {
		const text = await exchangeResponse.text().catch(() => "");
		throw new Error(`token exchange failed (HTTP ${exchangeResponse.status})${text === "" ? "" : `: ${text.slice(0, 200)}`}`);
	}
	const tokens = await exchangeResponse.json();
	if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string" || typeof tokens.id_token !== "string") throw new Error("token exchange returned an unexpected payload");
	return {
		idToken: tokens.id_token,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		accountId: accountIdFromIdToken(tokens.id_token)
	};
}
/**
 * Poll until the user approves, then exchange the code for OAuth tokens.
 * @returns `{status: "success", tokens}` with `tokens = {idToken,
 *   accessToken, refreshToken, accountId}`, or `{status: "expired"}`.
 */
async function completeDeviceLogin(flow) {
	for (;;) {
		const poll = await pollAuthorizationOnce(flow.deviceAuthId, flow.userCode, flow.expiresAtMs);
		if (poll.status === "pending") {
			await sleep(flow.intervalMs);
			continue;
		}
		if (poll.status === "expired") return { status: "expired" };
		return {
			status: "success",
			tokens: await exchangeAuthorizationCode(poll.authorizationCode, poll.codeVerifier)
		};
	}
}
/**
 * Serialize exchanged tokens into the codex-shaped auth.json payload the
 * token store (and the official codex CLI) reads.
 */
function authFilePayload(tokens) {
	return {
		auth_mode: "chatgpt",
		OPENAI_API_KEY: null,
		tokens: {
			id_token: tokens.idToken,
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken,
			...tokens.accountId === void 0 ? {} : { account_id: tokens.accountId }
		},
		last_refresh: new Date().toISOString()
	};
}
export { DEVICE_CODE_LIFETIME_MS, DEVICE_VERIFY_URL, ISSUER, OAUTH_CLIENT_ID, REDIRECT_URI, accountIdFromIdToken, authFilePayload, completeDeviceLogin, exchangeAuthorizationCode, pollAuthorizationOnce, requestUserCode };
