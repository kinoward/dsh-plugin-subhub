// Client half of the kino-codex plugin: the "第三方订阅" settings section —
// one hub page where every third-party subscription provider lives. Each
// provider card shares the same login-modal surface; today OpenAI (ChatGPT /
// Codex subscription) is wired end to end, and further providers (Anthropic,
// 火山方舟 Coding Plan, …) plug in by adding a card entry plus their own
// host-side auth endpoints. Only after a successful login does the host
// register the provider route, which is what makes it appear in the Models
// page and the model picker. Hand-written client bundle in the shell's
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
			".kino-sub-copy{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px;margin:0 0 16px}",
			".kino-sub-cards{display:flex;flex-direction:column;gap:10px}",
			".kino-sub-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-module-platform,transparent)}",
			".kino-sub-head{display:flex;align-items:center;gap:10px}",
			".kino-sub-name{color:var(--dsw-alias-label-primary,#fff);font-size:14px;font-weight:500;line-height:22px}",
			".kino-sub-tag{border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));color:var(--dsw-alias-label-secondary,#ccc);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}",
			".kino-sub-tag-ok{color:var(--dsw-alias-state-success-primary,#46a758);border-color:currentColor}",
			".kino-sub-desc{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:20px;margin:0}",
			".kino-sub-actions{display:flex;align-items:center;gap:8px}",
			".kino-codex-row{display:flex;align-items:center;gap:8px;margin:8px 0}",
			".kino-codex-label{min-width:64px;font-size:13px;color:var(--dsw-alias-label-secondary)}",
			".kino-codex-code{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12));padding:6px 10px;border-radius:6px;overflow-wrap:anywhere}",
			".kino-codex-usercode{flex:0 1 auto;font-size:15px;letter-spacing:.06em}",
			".kino-codex-hint{font-size:13px;color:var(--dsw-alias-label-secondary);margin:8px 0 16px}",
			".kino-codex-success{color:var(--dsw-alias-state-success-primary,#46a758);font-size:14px;line-height:22px;margin:0 0 12px}",
			".kino-codex-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:14px;line-height:22px;margin:0 0 12px}",
			".kino-codex-btn{font:inherit;font-size:14px;padding:6px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border,rgba(127,127,127,.35));background:var(--dsw-alias-fill,rgba(255,255,255,.04));color:var(--dsw-alias-label-primary,#fff);cursor:pointer}",
			".kino-codex-btn:hover{border-color:var(--dsw-alias-label-secondary)}",
			".kino-codex-primary{background:var(--dsw-alias-accent,rgba(99,126,255,.16))}",
			".kino-codex-copy{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px;margin:0 0 16px}"
		].join("\n");
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"kino-subscriptions\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = "kino-subscriptions";
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
		 * The device-login panel: the login button, the URL + one-time code
		 * display with copy buttons, and automatic polling. Callers wrap it in
		 * their own modal and get `onDone` when a login just succeeded.
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
			return h("div", null, [
				h("p", { className: "kino-codex-copy", key: "copy" }, "使用 ChatGPT / Codex 订阅账户登录,登录成功后「OpenAI 订阅」才会出现在模型选择器里。本插件只使用自己保存的凭据,不会读取 codex CLI 等其它程序的登录信息。"),
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
				}, `✓ 登录成功,凭据已保存到 ${login.authFile}。「OpenAI 订阅」现已出现在模型选择器里。`) : login.phase === "expired" ? h("div", { key: "body" }, [
					h("p", { className: "kino-codex-error" }, "一次性码已过期,请重新登录。"),
					button("重新登录", () => void start())
				]) : login.phase === "error" ? h("div", { key: "body" }, [
					h("p", { className: "kino-codex-error" }, `登录失败:${login.message}`),
					button("重试", () => void start())
				]) : status.loggedIn === true ? h("p", {
					className: "kino-codex-success",
					key: "body"
				}, "✓ 已登录,「OpenAI 订阅」提供商已就绪。") : button("使用 ChatGPT 账号登录", () => void start(), "kino-codex-btn kino-codex-primary")
			]);
		}
		/**
		 * One provider card in the hub. `wired` providers offer the shared
		 * login modal; un-wired ones show a "coming soon" tag.
		 */
		function ProviderCard(props) {
			const { provider, loggedIn, authFile, onChanged } = props;
			const [open, setOpen] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const h = React.createElement;
			const button = (label, onClick, extra) => h("button", {
				type: "button",
				className: extra ?? "kino-codex-btn",
				onClick
			}, label);
			const logout = async () => {
				setBusy(true);
				setError("");
				try {
					await api("/login/logout", { method: "POST", body: "{}" });
					onChanged?.();
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setBusy(false);
				}
			};
			return h("div", { className: "kino-sub-card" }, [
				h("div", { className: "kino-sub-head", key: "head" }, [
					h("span", { className: "kino-sub-name" }, provider.name),
					provider.wired === true && loggedIn === true ? h("span", { className: "kino-sub-tag kino-sub-tag-ok" }, "已登录") : provider.wired !== true ? h("span", { className: "kino-sub-tag" }, "即将支持") : h("span", { className: "kino-sub-tag" }, "未登录")
				]),
				h("p", { className: "kino-sub-desc", key: "desc" }, provider.description),
				provider.wired === true ? h("div", { className: "kino-sub-actions", key: "actions" }, [
					button(loggedIn === true ? "重新登录" : "登录", () => setOpen(true), "kino-codex-btn kino-codex-primary"),
					loggedIn === true ? button(busy ? "退出中…" : "退出登录", () => void logout()) : null,
					loggedIn === true ? h("span", { className: "kino-sub-desc", style: { overflowWrap: "anywhere", fontSize: "12px" } }, authFile ?? "") : null
				]) : null,
				error !== "" ? h("p", { className: "kino-codex-error", key: "error", style: { margin: 0 } }, error) : null,
				open ? h(Primitives.Modal, {
					key: "modal",
					open: true,
					onClose: () => setOpen(false),
					title: `登录 ${provider.name}`,
					closeLabel: "关闭"
				}, h(LoginPanel, {
					onDone: () => {
						setOpen(false);
						onChanged?.();
					}
				})) : null
			]);
		}
		/** The hub page content. */
		function SubscriptionsSection() {
			const [state, setState] = React.useState({ phase: "loading" });
			const refresh = React.useCallback(async () => {
				try {
					const result = await api("/login/status");
					setState({
						phase: "ready",
						loggedIn: result.loggedIn === true,
						authFile: result.authFile
					});
				} catch (error) {
					setState({
						phase: "error",
						message: error?.message ?? String(error)
					});
				}
			}, []);
			React.useEffect(() => {
				void refresh();
			}, [refresh]);
			const h = React.createElement;
			const providers = [
				{
					id: "codex",
					name: "OpenAI 订阅",
					description: "ChatGPT / Codex 订阅账户,提供 GPT 系列模型。登录成功后自动出现在「模型」页与模型选择器。",
					wired: true
				},
				{
					id: "anthropic",
					name: "Anthropic 订阅",
					description: "Claude 系列模型。登录流程待接入。",
					wired: false
				},
				{
					id: "volcano",
					name: "火山方舟 Coding Plan",
					description: "豆包 / 深度求索系列模型。登录流程待接入。",
					wired: false
				}
			];
			return h("div", null, [
				h("p", { className: "kino-sub-copy", key: "copy" }, "在这里管理第三方订阅服务:登录成功后,对应服务才会出现在「模型」页;退出登录后即从「模型」页移除。模型与思考深度在「模型」页的服务行里设置。"),
				state.phase === "error" ? h("p", { className: "kino-codex-error", key: "error" }, `无法读取登录状态:${state.message}`) : null,
				h("div", { className: "kino-sub-cards", key: "cards" }, providers.map((provider) => {
					const props = {
						provider,
						loggedIn: provider.wired === true && state.loggedIn === true,
						authFile: state.authFile,
						onChanged: () => void refresh()
					};
					return h(ProviderCard, { ...props, key: provider.id });
				}))
			]);
		}
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "third-party-subscriptions",
				order: 20,
				label: () => "第三方订阅",
				inject: () => ({})
			}, SubscriptionsSection));
		}
		return { apply, inject };
	}
});
