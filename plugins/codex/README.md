# kino-codex

用 Codex 订阅账户(ChatGPT OAuth)把 GPT 模型接进 DeepSeek Harness 的 LLM 适配器。它在 `ctx.llm` 上注册 provider 路由 `codex`(显示名 Codex),用你的 Codex 订阅账户的 token 调用 GPT 模型。由根 `cordis.patch.yml` 以子路径 `kino-dsh-plugins/codex` 挂载。

## 工作原理

- 鉴权基于 OAuth token:优先读官方 codex CLI 登录留下的 `~/.codex/auth.json`;没有时读随包登录脚本写入的 `~/.kino-dsh/codex-auth.json`。
- `access_token` 是 JWT,临近过期(5 分钟内)会自动用 `refresh_token` 刷新,刷新端点 `https://auth.openai.com/oauth/token`;刷新会加锁(并发时只刷一次),并把新 token 回写文件(权限 0600)。
- 如果存在 `OPENAI_API_KEY`,则按 API key 模式走 `https://api.openai.com/v1`。
- 模型列表来自 `GET https://chatgpt.com/backend-api/codex/models`,缓存 5 分钟;失败时回退到静态备用模型列表。
- 请求走 Responses API:`POST https://chatgpt.com/backend-api/codex/responses`,SSE 流式,`store: false`。

## 登录

二选一:

1. **官方 codex CLI 已登录过**:插件直接读 `~/.codex/auth.json`,无需额外操作。
2. **运行随包登录脚本**(设备码流程):

   ```sh
   node plugins/codex/login.js
   ```

   脚本会打印一个链接和一次性码;在浏览器打开链接、输入码完成登录后,默认把凭据写到 `~/.kino-dsh/codex-auth.json`。可用 `--auth-file <路径>` 覆盖保存位置;文件权限为 0600。

## 使用

登录完成后,在 DeepSeek Harness 的模型选择器里把提供商切到 Codex,再选一个模型即可。在线时显示你的账户可用模型;拉取失败时回退到静态备用模型(gpt-5.6-sol、gpt-5.6-terra、gpt-5.5、gpt-5.4、gpt-5.3-codex-spark)。

## 可选设置

在 `$DSH_HOME/settings.yaml` 的 `codex:` 节里可以配置:

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `authFile` | 空 | 鉴权文件路径;留空时优先读 `~/.codex/auth.json`,其次 `~/.kino-dsh/codex-auth.json` |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | ChatGPT OAuth 模式的后端地址 |
| `apiBaseURL` | `https://api.openai.com/v1` | API key 模式的后端地址 |
| `defaultContextWindow` | `400000` | 默认上下文窗口(token 数) |
| `modelsCacheTtlMs` | `300000` | 模型列表缓存时长(毫秒) |
| `models` | 静态备用模型列表 | 请求失败时的回退模型,每项形如 `{id, name?, description?, contextWindow?}` |
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
