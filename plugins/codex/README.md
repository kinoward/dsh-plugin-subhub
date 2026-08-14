# kino-codex

用 Codex 订阅账户(ChatGPT OAuth)把 GPT 模型接进 DeepSeek Harness 的 LLM 适配器。它在 `ctx.llm` 上注册 provider 路由 `codex`(显示名「OpenAI 订阅」),用你的 Codex 订阅账户的 token 调用 GPT 模型。由根 `cordis.patch.yml` 以子路径 `kino-dsh-plugins/codex` 挂载。

## 工作原理

- 鉴权基于 OAuth token,凭据只放在插件自己的文件 `~/.kino-dsh/codex-auth.json`(或 `authFile` 显式指定的文件);`access_token` 是 JWT,临近过期(5 分钟内)会自动用 `refresh_token` 刷新,刷新端点 `https://auth.openai.com/oauth/token`;刷新会加锁(并发时只刷一次),并把新 token 回写文件(权限 0600)。
- **隐私边界**:插件默认只读写自己的凭据文件,绝不读取 codex CLI 的 `~/.codex/auth.json` 或其它程序的认证文件。安装后每位用户都必须通过本插件完成一次登录授权,不会"复用"任何既有登录。
- 如果自己的凭据文件里存在 `OPENAI_API_KEY`,则按 API key 模式走 `https://api.openai.com/v1`。
- 模型列表来自 `GET https://chatgpt.com/backend-api/codex/models`,缓存 5 分钟;失败时回退到静态备用模型列表。
- 请求走 Responses API:`POST https://chatgpt.com/backend-api/codex/responses`,SSE 流式,`store: false`。

## 登录

安装插件后**必须完成一次本插件的登录授权**(无论本机是否用过 codex CLI,插件都不会读取它的凭据)。两种方式,任选其一:

1. **设置面板的「第三方订阅」页(推荐)**:侧边栏打开 **第三方订阅** → **OpenAI 订阅** 卡片 → 点「登录」。登录框会显示链接和一次性码(可一键复制);在浏览器里打开链接、输入一次性码后,页面自动完成登录。全程在设备码流程内,凭据只落在本机,页面上永远看不到 token。「第三方订阅」页是统一的订阅管理入口,后续接入 Anthropic、火山方舟等订阅商后,它们的登录认证也会呈现在这里(卡片列表扩展)。
2. **运行随包登录脚本**(无头 profile 或偏好终端的用户):

   ```sh
   node plugins/codex/login.js
   ```

   脚本会打印一个链接和一次性码;在浏览器打开链接、输入码完成登录后,把凭据写到 `~/.kino-dsh/codex-auth.json`。可用 `--auth-file <路径>` 覆盖保存位置;文件权限为 0600。

> **登录成功才可见**:「OpenAI 订阅」提供商只有在登录成功后才会注册,从而出现在「模型」页和模型选择器里;在「第三方订阅」页点「退出登录」即删除本插件的凭据文件,提供商随即从「模型」页消失。
>
> 两种方式写入同一个插件自有文件。想要自定义位置或彻底隔离:在 `$DSH_HOME/settings.yaml` 的 `codex:` 节设置 `authFile: <绝对路径>`,插件就只读写该文件。切换账户:直接重新登录即可覆盖,或先退出登录。

## 使用

插件界面文案**跟随 DeepSeek Harness 的语言设置**(通用设置 → 语言):选择中文时全部显示中文,选择 English 时全部显示英文,包括「第三方订阅」页、「模型」页展开卡片里的模型列表,以及「模型」页与模型选择器中的「OpenAI 订阅」提供商名称。模型 ID、思考深度档位名与模型简介来自账户接口的原始元数据,保持接口原样、不做翻译。

登录完成后,在 DeepSeek Harness 的模型选择器里把提供商切到「OpenAI 订阅」,再选一个模型即可。**模型列表完全动态**:实时取自你账户的 `/models` 接口(缓存 5 分钟),接口返回什么就显示什么;内部条目(如 `-wm` Work Mode 路由别名、自动审查模型)会按 `visibility: hide` 过滤,与官方 codex CLI 的显示一致;只有接口不可达时才用内置备用列表兜底,静态列表绝不混入在线展示。上下文窗口也直接采用接口的 `context_window` 字段。

