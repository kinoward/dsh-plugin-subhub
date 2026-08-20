# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.8.1] - 2026-08-21

The subscription hub now covers more providers end to end: xAI / Grok (already shipped since v1.0.x, hardened with catalog-driven wire protocol and reasoning levels), GitHub Copilot, Claude, Gemini, and Kimi Code subscriptions, plus the Volcengine Ark Coding Plan via a pasted plan key. MiniMax, Alibaba Cloud Bailian, and OpenRouter were integrated and then dropped again because DeepSeek Harness already ships them as built-in API-key routes on its Models page. Model lists and reasoning levels stay fully dynamic from each account's catalog.

### Added

- `e3bb57e` `feat(subhub)`: Reusable pi-ai-backed core for subscription providers: credential store, browser login API, and adapter bridge.
- `0c3360c` `feat(subhub)`: xAI Grok subscription card and live model catalog in the subscriptions hub.
- `6233450` `feat(subhub)`: Per-model reasoning levels driven by the account catalog.
- `7ce365c` `feat(subhub)`: GitHub Copilot subscription provider with device-code sign-in.
- `abed63b` `feat(subhub)`: Claude subscription provider with loopback OAuth sign-in.
- `10cf45b` `feat(subhub)`: Gemini subscription provider with loopback OAuth and token refresh.
- `a5c69fc` `feat(subhub)`: Kimi Code subscription provider.
- `5c44d0c` `feat(subhub)`: Volcengine Ark Coding Plan provider with a pasted plan key.

### Fixed

- `9fdd76f` `fix(subhub)`: Demo GIF capture feeds frames to ffmpeg by glob.
- `7882fbe` `fix(subhub)`: Shared login and catalog copy no longer hardcodes ChatGPT.
- `f5232d8` `fix(subhub)`: Grok proxy fingerprint headers sent; catalog-declared wire backend honored.
- `620d8b1` `fix(subhub)`: Assistant history carries zero usage and a correct stop reason.
- `8e5ba7a` `fix(subhub)`: Tool-result images echoed into the assistant message.
- `c183659` `fix(subhub)`: Latest conversation image found across tool results and echoes.
- `3d969f3` `fix(subhub)`: Reasoning levels ordered low to high as declared.
- `bb786e9` `fix(subhub)`: Custom provider models completed with the wire fields pi-ai requires.

### Changed

- `d1660e8` `docs(subhub)`: awesome-dsh-plugin badge added.
- `1f4ff8c` `docs(subhub)`: README badges reorganized and star count added.
- `b24a81f` `docs(subhub)`: Stars badge moved to the top badge row.
- `860b4c9` `docs(subhub)`: Release and dsh score badges added.
- `e2aa53e` `docs(subhub)`: dsh score badge removed until top-200.
- `7e16be5` `chore`: WeChat share images added.
- `92d578d` `docs(agents)`: Share images added to the directory map.
- `4435318` `chore(subhub)`: pi-ai dependency added and Node floor raised to 22.19.
- `aaae883` `docs(subhub)`: xAI subscription support and Node 22.19 documented.
- `4cb7a2b` `docs(subhub)`: Integration rules codified for all future subscription providers.
- `f05f4b2` `docs(subhub)`: xAI integration lessons distilled into provider guidelines.
- `2da74d2` `docs(subhub)`: Push-protection rule for OAuth secrets recorded.
- `9f8293b` `refactor(subhub)`: Providers already built into the harness dropped (MiniMax, Bailian, OpenRouter).

## [v1.0.0] - 2026-08-16

First public release. dsh-plugin-subhub brings third-party subscription accounts into DeepSeek Harness. Currently integrated: OpenAI / ChatGPT subscriptions; more subscription services are planned.

### Added

- `8028272` `feat(plugins)`: Subscription LLM adapter: chat models served through the subscription account.
- `b065b2a` `feat(plugins)`: Third-party subscriptions hub in Settings, with sign-in gating.
- `b28db3b` `feat(plugins)`: Browser sign-in UI for subscription providers.
- `2c761a9` `feat(plugins)`: Model list fetched purely from the account API.
- `28fd110` `feat(plugins)`: Internal models filtered out; context windows read from the API.
- `264b96f` `feat(plugins)`: Reasoning levels driven by the model API.
- `0dde7dd` `feat(plugins)`: Proactive delegation in the top reasoning level.
- `eae2aff` `feat(plugins)`: Redesigned subscription hub interface.
- `60ca642` `feat(plugins)`: Provider logos on hub cards.
- `52b5b33` `feat(plugins)`: Read-only model catalog on the Models card.
- `1a480fb` `feat(plugins)`: Interface language follows the harness language setting.
- `9502733` `feat(subhub)`: In-conversation image generation and editing.
- `593012e` `feat(subhub)`: generate_image tool for the ChatGPT backend.
- `6c6762b` `feat(subhub)`: Image-to-image edits in generate_image.
- `1fd5e05` `feat(subhub)`: Warning when a preset-default subagent model is unavailable.

### Fixed

- `6736b9f` `fix(plugins)`: Never reuse other programs' credential files.
- `dc7f66d` `fix(plugins)`: Provider stays hidden on the Models page until sign-in.
- `1107c55` `fix(plugins)`: Top reasoning level mapped to the backend maximum on the wire.
- `f9fca78` `fix(plugins)`: Image input supported in the subscription adapter.
- `f61798a` `fix(plugins)`: Login dialog no longer crashes the settings section.
- `481e99e` `fix(plugins)`: Unique provider id avoids directory conflicts with built-ins.
- `f6ab028` `fix(plugins)`: Provider names follow the harness UI language.
- `0c64811` `fix(subhub)`: Tool-result images carried into chat requests.
- `78c4dbd` `fix(subhub)`: Image output harvested from terminal events with diagnostics.
- `02f11f1` `fix(subhub)`: Tool-result images echoed into the assistant message.
- `636abfb` `fix(subhub)`: Image credentials sent only to OpenAI-owned hosts.
- `ab994e0` `fix(subhub)`: Model catalog cache keyed to the credential identity.
- `e03c816` `fix(subhub)`: Credential persistence and refresh locking hardened.
- `767ed91` `fix(subhub)`: Device login flow made more robust.
- `ef95cad` `fix(subhub)`: Empty SSE payloads skipped.
- `dfc5e84` `fix(subhub)`: Localhost-only errors explained; row names derived from dictionaries.
- `b112827` `fix(subhub)`: Delegation result collection at every reasoning level.

### Changed

- `a69e4a0` `refactor!`: Bundle renamed to dsh-plugin-subhub with a flat layout (breaking, pre-release).
- `1a9acd9` `refactor(plugins)`: Plugin renamed from codex to subhub.
- `9ccea20` `chore`: Node 18.17+ required.
- `a707c9d` `chore`: Repository prepared for public distribution.
- `8f3ba7d` `chore`: MIT license added.
- `eeec6b4` `docs`: Installed script path, Node floor, and local-only API documented.
- `53f0cca` `docs(subhub)`: Wording generalized away from OpenAI branding.
- `99124d3` `docs(subhub)`: dsh-recommend certified badge added.

[v1.8.1]: https://github.com/kinoward/dsh-plugin-subhub/releases/tag/v1.8.1
[v1.0.0]: https://github.com/kinoward/dsh-plugin-subhub/releases/tag/v1.0.0
