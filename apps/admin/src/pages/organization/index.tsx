import { PageContainer, ProCard, ProTable } from '@ant-design/pro-components'
import { Button, Space, Tag } from 'antd'
import type { Employee } from '@eaw/shared'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'

const sourceLabel = { wecom: '企业微信', lark: '飞书', dingtalk: '钉钉' }

export default function OrganizationPage() {
  const { employees } = useAdminSnapshot()

  return (
    <PageContainer
      className="admin-page"
      extra={<Button type="primary">立即同步</Button>}
      subTitle="统一接入企业微信、飞书、钉钉的员工与组织架构数据"
      title="组织同步"
    >
      <ProCard gutter={16} wrap>
        <ProCard colSpan="33%" title="企业微信">
          <Tag color="green">已接入</Tag>
        </ProCard>
        <ProCard colSpan="33%" title="飞书">
          <Tag color="blue">待授权</Tag>
        </ProCard>
        <ProCard colSpan="33%" title="钉钉">
          <Tag>未启用</Tag>
        </ProCard>
      </ProCard>

      <ProCard className="section-card" extra={<Space><Button>导出员工</Button><Button>同步设置</Button></Space>} title="员工目录">
        <ProTable<Employee>
          columns={[
            { title: '员工', dataIndex: 'name' },
            { title: '部门', dataIndex: 'department' },
            { title: '岗位', dataIndex: 'title' },
            {
              title: '来源',
              dataIndex: 'source',
              render: (_, row) => <Tag>{sourceLabel[row.source]}</Tag>,
            },
            { title: '直属上级', dataIndex: 'manager' },
          ]}
          dataSource={employees}
          options={false}
          pagination={{ pageSize: 8 }}
          rowKey="id"
          search={false}
          scroll={{ x: 720 }}
        />
      </ProCard>
    </PageContainer>
  )
}
