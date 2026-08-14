# AGENTS.md

本文件约束在此仓库工作的 AI 编程代理。面向人类的内容在 `README.md`、`docs/` 与 `plugins/*/README.md`;不要把 AI 专用规范写回 README。

## 仓库不变量(任何改动不得破坏)

- **唯一仓库 = 唯一可安装组合包**:根 `package.json` 声明 `dsh.bundle.patch`,根 `cordis.patch.yml` 是唯一补丁层。
- 不上 npm、不拆仓库、不为单个插件创建独立分发仓库。
- 纯 JavaScript、无构建步骤、无 `prepare` 脚本;插件源码直接位于 `plugins/<name>/src/index.js`。
- 插件如需 npm 依赖,只能加在**根** `package.json`(用户只安装根包,子目录依赖不生效)。
- 密钥、凭据、token 一律不进仓库文件;机密走环境变量或宿主侧配置。
- **凭据隐私边界**:插件只读写自己拥有的凭据文件(如 `~/.kino-dsh/<name>-auth.json`),不得读取、复用其它程序(如 codex CLI 的 `~/.codex/auth.json`)的认证文件;用户显式用配置指定文件路径的除外。安装插件不构成对既有登录的授权。

## 文件职责

- `README.md`、`docs/`、`plugins/*/README.md`:人类文档,用中文。
- `AGENTS.md`:本文件,AI 行为规范。
- 插件三件套:`plugins/<name>/src/index.js`(代码)+ `plugins/<name>/README.md`(说明);挂载点 = 根 `package.json` 的 `exports` 子路径 + 根 `cordis.patch.yml` 一行,行 id 统一 `kino-<name>`。
- 新增插件三步:1) 复制现有插件目录改名;2) 根 `exports` 加 `"./<name>"`;3) 根 `cordis.patch.yml` 追加一行。
- 客户端插件两层 inject 不可混用:`plugins/<name>/package.json` 的 `dsh.client.inject` 是客户端 npm **包**依赖边;`plugins/<name>/src/client.js` 导出的 `inject` 是模块实际读取的 Cordis **服务**名(只用 `ctx.slots` 就写 `["slots"]`)。

## 目录地图(按需读取,禁止全仓扫描)

开始工作前先读本文件;需要具体内容时按地图直达目标路径,用 read 工具读取,不要用 `glob`/`find` 枚举全树、不要 `cat` 整个仓库:

```
AGENTS.md                       AI 约束与本文地图(先读)
README.md                       人类:项目介绍与快速使用
docs/development.md             人类:开发循环、验证、新增插件、分发
package.json                    唯一清单:dsh.bundle.patch、exports 插件子路径、依赖
cordis.patch.yml                唯一补丁层:每个插件一行
index.js                        空入口,不放代码
plugins/README.md               插件目录约定
plugins/<name>/src/index.js     插件代码(export const name + export function apply)
plugins/<name>/README.md        插件说明与禁用方式
plugins/codex/src/index.js     插件代码
plugins/codex/src/device-flow.js 共享的 OpenAI 设备码登录流程
plugins/codex/src/client.js    客户端半边:设置面板的 Codex 登录页(手写模块加载器格式)
plugins/codex/package.json     codex 插件的 dsh.client 客户端声明与 ./client 出口
plugins/codex/login.js         独立登录脚本,node 直接运行
plugins/codex/README.md        插件说明与登录指南
```

按需读取的最小集:

- 改动某个插件:读该插件目录 + 根 `package.json` 的 `exports` + 根 `cordis.patch.yml`;
- 改动集合层(清单/补丁/依赖):读根 `package.json` 与 `cordis.patch.yml`;
- 改动文档:只读目标文档本身;
- 地图未覆盖到的新文件:先更新本目录地图,再读取。

## 提交规范(每次提交都必须遵守)

- Conventional Commits;**首行用简单英文**,祈使语气、≤72 字符,如 `feat(plugins): add kino-<name> plugin`。
- 需要解释时**正文中英对照**:先写英文一段,再写内容对应的中文一段;语言通俗,不用内部黑话和缩写。
- 常用 type:`feat`(新功能)、`fix`(修 bug)、`docs`(文档)、`refactor`(重构)、`chore`(杂项维护);破坏性变更用 `feat!` 或 `BREAKING CHANGE` footer。
- 提交前自检:`git status` 无意外文件、不含敏感信息、已跑下方验证清单。

## 验证清单(改动后至少执行)

- `node --check` 所有改动的 JS 文件;
- JSON/YAML 解析校验 `package.json` 与各 `cordis.patch.yml`;
- 改动客户端插件时,核对 `src/client.js` 导出的 `inject` 全是 Cordis 服务名、`plugins/<name>/package.json` 的 `dsh.client.inject` 是包名;
- 组装验证(把 `DSH_HOME` 指向临时目录,避免污染 `~/.dsh`):

  ```sh
  dsh --profile web --patch ./cordis.patch.yml --dump-config
  ```

  确认输出出现本仓库补丁层(`# == .../cordis.patch.yml`)与对应的插件行。

## 语言约定

- 人类文档:中文;
- commit:首行英文、正文中英对照;
- 代码标识符、命令、配置键:保持原样,不翻译。
