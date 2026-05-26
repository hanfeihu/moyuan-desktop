# 企业 AI 工作台

企业私有化部署的双端系统：

- `apps/desktop`：员工桌面端，内置 Codex-style 工作区、任务执行、工具调用和人工确认体验。
- `apps/admin`：企业 Web 后台，使用 Ant Design Pro 风格管理组织、模型、密钥、审计、策略和连接器。
- `services/api`：企业控制面 API，保存企业配置、组织同步、审计、权限策略。
- `services/codex-runtime`：Codex runtime 包装层，接入 `@openai/codex`，并通过企业配置的中转地址和密钥调用模型。
- `packages/shared`：双端共用类型。

## 设计原则

员工端不是后台页面，而是优雅的桌面工作台。默认围绕“我今天要完成什么”组织界面，支持文件、任务、日报、会议纪要、工具调用和执行记录。

企业后台是控制中心。管理员可以配置模型中转地址、API Key、组织来源、工具权限、敏感策略、审计保留和部门额度。

Codex 能力作为 runtime 内置。当前第一步通过 `@openai/codex` 包和服务封装接入，后续可以把更多 Codex CLI 的 sandbox、approval、tool-call transcript 逻辑内聚到 runtime 服务里。

## 本地开发

```bash
npm install
npm run dev:admin
npm run dev:desktop
npm run dev:api
npm run dev:codex
```

密钥放在环境变量或后台配置里，不提交到 Git：

```bash
AI_BASE_URL=https://ai.blector.com/v1
AI_API_KEY=your-key
```
