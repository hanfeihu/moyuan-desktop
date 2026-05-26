# 墨渊 Desktop 发布计划

## 目标

墨渊 Desktop 要做到员工安装后开箱即用：桌面客户端启动时自动拉起本地 Runtime，Runtime 内置 Codex 执行能力，用户不需要再手动安装或启动 Codex CLI。公开仓库负责吸引开发者试用，企业部署时再通过后台或环境变量注入模型中转、组织架构和安全策略。

## 今晚必须完成

- Electron 主进程负责启动本地 `codex-runtime`，传入本机端口、一次性访问令牌、Runtime 数据目录和 Codex Home。
- Runtime 只监听 `127.0.0.1`，本地接口默认端口 `4101`，打包版使用一次性 token 防止网页直接调用本机命令执行接口。
- macOS 本地可生成 `.dmg` 和 `.zip`；Windows 通过 GitHub Actions 在 `windows-latest` 生成 `.exe` 和 `.zip`。
- GitHub Actions 支持手动触发，也支持推送 `v*.*.*` 标签后自动上传 Release。
- README 写清安装、开发、打包、发布和密钥配置方式，仓库内不提交任何真实密钥。

## 发布检查

- `npm run typecheck`
- `npm run build:release`
- `npm run dist:desktop:dir`
- macOS 本机验证 `apps/desktop/release/mac*/Moyuan Desktop.app` 可以打开，窗口能连上随包启动的 Runtime。
- GitHub Actions 验证 macOS 与 Windows artifact 均生成成功。

## 后续增强

- 增加企业后台下发配置，替代本地环境变量。
- 配置 Apple Developer ID、Notarization 和 Windows Authenticode 签名。
- 优化打包体积，把当前保守包含的依赖集合收敛为 Runtime 生产依赖。
- 增加首启设置页，帮助开源用户配置模型地址、API Key、工作区和员工身份。
