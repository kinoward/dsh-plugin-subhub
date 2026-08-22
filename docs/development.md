# 开发指南

本文面向人类开发者,介绍本仓库(dsh-plugin-subhub 单插件仓库)的开发与验证方式。AI 编程代理的行为约束见根目录 [`AGENTS.md`](../AGENTS.md)。

## 环境

- 已安装的 `dsh` CLI(npx 启动的部署即可);
- Node.js 22.19+(宿主插件依赖 pi-ai 运行时,其引擎要求与 harness 自带版本一致);
- 不需要构建工具链:仓库是纯 JavaScript,无编译步骤。

## 仓库结构

本仓库就是 dsh-plugin-subhub 一个插件:`src/index.js` 是宿主半边(LLM 适配器 + 登录 API),`src/client.js` 是客户端半边(「第三方订阅」中心页),`src/device-flow.js` 是两边共用的 OpenAI 设备码登录流程,`login.js` 是无头环境用的独立登录脚本。OpenAI 之外的新订阅商走 pi-ai 通用底座:`src/piai.js`(凭据文件存储 + 浏览器登录控制器 + pi-ai 适配器桥接 + 通用注册),每家只需一个规格文件(样板见 `src/providers/xai.js`)。根 `package.json` 同时声明 `dsh.bundle.patch`(bundle 安装机制,`dsh plugin add` 唯一支持的形态)与 `dsh.client`(客户端模块声明);`cordis.patch.yml` 是本插件唯一一行挂载(`id` 与挂载模块均为 `dsh-plugin-subhub`)。

## 本机开发循环

```sh
# 0. 先在仓库里安装依赖(link 模式不会替被链接包装依赖,没有这一步插件会因缺包加载失败)
pnpm install

# 1. 本地链接安装进演示 profile(首次自动初始化 profile)
dsh plugin --profile demo add link:./

# 2. 验证插件层被组装(应出现 dsh-plugin-subhub 层与本插件行)
dsh --profile demo --dump-config

# 3. 真实运行(web profile 下可到设置页确认插件 UI;加载错误会出现在启动日志)
dsh --profile demo
```

> `link:` 会把 `node_modules/dsh-plugin-subhub` 指向本仓库(改代码后重启即生效);`file:`/`./` 则安装快照,每次改代码都要重新 `add`。`pnpm install` 生成的 `node_modules/` 已加入 `.gitignore`,`pnpm-lock.yaml` 建议提交,保证本地开发环境可复现。

## 客户端插件的两层 inject(容易踩坑)

本插件同时有两处注入声明,含义完全不同:

- 根 `package.json` 里的 `dsh.client.inject`:客户端 **npm 包依赖边**,填包名(如 `@deepseek-ai/dsh-client-runtime`);
- `src/client.js` 导出的 `inject`:模块实际读取的 **Cordis 服务名**(如 `slots`、`locale`)。

填反任何一处,web 启动都会停在"等待服务"的报错页。客户端模块只用 `ctx.slots` 时,导出 `const inject = ["slots"]` 即可。

## 验证

改动后至少执行:

- `node --check` 所有改动的 JS 文件;
- JSON/YAML 解析校验 `package.json` 与 `cordis.patch.yml`;
- 组装验证(把 `DSH_HOME` 指向临时目录,避免污染 `~/.dsh`):

  ```sh
  dsh --profile web --patch ./cordis.patch.yml --dump-config
  ```

  确认输出出现本仓库补丁层(`# == .../cordis.patch.yml`)与 `dsh-plugin-subhub` 插件行。

## 登录与验证

本插件当前接入 OpenAI 订阅(ChatGPT OAuth),provider 路由 id 为 `dsh-plugin-subhub-openai`(命名约定 `dsh-plugin-subhub-<服务商>`;不能用 `openai`:外壳内置的可配置提供商目录已声明 `openai`,重名会让插件树加载失败)。需要先登录。普通用户在设置面板侧边栏的 **第三方订阅** 页,对 **OpenAI 订阅** 卡片点「登录」即可;无头 profile 或偏好终端时运行随包脚本:

```sh
node login.js
```

