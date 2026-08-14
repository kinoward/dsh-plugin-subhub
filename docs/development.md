# 开发指南

本文面向人类开发者,介绍本仓库的开发与验证方式。AI 编程代理的行为约束见根目录 [`AGENTS.md`](../AGENTS.md)。

## 环境

- 已安装的 `dsh` CLI(npx 启动的部署即可);
- 不需要构建工具链:仓库是纯 JavaScript,无编译步骤。

## 本机开发循环

```sh
# 1. 本地链接安装进演示 profile(首次自动初始化 profile)
dsh plugin --profile demo add ./

# 2. 验证集合层被组装(应出现 # == kino-dsh-plugins 层与各插件行)
dsh --profile demo --dump-config

# 3. 真实运行(加载成功会打印 [kino-hello] plugin loaded!)
dsh --profile demo
```

## 验证

改动后至少执行:

- `node --check` 所有改动的 JS 文件;
- JSON/YAML 解析校验 `package.json` 与各 `cordis.patch.yml`;
- 组装验证(把 `DSH_HOME` 指向临时目录,避免污染 `~/.dsh`):

  ```sh
  dsh --profile web --patch ./cordis.patch.yml --dump-config
  ```

## codex 插件:登录与验证

`kino-codex` 用 Codex 订阅账户调用 GPT 模型,需要先登录。普通用户在 web 设置面板的 **Codex** 分区点「使用 ChatGPT 账号登录」即可(页面展示链接与一次性码、自动完成);无头 profile 或偏好终端时运行随包脚本:

```sh
node plugins/codex/login.js
```

脚本会打印一个链接和一次性码,在浏览器打开链接、输入码后,默认把凭据写到 `~/.kino-dsh/codex-auth.json`(权限 0600)。已用官方 codex CLI 登录过的,插件会直接读 `~/.codex/auth.json`,无需再登录。

插件同时带客户端半边:登录 API 是宿主插件注册的 `webServer` 前缀路由(`/api/kino-codex/*`,只接受本机同源请求),设置页 UI 是 `plugins/codex/src/client.js`(手写模块加载器格式),由 `plugins/codex/package.json` 的 `dsh.client` 声明并随 `settings.section` 插槽挂进设置面板。

验证要点:

- 登录后启动 harness,在模型选择器里应能看到 Codex 提供商及其模型;
- 登录 API 可用 curl 检查:`GET /api/kino-codex/login/status` 应返回 `{ok:true,loggedIn:...}`;
- 若模型列表接口不可用,会回退到静态备用模型(gpt-5.6-sol、gpt-5.6-terra、gpt-5.5、gpt-5.4、gpt-5.3-codex-spark);
- 鉴权文件权限应为 0600、不要提交进 git;token 不会打印到日志或终端,也不会经过登录 API 回传浏览器。

## 新增插件

1. 复制一个现有插件目录(`plugins/hello/`)改名为 `<name>`;
2. 在根 `package.json` 的 `exports` 增加 `"./<name>": "./plugins/<name>/src/index.js"`;
3. 在根 `cordis.patch.yml` 追加一行 `{ id: kino-<name>, name: 'kino-dsh-plugins/<name>' }`;
4. 更新插件自己的 `README.md`,按上节验证。

## 分发(单一仓库直装)

```sh
dsh plugin --profile <name> add github:<you>/kino-ds-harness-plugin
```

想只启用部分插件:在自身 profile 的 `cordis.patch.yml` 中按 `id` 禁用对应行(用户层在所有 bundle 层之后应用、按 id 胜出)。
