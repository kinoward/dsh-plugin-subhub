# kino-dsh-hello

示例插件,用于验证"组合包开发 → 安装 → 加载"全链路。加载成功时终端打印 `[kino-hello] plugin loaded!`。

## 挂载方式

由仓库根 `cordis.patch.yml` 以子路径 `kino-dsh-plugins/hello` 挂载(与根 `package.json` 的 `exports` 对应)。

## 用户禁用本插件

用户在自己 profile 的 `cordis.patch.yml` 中写:

```yaml
- id: kino-hello
  name: 'kino-dsh-plugins/hello'
  disabled: true
```
