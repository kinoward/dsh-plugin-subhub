// Client half of the kino-codex plugin: the "第三方订阅" settings section —
// one hub page where every third-party subscription provider lives. Each
// provider card shares the same login-modal surface; today OpenAI (ChatGPT /
// Codex subscription) is wired end to end, and further providers (Anthropic,
// 火山方舟 Coding Plan, …) plug in by adding a card entry plus their own
// host-side auth endpoints. Only after a successful login does the host
// register the provider route, which is what makes it appear in the Models
// page and the model picker. The UI follows the shell design system: shell
// primitives (Button / Modal / StateDot), --dsw-alias-* theme tokens, and
// locale dictionaries registered through the locale service. Hand-written
// client bundle in the shell's module-loader format (no build step).
window.__ModuleLoader__.load({
	id: "kino-dsh-plugins/codex",
	factory: (require) => {
		const React = require("react");
		const {
			Button,
			Modal,
			StateDot,
			IconCheckOutline16,
			IconCopyOutline16,
			IconGlobeOutline14,
			IconRightUpOutline16,
			IconUserOutline16,
			IconWarningOutline16,
			writeClipboard
		} = require("@deepseek-ai/dsh-client-ui-primitives");
		const inject = ["slots", "locale"];
		const API = "/api/kino-codex";
		const POLL_MS = 2500;
		const NS = "settings.subscriptions";
		const h = React.createElement;
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			nav: "第三方订阅",
			intro: "在这里管理第三方订阅:登录成功后,对应服务会出现在「模型」页;退出登录后即移除。模型与思考深度请在「模型」页的服务行中设置。",
			checking: "正在读取登录状态…",
			statusError: "无法读取登录状态:{message}",
			retry: "重试",
			statusLoggedIn: "已登录",
			statusLoggedOut: "未登录",
			login: "登录",
			relogin: "重新登录",
			logout: "退出登录",
			loggingOut: "退出中…",
			credentialFile: "凭据文件",
			openaiName: "OpenAI 订阅",
			openaiDesc: "GPT 系列模型,使用 ChatGPT / Codex 订阅账户登录。",
			moreComing: "其他服务即将接入,敬请期待。",
			modalTitle: "登录 {name}",
			modalDesc: "在浏览器中完成一次性设备授权,登录成功后此页面自动同步。",
			close: "关闭",
			privacyNote: "登录凭据仅保存在本插件自己的文件中,不会读取 codex CLI 等其它程序的登录信息。",
			requesting: "正在申请一次性登录码…",
			step1: "打开下面的登录链接",
			step2: "输入一次性码",
			step3: "完成授权后,此页面会自动继续",
			linkExpires: "一次性码 15 分钟内有效",
			open: "打开链接",
			copy: "复制",
			copied: "已复制",
			waitingForAuth: "等待授权中,请勿关闭此页面…",
			loggedInDone: "登录成功,「{name}」现已出现在模型选择器中。",
			loggedInReady: "已登录,「{name}」提供商已就绪。",
			expired: "一次性码已过期,请重新登录。",
			loginFailed: "登录失败:{message}",
			loginButton: "使用 ChatGPT 账号登录",
			loginButtonAgain: "使用新账号登录"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			nav: "Subscriptions",
			intro: "Manage third-party subscriptions here: after a successful sign-in the provider appears on the Models page, and signing out removes it. Models and reasoning levels are configured on the Models page.",
			checking: "Reading login status…",
			statusError: "Could not read login status: {message}",
			retry: "Retry",
			statusLoggedIn: "Signed in",
			statusLoggedOut: "Signed out",
			login: "Sign in",
			relogin: "Sign in again",
			logout: "Sign out",
			loggingOut: "Signing out…",
			credentialFile: "Credential file",
			openaiName: "OpenAI subscription",
			openaiDesc: "GPT models, signed in with a ChatGPT / Codex subscription account.",
			moreComing: "More providers are on the way. Stay tuned.",
			modalTitle: "Sign in to {name}",
			modalDesc: "Complete a one-time device authorization in the browser; this page syncs automatically after sign-in.",
			close: "Close",
			privacyNote: "Credentials are stored only in this plugin's own file; sign-in never reads other apps such as the codex CLI.",
			requesting: "Requesting a one-time code…",
			step1: "Open the sign-in link below",
			step2: "Enter the one-time code",
			step3: "This page continues automatically once you authorize",
			linkExpires: "The one-time code is valid for 15 minutes",
			open: "Open link",
			copy: "Copy",
			copied: "Copied",
			waitingForAuth: "Waiting for authorization, keep this page open…",
			loggedInDone: "Signed in. \"{name}\" now appears in the model picker.",
			loggedInReady: "Signed in; the \"{name}\" provider is ready.",
			expired: "The one-time code has expired. Please sign in again.",
			loginFailed: "Sign-in failed: {message}",
			loginButton: "Sign in with ChatGPT",
			loginButtonAgain: "Sign in with a different account"
		};
		const css = [
			".kino-sub-root{width:100%;max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}",
			".kino-sub-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".kino-sub-copy{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}",
			".kino-sub-cards{display:flex;flex-direction:column;gap:8px}",
			".kino-sub-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}",
			".kino-sub-head{display:flex;align-items:center;gap:10px;min-width:0}",
			".kino-sub-icon{flex:none;width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-tsp-secondary)}",
			".kino-sub-name{flex:1;min-width:0;font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".kino-sub-status{flex:none;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px}",
			".kino-sub-status-ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}",
			".kino-sub-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
			".kino-sub-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".kino-sub-file{display:flex;align-items:baseline;gap:8px;min-width:0}",
			".kino-sub-file-label{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".kino-sub-file-path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".kino-sub-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".kino-sub-more{display:flex;align-items:center;gap:8px;margin:0;padding:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".kino-sub-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}",
			".kino-sub-error-row{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}",
			".kino-sub-muted{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".kino-sub-success{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-state-success-primary);font-size:14px;line-height:22px}",
			".kino-sub-panel{display:flex;flex-direction:column;gap:14px;align-items:flex-start;min-width:0}",
			".kino-sub-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
			".kino-sub-steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:14px;width:100%}",
			".kino-sub-step{display:flex;gap:10px;min-width:0}",
			".kino-sub-step-no{flex:none;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-top:1px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-tsp-secondary)}",
			".kino-sub-step-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}",
			".kino-sub-step-label{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".kino-sub-linkrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
			".kino-sub-code{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-tsp-secondary);border-radius:6px;padding:6px 10px;overflow-wrap:anywhere}",
			".kino-sub-usercode{flex:0 1 auto;font-size:15px;letter-spacing:.06em}",
			".kino-sub-waiting{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}"
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
		/** Inline OpenAI logomark (official mark, drawn in currentColor). */
		function OpenAILogo({ size = 16 }) {
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "currentColor",
				"aria-hidden": "true"
			}, h("path", {
				d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
			}));
		}
		/** Shell-style copy button with one-second "copied" feedback. */
		function CopyButton({ t, text }) {
			const [copied, setCopied] = React.useState(false);
			const onCopy = React.useCallback(() => {
				if (copied) return;
				writeClipboard(text).then((ok) => {
					if (!ok) return;
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1000);
				});
			}, [copied, text]);
			return h(Button, {
				variant: "outline",
				size: "sm",
				icon: h(copied ? IconCheckOutline16 : IconCopyOutline16, { size: 12 }),
				onClick: onCopy,
				"aria-label": copied ? t("copied") : t("copy")
			}, copied ? t("copied") : t("copy"));
		}
		/**
		 * The device-login panel: privacy note, the login button, a numbered
		 * three-step guide with the URL + one-time code and copy buttons, and
		 * automatic polling. Callers wrap it in their own modal and get
		 * `onDone` shortly after a login succeeded.
		 */
		function LoginPanel({ t, name, onDone }) {
			const [status, setStatus] = React.useState({ phase: "loading" });
			const [login, setLogin] = React.useState({ phase: "idle" });
			const mounted = React.useRef(true);
			const pollTimer = React.useRef(void 0);
			const doneTimer = React.useRef(void 0);
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
							setLogin({ phase: "success" });
							void refresh();
							if (typeof onDone === "function") {
								doneTimer.current = setTimeout(onDone, 1200);
							}
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
					if (doneTimer.current !== void 0) clearTimeout(doneTimer.current);
				};
			}, [refresh]);
			const content = [];
			if (status.phase === "loading") {
				content.push(h("p", { className: "kino-sub-muted", key: "body" }, [
					h(StateDot, { state: "ongoing", size: 8 }),
					t("checking")
				]));
			} else if (status.phase === "error") {
				content.push(h("p", { className: "kino-sub-error", key: "body" }, t("statusError", { message: status.message })));
			} else if (login.phase === "starting") {
				content.push(h("p", { className: "kino-sub-muted", key: "body" }, [
					h(StateDot, { state: "ongoing", size: 8 }),
					t("requesting")
				]));
			} else if (login.phase === "waiting") {
				content.push(h("ol", { className: "kino-sub-steps", key: "body" }, [
					h("li", { className: "kino-sub-step", key: "url" }, [
						h("span", { className: "kino-sub-step-no" }, "1"),
						h("div", { className: "kino-sub-step-body" }, [
							h("p", { className: "kino-sub-step-label" }, t("step1")),
							h("div", { className: "kino-sub-linkrow" }, [
								h("code", { className: "kino-sub-code", title: login.verificationUrl }, login.verificationUrl),
								h(CopyButton, { t, text: login.verificationUrl }),
								h(Button, {
									variant: "outline",
									size: "sm",
									icon: h(IconRightUpOutline16, { size: 14 }),
									onClick: () => window.open(login.verificationUrl, "_blank", "noopener,noreferrer")
								}, t("open"))
							])
						])
					]),
					h("li", { className: "kino-sub-step", key: "code" }, [
						h("span", { className: "kino-sub-step-no" }, "2"),
						h("div", { className: "kino-sub-step-body" }, [
							h("p", { className: "kino-sub-step-label" }, t("step2")),
							h("div", { className: "kino-sub-linkrow" }, [
								h("code", { className: "kino-sub-code kino-sub-usercode" }, login.userCode),
								h(CopyButton, { t, text: login.userCode })
							]),
							h("p", { className: "kino-sub-hint" }, t("linkExpires"))
						])
					]),
					h("li", { className: "kino-sub-step", key: "sync" }, [
						h("span", { className: "kino-sub-step-no" }, "3"),
						h("div", { className: "kino-sub-step-body" }, [
							h("p", { className: "kino-sub-step-label" }, t("step3")),
							h("p", { className: "kino-sub-waiting" }, [
								h(StateDot, { state: "ongoing", size: 8 }),
								t("waitingForAuth")
							])
						])
					])
				]));
			} else if (login.phase === "success") {
				content.push(h("p", { className: "kino-sub-success", key: "body" }, [
					h(IconCheckOutline16),
					t("loggedInDone", { name })
				]));
			} else if (login.phase === "expired") {
				content.push(h("p", { className: "kino-sub-error", key: "body" }, t("expired")));
				content.push(h(Button, { variant: "primary", size: "md", key: "retry", onClick: () => void start() }, t("relogin")));
			} else if (login.phase === "error") {
				content.push(h("p", { className: "kino-sub-error", key: "body" }, t("loginFailed", { message: login.message })));
				content.push(h(Button, { variant: "primary", size: "md", key: "retry", onClick: () => void start() }, t("retry")));
			} else {
				content.push(h("p", { className: "kino-sub-note", key: "note" }, t("privacyNote")));
				if (status.loggedIn === true) {
					content.push(h("p", { className: "kino-sub-success", key: "ready" }, [
						h(IconCheckOutline16),
						t("loggedInReady", { name })
					]));
				}
				content.push(h(Button, {
					variant: "primary",
					size: "md",
					icon: h(IconUserOutline16),
					key: "cta",
					onClick: () => void start()
				}, t(status.loggedIn === true ? "loginButtonAgain" : "loginButton")));
			}
			return h("div", { className: "kino-sub-panel" }, content);
		}
		/**
		 * One provider card in the hub. Each card renders the provider's own
		 * logo and offers the shared login modal.
		 */
		function ProviderCard({ t, provider, loggedIn, authFile, onChanged }) {
			const [open, setOpen] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
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
					h("span", { className: "kino-sub-icon", "aria-hidden": "true" }, provider.logo),
					h("span", { className: "kino-sub-name" }, t(provider.nameKey)),
					h("span", {
						className: loggedIn === true ? "kino-sub-status kino-sub-status-ok" : "kino-sub-status"
					}, [
						loggedIn === true ? h(IconCheckOutline16, { size: 12, "aria-hidden": "true" }) : null,
						t(loggedIn === true ? "statusLoggedIn" : "statusLoggedOut")
					])
				]),
				h("p", { className: "kino-sub-desc", key: "desc" }, t(provider.descKey)),
				h("div", { className: "kino-sub-actions", key: "actions" }, [
					h(Button, {
						variant: "primary",
						size: "md",
						icon: h(IconUserOutline16),
						onClick: () => setOpen(true)
					}, t(loggedIn === true ? "relogin" : "login")),
					loggedIn === true ? h(Button, {
						variant: "outline",
						size: "md",
						disabled: busy,
						onClick: () => void logout()
					}, t(busy ? "loggingOut" : "logout")) : null
				]),
				loggedIn === true && typeof authFile === "string" && authFile !== "" ? h("div", {
					className: "kino-sub-file",
					key: "file",
					title: authFile
				}, [
					h("span", { className: "kino-sub-file-label" }, t("credentialFile")),
					h("code", { className: "kino-sub-file-path" }, authFile)
				]) : null,
				error !== "" ? h("p", { className: "kino-sub-error", key: "error" }, error) : null,
				open ? h(Modal, {
					key: "modal",
					open: true,
					onClose: () => setOpen(false),
					title: t("modalTitle", { name: t(provider.nameKey) }),
					description: t("modalDesc"),
					closeLabel: t("close")
				}, h(LoginPanel, {
					t,
					name: t(provider.nameKey),
					onDone: () => {
						setOpen(false);
						onChanged?.();
					}
				})) : null
			]);
		}
		/** The hub page content. */
		function SubscriptionsSection({ t, subscribeLocale }) {
			const [, force] = React.useReducer((value) => value + 1, 0);
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
				const unsubscribe = subscribeLocale(force);
				void refresh();
				return unsubscribe;
			}, [subscribeLocale, refresh]);
			const providers = [
				{
					id: "codex",
					nameKey: "openaiName",
					descKey: "openaiDesc",
					logo: h(OpenAILogo, { size: 16 })
				}
			];
			return h("div", { className: "kino-sub-root" }, [
				h("h3", { className: "kino-sub-title", key: "title" }, t("nav")),
				h("p", { className: "kino-sub-copy", key: "copy" }, t("intro")),
				state.phase === "loading" ? h("p", { className: "kino-sub-muted", key: "loading" }, [
					h(StateDot, { state: "ongoing", size: 8 }),
					t("checking")
				]) : null,
				state.phase === "error" ? h("div", { className: "kino-sub-error-row", key: "error" }, [
					h(IconWarningOutline16, { "aria-hidden": "true" }),
					h("span", null, t("statusError", { message: state.message })),
					h(Button, { variant: "outline", size: "sm", onClick: () => void refresh() }, t("retry"))
				]) : null,
				state.phase === "ready" ? h("div", { className: "kino-sub-cards", key: "cards" }, providers.map((provider) => h(ProviderCard, {
					key: provider.id,
					t,
					provider,
					loggedIn: state.loggedIn === true,
					authFile: state.authFile,
					onChanged: () => void refresh()
				}))) : null,
				state.phase === "ready" ? h("p", { className: "kino-sub-more", key: "more" }, [
					h(IconGlobeOutline14, { size: 14, "aria-hidden": "true" }),
					t("moreComing")
				]) : null
			]);
		}
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "kino-codex: subscription dictionaries");
			const t = ctx.locale.bind(NS);
			const subscribeLocale = (listener) => ctx.locale.subscribe(listener);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "third-party-subscriptions",
				order: 20,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ t, subscribeLocale })
			}, SubscriptionsSection));
		}
		return { apply, inject };
	}
});
