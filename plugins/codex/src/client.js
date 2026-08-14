// Client half of the kino-codex plugin: a "Codex" settings page section
// driving the ChatGPT device-code login through the host plugin's
// same-origin login API (/api/kino-codex). Hand-written client bundle in the
// shell's module-loader format (no build step): the factory registers one
// settings.section slot contribution, mirroring the official client UI
// packages' pattern.
window.__ModuleLoader__.load({
	id: "kino-dsh-plugins/codex",
	factory: (require) => {
		const React = require("react");
		const inject = ["@deepseek-ai/dsh-client-runtime"];
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
			".kino-codex-primary{background:var(--dsw-alias-accent,rgba(99,126,255,.16))}"
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
		function CodexSettingsSection() {
			const [status, setStatus] = React.useState({ phase: "loading" });
			const [login, setLogin] = React.useState({ phase: "idle" });
			const mounted = React.useRef(true);
			const pollTimer = React.useRef(void 0);
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
			}, [refresh]);
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
				h("p", { className: "kino-codex-copy", key: "copy" }, "使用 ChatGPT / Codex 订阅账户登录,即可在模型选择器里选用 GPT 模型(无需 API Key)。"),
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
					h("p", { className: "kino-codex-hint", key: "hint" }, "在浏览器里打开链接并输入一次性码(15 分钟内有效)。完成后此页面会自动继续。"),
					button("取消", () => {
						stopPoll();
						setLogin({ phase: "idle" });
					})
				]) : login.phase === "success" ? h("p", {
					className: "kino-codex-success",
					key: "body"
				}, `✓ 登录成功,凭据已保存到 ${login.authFile}。现在可以在模型选择器里选择 Codex 提供商。`) : login.phase === "expired" ? h("div", { key: "body" }, [
					h("p", { className: "kino-codex-error" }, "一次性码已过期,请重新登录。"),
					button("重新登录", () => void start())
				]) : login.phase === "error" ? h("div", { key: "body" }, [
					h("p", { className: "kino-codex-error" }, `登录失败:${login.message}`),
					button("重试", () => void start())
				]) : status.loggedIn === true ? h("div", { key: "body" }, [
					h("p", { className: "kino-codex-success" }, "✓ 已登录,Codex 提供商已就绪。"),
					h("p", { className: "kino-codex-hint" }, `凭据文件:${status.authFile}`),
					button("重新登录", () => void start())
				]) : button("使用 ChatGPT 账号登录", () => void start(), "kino-codex-btn kino-codex-primary")
			]);
		}
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "codex",
				order: 20,
				label: () => "Codex",
				inject: () => ({})
			}, CodexSettingsSection));
		}
		return { apply, inject };
	}
});
