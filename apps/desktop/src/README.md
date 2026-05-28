# Moyuan Desktop 模块说明

桌面端按功能拆分，后续多人或多个 AI 协作时按模块认领，避免都去改 `main.tsx`。

## 目录边界

- `main.tsx`：应用入口，只负责字体、全局样式、错误边界和 React 挂载。
- `app/`：应用级编排。
  - `DesktopApp.tsx`：把认证、任务、布局组合成完整客户端。
  - `errors.tsx`：启动异常兜底和错误边界，避免白屏。
- `features/auth/`：登录、注册、验证码、当前用户刷新。
- `features/chat/`：输入框、对话流、Markdown、图片视频结果、工具输出。
- `features/layout/`：侧边栏、顶栏、账号和运行状态展示。
- `features/runtime/`：Runtime 相关类型，后续 Runtime 健康检查和事件流可以继续下沉到这里。
- `features/tasks/`：任务初始值、任务提交、停止、续聊、SSE、轮询和额度提示。
- `ui/`：可复用小组件，例如 Token 额度展示。
- `utils/`：纯函数工具，例如数字和时间格式化。
- `api.ts`：企业后台和本地 Runtime 请求封装。
- `config.ts`：启动参数、环境变量和本地默认配置。
- `tasks.ts`：任务、事件、transcript 合并和去重逻辑。
- `styles.css`：当前仍为全局样式；后续可以按模块继续拆 CSS。

## 协作规则

1. 改登录注册，只动 `features/auth`，必要时改 `api.ts`。
2. 改输入框、流式渲染、Markdown、图片视频展示，只动 `features/chat`。
3. 改侧边栏、顶部栏、Token 额度视觉，只动 `features/layout` 或 `ui`。
4. 改任务续聊、事件合并、重复输出、错误文案，优先看 `tasks.ts`。
5. 改 Runtime 请求地址、请求头、token，只动 `api.ts` 和 `config.ts`。
6. 新增复杂业务时先建 feature 目录，不要把逻辑重新塞回 `main.tsx`。
7. 每次修改桌面端至少跑 `npm run typecheck -w @eaw/desktop` 和 `npm run build -w @eaw/desktop`。

## 后续可继续优化

- 把 `styles.css` 按 `auth.css`、`chat.css`、`layout.css` 拆分，保留一个入口样式文件统一 import。
- 把 Runtime 健康检查和事件流的请求细节从 `features/tasks/useTaskController.ts` 继续拆到 `features/runtime/`。
- 给 `tasks.ts` 补单元测试，重点覆盖流式 delta 去重、resume 后 transcript 合并和失败兜底文案。
