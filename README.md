# dsh-plugin-subhub

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DeepSeek Harness 第三方订阅接入插件:在设置侧边栏提供「第三方订阅」中心页,统一管理各订阅服务的登录与凭据;登录成功的服务会作为模型提供商出现在「模型」页与模型选择器里,退出登录即移除。当前已接入 **OpenAI 订阅**(ChatGPT OAuth),用你的 ChatGPT 订阅账户调用 GPT 模型;支持图片理解(多模态输入),并内置 `generate_image` 工具实现对话内**文生图与图生图(图片编辑)**。

- 行 id:`dsh-plugin-subhub`;挂载模块:`dsh-plugin-subhub`;provider 路由 id:`dsh-plugin-subhub-openai`(与外壳内置目录里的 `openai` 区分;未来新服务商统一用 `dsh-plugin-subhub-<服务商>`)。

GitHub 仓库:https://github.com/kinoward/dsh-plugin-subhub

## 安装与更新

要求:已安装 `dsh` CLI(DeepSeek Harness 0.1 预览版);插件运行需要 Node.js 18.17+,使用随包脚本登录时需要 Node.js 18+。纯 JavaScript、无构建步骤,安装时无需授予构建权限。

```sh
# 安装:`--profile` 为必填参数,名字任意;用 web 时可直接 `dsh web` 启动
# (首次会自动初始化 profile)
dsh plugin --profile web add github:kinoward/dsh-plugin-subhub

# 启动(profile 名为 web 时也可直接 dsh web)
dsh --profile web
```

启动后完成一次性登录授权(见下节),即可在模型选择器里使用本插件提供的模型。更新:再次执行上面的安装命令即可。

> 关于随包登录脚本:安装后的文件位于 profile 目录的 `node_modules/dsh-plugin-subhub/login.js`(在该目录下执行 `node node_modules/dsh-plugin-subhub/login.js`);从 GitHub 克隆本仓库自用的开发者可以直接 `node login.js`。网页登录不受此影响,推荐优先使用网页登录。

安装后,可在界面 **设置 → 插件 → 插件列表** 里按行启用/停用插件;命令行方式则是按 `id` 在自己 profile 的 `cordis.patch.yml` 中禁用对应行(用户层在所有 bundle 层之后应用、按 id 胜出):

```yaml
- id: dsh-plugin-subhub
  name: 'dsh-plugin-subhub'
  disabled: true
```

## 快速开始

1. **登录**:打开设置 → **第三方订阅**,在 **OpenAI 订阅** 卡片点「登录」,按提示在浏览器里打开链接、输入一次性码完成授权。每位用户安装后都必须通过本插件完成一次登录——插件只使用自己保存的凭据,不会读取其它程序的登录信息;
2. **选模型**:登录成功后,在左下角 **选择模型** 里切到 **OpenAI 订阅**,挑一个模型即可开始对话;
3. **管理**:在「第三方订阅」页点「退出登录」即删除本插件的凭据文件,提供商随之从「模型」页消失;切换账户直接重新登录即可覆盖。

界面文案自动跟随 DeepSeek Harness 的界面语言(中文 / English);模型列表、上下文窗口、思考深度档位与图片输入能力全部实时取自你的账户接口,无需手动配置。

无头环境可用随包脚本登录(等价于上面的网页流程)。脚本位于安装包内(路径见「安装与更新」);可用 `--auth-file <路径>` 覆盖保存位置。脚本登录后**重启 harness**,或**打开一次「第三方订阅」页**(该页的状态轮询会自动完成 provider 注册)。

## 工作原理

