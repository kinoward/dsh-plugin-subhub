<p align="center">
  <img src="assets/hero-zh.svg" width="100%" alt="dsh-plugin-subhub — 在 DeepSeek Harness 中使用第三方订阅账户" />
</p>

<h1 align="center">Dsh Plugin Subhub</h1>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome DSH Plugin" /></a>
  <a href="https://github.com/zp-home/dsh-recommend"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2Fkinoward__dsh-plugin-subhub.certified.json" alt="dsh-recommend · 精选认证" /></a>
  <a href="https://github.com/kinoward/dsh-plugin-subhub/stargazers"><img src="https://img.shields.io/github/stars/kinoward/dsh-plugin-subhub" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D18.17-339933?logo=nodedotjs&logoColor=white" alt="Node.js >= 18.17" /></a>
  <img src="https://img.shields.io/badge/DSH-Web%20profile-5B4CF0" alt="DSH Web profile" />
</p>

把**第三方订阅账户**接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，使用订阅覆盖的模型进行对话：文字对话、图片理解、图片生成与图片编辑。

**目前仅支持 OpenAI（ChatGPT）订阅，更多订阅服务规划中。**

> 可用模型、使用额度和响应速度由订阅服务商及你的账户决定。服务商调整服务后，部分功能可能暂时不可用。

## 安装

- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`），Node.js 18.17 或更高版本。

```sh
dsh plugin --profile web add github:kinoward/dsh-plugin-subhub
dsh web
```

`dsh web` 即启动 `web` profile（等同 `dsh --profile web`）。安装完成后请重新启动 DeepSeek Harness。

## 快速开始

1. **登录** —— 打开 **设置 → 第三方订阅**，在 **OpenAI 订阅** 卡片上点击「登录」，在浏览器中打开授权链接并输入一次性码（码 15 分钟内有效）。完成授权后页面会自动同步，订阅随即出现在模型选择器中。
2. **选择模型** —— 点击输入框左下角的模型选择器（显示当前模型与推理等级），点「模型」，在 **OpenAI 订阅** 分组下选择想用的模型；需要时可在同一菜单中调整推理等级。可用模型与推理等级随账户自动同步显示。
3. **使用图片** —— 上传图片并提问、描述画面生成图片，或要求编辑图片：

   - 查看：*“这张图片里有什么？”* / *“帮我提取图片中的文字。”*
   - 生成：*“生成一张雨夜霓虹街道的电影感插画。”*
   - 编辑：先上传图片（或使用刚生成的图片），然后说 *“把天空改成晚霞，其他内容保持不变。”* 编辑会使用当前对话中最近的一张图片；没有图片时，请先上传一张。

   图片理解、生成与编辑都需要支持图片输入的模型，模型信息中会标明（「支持图片」标签）。

### 账户管理

- **重新登录 / 退出登录** —— 打开 **设置 → 第三方订阅**：「重新登录」可更换账户；「退出登录」会删除本插件保存的登录信息。
- **更新插件** —— 再次执行安装命令，然后重新启动 DeepSeek Harness。
- **停用插件** —— 打开 **设置 → 插件 → 插件列表**，停用 `dsh-plugin-subhub`。

## 命令行登录（可选）

没有图形界面时，可以使用随包登录脚本完成登录。先进入所用 profile 的目录，再运行：

```sh
node node_modules/dsh-plugin-subhub/login.js
```

脚本会打印授权链接和一次性码：在浏览器打开链接、输入码后，凭据会写入 `~/.dsh-plugin-subhub/openai-auth.json`。登录完成后，打开一次 **设置 → 第三方订阅**，订阅即可出现在模型选择器中。

## 界面预览

以下为 DeepSeek Harness Web 界面内插件的浏览器窗口截图，浅色与深色主题：

**设置 → 第三方订阅（未登录）**：

<p align="center">
  <img src="assets/settings-loggedout-zh-light.png" width="46%" alt="第三方订阅设置页（未登录，浅色）" />
  <img src="assets/settings-loggedout-zh-dark.png" width="46%" alt="第三方订阅设置页（未登录，深色）" />
</p>

**设置 → 第三方订阅（已登录）**：

<p align="center">
  <img src="assets/settings-loggedin-zh-light.png" width="46%" alt="第三方订阅设置页（已登录，浅色）" />
  <img src="assets/settings-loggedin-zh-dark.png" width="46%" alt="第三方订阅设置页（已登录，深色）" />
</p>

**「模型」页展开的 OpenAI 订阅（已登录）**：

<p align="center">
  <img src="assets/models-zh-light.png" width="46%" alt="模型页 — OpenAI 订阅展开（浅色）" />
  <img src="assets/models-zh-dark.png" width="46%" alt="模型页 — OpenAI 订阅展开（深色）" />
</p>

**对话中使用图片（图片理解）**：

<p align="center">
  <img src="assets/chat-image-zh-light.png" width="46%" alt="对话中使用图片（浅色）" />
  <img src="assets/chat-image-zh-dark.png" width="46%" alt="对话中使用图片（深色）" />
</p>

**对话中生成图片（文生图）**：

<p align="center">
  <img src="assets/chat-generate-zh-light.png" width="46%" alt="对话中生成图片（浅色）" />
  <img src="assets/chat-generate-zh-dark.png" width="46%" alt="对话中生成图片（深色）" />
</p>

**对话中编辑图片（图生图）**：

<p align="center">
  <img src="assets/chat-edit-zh-light.png" width="46%" alt="对话中编辑图片（浅色）" />
  <img src="assets/chat-edit-zh-dark.png" width="46%" alt="对话中编辑图片（深色）" />
</p>

## 安全与隐私

- 未自定义保存位置时，登录信息保存在 `~/.dsh-plugin-subhub/openai-auth.json`；
- 插件创建或更新该文件时，会将访问权限限制为仅当前系统用户可读写；
- 插件不会读取 Codex CLI 或其他程序保存的登录信息，安装后需要在本插件中单独登录一次；
- 退出登录会删除本插件当前使用的登录文件；
- 不要分享登录文件、一次性码或其他账户信息，也不要把它们提交到 Git 或 Issue。

## 支持

- [GitHub Issues](https://github.com/kinoward/dsh-plugin-subhub/issues) —— 报告问题或提出建议，发送前请删除账户信息和其他敏感内容。

## 许可

[MIT License](LICENSE)