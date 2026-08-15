# kino-ds-harness-plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Kino 的 DeepSeek Harness 插件集合:**唯一仓库,即一个可安装的组合包(bundle)**,内含多个插件。仅通过本 GitHub 仓库直装使用;不上 npm、不拆仓库。

GitHub 仓库:https://github.com/kinoward/kino-ds-harness-plugin

## 快速开始

前提:已安装 `dsh` CLI(DeepSeek Harness 0.1 预览版)。

```sh
# 安装:`--profile` 为必填参数,名字任意;用 web 时可直接 `dsh web` 启动
# (一律锁定到具体 commit,保证版本可复现、不受上游变动影响;首次会自动初始化 profile)
dsh plugin --profile web add github:kinoward/kino-ds-harness-plugin#<sha>

# 启动(profile 名为 web 时也可直接 dsh web)
dsh --profile web
```

启动后,按下方**插件清单**进入各插件的 README,完成其中的一次性初始化(如 kino-subhub 只需一次登录授权),即可在模型选择器里使用对应插件提供的模型。

## 插件清单

| 插件 | 挂载子路径 | 说明 |
| --- | --- | --- |
| [**kino-subhub**](plugins/subhub/README.md) | `kino-dsh-plugins/subhub` | 第三方订阅服务接入:提供设置侧边栏的「第三方订阅」中心页,统一管理订阅登录与凭据;当前接入 OpenAI 订阅(ChatGPT OAuth),登录后作为「OpenAI 订阅」提供商出现在「模型」页与模型选择器 |

## 安装与更新

要求:已安装 `dsh` CLI;使用随包脚本登录时需要 Node.js 18+。纯 JavaScript、无构建步骤,安装时无需授予构建权限。

```sh
# 安装(`--profile <name>` 必填、名字任意;锁定到具体 commit,`<sha>` 取仓库提交记录里的任一 commit)
dsh plugin --profile <name> add github:kinoward/kino-ds-harness-plugin#<sha>
```

更新:把 `#<sha>` 换成新 commit,再执行一次上面的命令。

安装后,可在界面 **设置 → 插件 → 插件列表** 里按行启用/停用插件;命令行方式则是按上例在 profile 的 `cordis.patch.yml` 中禁用对应行。

**只想要部分插件**:在自己 profile 的 `cordis.patch.yml` 中按 `id` 禁用对应行(用户层在所有 bundle 层之后应用、按 id 胜出):

```yaml
- id: kino-subhub
  name: 'kino-dsh-plugins/subhub'
  disabled: true
```

## 许可

本仓库采用 [MIT License](LICENSE):学习、修改、商用均自由。唯一要求:以任何形式**分发**本软件(包括随商业产品分发、二次封装)时,必须保留版权声明与 MIT 许可文本——即商用分发时注明出处(引用说明)。个人或企业内部使用不附带此义务。

## 目录结构

```
kino-ds-harness-plugin/
├── AGENTS.md             # AI 编程代理的行为规范
├── README.md             # 本文:项目介绍与快速使用
├── LICENSE               # MIT 许可文本
├── docs/
│   └── development.md    # 开发、验证、分发指南
├── package.json          # 唯一清单:依赖 + exports 插件子路径 + dsh.bundle.patch
├── cordis.patch.yml      # 唯一补丁层:每个插件一行
├── index.js              # 空入口(插件行全部走子路径)
└── plugins/
    ├── README.md         # 插件目录约定与新增三步
    └── subhub/           # kino-subhub 插件(src、login.js、README)
```

## 进一步阅读

- 各插件的功能与使用:见「插件清单」中的链接;
- 开发循环、验证清单、新增插件与分发:见 [`docs/development.md`](docs/development.md);
- 问题与反馈:到仓库的 [Issues](https://github.com/kinoward/kino-ds-harness-plugin/issues) 提出;
- AI 编程代理的约束(含提交规范):见 [`AGENTS.md`](AGENTS.md)。
