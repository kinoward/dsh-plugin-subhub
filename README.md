# kino-ds-harness-plugin

Kino 的 DeepSeek Harness 插件集合:**唯一仓库,即一个可安装的组合包(bundle)**,内含多个插件。仅通过本 GitHub 仓库直装使用;不上 npm、不拆仓库。

## 目录结构

```
kino-ds-harness-plugin/
├── AGENTS.md             # AI 编程代理的行为规范
├── README.md             # 本文:项目介绍与快速使用
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

- **kino-hello**(`kino-dsh-plugins/hello`):示例插件,验证"组合包开发 → 安装 → 加载"全链路。
- **kino-codex**(`kino-dsh-plugins/codex`):用 Codex 订阅账户(ChatGPT OAuth)调用 GPT 模型的 LLM 适配器,在模型选择器里以 Codex 提供商出现。

### Codex 快速上手

1. 打开设置面板的 **Codex** 分区,点「使用 ChatGPT 账号登录」,按页面提示在浏览器里输入一次性码即可(已装 codex CLI 并登录过的用户可跳过这一步)。
2. 登录后在模型选择器里选 Codex 提供商即可使用。详见 [`plugins/codex/README.md`](plugins/codex/README.md)。

## 快速使用

```sh
# 安装整个集合(首次会自动初始化 profile)
dsh plugin --profile <name> add github:<you>/kino-ds-harness-plugin
```

**只想要部分插件**:在自己 profile 的 `cordis.patch.yml` 中按 `id` 禁用对应行(用户层在所有 bundle 层之后应用、按 id 胜出):

```yaml
- id: kino-hello
  name: 'kino-dsh-plugins/hello'
  disabled: true
```

纯 JavaScript、无构建步骤,用户无需为 git 依赖授予构建权限;建议安装时锁定 commit(`github:<you>/kino-ds-harness-plugin#<sha>`)。

## 进一步阅读

- 开发循环、验证清单、新增插件与分发:见 [`docs/development.md`](docs/development.md);
- AI 编程代理的约束(含提交规范):见 [`AGENTS.md`](AGENTS.md)。