- 在 `ctx.llm` 上注册 provider 路由 `dsh-plugin-subhub-openai`(显示名「OpenAI 订阅」);登录成功即注册、退出登录即注销,因此「模型」页与模型选择器只显示已认证的服务。
- 鉴权基于 OAuth token,凭据只放在插件自己的文件 `~/.dsh-plugin-subhub/openai-auth.json`(或 `authFile` 显式指定的文件);`access_token` 是 JWT,临近过期(5 分钟内)会自动用 `refresh_token` 刷新,刷新端点 `https://auth.openai.com/oauth/token`;刷新会加锁(并发时只刷一次),并把新 token 回写文件(权限 0600)。
- **隐私边界**:插件默认只读写自己的凭据文件,绝不读取官方 Codex CLI 的 `~/.codex/auth.json` 或其它程序的认证文件。安装后每位用户都必须通过本插件完成一次登录授权,不会"复用"任何既有登录。
- 如果自己的凭据文件里存在 `OPENAI_API_KEY`,则按 API key 模式走 `https://api.openai.com/v1`。
- 模型列表来自 `GET https://chatgpt.com/backend-api/codex/models`,缓存 5 分钟;失败时回退到静态备用模型列表。
- 请求走 Responses API:`POST https://chatgpt.com/backend-api/codex/responses`,SSE 流式,`store: false`。
- 登录期间,插件还会向 harness 工具注册表注册 `generate_image` 工具(随登录/退出自动注册与注销),对话内的图片生成与编辑都由它执行,见「图片生成与编辑」。

## 登录

两种方式(「快速开始」为网页版):设置面板的「第三方订阅」页(推荐;登录框显示链接和一次性码、可一键复制,全程设备码流程,页面上永远看不到 token),或运行随包脚本(路径见「安装与更新」)。两种方式写入同一个插件自有文件,权限 0600。

想要自定义位置或彻底隔离:在 `$DSH_HOME/settings.yaml` 的 `dsh-plugin-subhub-openai:` 节设置 `authFile: <绝对路径>`,插件就只读写该文件。

## 模型与思考深度

**模型列表完全动态**:实时取自你账户的 `/models` 接口(缓存 5 分钟),接口返回什么就显示什么;内部条目(如 `-wm` Work Mode 路由别名、自动审查模型)按 `visibility: hide` 过滤,与官方 CLI 的显示一致;只有接口不可达时才用内置备用列表兜底,静态列表绝不混入在线展示。上下文窗口直接采用接口的 `context_window` 字段。

**查看可用模型**:登录后,「模型」页会出现「OpenAI 订阅」服务行;点「编辑」展开卡片即可查看当前账户的**可用模型列表**(只读展示)。每个模型列出 ID、名称、上下文窗口、思考深度档位(标注接口默认档)与是否支持图片。可选档位由模型接口**动态下发、不写死**,默认档也取自接口;单次会话的模型与档位在模型选择器里随时切换。默认上下文窗口、默认思考深度(`defaultReasoningEffort`)等行为参数在 `$DSH_HOME/settings.yaml` 的 `dsh-plugin-subhub-openai:` 节配置(见「可选设置」)。

**ultra 档说明**:`ultra` 在发送到后端时映射为 `max`(线上端点不直接接受 ultra,与官方 CLI 的做法一致),选择器里仍显示 Ultra。官方 CLI 里 Ultra = max 推理 + 代理层切换到主动多智能体模式(自动任务委派);模型侧推理上限就是 max。本插件实现等价机制(**ultra 自动委派**):选择 ultra 档且会话中存在 subagent 工具时,每次请求会自动在系统提示里注入主动委派指令——模型把独立子任务拆解后交给后台 subagent 并行执行、自己负责收集验证与最终汇总。注意:subagent 工具对所有模型、所有档位都可用(由 agent 预设无条件挂载,harness 的工具装配不按模型或档位过滤);ultra 只是把委派升级为主动并行模式,并不是委派能力的开关。

## 图片输入(多模态)

