# 墨渊 Desktop

墨渊 Desktop 是面向企业员工的本地 AI 工作台。它把 Codex-style 任务执行、文件修改、命令运行、会话续聊、企业可控审计和无感图片生成放进桌面客户端里，让员工安装后即可在自己的工作区完成真实工作。

企业私有化部署的双端系统：

- `apps/desktop`：员工桌面端，内置 Codex-style 工作区、任务执行、工具调用和人工确认体验。
- `apps/admin`：企业 Web 后台，使用 Ant Design Pro 风格管理组织、模型、密钥、审计、策略和连接器。
- `services/api`：企业控制面 API，保存企业配置、组织同步、审计、权限策略。
- `services/codex-runtime`：Codex runtime 包装层，接入 `@openai/codex`，并通过企业配置的中转地址和密钥调用模型。
- `packages/shared`：双端共用类型。

## 设计原则

员工端不是后台页面，而是优雅的桌面工作台。默认围绕“我今天要完成什么”组织界面，支持文件、任务、日报、会议纪要、工具调用和执行记录。

企业后台是控制中心。管理员可以配置模型中转地址、API Key、组织来源、工具权限、敏感策略、审计保留和部门额度。

Codex 能力作为 runtime 内置。桌面安装包会随包启动 `services/codex-runtime`，用户不需要单独启动 Codex Runtime。企业版通过后台配置模型中转、组织来源、工具权限、敏感策略和审计保留。

## 下载安装

公开发布后，到 GitHub Releases 下载：

- macOS：`Moyuan-Desktop-*-mac-*.dmg`
- Windows：`Moyuan-Desktop-*-win-*.exe`

安装包启动后会自动拉起本机 Runtime。Runtime 只监听 `127.0.0.1`，打包版使用一次性本地访问令牌保护命令执行接口。

首次体验可通过环境变量配置 OpenAI-compatible 中转：

```bash
AI_BASE_URL=https://your-model-gateway.example.com/v1
AI_API_KEY=your-key
AI_MODEL=gpt-5.5
IMAGE_BASE_URL=https://your-image-gateway.example.com/v1
IMAGE_API_KEY=your-image-key
IMAGE_MODEL=gpt-image-2
```

这些密钥不要提交到 Git。企业部署时建议由后台下发或写入本机安全配置。

## 本地开发

```bash
npm install
npm run dev:codex
npm run dev:desktop
```

常用服务：

```bash
npm run dev:admin
npm run dev:api
```

## 构建安装包

macOS 本机可直接构建：

```bash
npm run dist:desktop:mac
```

Windows 安装包由 GitHub Actions 在 Windows Runner 构建：

```bash
npm run dist:desktop:win
```

CI 支持手动触发，也支持推送版本标签自动发 Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```

产物会上传到 Actions Artifacts；标签发布时会同步到 GitHub Release。

## 验证清单

```bash
npm run typecheck
npm run build:release
npm run dist:desktop:dir
```

打包验证重点：

- 打开 `Moyuan Desktop.app` 后窗口能正常加载。
- Runtime 日志位于应用数据目录的 `logs/codex-runtime.log`。
- 会话历史、续聊、命令执行、图片生成都走同一个输入框。
- 仓库内不能出现真实 API Key、证书或私有部署密码。

## 发布签名

当前工作流可以生成未签名安装包，适合内部测试和开源预览。正式对外分发建议配置：

- macOS：Apple Developer ID、Notarization、`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
- Windows：Authenticode 证书、`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`

签名材料只放 GitHub Secrets，不写入仓库。