**查看可用模型**:登录后,「模型」页会出现「OpenAI 订阅」服务行;点「编辑」展开卡片即可查看当前账户的**可用模型列表**(只读展示,不可编辑)。每个模型列出模型 ID、名称、上下文窗口、思考深度档位(标注接口默认档)与是否支持图片,数据与模型选择器同源、实时取自账户 `/models` 接口。默认上下文窗口、默认思考深度(`defaultReasoningEffort`)等行为参数请在 `$DSH_HOME/settings.yaml` 的 `codex:` 节配置(见下文「可选设置」);单次会话的模型与思考深度在模型选择器里随时切换。可选档位由模型接口**动态下发、不写死**:每个模型展示它自己支持的档位(如 gpt-5.6-sol 支持 `low`~`ultra` 六档,gpt-5.5 支持 `low`~`xhigh` 四档),默认档也取自接口。注意:`ultra` 在发送到后端时会映射为 `max`(线上端点不直接接受 ultra,与官方 codex CLI 的做法一致),选择器里仍显示 Ultra。**ultra 的真实含义**:官方 CLI 里 Ultra = max 推理 + 代理层切换到主动多智能体模式(自动任务委派,见 codex-rs `multi_agents.rs`:Ultra → `MultiAgentMode::Proactive`);模型侧推理上限就是 max。在本平台,插件实现了等价机制(**ultra 自动委派**):选择 ultra 档且会话中存在 subagent 工具时,每次请求会自动在系统提示里注入主动委派指令——模型把独立子任务拆解后交给后台 subagent 并行执行、自己负责收集验证与最终汇总(对应官方 CLI 的 Ultra → 主动多智能体模式)。**注意:子代理调用与思考深度无关**——subagent 工具对所有模型、所有档位都可用(它们由 agent 预设无条件挂载,harness 的工具装配不按模型或档位过滤);任何档位下模型都可以按需调用子代理,ultra 只是把委派升级为主动并行模式,并不是委派能力的开关。

**图片输入(多模态)**:支持上传图片。图片先经 harness 附件服务保存,发送时插件从附件服务读出字节、编码为 data URL,作为 Responses API 的 `input_image` 内容块随用户消息一起发出(经真实后端探测验证:后端接受字符串形式的 data URL,不接受对象形式)。**能力声明同样动态下发、不写死**:每个模型是否接受图片取自你账户 `/models` 接口的 `input_modalities` 字段——目前账户里除 `gpt-5.3-codex-spark`(纯文本)外,各模型都声明 `text,image`;选择不支持图片的模型时,harness 会在发送前拒绝带图消息。工具结果里若包含图片无法表示(`function_call_output` 只支持文本),会得到明确的错误提示而不是被静默丢弃。

## 可选设置

在 `$DSH_HOME/settings.yaml` 的 `codex:` 节里可以配置:

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `authFile` | `~/.kino-dsh/codex-auth.json` | 鉴权文件路径;默认插件自有文件,显式指定后只读写该文件 |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | ChatGPT OAuth 模式的后端地址 |
| `apiBaseURL` | `https://api.openai.com/v1` | API key 模式的后端地址 |
| `defaultContextWindow` | `400000` | 未知模型的默认上下文窗口(token 数);已知模型直接用接口下发的 `context_window` |
| `modelsCacheTtlMs` | `300000` | 模型列表缓存时长(毫秒) |
| `defaultReasoningEffort` | 空(用模型接口默认) | 默认思考深度:`low`/`medium`/`high`/`xhigh`/`max`/`ultra`;模型不支持的档位会回退到接口默认 |
| `streamIdleTimeoutMs` | `300000` | 流式响应空闲超时(毫秒) |
| `retryPolicy` | `normal`(重试 2 次) | 请求重试策略 |

## 限制

- 图片只能出现在用户消息里;工具结果里带图片会报错(`function_call_output` 只支持文本输出)。
- `gpt-5.3-codex-spark` 是纯文本模型(账户接口声明的能力),不支持图片输入。
- 不支持 stop 序列(Responses API 没有这个参数)。
- 不支持输出 token 上限(后端不接受 `max_output_tokens`,harness 的 `maxTokens` 不会发送)。
- 推理强度档位随模型由接口下发(`low`/`medium`/`high`/`xhigh`/`max`/`ultra` 的子集)。

## 禁用方式

在自己 profile 的 `cordis.patch.yml` 里写:

```yaml
- id: kino-codex
  disabled: true
```

## 安全提示

- 鉴权文件权限为 0600,只有当前用户可读写。
- 不要把鉴权文件提交进 git;token 属于机密,不进仓库文件。
- token 永不打印:插件和登录脚本都不会把 token 输出到日志或终端。

## 重要说明

Codex 后端是官方 codex CLI 使用的内部 API,非公开 API,可能随 OpenAI 调整而变化;订阅配额与限速由你的 ChatGPT/Codex 订阅决定。实现参考了官方 codex CLI 与 opencode 开源项目的 ChatGPT 登录流程与模型配置(各模型族的上下文窗口等元数据与 opencode 的 codex 插件保持一致)。
