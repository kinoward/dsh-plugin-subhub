// Client half of the kino-codex plugin: the ChatGPT device-code login
// integrated into the Models settings domain (no sidebar section). Two
// official surfaces carry it:
//   - `settings.onboarding`: a step in the model-settings onboarding layer
//     (the same layer as the official DeepSeek credential dialog) that opens
//     a login modal when the app is fresh and no Codex credential exists;
//   - `settings.action`: a header button "登录 OpenAI 订阅" on the settings
//     panel, available any time until the user is logged in.
// Both render the same LoginPanel. Hand-written client bundle in the shell's
// module-loader format (no build step).
window.__ModuleLoader__.load({
	id: "kino-dsh-plugins/codex",
	factory: (require) => {
		const React = require("react");
		const Primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const inject = ["slots"];
		const API = "/api/kino-codex";
		const POLL_MS = 2500;
		const css = [
			".kino-codex-copy{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px;margin:0 0 16px}",
			".kino-codex-row{display:flex;align-items:center;gap:8px;margin:8px 0}",
			".kino-codex-label{min-width:64px;font-size:13px;color:var(--dsw-alias-label-secondary)}",
			".kino-codex-code{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12));padding:6px 10px;border-radius:6px;overflow-wrap:anywhere}",
			".kino-codex-usercode{flex:0 1 auto;font-size:15px;letter-spacing:.06em}",
			".kino-codex-hint{font-size:13px;color:var(--dsw-alias-label-secondary);margin:8px 0 16px}",
			".kino-codex-success{color:var(--dsw-alias-state-success,var(--dsw-alias-label-primary));font-size:14px;line-height:22px;margin:0 0 12px}",
			".kino-codex-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:14px;line-height:22px;margin:0 0 12px}",
			".kino-codex-btn{font:inherit;font-size:14px;padding:6px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border,rgba(127,127,127,.35));background:var(--dsw-alias-fill,rgba(255,255,255,.04));color:var(--dsw-alias-label-primary,#fff);cursor:pointer}",
			".kino-codex-btn:hover{border-color:var(--dsw-alias-label-secondary)}",
			".kino-codex-primary{background:var(--dsw-alias-accent,rgba(99,126,255,.16))}",
			".kino-codex-header-btn{box-sizing:border-box;height:28px;font:inherit;font-size:12px;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:14px;color:var(--dsw-alias-label-primary,#fff);padding:0 10px;line-height:18px}",
			".kino-codex-header-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}"
		].join("\n");
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"kino-codex\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = "kino-codex";
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		/** Same-origin JSON call to the host plugin's login API. */
		async function api(path, options = {}) {
			const response = await fetch(`${API}${path}`, {
				...options,
				headers: {
					"content-type": "application/json",
					...options.headers === void 0 ? {} : options.headers
				}
			});
			let body;
			try {
				body = await response.json();
			} catch {
				body = {};
			}
			if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
			return body;
		}
		/**
		 * The device-login panel: status line, the login button, and the
		 * URL + one-time code display with automatic polling. Callers wrap it
		 * in their own modal and get `onDone` when a login just succeeded.
		 */
		function LoginPanel(props) {
			const [status, setStatus] = React.useState({ phase: "loading" });
			const [login, setLogin] = React.useState({ phase: "idle" });
			const mounted = React.useRef(true);
			const pollTimer = React.useRef(void 0);
			const onDone = props.onDone;
			const stopPoll = () => {
				if (pollTimer.current !== void 0) {
					clearTimeout(pollTimer.current);
					pollTimer.current = void 0;
				}
			};
			const refresh = React.useCallback(async () => {
				try {
					const result = await api("/login/status");
					if (!mounted.current) return;
					setStatus({
						phase: "ready",
						loggedIn: result.loggedIn === true,
						authFile: result.authFile
					});
				} catch (error) {
					if (mounted.current) setStatus({
						phase: "error",
						message: error?.message ?? String(error)
					});
				}
			}, []);
			const schedulePoll = React.useCallback(() => {
				pollTimer.current = setTimeout(async () => {
					try {
						const result = await api("/login/poll", { method: "POST", body: "{}" });
						if (!mounted.current) return;
						if (result.status === "pending") {
							schedulePoll();
							return;
						}
						if (result.status === "success") {
							setLogin({
								phase: "success",
								authFile: result.authFile
							});
							void refresh();
							if (typeof onDone === "function") onDone();
							return;
						}
						if (result.status === "expired") {
							setLogin({ phase: "expired" });
							return;
						}
						setLogin({
							phase: "error",
							message: result.message ?? "login failed"
						});
					} catch {
						if (mounted.current) schedulePoll();
					}
				}, POLL_MS);
			}, [refresh, onDone]);
			const start = React.useCallback(async () => {
				setLogin({ phase: "starting" });
				try {
					const result = await api("/login/start", { method: "POST", body: "{}" });
					if (!mounted.current) return;
					setLogin({
						phase: "waiting",
						verificationUrl: result.verificationUrl,
						userCode: result.userCode
					});
					schedulePoll();
				} catch (error) {
					if (mounted.current) setLogin({
						phase: "error",
						message: error?.message ?? String(error)
					});
				}
			}, [schedulePoll]);
			React.useEffect(() => {
				mounted.current = true;
				void refresh();
				return () => {
					mounted.current = false;
					stopPoll();
				};
			}, [refresh]);
			const copy = async (text) => {
				try {
					await navigator.clipboard.writeText(text);
				} catch {}
			};
			const h = React.createElement;
			const button = (label, onClick, extra) => h("button", {
				type: "button",
				className: extra ?? "kino-codex-btn",
				onClick
			}, label);
			return h("div", { className: "kino-codex" }, [
				h("p", { className: "kino-codex-copy", key: "copy" }, "使用 ChatGPT / Codex 订阅账户登录,即可在模型选择器里选用 GPT 模型(无需 API Key)。本插件只使用自己保存的凭据,不会读取 codex CLI 等其它程序的登录信息。"),
				status.phase === "loading" ? h("p", { key: "body" }, "正在读取登录状态…") : status.phase === "error" ? h("p", {
					className: "kino-codex-error",
					key: "body"
				}, `无法读取登录状态:${status.message}`) : login.phase === "starting" ? h("p", { key: "body" }, "正在申请一次性登录码…") : login.phase === "waiting" ? h("div", { key: "body" }, [
					h("div", { className: "kino-codex-row", key: "url" }, [
						h("span", { className: "kino-codex-label" }, "登录链接"),
						h("code", { className: "kino-codex-code" }, login.verificationUrl),
						button("复制", () => void copy(login.verificationUrl))
					]),
					h("div", { className: "kino-codex-row", key: "code" }, [
						h("span", { className: "kino-codex-label" }, "一次性码"),
						h("code", { className: "kino-codex-code kino-codex-usercode" }, login.userCode),
						button("复制", () => void copy(login.userCode))
					]),
					h("p", { className: "kino-codex-hint", key: "hint" }, "在浏览器里打开链接并输入一次性码(15 分钟内有效)。完成后此页面会自动继续。")
				]) : login.phase === "success" ? h("p", {
					className: "kino-codex-success",
					key: "body"
				}, `✓ 登录成功,凭据已保存到 ${login.authFile}。现在可以在模型选择器里选择「OpenAI 订阅」提供商。`) : login.phase === "expired" ? h("div", { key: "body" }, [
					h("p", { className: "kino-codex-error" }, "一次性码已过期,请重新登录。"),
					button("重新登录", () => void start())
				]) : login.phase === "error" ? h("div", { key: "body" }, [
					h("p", { className: "kino-codex-error" }, `登录失败:${login.message}`),
					button("重试", () => void start())
				]) : status.loggedIn === true ? h("div", { key: "body" }, [
					h("p", { className: "kino-codex-success" }, "✓ 已登录,「OpenAI 订阅」提供商已就绪。"),
					h("p", { className: "kino-codex-hint" }, `凭据文件:${status.authFile}`)
				]) : button("使用 ChatGPT 账号登录", () => void start(), "kino-codex-btn kino-codex-primary")
			]);
		}
		/**
		 * Onboarding step in the model-settings layer (the same surface the
		 * official DeepSeek credential dialog uses). Renders nothing and
		 * completes itself when credentials already exist or the status check
		 * fails; otherwise it opens the login modal until the user logs in or
		 * skips.
		 */
		function CodexOnboardingStep(props) {
			const { complete } = props;
			const [needsLogin, setNeedsLogin] = React.useState(false);
			const checked = React.useRef(false);
			const check = React.useCallback(async () => {
				try {
					const result = await api("/login/status");
					if (result.loggedIn === true) {
						complete();
						return;
					}
					setNeedsLogin(true);
				} catch {
					complete();
				}
			}, [complete]);
			React.useEffect(() => {
				if (checked.current) return;
				checked.current = true;
				void check();
			}, [check]);
			if (!needsLogin) return null;
			const h = React.createElement;
			return h(Primitives.Modal, {
				open: true,
				onClose: () => complete(),
				title: "登录 OpenAI 订阅",
				closeLabel: "稍后再说"
			}, h(LoginPanel, { onDone: () => complete() }));
		}
		/** Header action: a login button on the settings panel until logged in. */
		function CodexLoginAction() {
			const [phase, setPhase] = React.useState("loading");
			const [open, setOpen] = React.useState(false);
			React.useEffect(() => {
				let alive = true;
				void (async () => {
					try {
						const result = await api("/login/status");
						if (alive) setPhase(result.loggedIn === true ? "logged-in" : "ready");
					} catch {
						if (alive) setPhase("ready");
					}
				})();
				return () => {
					alive = false;
				};
			}, []);
			if (phase !== "ready") return null;
			const h = React.createElement;
			return h(React.Fragment, null, [
				h("button", {
					type: "button",
					key: "trigger",
					className: "kino-codex-header-btn",
					onClick: () => setOpen(true)
				}, "登录 OpenAI 订阅"),
				open ? h(Primitives.Modal, {
					key: "modal",
					open: true,
					onClose: () => setOpen(false),
					title: "登录 OpenAI 订阅",
					closeLabel: "关闭"
				}, h(LoginPanel, { onDone: () => setOpen(false) })) : null
			]);
		}
		function apply(ctx) {
			ctx.slots.inject("settings.onboarding", () => ctx.slots.register({
				name: "settings.onboarding",
				id: "codex-login",
				order: 10,
				inject: () => ({})
			}, CodexOnboardingStep));
			ctx.slots.inject("settings.action", () => ctx.slots.register({
				name: "settings.action",
				id: "codex-login",
				order: 0,
				inject: () => ({})
			}, CodexLoginAction));
		}
		return { apply, inject };
	}
});
