import cors from '@fastify/cors'
import Fastify from 'fastify'
import { z } from 'zod'

const app = Fastify({ logger: true })

await app.register(cors, {
  origin: true,
})

const employees = [
  {
    id: 'u-1001',
    name: '韩飞虎',
    department: '销售一组',
    title: '客户经理',
    source: '企业微信',
    manager: '王敏',
  },
  {
    id: 'u-1002',
    name: '林青',
    department: '交付中心',
    title: '实施顾问',
    source: '飞书',
    manager: '赵远',
  },
  {
    id: 'u-1003',
    name: '周然',
    department: '产品部',
    title: '产品经理',
    source: '钉钉',
    manager: '陈立',
  },
]

const workSignals = [
  { type: 'meeting', title: '华东客户项目例会', owner: '韩飞虎', risk: '审批延迟' },
  { type: 'document', title: '企业 AI 私有化部署方案', owner: '周然', risk: '无' },
  { type: 'task', title: '飞书审批回调联调', owner: '林青', risk: '接口权限待确认' },
]

const auditEvents = [
  { id: 1, actor: '韩飞虎', action: '生成日报草稿', resource: '客户沟通记录', result: '待本人确认' },
  { id: 2, actor: 'AI Agent', action: '调用知识库检索', resource: '销售资料库', result: '命中 12 篇' },
  { id: 3, actor: '管理员', action: '调整策略', resource: '高风险工具调用', result: '启用人工确认' },
]

const draftReportSchema = z.object({
  employeeId: z.string(),
  notes: z.string().min(1),
})

app.get('/health', async () => ({
  ok: true,
  service: 'enterprise-ai-workbench',
}))

app.get('/api/organization/employees', async () => ({
  data: employees,
  sources: ['企业微信', '飞书', '钉钉'],
}))

app.get('/api/work-signals', async () => ({
  data: workSignals,
}))

app.get('/api/audit-events', async () => ({
  data: auditEvents,
}))

app.post('/api/reports/draft', async (request, reply) => {
  const parsed = draftReportSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({
      error: '参数不完整',
      detail: parsed.error.flatten(),
    })
  }

  const employee = employees.find((item) => item.id === parsed.data.employeeId)

  if (!employee) {
    return reply.status(404).send({ error: '员工不存在' })
  }

  return {
    data: {
      title: `${employee.name} 今日工作日报`,
      owner: employee.name,
      department: employee.department,
      summary: `根据已授权的聊天、会议、任务记录，系统识别到：${parsed.data.notes}`,
      nextActions: ['本人确认日报内容', '主管复核风险项', '沉淀到团队周报'],
      control: {
        dataBoundary: '企业内网',
        reviewRequired: true,
        auditEnabled: true,
      },
    },
  }
})

const port = Number(process.env.PORT ?? 4000)
const host = process.env.HOST ?? '0.0.0.0'

await app.listen({ port, host })
