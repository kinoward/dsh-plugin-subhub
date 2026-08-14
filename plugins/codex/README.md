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

登录完成后,在 DeepSeek Harness 的模型选择器里把提供商切到「OpenAI 订阅」,再选一个模型即可。在线时显示你的账户可用模型;拉取失败时回退到静态备用模型(gpt-5.6-sol、gpt-5.6-terra、gpt-5.5、gpt-5.4、gpt-5.3-codex-spark)。

**设置模型与思考深度**:在「模型」页的「OpenAI 订阅」服务行点「编辑」可配置备用模型列表(`models`)、默认思考深度(`defaultReasoningEffort`)等;单次会话的模型与思考深度在模型选择器里随时切换(可选 `low` / `medium` / `high`)。

## 可选设置

在 `$DSH_HOME/settings.yaml` 的 `codex:` 节里可以配置:

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `authFile` | `~/.kino-dsh/codex-auth.json` | 鉴权文件路径;默认插件自有文件,显式指定后只读写该文件 |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | ChatGPT OAuth 模式的后端地址 |
| `apiBaseURL` | `https://api.openai.com/v1` | API key 模式的后端地址 |
| `defaultContextWindow` | `400000` | 默认上下文窗口(token 数) |
| `modelsCacheTtlMs` | `300000` | 模型列表缓存时长(毫秒) |
| `models` | 静态备用模型列表 | 请求失败时的回退模型,每项形如 `{id, name?, description?, contextWindow?}` |
| `defaultReasoningEffort` | 空(用提供商默认) | 默认思考深度:`low` / `medium` / `high` |
| `streamIdleTimeoutMs` | `300000` | 流式响应空闲超时(毫秒) |
| `retryPolicy` | `normal`(重试 2 次) | 请求重试策略 |

## 限制

- 不支持图片输入。
- 不支持 stop 序列(Responses API 没有这个参数)。
- 不支持输出 token 上限(后端不接受 `max_output_tokens`,harness 的 `maxTokens` 不会发送)。
- 推理强度可选 `low` / `medium` / `high`。

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

Codex 后端是官方 codex CLI 使用的内部 API,非公开 API,可能随 OpenAI 调整而变化;订阅配额与限速由你的 ChatGPT/Codex 订阅决定。