支持上传图片:图片先经 harness 附件服务保存,发送时插件从附件服务读出字节、编码为 data URL,作为 Responses API 的 `input_image` 内容块随用户消息一起发出。工具结果里的图片(例如 `read_image` 的返回)同样会编码为 `function_call_output` 输出里的 `input_image` 内容块,模型可以继续"看到"工具读出的图;若后端拒绝这种形式,插件会自动降级为文本占位符并重试一次,不会中断会话。每个模型是否接受图片取自你账户 `/models` 接口的 `input_modalities` 字段(目前除 `gpt-5.3-codex-spark` 纯文本外,各模型都声明 `text,image`);选择不支持图片的模型时,harness 会在发送前拒绝带图消息。

## 图片生成与编辑

登录后,插件会向 harness 工具注册表注册一个真实的 `generate_image` 工具(随登录/退出自动注册与注销),模型可以直接在对话里**生成**图片——例如"生成一张二次元美少女微笑的 jpg 图片"。工具经账户后端执行:

- **ChatGPT 订阅模式**:优先调用 `chatgpt.com/backend-api/codex/images/generations`(gpt-image 模型);若该路径不可用,自动回退到网页版合成端点 `/backend-api/synthesize`。实测 ChatGPT 后端会忽略 Responses API 的 `image_generation` 服务端工具,所以订阅模式走 harness 工具而不是 wire 工具。
- **API key 模式**:调用 `api.openai.com/v1/images/generations`,并额外保留 Responses API 服务端 `image_generation` 工具的注入(公开 API 官方支持;后端拒绝时自动停用并重试一次)。

**编辑图片(图生图)**:把要改的图放进对话(上传,或使用上一轮生成的图),让模型修改即可——模型会以 `edit_latest_image: true` 调用工具,工具自动取**会话中最近一张图**作为编辑源,向后端图片编辑端点(`chatgpt.com/backend-api/codex/images/edits`;API key 模式为 `api.openai.com/v1/images/edits`)发送真实编辑请求,只应用描述的改动、其余保持不变,而不是凭空重画。实测 ChatGPT 后端只接受 JSON 且要求 `images` 数组(元素为 `{"image_url": "data:…"}` 对象;multipart 与单数 `image` 字段都会被拒),插件会按候选形态依次尝试并在全部失败时如实报错。

生成的图片经 harness 附件服务持久化,以工具结果图片块返回,并自动**回显到助手消息**里直接显示在对话中(可下载)——harness 的工具结果卡片只渲染文本,回显是让图片出现在界面的通道;图片同时会在后续轮次回放给模型,模型能持续看到自己生成或编辑的图,后续再编辑也以此图为源。

注意事项:
- 生成/编辑结果必须能被附件服务接受(PNG/JPEG/WebP/GIF);后端只返回文件引用而无内联字节时,工具会报错而不是假装成功。
- 会话中没有图片时,编辑请求会明确报错并请用户先上传图片,不会凭空重画。
- 可用 `dsh-plugin-subhub-openai.imageModel` 覆盖生图/编辑模型(默认 `gpt-image-2`);`dsh-plugin-subhub-openai.enableImageTool: false` 关闭 API key 模式下的 wire 工具注入。
- 图片相关失败会记录到插件自有诊断日志 `~/.dsh-plugin-subhub/openai-image-debug.log`(与鉴权文件同目录;只记录异常与重试,不记录 token),排查问题时把该文件内容发给开发者即可。

## 可选设置

在 `$DSH_HOME/settings.yaml` 的 `dsh-plugin-subhub-openai:` 节里可以配置:

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `authFile` | `~/.dsh-plugin-subhub/openai-auth.json` | 鉴权文件路径;默认插件自有文件,显式指定后只读写该文件 |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | ChatGPT OAuth 模式的后端地址 |
| `apiBaseURL` | `https://api.openai.com/v1` | API key 模式的后端地址 |
| `defaultContextWindow` | `400000` | 未知模型的默认上下文窗口(token 数);已知模型直接用接口下发的 `context_window` |
| `modelsCacheTtlMs` | `300000` | 模型列表缓存时长(毫秒) |
| `defaultReasoningEffort` | 空(用模型接口默认) | 默认思考深度:`low`/`medium`/`high`/`xhigh`/`max`/`ultra`;模型不支持的档位会回退到接口默认 |
| `streamIdleTimeoutMs` | `300000` | 流式响应空闲超时(毫秒) |
| `enableImageTool` | `true` | API key 模式下是否在请求里挂载 `image_generation` 服务端工具;后端拒绝时插件会自动停用并重试 |
| `imageModel` | `gpt-image-2` | `generate_image` 工具使用的生图/编辑模型 |
| `retryPolicy` | `normal`(重试 2 次) | 请求重试策略 |

