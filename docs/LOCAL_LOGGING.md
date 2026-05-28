# 墨渊 Desktop 本地日志说明

墨渊采用本地结构化日志，格式为 NDJSON：一行一条 JSON 事件。日志只写在用户本机，主要用于复现问题后定位客户端、Runtime、Codex app-server、SSE 和任务状态机的事件顺序。

## 日志文件

开发环境默认：

- Runtime 日志：`/tmp/moyuan-runtime/logs/runtime.ndjson`
- 客户端渲染进程日志：`/tmp/moyuan-runtime/logs/desktop-client.ndjson`
- Electron 主进程启动日志：`~/Library/Application Support/Moyuan Desktop/logs/electron-main.ndjson`
- Electron 兼容启动日志：`/tmp/moyuan-desktop-startup.log`

打包安装后：

- Runtime 日志：`~/Library/Application Support/Moyuan Desktop/runtime/logs/runtime.ndjson`
- 客户端渲染进程日志：`~/Library/Application Support/Moyuan Desktop/runtime/logs/desktop-client.ndjson`
- Electron 主进程日志：`~/Library/Application Support/Moyuan Desktop/logs/electron-main.ndjson`

## 本地接口

Runtime 启动后可以读取日志路径：

```bash
curl -s http://127.0.0.1:4101/api/logs/info
```

读取最近日志：

```bash
curl -s 'http://127.0.0.1:4101/api/logs/recent?target=runtime&limit=200'
curl -s 'http://127.0.0.1:4101/api/logs/recent?target=client&limit=200'
```

## 事件覆盖

- 客户端：启动、登录、健康检查、历史加载、会话选择、新会话、发送、停止、SSE open/message/error/close、轮询回补、全局错误。
- Runtime：任务创建、额度校验、生命周期状态变化、Codex app-server/exec 启动、连接、thread/turn、stderr、失败、取消、最终回复等待、SSE 订阅。
- 安全：日志写入前会脱敏 `token`、`Authorization`、`apiKey`、`sk-*`、授权码等字段。

排查问题时优先按时间顺序同时看 `desktop-client.ndjson` 和 `runtime.ndjson`，可以对齐一次操作从点击发送到最终失败或完成的全链路。
