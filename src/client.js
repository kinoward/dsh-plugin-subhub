// Client half of the dsh-plugin-subhub plugin: the "第三方订阅" settings
// one hub page where every third-party subscription provider lives. Each
// provider card shares the same login-modal surface; today OpenAI (ChatGPT /
// OpenAI subscription) is wired end to end, and further providers plug in by
// adding a card entry plus their own host-side auth endpoints. Only after a
// successful login does the host register the provider route, which is what
// makes it appear in the Models page and the model picker. The same plugin
// also augments the Models page: expanding the OpenAI 订阅 row replaces the
// generic settings chrome with a read-only live model catalog. The UI
// follows the shell design system: shell primitives (Button / Modal /
// StateDot), --dsw-alias-* theme tokens, and locale dictionaries registered
// through the locale service. Hand-written client bundle in the shell's
// module-loader format (no build step).
window.__ModuleLoader__.load({
	id: "dsh-plugin-subhub",
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
		const API = "/api/dsh-plugin-subhub";
		const POLL_MS = 2500;
		const NS = "settings.subscriptions";
		const h = React.createElement;
		// Active harness UI language, refreshed from the locale snapshot; every
		// host API call carries it so the host can keep the provider display
		// name in the same language as the shell (explicit setting or shell
		// fallback — whatever the snapshot resolved to).
		let uiLocale = "zh";
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			nav: "第三方订阅",
			intro: "在这里管理第三方订阅:登录成功后,对应服务会出现在「模型」页;退出登录后即移除。模型与思考深度请在「模型」页的服务行中设置。",
			checking: "正在读取登录状态…",
			statusError: "无法读取登录状态:{message}",
			localOnly: "该功能仅支持在本机打开时使用(地址为 127.0.0.1 或 localhost)。请改用本机地址打开此页面。",
			retry: "重试",
			statusLoggedIn: "已登录",
			statusLoggedOut: "未登录",
			login: "登录",
			relogin: "重新登录",
			logout: "退出登录",
			loggingOut: "退出中…",
			credentialFile: "凭据文件",
			openaiName: "OpenAI 订阅",
			openaiDesc: "GPT 系列模型,使用 ChatGPT 订阅账户登录。",
			moreComing: "其他服务即将接入,敬请期待。",
			modalTitle: "登录 {name}",
			modalDesc: "在浏览器中完成一次性设备授权,登录成功后此页面自动同步。",
			close: "关闭",
			privacyNote: "登录凭据仅保存在本插件自己的文件中,不会读取其它程序的登录信息。",
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
			loginButtonAgain: "使用新账号登录",
			modelsTitle: "可用模型",
			modelsMeta: "来自 ChatGPT 订阅 · 共 {count} 个模型 · 实时同步",
			modelsLoading: "正在读取模型列表…",
			modelsError: "无法读取模型列表:{message}",
			modelsEmpty: "暂无可用模型。",
			contextTag: "上下文 {value}",
			imageTag: "支持图片",
			reasoningTag: "推理 {names}",
			expand: "展开",
			collapse: "收起"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			nav: "Subscriptions",
			intro: "Manage third-party subscriptions here: after a successful sign-in the provider appears on the Models page, and signing out removes it. Models and reasoning levels are configured on the Models page.",
			checking: "Reading login status…",
			statusError: "Could not read login status: {message}",
			localOnly: "This feature only accepts requests from this machine (127.0.0.1 / localhost). Open the page via a local address.",
			retry: "Retry",
			statusLoggedIn: "Signed in",
			statusLoggedOut: "Signed out",
			login: "Sign in",
			relogin: "Sign in again",
			logout: "Sign out",
			loggingOut: "Signing out…",
			credentialFile: "Credential file",
			openaiName: "OpenAI subscription",
			openaiDesc: "GPT models, signed in with a ChatGPT / OpenAI subscription account.",
			moreComing: "More providers are on the way. Stay tuned.",
			modalTitle: "Sign in to {name}",
			modalDesc: "Complete a one-time device authorization in the browser; this page syncs automatically after sign-in.",
			close: "Close",
			privacyNote: "Credentials are stored only in this plugin's own file; sign-in never reads other apps' sign-in data.",
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
			loginButtonAgain: "Sign in with a different account",
			modelsTitle: "Available models",
			modelsMeta: "From your ChatGPT subscription · {count} models · synced live",
			modelsLoading: "Reading the model list…",
			modelsError: "Could not read the model list: {message}",
			modelsEmpty: "No models are available.",
			contextTag: "Context {value}",
			imageTag: "Image input",
			reasoningTag: "Reasoning {names}",
			expand: "Expand",
			collapse: "Collapse"
		};
		const css = [
			".dsh-plugin-sub-root{width:100%;max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}",
			".dsh-plugin-sub-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".dsh-plugin-sub-copy{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}",
			".dsh-plugin-sub-cards{display:flex;flex-direction:column;gap:8px}",
			".dsh-plugin-sub-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}",
			".dsh-plugin-sub-head{display:flex;align-items:center;gap:10px;min-width:0}",
			".dsh-plugin-sub-icon{flex:none;width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-tsp-secondary)}",
			".dsh-plugin-sub-name{flex:1;min-width:0;font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-plugin-sub-status{flex:none;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px}",
			".dsh-plugin-sub-status-ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}",
			".dsh-plugin-sub-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
			".dsh-plugin-sub-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsh-plugin-sub-file{display:flex;align-items:baseline;gap:8px;min-width:0}",
			".dsh-plugin-sub-file-label{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-plugin-sub-file-path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-plugin-sub-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsh-plugin-sub-more{display:flex;align-items:center;gap:8px;margin:0;padding:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".dsh-plugin-sub-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}",
			".dsh-plugin-sub-error-row{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}",
			".dsh-plugin-sub-muted{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".dsh-plugin-sub-success{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-state-success-primary);font-size:14px;line-height:22px}",
			".dsh-plugin-sub-panel{display:flex;flex-direction:column;gap:14px;align-items:flex-start;min-width:0}",
			".dsh-plugin-sub-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
			".dsh-plugin-sub-steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:14px;width:100%}",
			".dsh-plugin-sub-step{display:flex;gap:10px;min-width:0}",
			".dsh-plugin-sub-step-no{flex:none;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-top:1px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-tsp-secondary)}",
			".dsh-plugin-sub-step-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}",
			".dsh-plugin-sub-step-label{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".dsh-plugin-sub-linkrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
			".dsh-plugin-sub-code{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-tsp-secondary);border-radius:6px;padding:6px 10px;overflow-wrap:anywhere}",
			".dsh-plugin-sub-usercode{flex:0 1 auto;font-size:15px;letter-spacing:.06em}",
			".dsh-plugin-sub-waiting{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".dsh-plugin-sub-catalog{display:flex;flex-direction:column;gap:10px;width:100%;min-width:0;animation:dsh-plugin-sub-fade-in .12s ease}",
			"@keyframes dsh-plugin-sub-fade-in{from{opacity:0}to{opacity:1}}",
			"@media (prefers-reduced-motion:reduce){.dsh-plugin-sub-catalog{animation:none}}",
			".dsh-plugin-sub-catalog-head{display:flex;flex-direction:column;gap:2px}",
			".dsh-plugin-sub-catalog-title{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}",
			".dsh-plugin-sub-catalog-meta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsh-plugin-sub-catalog-list{display:flex;flex-direction:column;gap:8px}",
			".dsh-plugin-sub-model{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;min-width:0}",
			".dsh-plugin-sub-model-head{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}",
			".dsh-plugin-sub-model-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}",
			".dsh-plugin-sub-model-name{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-plugin-sub-model-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
			".dsh-plugin-sub-model-tag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}",
			".dsh-plugin-sub-model-desc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsh-plugin-sub-catalog-mount{display:flex;flex-direction:column;gap:10px;min-width:0}",
			".dsh-plugin-sub-retry{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:14px;align-self:flex-start;padding:0 10px;font-size:12px;line-height:18px}",
			".dsh-plugin-sub-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-plugin-sub-row-chevron{box-sizing:border-box;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);border-radius:6px;cursor:pointer;padding:0}",
			".dsh-plugin-sub-row-chevron:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-plugin-sub-row-chevron svg{transition:transform .12s}",
			".dsh-plugin-sub-row-chevron-open svg{transform:rotate(180deg)}"
		].join("\n");
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-plugin-subhub\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = "dsh-plugin-subhub";
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		/** Same-origin JSON call to the host plugin's login API. */
		async function api(path, options = {}) {
			const sep = path.includes("?") ? "&" : "?";
			const response = await fetch(`${API}${path}${sep}locale=${encodeURIComponent(uiLocale)}`, {
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
			if (!response.ok) {
				if (response.status === 403) {
					// The host trust fence only accepts localhost requests:
					// explain that instead of the bare "forbidden".
					throw new Error(uiLocale.startsWith("en") ? en.localOnly : zh.localOnly);
				}
				throw new Error(body?.message ?? `HTTP ${response.status}`);
			}
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
		/** Compact context-window text: 272000 -> "272K". */
		function formatContext(value) {
			if (!Number.isInteger(value) || value <= 0) return void 0;
			return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
		}
		/** One read-only catalog row (plain DOM, no React ownership). */
		function catalogRowNode(model, t) {
			const entry = document.createElement("div");
			entry.className = "dsh-plugin-sub-model";
			const head = document.createElement("div");
			head.className = "dsh-plugin-sub-model-head";
			const id = document.createElement("code");
			id.className = "dsh-plugin-sub-model-id";
			id.textContent = model.id;
			head.appendChild(id);
			if (typeof model.name === "string" && model.name !== "" && model.name !== model.id) {
				const name = document.createElement("span");
				name.className = "dsh-plugin-sub-model-name";
				name.textContent = model.name;
				head.appendChild(name);
			}
			entry.appendChild(head);
			const tags = [];
			const context = formatContext(model.contextWindow);
			if (context !== void 0) tags.push(t("contextTag", { value: context }));
			if (Array.isArray(model.inputModalities) && model.inputModalities.includes("image")) tags.push(t("imageTag"));
			const efforts = model.reasoning !== void 0 && model.reasoning !== null && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
			if (efforts.length > 0) {
				tags.push(t("reasoningTag", { names: efforts.map((effort) => effort.name).join(" / ") }));
			}
			if (tags.length > 0) {
				const meta = document.createElement("div");
				meta.className = "dsh-plugin-sub-model-meta";
				for (const text of tags) {
					const tag = document.createElement("span");
					tag.className = "dsh-plugin-sub-model-tag";
					tag.textContent = text;
					meta.appendChild(tag);
				}
				entry.appendChild(meta);
			}
			if (typeof model.description === "string" && model.description !== "") {
				const desc = document.createElement("p");
				desc.className = "dsh-plugin-sub-model-desc";
				desc.textContent = model.description;
				entry.appendChild(desc);
			}
			return entry;
		}
		/** Render the catalog's ready state synchronously (no loading flash). */
		function renderCatalogReady(container, t, models) {
			container.textContent = "";
			const section = document.createElement("section");
			section.className = "dsh-plugin-sub-catalog";
			section.setAttribute("aria-label", t("modelsTitle"));
			const head = document.createElement("div");
			head.className = "dsh-plugin-sub-catalog-head";
			const title = document.createElement("span");
			title.className = "dsh-plugin-sub-catalog-title";
			title.textContent = t("modelsTitle");
			head.appendChild(title);
			section.appendChild(head);
			if (models.length === 0) {
				const empty = document.createElement("p");
				empty.className = "dsh-plugin-sub-hint";
				empty.textContent = t("modelsEmpty");
				section.appendChild(empty);
				container.appendChild(section);
				return;
			}
			const meta = document.createElement("span");
			meta.className = "dsh-plugin-sub-catalog-meta";
			meta.textContent = t("modelsMeta", { count: models.length });
			head.appendChild(meta);
			const list = document.createElement("div");
			list.className = "dsh-plugin-sub-catalog-list";
			for (const model of models) list.appendChild(catalogRowNode(model, t));
			section.appendChild(list);
			container.appendChild(section);
		}
		/** Render the read-only catalog into one mount container. */
		function renderCatalogInto(container, t, loadCatalog, warmCatalog, revalidateCatalog) {
			const cached = typeof warmCatalog === "function" ? warmCatalog() : void 0;
			if (cached !== void 0) {
				renderCatalogReady(container, t, cached.value);
				// Warm render is synchronous (no loading flash); revalidate in
				// the background so a changed credential identity swaps the
				// list in without user action.
				if (typeof revalidateCatalog === "function") revalidateCatalog(container, t);
				return;
			}
			container.textContent = "";
			const section = document.createElement("section");
			section.className = "dsh-plugin-sub-catalog";
			section.setAttribute("aria-label", t("modelsTitle"));
			const head = document.createElement("div");
			head.className = "dsh-plugin-sub-catalog-head";
			const title = document.createElement("span");
			title.className = "dsh-plugin-sub-catalog-title";
			title.textContent = t("modelsTitle");
			head.appendChild(title);
			section.appendChild(head);
			const status = document.createElement("p");
			status.className = "dsh-plugin-sub-muted";
			status.textContent = t("modelsLoading");
			section.appendChild(status);
			container.appendChild(section);
			loadCatalog(container, t).then((models) => {
				renderCatalogReady(container, t, models);
			}, (error) => {
				container.textContent = "";
				const failed = document.createElement("section");
				failed.className = "dsh-plugin-sub-catalog";
				failed.setAttribute("aria-label", t("modelsTitle"));
				const message = document.createElement("p");
				message.className = "dsh-plugin-sub-error";
				message.textContent = t("modelsError", { message: error?.message ?? String(error) });
				failed.appendChild(message);
				const retry = document.createElement("button");
				retry.type = "button";
				retry.className = "dsh-plugin-sub-retry";
				retry.textContent = t("retry");
				retry.addEventListener("click", () => renderCatalogInto(container, t, loadCatalog, warmCatalog, revalidateCatalog));
				failed.appendChild(retry);
				container.appendChild(failed);
			});
		}
		/**
		 * Models-page augmentation for subscription providers. Two things
		 * happen per provider row: the generic "edit" button is hidden and
		 * replaced by a chevron toggle that expands the same shell state, and
		 * the expanded shell editor's generic chrome (header, hint, and save /
		 * cancel actions) is replaced by the live, read-only model catalog. A
		 * MutationObserver re-applies after shell re-renders because the
		 * shell's React can drop the foreign nodes.
		 */
		function installModelCatalogAugmentation(ctx, t) {
			if (typeof document === "undefined") return () => {};
			// The shell's provider row exposes no stable identifier, so rows
			// are matched by display name — taken from the dictionaries (both
			// languages), so there is a single source of truth for the name.
			const SUBSCRIPTION_NAMES = [zh.openaiName, en.openaiName];
			const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6 L8 10 L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
			const catalogCache = { at: 0, value: void 0, fingerprint: void 0 };
			let inflight;
			const warmCatalog = () => catalogCache.value !== void 0 && Date.now() - catalogCache.at < 60000 ? catalogCache : void 0;
			const acceptCatalog = (result) => {
				const models = Array.isArray(result.models) ? result.models : [];
				catalogCache.value = models;
				catalogCache.at = Date.now();
				catalogCache.fingerprint = typeof result.fingerprint === "string" ? result.fingerprint : void 0;
				return models;
			};
			const loadCatalog = (container, t) => {
				const warm = warmCatalog();
				if (warm !== void 0) {
					revalidateCatalog(container, t);
					return Promise.resolve(warm.value);
				}
				if (inflight === void 0) {
					inflight = api("/models").then(acceptCatalog).finally(() => {
						inflight = void 0;
					});
				}
				return inflight;
			};
			/**
			 * Quietly re-check the catalog after serving the warm list: if the
			 * credential identity changed (login / account switch), the host
			 * reports a different fingerprint and the fresh list replaces the
			 * stale one as soon as it arrives.
			 */
			const revalidateCatalog = (container, t) => {
				const warm = warmCatalog();
				if (warm === void 0) return;
				api("/models").then((result) => {
					if (result.fingerprint !== warm.fingerprint && container.isConnected) {
						renderCatalogReady(container, t, acceptCatalog(result));
					}
				}).catch(() => {});
			};
			const findEditButton = (row) => {
				for (const button of row.querySelectorAll("button")) {
					const cls = typeof button.className === "string" ? button.className : "";
					if (cls.includes("secondaryButton")) return button;
				}
				return void 0;
			};
			const rows = new Set();
			const rowViews = new WeakMap();
			const editorViews = new WeakMap();
			const augmentRow = (row) => {
				const head = row.children[0];
				if (!(head instanceof HTMLElement)) return;
				let actions;
				for (const child of Array.from(head.children)) {
					const cls = typeof child.className === "string" ? child.className : "";
					if (cls.includes("rowActions")) {
						actions = child;
						break;
					}
				}
				if (actions === void 0) return;
				const edit = findEditButton(row);
				if (edit !== void 0 && edit.style.display !== "none") edit.style.display = "none";
				let view = rowViews.get(row);
				if (view === void 0 || !view.button.isConnected) {
					const button = document.createElement("button");
					button.type = "button";
					button.className = "dsh-plugin-sub-row-chevron";
					button.innerHTML = CHEVRON_SVG;
					button.addEventListener("click", () => {
						const current = findEditButton(row);
						if (current !== void 0) current.click();
					});
					view = { button };
					rowViews.set(row, view);
					actions.appendChild(button);
				}
				const open = row.children.length >= 2;
				view.button.classList.toggle("dsh-plugin-sub-row-chevron-open", open);
				view.button.setAttribute("aria-expanded", String(open));
				view.button.setAttribute("aria-label", t(open ? "collapse" : "expand"));
				view.button.setAttribute("title", t(open ? "collapse" : "expand"));
			};
			const augmentEditor = (editor) => {
				for (const child of Array.from(editor.children)) {
					const cls = typeof child.className === "string" ? child.className : "";
					if ((cls.includes("editorHeader") || cls.includes("advancedHint") || cls.includes("editorActions")) && child.style.display !== "none") child.style.display = "none";
				}
				let view = editorViews.get(editor);
				if (view === void 0) {
					const container = document.createElement("div");
					container.className = "dsh-plugin-sub-catalog-mount";
					view = { container };
					editorViews.set(editor, view);
				}
				if (!view.container.isConnected) {
					editor.appendChild(view.container);
					if (view.container.childNodes.length === 0) renderCatalogInto(view.container, t, loadCatalog, warmCatalog, revalidateCatalog);
					return;
				}
				if (view.container.childNodes.length === 0) renderCatalogInto(view.container, t, loadCatalog, warmCatalog, revalidateCatalog);
			};
			let scanning = false;
			const scan = () => {
				scanning = false;
				for (const row of [...rows]) {
					if (row.isConnected) continue;
					rows.delete(row);
				}
				for (const span of document.querySelectorAll("span")) {
					if (!SUBSCRIPTION_NAMES.includes(span.textContent)) continue;
					const row = span.closest("li");
					if (row === null) continue;
					rows.add(row);
					augmentRow(row);
					if (row.children.length >= 2 && row.children[1] instanceof HTMLElement) augmentEditor(row.children[1]);
				}
			};
			const observer = new MutationObserver(() => {
				if (scanning) return;
				scanning = true;
				queueMicrotask(scan);
			});
			observer.observe(document.body, { childList: true, subtree: true });
			scan();
			const unsubscribeLocale = ctx.locale.subscribe(() => {
				for (const row of rows) {
					augmentRow(row);
					if (row.children.length >= 2 && row.children[1] instanceof HTMLElement) {
						const view = editorViews.get(row.children[1]);
						if (view !== void 0 && view.container.isConnected) renderCatalogInto(view.container, t, loadCatalog, warmCatalog, revalidateCatalog);
					}
				}
			});
			return () => {
				unsubscribeLocale();
				observer.disconnect();
				rows.clear();
			};
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
				content.push(h("p", { className: "dsh-plugin-sub-muted", key: "body" }, [
					h(StateDot, { state: "ongoing", size: 8 }),
					t("checking")
				]));
			} else if (status.phase === "error") {
				content.push(h("p", { className: "dsh-plugin-sub-error", key: "body" }, t("statusError", { message: status.message })));
			} else if (login.phase === "starting") {
				content.push(h("p", { className: "dsh-plugin-sub-muted", key: "body" }, [
					h(StateDot, { state: "ongoing", size: 8 }),
					t("requesting")
				]));
			} else if (login.phase === "waiting") {
				content.push(h("ol", { className: "dsh-plugin-sub-steps", key: "body" }, [
					h("li", { className: "dsh-plugin-sub-step", key: "url" }, [
						h("span", { className: "dsh-plugin-sub-step-no" }, "1"),
						h("div", { className: "dsh-plugin-sub-step-body" }, [
							h("p", { className: "dsh-plugin-sub-step-label" }, t("step1")),
							h("div", { className: "dsh-plugin-sub-linkrow" }, [
								h("code", { className: "dsh-plugin-sub-code", title: login.verificationUrl }, login.verificationUrl),
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
					h("li", { className: "dsh-plugin-sub-step", key: "code" }, [
						h("span", { className: "dsh-plugin-sub-step-no" }, "2"),
						h("div", { className: "dsh-plugin-sub-step-body" }, [
							h("p", { className: "dsh-plugin-sub-step-label" }, t("step2")),
							h("div", { className: "dsh-plugin-sub-linkrow" }, [
								h("code", { className: "dsh-plugin-sub-code dsh-plugin-sub-usercode" }, login.userCode),
								h(CopyButton, { t, text: login.userCode })
							]),
							h("p", { className: "dsh-plugin-sub-hint" }, t("linkExpires"))
						])
					]),
					h("li", { className: "dsh-plugin-sub-step", key: "sync" }, [
						h("span", { className: "dsh-plugin-sub-step-no" }, "3"),
						h("div", { className: "dsh-plugin-sub-step-body" }, [
							h("p", { className: "dsh-plugin-sub-step-label" }, t("step3")),
							h("p", { className: "dsh-plugin-sub-waiting" }, [
								h(StateDot, { state: "ongoing", size: 8 }),
								t("waitingForAuth")
							])
						])
					])
				]));
			} else if (login.phase === "success") {
				content.push(h("p", { className: "dsh-plugin-sub-success", key: "body" }, [
					h(IconCheckOutline16),
					t("loggedInDone", { name })
				]));
			} else if (login.phase === "expired") {
				content.push(h("p", { className: "dsh-plugin-sub-error", key: "body" }, t("expired")));
				content.push(h(Button, { variant: "primary", size: "md", key: "retry", onClick: () => void start() }, t("relogin")));
			} else if (login.phase === "error") {
				content.push(h("p", { className: "dsh-plugin-sub-error", key: "body" }, t("loginFailed", { message: login.message })));
				content.push(h(Button, { variant: "primary", size: "md", key: "retry", onClick: () => void start() }, t("retry")));
			} else {
				content.push(h("p", { className: "dsh-plugin-sub-note", key: "note" }, t("privacyNote")));
				if (status.loggedIn === true) {
					content.push(h("p", { className: "dsh-plugin-sub-success", key: "ready" }, [
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
			return h("div", { className: "dsh-plugin-sub-panel" }, content);
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
			return h("div", { className: "dsh-plugin-sub-card" }, [
				h("div", { className: "dsh-plugin-sub-head", key: "head" }, [
					h("span", { className: "dsh-plugin-sub-icon", "aria-hidden": "true" }, provider.logo),
					h("span", { className: "dsh-plugin-sub-name" }, t(provider.nameKey)),
					h("span", {
						className: loggedIn === true ? "dsh-plugin-sub-status dsh-plugin-sub-status-ok" : "dsh-plugin-sub-status"
					}, [
						loggedIn === true ? h(IconCheckOutline16, { size: 12, "aria-hidden": "true" }) : null,
						t(loggedIn === true ? "statusLoggedIn" : "statusLoggedOut")
					])
				]),
				h("p", { className: "dsh-plugin-sub-desc", key: "desc" }, t(provider.descKey)),
				h("div", { className: "dsh-plugin-sub-actions", key: "actions" }, [
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
					className: "dsh-plugin-sub-file",
					key: "file",
					title: authFile
				}, [
					h("span", { className: "dsh-plugin-sub-file-label" }, t("credentialFile")),
					h("code", { className: "dsh-plugin-sub-file-path" }, authFile)
				]) : null,
				error !== "" ? h("p", { className: "dsh-plugin-sub-error", key: "error" }, error) : null,
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
					id: "dsh-plugin-subhub-openai",
					nameKey: "openaiName",
					descKey: "openaiDesc",
					logo: h(OpenAILogo, { size: 16 })
				}
			];
			return h("div", { className: "dsh-plugin-sub-root" }, [
				h("h3", { className: "dsh-plugin-sub-title", key: "title" }, t("nav")),
				h("p", { className: "dsh-plugin-sub-copy", key: "copy" }, t("intro")),
				state.phase === "loading" ? h("p", { className: "dsh-plugin-sub-muted", key: "loading" }, [
					h(StateDot, { state: "ongoing", size: 8 }),
					t("checking")
				]) : null,
				state.phase === "error" ? h("div", { className: "dsh-plugin-sub-error-row", key: "error" }, [
					h(IconWarningOutline16, { "aria-hidden": "true" }),
					h("span", null, t("statusError", { message: state.message })),
					h(Button, { variant: "outline", size: "sm", onClick: () => void refresh() }, t("retry"))
				]) : null,
				state.phase === "ready" ? h("div", { className: "dsh-plugin-sub-cards", key: "cards" }, providers.map((provider) => h(ProviderCard, {
					key: provider.id,
					t,
					provider,
					loggedIn: state.loggedIn === true,
					authFile: state.authFile,
					onChanged: () => void refresh()
				}))) : null,
				state.phase === "ready" ? h("p", { className: "dsh-plugin-sub-more", key: "more" }, [
					h(IconGlobeOutline14, { size: 14, "aria-hidden": "true" }),
					t("moreComing")
				]) : null
			]);
		}
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-subhub: subscription dictionaries");
			const t = ctx.locale.bind(NS);
			const subscribeLocale = (listener) => ctx.locale.subscribe(listener);
			const syncUiLocale = () => {
				const snapshot = ctx.locale.getSnapshot();
				if (snapshot !== null && typeof snapshot === "object" && typeof snapshot.active === "string" && snapshot.active.length > 0) {
					uiLocale = snapshot.active;
				}
			};
			syncUiLocale();
			ctx.effect(() => ctx.locale.subscribe(syncUiLocale), "dsh-plugin-subhub: locale snapshot");
			ctx.effect(() => installModelCatalogAugmentation(ctx, t), "dsh-plugin-subhub: models page augmentation");
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