脚本会打印一个链接和一次性码,在浏览器打开链接、输入码后,把凭据写到 `~/.dsh-plugin-subhub/openai-auth.json`(权限 0600)。隐私约束:插件只读写自己的凭据文件,不读取官方 Codex CLI 的 `~/.codex/auth.json` 或其它程序的认证文件;每位用户安装后都必须通过插件完成一次登录授权。

登录 API 是宿主插件注册的 `webServer` 前缀路由(`/api/dsh-plugin-subhub/*`,只接受本机同源请求;含 `status`/`start`/`poll`/`logout`/`models`),「第三方订阅」中心页 UI 是 `src/client.js`(手写模块加载器格式),由根 `package.json` 的 `dsh.client` 声明,并随 `settings.section` 插槽挂进设置侧边栏。

**登录门控**:`ctx.llm` 上的 provider 路由只有凭据存在时才注册(登录成功即注册、退出登录即注销),因此「模型」页与模型选择器只显示已认证的服务;「模型」页通过 `llm/adapters-updated` 事件自动刷新。注册触发器有四处:插件挂载时、对应 `dsh-plugin-subhub-<服务商>:` 设置节变更时、网页登录/退出成功回调,以及「第三方订阅」页的状态轮询(登录状态变化时自愈补注册,因此**脚本登录后打开一次该页即可注册,不必重启**)。OpenAI 之外的新订阅商(xAI 为第一个)挂在 `src/piai.js` 的通用底座上:provider id 用 `dsh-plugin-subhub-<服务商>`、凭据文件 `~/.dsh-plugin-subhub/<服务商>-auth.json`、登录 API `/api/dsh-plugin-subhub/<服务商>/login/*`(嵌套在 OpenAI 的 `/api/dsh-plugin-subhub` 前缀之下,webserver 按最长前缀优先路由,不会互相遮蔽),客户端在中心页 provider 数组里加一张卡片并复用同一个登录弹窗组件。

验证要点:

- 登录后启动 harness,在模型选择器里应能看到「OpenAI 订阅」提供商及其模型;退出登录后应消失;
- 登录 API 可用 curl 检查:`GET /api/dsh-plugin-subhub/login/status` 应返回 `{ok:true,loggedIn:...}`,`POST /login/logout` 删除凭据并注销路由;
- 模型列表完全动态(在线仅显示账户 /models 接口返回的模型,离线才用内置备用列表);
- 鉴权文件权限应为 0600、不要提交进 git;token 不会打印到日志或终端,也不会经过登录 API 回传浏览器。

## 客户端半边:开发要点与验证

- **两层 inject 方向不能反**(见上节):`dsh.client.inject` 填 npm 包名,`src/client.js` 的 `inject` 填 Cordis 服务名;填反任何一处,web 启动会停在"等待服务"报错页。
- **UI 文字跟随语言设置**:客户端用 `ctx.locale.register(ns, {zh, en})` 提供词典、`bind(ns)` 取翻译函数、`subscribe` 随语言切换重渲染;宿主侧的用户可见名称(如「模型」页目录里的提供商名)不能写死——客户端把 locale 快照(`ctx.locale.getSnapshot().active`,即 harness 当前界面语言)作为 `locale` 查询参数随登录 API 轮询带给宿主,宿主据此用目录条目的 `replace()` 原子换名;用户显式选择语言时以设置为准(宿主读 `settings.get("locale")?.preference`),`Accept-Language` 仅作非浏览器调用者的兜底。模型 ID、档位名、简介等来自账户接口的元数据保持原样、不做翻译。
- **往外壳 React 树里注入内容**:外壳页面是构建产物的 React 树,不提供渲染接口;用 `MutationObserver`(childList+subtree,挂在 `document.body`)+ `queueMicrotask` 扫描目标行,用纯 DOM 构建节点。暖缓存同步渲染可以避免展开闪烁;重复扫描要幂等(挂载容器 `childNodes.length === 0` 才重建)。
- **外壳运行时不等于类型声明**:`useCopyFeedback` 只在类型声明里,运行时没有导出;实际可用的是 `writeClipboard`(以及 `Button`/`Modal`/`StateDot`/若干图标)。以运行时导出为准,先验证再解构。
- **Web UI 改动建议无头浏览器验证**:临时 `DSH_HOME` + 复制 profile 的 `package.json` 与 `pnpm-workspace.yaml` + `pnpm install --prefer-offline`,起 `dsh --profile web --port <新端口>`,用 Playwright chromium 驱动:跳过首次引导 → 设置 → 目标页面,断言文案与行为;结束后清理临时目录。settings 文件放在 `DSH_HOME/settings.yaml`。

