import { PageContainer, ProCard, ProTable } from '@ant-design/pro-components'
import { Button, Tag } from 'antd'

const rows = [
  { id: 'a1', actor: '韩飞虎', action: '执行本地命令', result: '已确认', time: '2026-05-27 13:20' },
  { id: 'a2', actor: '林青', action: '生成日报摘要', result: '自动通过', time: '2026-05-27 12:44' },
  { id: 'a3', actor: '周然', action: '读取工作区文件', result: '已记录', time: '2026-05-27 11:58' },
]

export default function AuditPage() {
  return (
    <PageContainer
      className="admin-page"
      extra={<Button type="primary">导出审计</Button>}
      subTitle="查看员工桌面端模型请求、工具调用、命令历史和策略命中记录"
      title="审计日志"
    >
      <ProCard title="最近事件">
        <ProTable<(typeof rows)[number]>
          columns={[
            { title: '员工', dataIndex: 'actor' },
            { title: '事件', dataIndex: 'action' },
            { title: '结果', dataIndex: 'result', render: (_, row) => <Tag color="blue">{row.result}</Tag> },
            { title: '时间', dataIndex: 'time' },
          ]}
          dataSource={rows}
          options={false}
          pagination={false}
          rowKey="id"
          search={false}
          scroll={{ x: 640 }}
        />
      </ProCard>
    </PageContainer>
  )
}
