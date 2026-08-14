#!/usr/bin/env node
// Standalone device-code login for the kino-codex plugin. It implements the
// same flow the official codex CLI uses (`codex login` with device code) and
// writes a codex-shaped auth.json, so either tool can read it.
//
// Usage:
//   node plugins/codex/login.js [--auth-file /path/to/codex-auth.json]
//
// Requires Node.js 18+ (global fetch). Tokens are written with file mode
// 0600; the file content is never printed.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const ISSUER = "https://auth.openai.com";
const DEVICE_VERIFY_URL = `${ISSUER}/codex/device`;
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
/** Same OAuth app the official codex CLI logs in through. */
const CLIENT_ID = process.env.KINO_CODEX_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const MAX_WAIT_MS = 15 * 60 * 1000;

function fail(message) {
	console.error(`error: ${message}`);
	process.exit(1);
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function postJson(url, body) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	return response;
}
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
function parseArgs(argv) {
	let authFile;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--auth-file") {
			authFile = argv[index + 1];
			if (authFile === void 0) fail("--auth-file needs a path argument");
			index++;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			console.log("Usage: node plugins/codex/login.js [--auth-file <path>]");
			console.log("");
			console.log("Sign in with your ChatGPT/Codex subscription account and save");
			console.log("the OAuth tokens where the kino-codex plugin can read them.");
			console.log("Defaults to ~/.kino-dsh/codex-auth.json.");
			process.exit(0);
		}
		fail(`unknown argument: ${arg}`);
	}
	return authFile ?? join(homedir(), ".kino-dsh", "codex-auth.json");
}
async function main() {
	const target = parseArgs(process.argv.slice(2));

	// 1. Ask for a device code.
	const userCodeResponse = await postJson(`${ISSUER}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID });
	if (userCodeResponse.status === 404) fail("device login is not enabled for this Codex server; run `codex login` instead");
	if (!userCodeResponse.ok) fail(`device code request failed (HTTP ${userCodeResponse.status})`);
	const userCode = await userCodeResponse.json();
	if (typeof userCode.device_auth_id !== "string" || typeof userCode.user_code !== "string") fail("unexpected device code response");
	const intervalMs = Math.max(1000, (Number.parseInt(String(userCode.interval ?? "5"), 10) || 5) * 1000);

	console.log("Sign in with your ChatGPT account to use Codex models:");
	console.log("");
	console.log(`  1. Open this link in your browser:  ${DEVICE_VERIFY_URL}`);
	console.log(`  2. Enter this one-time code (expires in 15 minutes): ${userCode.user_code}`);
	console.log("");
	console.log("Waiting for you to finish signing in...");

	// 2. Poll until the user approves, then exchange the code for tokens.
	const start = Date.now();
	for (;;) {
		if (Date.now() - start >= MAX_WAIT_MS) fail("device login timed out after 15 minutes");
		await sleep(intervalMs);
		const pollResponse = await postJson(`${ISSUER}/api/accounts/deviceauth/token`, {
			device_auth_id: userCode.device_auth_id,
			user_code: userCode.user_code
		});
		if (pollResponse.status === 403 || pollResponse.status === 404) continue;
		if (!pollResponse.ok) fail(`device auth failed (HTTP ${pollResponse.status})`);
		const code = await pollResponse.json();
		if (typeof code.authorization_code !== "string" || typeof code.code_verifier !== "string") fail("unexpected token response");

		// 3. Exchange the authorization code for OAuth tokens.
		const form = new URLSearchParams({
			grant_type: "authorization_code",
			code: code.authorization_code,
			redirect_uri: REDIRECT_URI,
			client_id: CLIENT_ID,
			code_verifier: code.code_verifier
		});
		const exchangeResponse = await fetch(`${ISSUER}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form.toString()
		});
		if (!exchangeResponse.ok) {
			const text = await exchangeResponse.text().catch(() => "");
			fail(`token exchange failed (HTTP ${exchangeResponse.status})${text === "" ? "" : `: ${text.slice(0, 200)}`}`);
		}
		const tokens = await exchangeResponse.json();
		if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string" || typeof tokens.id_token !== "string") fail("token exchange returned an unexpected payload");
		const accountId = accountIdFromIdToken(tokens.id_token);
		const data = {
			auth_mode: "chatgpt",
			OPENAI_API_KEY: null,
			tokens: {
				id_token: tokens.id_token,
				access_token: tokens.access_token,
				refresh_token: tokens.refresh_token,
				...accountId === void 0 ? {} : { account_id: accountId }
			},
			last_refresh: new Date().toISOString()
		};
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, JSON.stringify(data, void 0, 2) + "\n", { mode: 384 });
		console.log(`Logged in. Credentials saved to ${target} (mode 600).`);
		console.log("Restart the harness or wait for the next request to pick them up.");
		return;
	}
}
main().catch((error) => fail(error?.message ?? String(error)));
