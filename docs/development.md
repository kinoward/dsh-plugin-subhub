# 开发指南

本文面向人类开发者,介绍本仓库的开发与验证方式。AI 编程代理的行为约束见根目录 [`AGENTS.md`](../AGENTS.md)。

## 环境

- 已安装的 `dsh` CLI(npx 启动的部署即可);
- 不需要构建工具链:仓库是纯 JavaScript,无编译步骤。

## 本机开发循环

```sh
# 0. 先在仓库里安装依赖(link 模式不会替被链接包装依赖,没有这一步插件会因缺包加载失败)
pnpm install

# 1. 本地链接安装进演示 profile(首次自动初始化 profile)
dsh plugin --profile demo add link:./

# 2. 验证集合层被组装(应出现 # == kino-dsh-plugins 层与各插件行)
dsh --profile demo --dump-config

# 3. 真实运行(web profile 下可到设置页确认插件 UI;加载错误会出现在启动日志)
dsh --profile demo
```

> `link:` 会把 `node_modules/kino-dsh-plugins` 指向本仓库(改代码后重启即生效);`file:`/`./` 则安装快照,每次改代码都要重新 `add`。`pnpm install` 生成的 `node_modules/` 已加入 `.gitignore`,`pnpm-lock.yaml` 建议提交,保证本地开发环境可复现。

## 客户端插件的两层 inject(容易踩坑)

带网页 UI 的插件同时有两处注入声明,含义完全不同:

- `plugins/<name>/package.json` 里的 `dsh.client.inject`:客户端 **npm 包依赖边**,填包名(如 `@deepseek-ai/dsh-client-runtime`);
- `plugins/<name>/src/client.js` 导出的 `inject`:模块实际读取的 **Cordis 服务名**(如 `slots`、`locale`)。

填反任何一处,web 启动都会停在"等待服务"的报错页。客户端模块只用 `ctx.slots` 时,导出 `const inject = ["slots"]` 即可。

## 验证

改动后至少执行:

- `node --check` 所有改动的 JS 文件;
- JSON/YAML 解析校验 `package.json` 与各 `cordis.patch.yml`;
- 组装验证(把 `DSH_HOME` 指向临时目录,避免污染 `~/.dsh`):

  ```sh
  dsh --profile web --patch ./cordis.patch.yml --dump-config
  ```

## subhub 插件:登录与验证

`kino-subhub` 是第三方订阅服务接入插件,当前接入 OpenAI 订阅(ChatGPT OAuth),provider 路由 id 为 `openai`。需要先登录。普通用户在设置面板侧边栏的 **第三方订阅** 页,对 **OpenAI 订阅** 卡片点「登录」即可;无头 profile 或偏好终端时运行随包脚本:

```sh
node plugins/subhub/login.js
```

脚本会打印一个链接和一次性码,在浏览器打开链接、输入码后,把凭据写到 `~/.kino-dsh/openai-auth.json`(权限 0600)。隐私约束:插件只读写自己的凭据文件,不读取官方 Codex CLI 的 `~/.codex/auth.json` 或其它程序的认证文件;每位用户安装后都必须通过插件完成一次登录授权。

插件同时带客户端半边:登录 API 是宿主插件注册的 `webServer` 前缀路由(`/api/kino-subhub/*`,只接受本机同源请求;含 `status`/`start`/`poll`/`logout`),「第三方订阅」中心页 UI 是 `plugins/subhub/src/client.js`(手写模块加载器格式),由 `plugins/subhub/package.json` 的 `dsh.client` 声明,并随 `settings.section` 插槽挂进设置侧边栏。

**登录门控**:`ctx.llm` 上的 provider 路由只有凭据存在时才注册(登录成功即注册、退出登录即注销),因此「模型」页与模型选择器只显示已认证的服务;「模型」页通过 `llm/adapters-updated` 事件自动刷新。接入新订阅商(如 Anthropic、火山方舟)的约定:宿主插件提供自己的认证端点与凭据文件,客户端在中心页的 provider 数组里加一张卡片,复用同一个登录弹窗组件。

验证要点:

- 登录后启动 harness,在模型选择器里应能看到「OpenAI 订阅」提供商及其模型;退出登录后应消失;
- 登录 API 可用 curl 检查:`GET /api/kino-subhub/login/status` 应返回 `{ok:true,loggedIn:...}`,`POST /login/logout` 删除凭据并注销路由;
- 模型列表完全动态(在线仅显示账户 /models 接口返回的模型,离线才用内置备用列表);
- 鉴权文件权限应为 0600、不要提交进 git;token 不会打印到日志或终端,也不会经过登录 API 回传浏览器。

## 客户端半边:已知坑与验证(会话复盘沉淀)

- **两层 inject 方向不能反**(见上节):`dsh.client.inject` 填 npm 包名,`src/client.js` 的 `inject` 填 Cordis 服务名;填反任何一处,web 启动会停在"等待服务"报错页。
- **UI 文字跟随语言设置**:客户端用 `ctx.locale.register(ns, {zh, en})` 提供词典、`bind(ns)` 取翻译函数、`subscribe` 随语言切换重渲染;宿主侧的用户可见名称(如「模型」页目录里的提供商名)不能写死——从 `settings.get("locale")?.preference` 读语言偏好(未设置回落中文,与外壳一致),并监听 `settings/updated`(ns 为 `locale`)时用目录条目的 `replace()` 原子换名。模型 ID、档位名、简介等来自账户接口的元数据保持原样、不做翻译。
- **往外壳 React 树里注入内容**:外壳页面是构建产物的 React 树,不提供渲染接口;用 `MutationObserver`(childList+subtree,挂在 `document.body`)+ `queueMicrotask` 扫描目标行,用纯 DOM 构建节点。暖缓存同步渲染可以避免展开闪烁;重复扫描要幂等(挂载容器 `childNodes.length === 0` 才重建)。
- **外壳运行时不等于类型声明**:`useCopyFeedback` 只在类型声明里,运行时没有导出;实际可用的是 `writeClipboard`(以及 `Button`/`Modal`/`StateDot`/若干图标)。以运行时导出为准,先验证再解构。
- **Web UI 改动建议无头浏览器验证**:临时 `DSH_HOME` + 复制 profile 的 `package.json` 与 `pnpm-workspace.yaml` + `pnpm install --prefer-offline`,起 `dsh --profile web --port <新端口>`,用 Playwright chromium 驱动:跳过首次引导 → 设置 → 目标页面,断言文案与行为;结束后清理临时目录。

## 新增插件

1. 复制一个现有插件目录(`plugins/subhub/`)改名为 `<name>`;
2. 在根 `package.json` 的 `exports` 增加 `"./<name>": "./plugins/<name>/src/index.js"`;
3. 在根 `cordis.patch.yml` 追加一行 `{ id: kino-<name>, name: 'kino-dsh-plugins/<name>' }`;
4. 更新插件自己的 `README.md`,按上节验证。

## 分发(单一仓库直装)

```sh
dsh plugin --profile <name> add github:<you>/kino-ds-harness-plugin
```

想只启用部分插件:在自身 profile 的 `cordis.patch.yml` 中按 `id` 禁用对应行(用户层在所有 bundle 层之后应用、按 id 胜出)。
