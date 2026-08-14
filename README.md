# kino-ds-harness-plugin

Kino 的 DeepSeek Harness 插件仓库:**唯一仓库,即一个可安装的组合包(bundle)**,内含多个插件。仅通过本 GitHub 仓库直装使用;不上 npm、不拆仓库、不另建分发仓库。

## 目录结构

```
kino-ds-harness-plugin/
├── package.json          # 唯一清单:依赖 + exports 全部插件子路径 + dsh.bundle.patch
├── cordis.patch.yml      # 唯一补丁层:每个插件一行
├── index.js              # 空入口(插件行全部走子路径)
├── plugins/
│   ├── README.md         # 插件目录约定与新增三步
│   └── <name>/           # 一个插件一个目录
│       ├── src/index.js  # 插件代码:export const name + export function apply(ctx)
│       └── README.md     # 功能与禁用说明
└── README.md
```

## 使用方式(单一仓库直装)

```sh
# 安装整个集合(首次会自动初始化 profile)
dsh plugin --profile <name> add github:<you>/kino-ds-harness-plugin
```

**只想要部分插件**:在自己 profile 的 `cordis.patch.yml` 中按 `id` 覆盖对应行(用户层在所有 bundle 层之后应用、按 id 胜出):

```yaml
# 例如禁用 hello 插件
- id: kino-hello
  name: 'kino-dsh-plugins/hello'
  disabled: true
```

纯 JavaScript、无构建步骤,用户无需为 git 依赖授予构建权限;建议安装时锁定 commit(`github:<you>/kino-ds-harness-plugin#<sha>`)。

## 本机开发循环(npx 即可)

```sh
# 1. 本地链接安装进演示 profile
dsh plugin --profile demo add ./

# 2. 验证集合层被组装(应出现 # == kino-dsh-plugins 层与各插件行)
dsh --profile demo --dump-config

# 3. 真实运行(加载成功会打印 [kino-hello] plugin loaded!)
dsh --profile demo
```

## 新增插件

见 `plugins/README.md` 的三步流程。插件如需 npm 依赖,声明在**根** `package.json`(只有根包会被安装);更完整的能力(Tool/Service/事件钩子)参照官方文档「开发」章节。

## Git 约定

- 提交信息采用 Conventional Commits,例如 `feat(plugins): add kino-<name> plugin`。
- 组合文件中不得写入密钥、凭据;机密一律走环境变量或宿主侧配置。
- 推送远端前检查 `git status`。
