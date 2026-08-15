# AGENTS.md

本文件约束在此仓库工作的 AI 编程代理。面向人类的内容在 `README.md` 与 `docs/`;不要把 AI 专用规范写回 README。

## 仓库不变量(任何改动不得破坏)

- **唯一仓库 = 唯一插件 dsh-plugin-subhub 的可安装组合包(bundle)**:根 `package.json` 声明 `dsh.bundle.patch`,根 `cordis.patch.yml` 是本插件唯一一行补丁。
- 不上 npm、不拆仓库;纯 JavaScript、无构建步骤、无 `prepare` 脚本;插件源码直接位于 `src/index.js`(宿主半边)与 `src/client.js`(客户端半边)。
- **命名约定**:插件身份一律 `dsh-plugin-subhub`(行 id、挂载模块、客户端模块 id、登录 API `/api/dsh-plugin-subhub/*`、CSS 前缀 `dsh-plugin-sub-*`、凭据目录 `~/.dsh-plugin-subhub/`);具体订阅服务相关 id 一律 `dsh-plugin-subhub-<服务商>`(provider 路由 id、settings.yaml 设置节,如 `dsh-plugin-subhub-openai`)。新服务商沿用此约定,不得引入新前缀。
- 插件如需 npm 依赖,只能加在根 `package.json`(用户只安装根包)。
- 密钥、凭据、token 一律不进仓库文件;机密走环境变量或宿主侧配置。
- **凭据隐私边界**:插件只读写自己拥有的凭据文件(如 `~/.dsh-plugin-subhub/openai-auth.json`),不得读取、复用其它程序(如 codex CLI 的 `~/.codex/auth.json`)的认证文件;用户显式用配置指定文件路径的除外。安装插件不构成对既有登录的授权。
- **provider id 全局唯一**:`ctx.llm` 的 configurable provider id 不能与外壳内置目录重名(内置已声明 `openai`、`deepseek`、`anthropic-messages` 等,见 `dsh-llm-pi-ai`);重名会让插件树以 DUPLICATE_DIRECTORY 加载失败。本插件因此用 `dsh-plugin-subhub-openai`;新提供商选 id 前先核对内置清单。
- **登录门控契约**:provider 路由与「模型」页目录条目只在凭据存在时注册;注册触发器固定为四处——插件挂载、插件设置节变更、网页登录/退出成功回调、中心页状态轮询的自愈补注册(脚本登录后打开一次「第三方订阅」页即可注册)。改动登录链路不得破坏自愈行为。
- **宿主显示名跟随 harness 界面语言**:客户端把 locale 快照(`ctx.locale.getSnapshot().active`)作为 `locale` 查询参数随每次登录 API 调用发给宿主;宿主以显式 `locale.preference` 设置为优先、快照为兜底决定显示名,并用目录条目 `replace()` 原子换名。用户可见名称不得写死中文。
- **依赖只用 pnpm**:仓库根依赖一律 `pnpm install`;禁止 `npm i`(会把临时包写进根 `package.json` 并生成 `package-lock.json`,污染清单)。诊断类临时工具装到自带 `package.json` 的独立目录,用后即删。
- **临时验证产物不进库**:验证用临时目录一律 `.tmp-repro/`(已在 `.gitignore`),结束即删;测试凭据(含假 token 文件)不得提交、不得留在工作区。
- **仓库已公开**:推送前必须跑密钥模式扫描(`sk-`、`eyJ…`、`ghp_`、私钥块等)与绝对路径扫描(`/Users/`、本机用户名等),并核对 `git ls-files` 只含预期清单与插件文件,凭据、会话、设置一律不得入库。

## 用户文档边界

- `README.md` 只服务插件使用者,按「用途 → 安装 → 登录 → 选择模型 → 图片使用 → 账户管理 → 更新/停用 → 常见问题 → 安全与反馈」组织;优先写用户要点击什么、执行什么、看到什么。
- 不在 README 展开行 id、provider 路由、内部 API 与端点、OAuth/JWT 刷新、缓存与并发锁、SSE、请求字段、附件编码、工具注册方式、源码目录职责等实现细节。稳定的维护约束写在本文件,短期实现事实留在代码及 `docs/development.md`。
- 不在 README 写死某个外部模型当前是否可用、是否支持图片或有哪些思考档位;以界面根据账户能力显示的结果为准。
- 用户文案避免「完全」「实时」「永不」「与官方实现等价」等无法长期保证的绝对说法。描述外部服务时明确模型、额度、限速和可用性由服务商与账户决定。

## 功能行为契约

- **模型目录**:正常情况下只展示账户接口返回且允许显示的模型;在线目录不可用时才使用静态备用列表,不得把备用项混入成功的在线结果。上下文窗口、可选及默认思考档位、图片输入能力优先采用模型目录字段,不得在用户文档中维护易过期的固定模型快照。
- **思考档位**:发送值必须符合后端接受的档位;附加的代理行为只能在所需工具真实存在时启用。不得把提示驱动的行为描述成模型必然执行。`ultra` 当前到 `max` 的映射与主动委派方式属于实现细节,变更时需验证选择器兼容性和会话行为。
- **图片输入**:用户附件和工具结果图片都应传给声明支持图片的模型;不支持图片的模型必须在发送前拒绝。后端拒绝工具结果图片时只做有限降级重试,不得无限重试。
- **图片工具生命周期**:`generate_image` 随有效凭据注册,退出登录后注销。生成或编辑成功必须得到附件服务可接受的真实图片,写入附件并在助手消息中回显;没有图片字节或附件写入失败时必须如实报错,不得伪造成功。回显按 attachment id 去重,后续轮次仍应能使用该图片。
- **图片编辑**:`edit_latest_image: true` 使用当前会话最近一张可用图片;没有图片时明确要求用户先上传,不得悄悄退化为文生图。
- **本机登录边界**:网页登录 API 只接受通过 `127.0.0.1`、`localhost` 或回环地址访问的请求,不得为反向代理无条件放宽。远程场景引导使用 SSH 端口转发或独立登录脚本。
- **适配器兼容性**:只发送目标后端支持的参数,推理档位限制在模型目录声明的选项内;当前 stop 序列和输出 token 上限的处理方式是实现细节,修改时必须验证后端兼容性。

