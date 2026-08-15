# kino-ds-harness-plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Kino 的 DeepSeek Harness 插件集合:**唯一仓库,即一个可安装的组合包(bundle)**,内含多个插件。仅通过本 GitHub 仓库直装使用;不上 npm、不拆仓库。

GitHub 仓库:https://github.com/kinoward/kino-ds-harness-plugin

## 快速开始

前提:已安装 `dsh` CLI(DeepSeek Harness 0.1 预览版)。

```sh
# 1. 安装(profile 名可自定,以下用 web 为例;首次会自动初始化 profile)
dsh plugin --profile web add github:kinoward/kino-ds-harness-plugin

# 2. 启动
dsh --profile web
```

1. 打开启动输出的网页地址,进入 **设置 → 第三方订阅**,在 **OpenAI 订阅** 卡片点「登录」,按提示在浏览器里输入一次性码完成授权(凭据只存你本机,插件不会读取其它程序的登录信息);
2. 在左下角 **选择模型** 里切到 **OpenAI 订阅**,挑一个模型即可开始对话。

界面文案自动跟随 DeepSeek Harness 的界面语言(中文 / English);模型列表、思考深度档位、上下文窗口与图片输入能力全部实时取自你的账户接口,无需手动配置。

## 插件清单

| 插件 | id | 挂载子路径 | 说明 |
| --- | --- | --- | --- |
| kino-subhub | `kino-subhub` | `kino-dsh-plugins/subhub` | 第三方订阅服务接入插件:提供设置侧边栏的「第三方订阅」中心页,统一管理订阅登录与凭据;当前已接入 **OpenAI 订阅**(ChatGPT OAuth),登录成功后以「OpenAI 订阅」提供商出现在「模型」页与模型选择器,后续订阅商在此扩展 |

## 安装与更新

要求:已安装 `dsh` CLI;使用随包脚本登录时需要 Node.js 18+。纯 JavaScript、无构建步骤,安装时无需授予构建权限。

```sh
dsh plugin --profile <name> add github:kinoward/kino-ds-harness-plugin
```

建议锁定到具体 commit,避免上游变动影响使用:

```sh
dsh plugin --profile <name> add github:kinoward/kino-ds-harness-plugin#<sha>
```

更新:再次执行上面的安装命令即可;锁定过 commit 的,把 `#<sha>` 替换为新 commit。

**只想要部分插件**:在自己 profile 的 `cordis.patch.yml` 中按 `id` 禁用对应行(用户层在所有 bundle 层之后应用、按 id 胜出):

```yaml
- id: kino-subhub
  name: 'kino-dsh-plugins/subhub'
  disabled: true
```

## 使用(kino-subhub)

1. **登录**:设置 → **第三方订阅** → **OpenAI 订阅** 卡片 → 点「登录」,在浏览器里打开链接并输入一次性码。每位用户安装后都需要完成一次登录授权;退出登录即删除凭据、提供商随之从「模型」页消失;切换账户直接重新登录覆盖。
2. **选择模型**:登录成功后「OpenAI 订阅」才出现在「模型」页与模型选择器里,选它即可;模型与思考深度在「模型」页的服务行里设置(展开卡片可查看当前账户的可用模型列表)。
3. **无头环境**:运行包内的 `plugins/subhub/login.js` 脚本登录(位于安装后的 `node_modules/kino-dsh-plugins/plugins/subhub/`),登录后重启或打开一次「第三方订阅」页即可注册。

完整说明见 [`plugins/subhub/README.md`](plugins/subhub/README.md)。

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

- 开发循环、验证清单、新增插件与分发:见 [`docs/development.md`](docs/development.md);
- 问题与反馈:到仓库的 [Issues](https://github.com/kinoward/kino-ds-harness-plugin/issues) 提出;
- AI 编程代理的约束(含提交规范):见 [`AGENTS.md`](AGENTS.md)。
