# kino-ds-harness-plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Kino 的 DeepSeek Harness 插件集合:**唯一仓库,即一个可安装的组合包(bundle)**,内含多个插件。仅通过本 GitHub 仓库直装使用;不上 npm、不拆仓库。

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
    └── <name>/           # 一个插件一个目录
        ├── src/index.js  # 插件代码:export const name + export function apply(ctx)
        └── README.md     # 功能与禁用说明
```

## 插件清单

- **kino-subhub**(`kino-dsh-plugins/subhub`):第三方订阅服务接入插件,提供设置侧边栏的「第三方订阅」中心页;当前接入 OpenAI 订阅(ChatGPT OAuth),登录成功后以「OpenAI 订阅」提供商出现在「模型」页与模型选择器里,后续订阅商在此扩展。

### Subhub 快速上手

1. 打开设置面板侧边栏的 **第三方订阅** 页,在 **OpenAI 订阅** 卡片点「登录」,按提示在浏览器里输入一次性码。每位用户安装后都需要完成一次登录授权——插件只使用自己保存的凭据,不会读取其它程序(如官方 Codex CLI)的登录信息。
2. 登录成功后「OpenAI 订阅」提供商才会出现在「模型」页与模型选择器里,选它即可使用;模型与思考深度在「模型」页的服务行里设置。详见 [`plugins/subhub/README.md`](plugins/subhub/README.md)。

## 快速使用

GitHub 仓库:https://github.com/kinoward/kino-ds-harness-plugin

```sh
# 安装整个集合(首次会自动初始化 profile)
dsh plugin --profile <name> add github:kinoward/kino-ds-harness-plugin
```

**只想要部分插件**:在自己 profile 的 `cordis.patch.yml` 中按 `id` 禁用对应行(用户层在所有 bundle 层之后应用、按 id 胜出):

```yaml
- id: kino-subhub
  name: 'kino-dsh-plugins/subhub'
  disabled: true
```

纯 JavaScript、无构建步骤,用户无需为 git 依赖授予构建权限;建议安装时锁定 commit(`github:kinoward/kino-ds-harness-plugin#<sha>`)。

## 许可

本仓库采用 [MIT License](LICENSE):学习、修改、商用均自由。唯一要求:以任何形式**分发**本软件(包括随商业产品分发、二次封装)时,必须保留版权声明与 MIT 许可文本——即商用分发时注明出处(引用说明)。个人或企业内部使用不附带此义务。

## 进一步阅读

- 开发循环、验证清单、新增插件与分发:见 [`docs/development.md`](docs/development.md);
- 问题与反馈:到仓库的 [Issues](https://github.com/kinoward/kino-ds-harness-plugin/issues) 提出;
- AI 编程代理的约束(含提交规范):见 [`AGENTS.md`](AGENTS.md)。
