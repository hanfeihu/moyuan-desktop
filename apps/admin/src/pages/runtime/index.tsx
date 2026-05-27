import { CodeOutlined, DesktopOutlined } from '@ant-design/icons'
import { PageContainer, ProCard, ProDescriptions, ProTable } from '@ant-design/pro-components'
import { Button, Progress, Space, Tag, Typography } from 'antd'

const releaseRows = [
  { id: 'mac', platform: 'macOS', version: '0.1.3', status: '已发布', channel: 'GitHub Release' },
  { id: 'win', platform: 'Windows', version: '0.1.3', status: '已发布', channel: 'GitHub Actions' },
]

export default function RuntimePage() {
  return (
    <PageContainer
      className="admin-page"
      extra={<Button type="primary">生成部署包</Button>}
      subTitle="管理员工桌面端、内置 Codex Runtime、本地命令权限与版本分发"
      title="Codex Runtime"
    >
      <ProCard gutter={16} wrap>
        <ProCard colSpan="50%" title="运行核心">
          <Space direction="vertical">
            <Typography.Text strong>
              <CodeOutlined /> 内置 Codex Runtime
            </Typography.Text>
            <Tag color="green">本机 127.0.0.1:4101</Tag>
            <Progress percent={86} strokeColor="#1677ff" />
          </Space>
        </ProCard>
        <ProCard colSpan="50%" title="员工桌面端">
          <Space direction="vertical">
            <Typography.Text strong>
              <DesktopOutlined /> Mac / Windows 双端分发
            </Typography.Text>
            <Tag color="blue">开箱即用</Tag>
            <Tag>企业策略下发</Tag>
          </Space>
        </ProCard>
      </ProCard>

      <ProCard className="section-card" title="版本发布">
        <ProTable<(typeof releaseRows)[number]>
          columns={[
            { title: '平台', dataIndex: 'platform' },
            { title: '版本', dataIndex: 'version' },
            { title: '状态', dataIndex: 'status', render: (_, row) => <Tag color="green">{row.status}</Tag> },
            { title: '渠道', dataIndex: 'channel' },
          ]}
          dataSource={releaseRows}
          options={false}
          pagination={false}
          rowKey="id"
          search={false}
          scroll={{ x: 640 }}
        />
      </ProCard>

      <ProCard className="section-card" title="权限边界">
        <ProDescriptions
          column={1}
          columns={[
            { title: '命令行能力', dataIndex: 'terminal' },
            { title: '文件读写', dataIndex: 'files' },
            { title: '高风险操作', dataIndex: 'approval' },
          ]}
          dataSource={{
            approval: '默认需要员工或企业策略确认',
            files: '限制在员工授权工作区内',
            terminal: '桌面端本机执行，后台审计留痕',
          }}
        />
      </ProCard>
    </PageContainer>
  )
}
