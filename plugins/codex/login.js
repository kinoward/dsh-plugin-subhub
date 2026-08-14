#!/usr/bin/env node
// Standalone device-code login for the kino-codex plugin. It implements the
// same flow the official codex CLI uses (`codex login` with device code) and
// writes credentials in the codex file format — but the plugin reads ONLY its
// own credential file, never another program's auth files.
//
// The web settings page's Codex section offers the same flow in the browser;
// use this script on headless profiles or when you prefer a terminal.
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
import { DEVICE_VERIFY_URL, authFilePayload, completeDeviceLogin, requestUserCode } from "./src/device-flow.js";

function fail(message) {
	console.error(`error: ${message}`);
	process.exit(1);
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
	const flow = await requestUserCode();

	console.log("Sign in with your ChatGPT account to use Codex models:");
	console.log("");
	console.log(`  1. Open this link in your browser:  ${DEVICE_VERIFY_URL}`);
	console.log(`  2. Enter this one-time code (expires in 15 minutes): ${flow.userCode}`);
	console.log("");
	console.log("Waiting for you to finish signing in...");

	const result = await completeDeviceLogin(flow);
	if (result.status === "expired") fail("device login timed out after 15 minutes");
	const data = authFilePayload(result.tokens);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, JSON.stringify(data, void 0, 2) + "\n", { mode: 384 });
	console.log(`Logged in. Credentials saved to ${target} (mode 600).`);
	console.log("Restart the harness or wait for the next request to pick them up.");
}
main().catch((error) => fail(error?.message ?? String(error)));