## 新订阅商接入:规范与实战速查

接入任何新的第三方订阅服务,除上面的通用验证外,必须遵守三条硬性规则(完整约束见 `AGENTS.md` 的「新订阅商接入规范」):

1. **模型列表与思考档位动态获取,不得写死**——不同订阅档位可用的模型与思考深度不同,写死会导致用户升级订阅后部分模型/档位不可用;选择器只展示账户目录接口返回的模型与档位,静态列表仅作离线兜底,绝不与成功的在线结果混用。
2. **多思考档位按从低到高排序,首项为 Off**(仿照 deepseek 模型的设计);Off 仅在账户目录声明关闭档时展示——若后端拒绝显式 off(如 xai 实测 HTTP 400 invalid reasoning effort),只展示目录声明的档位;默认档优先取目录声明的默认值,其次才用设置项。
3. **声明多模态(图片输入)的模型必须实测**:以真实账户或等效往返测试覆盖「用户图片输入」与「工具结果图片」两条路径,发现问题必须修复,验证通过前不算接入完成(openai 与 xai 的接入都经过这一步)。

### xAI 接入实战:问题与解法速查

按接入过程的时间顺序记录,后续服务商遇到同类症状可直接对照:

| # | 问题/现象 | 根因 | 解法(代码位置) |
|---|---|---|---|
| 1 | 所有订阅请求 HTTP 426,提示 Grok CLI 版本过旧 | cli-chat-proxy 对官方 CLI 做版本门控与代理鉴权,缺 `x-grok-client-version` 等指纹头 | 每次请求携带指纹头集合(标识/版本/模式/`X-XAI-Token-Auth`/`x-authenticateresponse`/UA),见 `src/providers/xai.js` 的 `grokProxyHeaders`;版本随上游调高 |
| 2 | HTTP 402 提示无额度/无订阅,但账户订阅正常 | 请求了账户目录之外的模型,且走了错误协议(chat completions vs responses) | 在线目录用 `/models-v2` 拉取账户真实模型;目录 `api_backend` 决定线协议模板(见 `src/piai.js` 的 `piModelFor`) |
| 3 | 第二轮请求崩溃 `Cannot read properties of undefined (reading 'totalTokens')` | pi-ai 的上下文估算无条件读取历史 assistant 消息的 `usage` | 历史 assistant 消息必须携带零 `usage` 与正确 `stopReason`(`src/piai.js` 的 `toPiAssistant`/`emptyPiUsage`) |
| 4 | 图片已生成并入库,但 UI 不显示 | 外壳的工具结果卡片只渲染文字、丢弃图片块 | 适配器把未回显的工具结果图片作为助手消息前导图片块回声,并按回声数偏移后续块 index(`src/piai.js` 的 `lastUnEchoedToolResultImages` + `stream` 回声) |
| 5 | `edit_latest_image` 报「会话中还没有图片」 | `latestConversationImageRef` 只扫 `user/message` 事件,漏掉 `tool/result` 与 `assistant/message` | 扫描扩展到三类表面事件、自后向前取最新(`src/index.js`) |
| 6 | 思考深度不可选 | M1 曾整体关闭档位;线协议模板的 `thinkingLevelMap` 缺账户目录声明的档,会把 xhigh 悄悄降级为 high | 档位从账户目录声明动态生成;`thinkingLevelMap` 用目录档位覆盖模板;默认档取目录声明 |
| 7 | 登录弹窗/目录文案写死 ChatGPT,其它服务也显示 ChatGPT | 共享文案未参数化 | 共享文案用 `{name}` 参数化,取当前服务显示名(`src/client.js`) |
| 8 | 后端拒绝 off 档(HTTP 400 invalid reasoning effort) | 该模型没有关闭档,目录也未声明 | Off 仅在目录声明时展示;目录只声明 high/xhigh 时就只显示这两档(低→高) |
| 9 | 推送被仓库规则拦截(repository rule violations) | 代码内嵌了 Google OAuth client secret(`GOCSPX-` 触发密钥保护) | `GOCSPX-` 字面量一律不进仓库:gemini-cli 的公开 client secret 在登录时从官方源(`google-gemini/gemini-cli` 的 `packages/core/src/code_assist/oauth2.ts`)运行时读取,`GEMINI_OAUTH_CLIENT_SECRET`/`GOOGLE_OAUTH_CLIENT_SECRET` 仅作显式覆盖(见 `src/providers/google.js` 的 `oauthClientSecret`);公开 client id 可以入库 |
| 10 | API-key 类服务与外壳内置目录重复 | harness 的「模型」页「Add provider」已原生内置 `minimax-cn`/`qwen-token-plan-cn`/`openrouter` 等 API-key 路由(同端点、同凭据方式) | 重复的服务不接入;产品方向定为「仅 OAuth 订阅」后,插件侧的密钥类实现(MiniMax/阿里百炼/OpenRouter/火山方舟)已全部移除(见 `AGENTS.md` 接入规范第 4 条) |
| 11 | 自定义 pi-ai provider 流式请求报 `Unknown provider: undefined` 或 `Cannot read properties of undefined (reading 'includes' / 'tiers')` | `createProvider` 的模型条目可能不带 `provider`/`baseUrl`/`contextWindow`/`maxTokens`/`cost` 字段,而 pi-ai 的派发、上下文钳制与费用统计都依赖它们 | `piModelFor` 克隆时补齐这些字段:`provider` 恒为当前 pi-ai provider id;`contextWindow` 取在线目录 → 模板 → 配置默认(否则钳制出 NaN);`maxTokens` 兜底 8192;`cost` 兜底全零(`src/piai.js`) |
| 12 | 密钥类服务的模型页无目录行(历史) | 验证脚本把 `settings.yaml` 放错位置(profile 子目录),设置未加载 | harness 的 settings 文件在 `DSH_HOME/settings.yaml`(harness home 根),不在 `profiles/<name>/` 下 |
| 13 | Gemini 授权页报 `403 restricted_client: Unregistered scope(s): generative-language`,或订阅请求 `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` | gemini-cli 的 OAuth 客户端只注册了 Cloud Code 作用域,Google 拒绝为其声明 generative-language 作用域;其令牌对 Generative Language API 无访问权 | 订阅访问需自建 Google Cloud「Desktop app」OAuth 客户端(项目内启用 Generative Language API),用 `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` 覆盖客户端身份;默认客户端仅作 Cloud Code 最佳努力回退(见 `src/providers/google.js`) |

### 真实账户最小验证配方

无 GUI 环境或自动化验证时,用插件自己的组件走同一条请求路径(以 xai 为例,见各次修复的 `.tmp-repro/verify-*.mjs`):

1. `FileCredentialStore` 指向真实凭据文件 → `createModels({ credentials: store })` → `setProvider(xaiProvider())`;
2. 克隆 pi-ai 模型模板,覆盖 `baseUrl`、`headers`(`grokProxyHeaders()`)、`thinkingLevelMap` 与在线目录字段——与适配器 `piModelFor` 的产物一致;
3. `models.streamSimple(...)` 发最小请求(如「Reply with exactly one word: ok」),迭代事件断言 `done`/文本/用量,或读取 `error` 事件的 `errorMessage` 定位后端拒绝原因。

验证结束必须删除 `.tmp-repro/`;真实凭据只读不复制。

## 分发(单一仓库直装)

```sh
# 安装(`--profile <name>` 必填、名字任意)
dsh plugin --profile <name> add github:kinoward/dsh-plugin-subhub
```

更新时再次执行上面的命令。想停用插件:在自身 profile 的 `cordis.patch.yml` 中按 `id` 禁用对应行(用户层在所有 bundle 层之后应用、按 id 胜出)。