## 限制

- 图片可以出现在用户消息、工具结果与助手消息里:用户图片编码为 `input_image`;工具结果图片编码为 `function_call_output` 的 `input_image` 内容块;助手产出的图片(生成/编辑结果的回显)回放时重定位为用户消息里的 `input_image`。后端拒绝时自动降级为文本占位符并重试一次。
- harness 的工具结果卡片只渲染文本:工具返回的图片对模型可见,但界面显示依赖插件把图片回显到助手消息;该回显按 attachment id 去重,每张图只出现一次。
- `gpt-5.3-codex-spark` 是纯文本模型(账户接口声明的能力),不支持图片输入。
- 不支持 stop 序列(Responses API 没有这个参数)。
- 不支持输出 token 上限(后端不接受 `max_output_tokens`,harness 的 `maxTokens` 不会发送)。
- 登录 API 只接受本机(127.0.0.1 / localhost)请求:通过局域网 IP、域名或反向代理打开界面时,「第三方订阅」页会提示仅支持本机访问;远程使用时请改用 SSH 隧道(如 `ssh -L 3080:127.0.0.1:3080`)。
- 推理强度档位随模型由接口下发(`low`/`medium`/`high`/`xhigh`/`max`/`ultra` 的子集)。

## 安全提示

- 鉴权文件权限为 0600,只有当前用户可读写。
- 不要把鉴权文件提交进 git;token 属于机密,不进仓库文件。
- token 永不打印:插件和登录脚本都不会把 token 输出到日志或终端。

## 重要说明

ChatGPT 订阅后端是官方 CLI 使用的内部 API,非公开 API,可能随 OpenAI 调整而变化;订阅配额与限速由你的 ChatGPT 订阅决定。实现参考了官方 CLI 与 opencode 开源项目的 ChatGPT 登录流程与模型配置(各模型族的上下文窗口等元数据与 opencode 保持一致)。

## 目录结构

```
dsh-plugin-subhub/
├── AGENTS.md             # AI 编程代理的行为规范
├── README.md             # 本文:插件介绍与快速使用
├── LICENSE               # MIT 许可文本
├── docs/
│   └── development.md    # 开发、验证、分发指南
├── package.json          # 唯一清单:dsh.bundle.patch + exports + dsh.client 声明 + 依赖
├── cordis.patch.yml      # 补丁层:本插件一行
├── login.js              # 独立登录脚本,node 直接运行
└── src/
    ├── index.js          # 插件代码(宿主半边:LLM 适配器与登录 API)
    ├── client.js         # 客户端半边:「第三方订阅」中心页(手写模块加载器格式)
    └── device-flow.js    # 共享的 OpenAI 设备码登录流程
```

## 进一步阅读

- 开发循环、验证清单与分发:见 [`docs/development.md`](docs/development.md);
- AI 编程代理的约束(含提交规范):见 [`AGENTS.md`](AGENTS.md);
- 问题与反馈:到仓库的 [Issues](https://github.com/kinoward/dsh-plugin-subhub/issues) 提出。

## 许可

本仓库采用 [MIT License](LICENSE):学习、修改、商用均自由。唯一要求:以任何形式**分发**本软件(包括随商业产品分发、二次封装)时,必须保留版权声明与 MIT 许可文本——即商用分发时注明出处(引用说明)。个人或企业内部使用不附带此义务。