## 配置兼容面

- `settings.yaml` 中 `dsh-plugin-subhub-openai` 节当前识别 `authFile`、`baseURL`、`apiBaseURL`、`defaultContextWindow`、`modelsCacheTtlMs`、`defaultReasoningEffort`、`streamIdleTimeoutMs`、`enableImageTool`、`imageModel`、`retryPolicy`。其中 README 或发布说明曾面向用户公开的键属于兼容面;内部调优键可以演进,但删除或改名之前必须检查仓库历史与用户迁移影响。
- `authFile` 一经显式配置,登录、刷新、状态查询与退出必须始终使用该文件;退出会删除它,因此不得暗中改读其它程序的凭据。
- 内部端点、请求体候选形态、缓存默认毫秒数和重试步骤属于可变实现,除非升级为兼容性承诺,否则不要复制到 README。

## 文件职责

- `README.md`、`docs/`:人类文档,用中文。
- `AGENTS.md`:本文件,AI 行为规范。
- 插件本体:`src/index.js`(宿主半边)+ `src/client.js`(客户端半边)+ `src/device-flow.js`(共享设备码登录流程);挂载点 = 根 `package.json` 的 `exports` + 根 `cordis.patch.yml` 一行,行 id 与挂载模块统一 `dsh-plugin-subhub`。
- `login.js`:无头环境独立登录脚本,`node login.js` 直接运行。
- 客户端两层 inject 不可混用:根 `package.json` 的 `dsh.client.inject` 是客户端 npm **包**依赖边;`src/client.js` 导出的 `inject` 是模块实际读取的 Cordis **服务**名(只用 `ctx.slots` 就写 `["slots"]`)。

## 目录地图(按需读取,禁止全仓扫描)

开始工作前先读本文件;需要具体内容时按地图直达目标路径,用 read 工具读取,不要用 `glob`/`find` 枚举全树、不要 `cat` 整个仓库:

```
AGENTS.md                       AI 约束与本文地图(先读)
README.md                       人类:插件介绍与快速使用
LICENSE                         MIT 许可文本(条款不可改写)
docs/development.md             人类:开发循环、验证、分发
package.json                    唯一清单:dsh.bundle.patch、exports、dsh.client、依赖
cordis.patch.yml                补丁层:本插件一行(id 与 name 均为 dsh-plugin-subhub)
login.js                        独立登录脚本,node 直接运行
src/index.js                    插件代码(宿主半边:LLM 适配器与登录 API)
src/client.js                   客户端半边:「第三方订阅」中心页(手写模块加载器格式)
src/device-flow.js              共享的 OpenAI 设备码登录流程
```

按需读取的最小集:

- 改动宿主半边:读 `src/index.js` + 根 `package.json` 的 `exports` + `cordis.patch.yml`;
- 改动客户端半边:读 `src/client.js` + 根 `package.json` 的 `dsh.client`;
- 改动集合层(清单/补丁/依赖):读根 `package.json` 与 `cordis.patch.yml`;
- 改动文档:只读目标文档本身;
- 地图未覆盖到的新文件:先更新本目录地图,再读取。

## 提交规范(每次提交都必须遵守)

- Conventional Commits;**首行用简单英文**,祈使语气、≤72 字符,如 `fix(subhub): harden credential refresh locking`。
- 需要解释时**正文中英对照**:先写英文一段,再写内容对应的中文一段;语言通俗,不用内部黑话和缩写。
- 常用 type:`feat`(新功能)、`fix`(修 bug)、`docs`(文档)、`refactor`(重构)、`chore`(杂项维护);破坏性变更用 `feat!` 或 `BREAKING CHANGE` footer。
- 提交前自检:`git status` 无意外文件、不含敏感信息、已跑下方验证清单。

## 验证清单(改动后至少执行)

- `node --check` 所有改动的 JS 文件;
- JSON/YAML 解析校验 `package.json` 与 `cordis.patch.yml`;
- 改动客户端插件时,核对 `src/client.js` 导出的 `inject` 全是 Cordis 服务名、根 `package.json` 的 `dsh.client.inject` 是包名;
- 组装验证(把 `DSH_HOME` 指向临时目录,避免污染 `~/.dsh`):

  ```sh
  dsh --profile web --patch ./cordis.patch.yml --dump-config
  ```

  确认输出出现本仓库补丁层(`# == .../cordis.patch.yml`)与 `dsh-plugin-subhub` 插件行。

- 客户端 UI 改动:按 `docs/development.md` 的无头浏览器配方(临时 `DSH_HOME` + Playwright)实测目标页面与语言切换,控制台零报错;
- 公开仓库推送前:密钥/绝对路径扫描覆盖工作区与全部历史(如 `git grep -nE '<模式>'`、`git log --all -S '<模式>'`),并 `git ls-files` 核对无凭据、会话、设置文件入库。

## 语言约定

- 人类文档:中文;
- commit:首行英文、正文中英对照;
- 代码标识符、命令、配置键:保持原样,不翻译。
