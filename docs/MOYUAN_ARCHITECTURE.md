# 墨渊架构原则

墨渊的核心是 Codex。桌面端不做业务关键词规则，所有用户请求先进入 Codex 任务；图片、视频、搜索、企业知识库、组织架构、文件系统、命令行等外部能力都作为 Skill 提供给 Codex 决策调用。

## 分层

- `apps/desktop`: 员工桌面客户端，只负责登录、会话、流式渲染、附件/工作区上下文和本地 Runtime 启停。
- `apps/admin`: 企业后台，负责模型、技能、员工、额度、审计、安全策略配置。
- `services/codex-runtime`: 本地 Codex 内核适配层，负责会话续聊、上下文拼装、Codex app-server/exec、工具调用和本地文件结果托管。
- `services/api`: 企业控制面服务，负责账号、额度、后台配置、技能密钥托管和需要服务端代理的第三方能力。
- `packages/shared`: 两端共享的数据类型，避免接口结构散落在 UI 和服务代码里。

## 技能模型

每个技能都应该拆成四段：

1. Admin Config: 后台配置 Key、开关、默认参数、额度和权限。
2. Skill Manifest: Runtime 拉取到的可用能力说明，不包含明文密钥。
3. Tool Contract: 注入给 Codex 的工具说明和 JSON 调用格式。
4. Executor: Runtime 或企业 API 负责真正执行，返回流式状态和结果。

当前第一版已经把图片、火山方舟视频接入到 `moyuan_tool` 契约里：

- `image_generation`: 本地 Runtime 直接调用图片生成接口。
- `video_generation`: Runtime 通过企业 API 代理调用火山方舟 `POST /contents/generations/tasks`，再轮询任务结果。

## 插件编排原则

插件和技能不是一回事。技能负责执行能力，插件负责让员工补充表单、上传素材或配置参数，然后把结果交回 Codex 继续编排。

不要在桌面端或 Runtime 里写死“某个业务关键词必须触发某个插件”的规则。插件触发应该由后台下发的插件定义驱动，包括插件说明、触发词、表单字段、权限和后续要补充的目标技能。Runtime 可以做通用安全桥接，例如识别“Codex 请求插件输入”并生成 `plugin.inputRequested` 事件，但不应该把“生成视频”“写日报”“查知识库”这类业务策略硬编码到代码分支里。

如果某个技能调用前需要员工补充输入，正确做法是在后台插件配置里描述清楚，并在 `services/codex-runtime/src/skills/contracts.ts` 的通用技能契约中告诉 Codex：当用户需求命中插件说明、触发词或表单字段时，先请求插件表单；员工提交后再调用技能。Runtime 的强制拦截也必须由插件 manifest 声明，例如 `targetTools` 和 `triggerPolicy: before_tool`，不能在 Runtime 中写固定插件 ID 或业务关键词。

## 目录演进

Runtime 已经先拆出第一层技能边界：

- `services/codex-runtime/src/config.ts`: 模型、图片接口和企业后台地址配置。
- `services/codex-runtime/src/enterprise/client.ts`: 企业后台 bootstrap、额度校验和技能代理调用。
- `services/codex-runtime/src/skills/contracts.ts`: 注入给 Codex 的技能契约和工具调用解析。
- `services/codex-runtime/src/skills/executor.ts`: 标准 `moyuan_tool` 执行入口。
- `services/codex-runtime/src/skills/image.ts`: 图片生成适配器。
- `services/codex-runtime/src/skills/video.ts`: 视频生成适配器。
- `services/codex-runtime/src/tasks/types.ts`: Runtime 任务记录类型。

Runtime 后续继续拆成：

- `services/codex-runtime/src/codex`: Codex app-server/exec 适配。
- `services/codex-runtime/src/context`: 工作区记忆、diff、命令历史、transcript。
- `services/codex-runtime/src/storage`: 本地任务和结果存储。

Desktop 后续继续拆成：

- `apps/desktop/src/components`: 纯 UI 组件，如 `TokenMeter`、`Composer`、`Transcript`。
- `apps/desktop/src/features/auth`: 注册登录。
- `apps/desktop/src/features/chat`: 会话、流式事件、消息渲染。
- `apps/desktop/src/features/runtime`: Runtime 健康检查和任务提交。

原则：新增能力先加 Skill，不改聊天入口规则；新增页面先拆 feature，不堆进一个大文件。
