# plugins/

插件目录,一个子目录对应一个插件。所有插件以源码形式直接挂在仓库根这个集合包里,不做独立打包、不拆分仓库。

```
plugins/<name>/
├── src/index.js   # 插件代码:export const name + export function apply(ctx)
└── README.md      # 功能说明与禁用方式
```

## 新增插件三步

1. 复制一个现有插件目录改名为 `<name>`;
2. 在仓库根 `package.json` 的 `exports` 增加 `"./<name>": "./plugins/<name>/src/index.js"`;
3. 在仓库根 `cordis.patch.yml` 追加一行 `{ id: kino-<name>, name: 'kino-dsh-plugins/<name>' }`。

## 约定

- 插件如需 npm 依赖,声明在根 `package.json`(用户只安装根包,子目录依赖不会生效)。
- 插件级开关由用户负责:他们可以在自己 profile 的 `cordis.patch.yml` 中按 `id` 禁用某行(用户层在所有 bundle 层之后应用、按 id 胜出)。
- 插件行 id 全局唯一,命名统一 `kino-<name>`。
