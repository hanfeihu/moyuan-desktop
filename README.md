# 企业 AI 工作台

面向企业私有化部署的员工 AI 工作系统。第一版聚焦三个目标：

- 员工端：帮助员工生成日报、周报、会议纪要、待办和工作材料。
- 管理端：把工作过程沉淀为团队看板、绩效辅助材料和项目风险。
- 企业可控：组织权限、工具调用、数据边界、人工确认、审计日志由企业统一管理。

## 产品切入点

先用“AI 日报/周报 + 团队工作看板”进入企业。员工得到真实提效，管理者得到更客观的工作成果沉淀。对外表达建议使用“绩效辅助分析”或“工作成果沉淀”，避免把产品描述成监控工具。

## 架构

```text
桌面客户端 / Web 工作台
  -> 后端 API
  -> AI Gateway / Agent Runtime
  -> 企业微信、飞书、钉钉、知识库、OA、CRM、ERP
```

当前仓库先实现：

- `web`：React 工作台演示界面。
- `server`：Fastify API 服务，提供组织、工作信号、审计和日报草稿接口。
- `docker-compose.yml`：本地和服务器快速部署入口。

后续建议把后端主系统迁移或扩展为 Java Spring Boot，把 AI 编排、RAG、文档解析放到独立 Python 服务。

## 本地启动

```bash
cd web
npm install
npm run dev
```

```bash
cd server
npm install
npm run dev
```

默认端口：

- Web: `5173`
- API: `4000`

## API

- `GET /health`
- `GET /api/organization/employees`
- `GET /api/work-signals`
- `GET /api/audit-events`
- `POST /api/reports/draft`

日报草稿示例：

```json
{
  "employeeId": "u-1001",
  "notes": "完成 3 个客户跟进，华东项目审批存在延迟风险"
}
```
