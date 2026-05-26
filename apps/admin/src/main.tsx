import {
  ApiOutlined,
  AuditOutlined,
  CloudServerOutlined,
  ControlOutlined,
  DeploymentUnitOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import {
  PageContainer,
  ProCard,
  ProConfigProvider,
  ProDescriptions,
  ProForm,
  ProFormDependency,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
} from '@ant-design/pro-components'
import { App, Button, ConfigProvider, Flex, Layout, Menu, Progress, Space, Tag, Typography, theme } from 'antd'
import React from 'react'
import ReactDOM from 'react-dom/client'
import type { Employee, ModelProviderConfig } from '@eaw/shared'
import './styles.css'

const { Header, Sider, Content } = Layout

const providers: ModelProviderConfig[] = [
  {
    id: 'blector',
    name: 'Blector 中转',
    baseUrl: 'https://ai.blector.com/v1',
    maskedApiKey: 'sk-gJcO************************lsBi',
    defaultModel: 'gpt-5-codex',
    enabled: true,
  },
  {
    id: 'local',
    name: '本地私有模型',
    baseUrl: 'http://model-gateway:8000/v1',
    maskedApiKey: '未配置',
    defaultModel: 'qwen3-coder',
    enabled: false,
  },
]

const employees: Employee[] = [
  { id: 'u-1001', name: '韩飞虎', department: '销售一组', title: '客户经理', source: 'wecom', manager: '王敏' },
  { id: 'u-1002', name: '林青', department: '交付中心', title: '实施顾问', source: 'lark', manager: '赵远' },
  { id: 'u-1003', name: '周然', department: '产品部', title: '产品经理', source: 'dingtalk', manager: '陈立' },
]

function AdminApp() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 8,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      }}
    >
      <ProConfigProvider hashed={false}>
        <App>
          <Layout className="admin-shell">
            <Sider width={248} className="admin-sider">
              <div className="admin-brand">
                <CloudServerOutlined />
                <div>
                  <strong>企业 AI 控制台</strong>
                  <span>Admin Console</span>
                </div>
              </div>
              <Menu
                theme="dark"
                mode="inline"
                defaultSelectedKeys={['overview']}
                items={[
                  { key: 'overview', icon: <ControlOutlined />, label: '总览' },
                  { key: 'models', icon: <ApiOutlined />, label: '模型与密钥' },
                  { key: 'org', icon: <TeamOutlined />, label: '组织同步' },
                  { key: 'runtime', icon: <DeploymentUnitOutlined />, label: 'Codex Runtime' },
                  { key: 'policy', icon: <SafetyCertificateOutlined />, label: '安全策略' },
                  { key: 'audit', icon: <AuditOutlined />, label: '审计日志' },
                ]}
              />
            </Sider>
            <Layout>
              <Header className="admin-header">
                <Typography.Text strong>本地化部署 · 企业可控 · 员工桌面端统一管控</Typography.Text>
                <Space>
                  <Tag color="green">运行中</Tag>
                  <Button type="primary">发布策略</Button>
                </Space>
              </Header>
              <Content className="admin-content">
                <PageContainer
                  title="企业 AI 后台"
                  subTitle="配置模型中转、组织来源、Codex 内核、工具权限和审计策略"
                >
                  <ProCard gutter={16} wrap>
                    <ProCard title="接入员工" colSpan="25%">
                      <Typography.Title level={2}>1,426</Typography.Title>
                      <Typography.Text type="secondary">企微、飞书、钉钉统一同步</Typography.Text>
                    </ProCard>
                    <ProCard title="Codex 任务" colSpan="25%">
                      <Typography.Title level={2}>238</Typography.Title>
                      <Typography.Text type="secondary">今日执行，37 次需人工确认</Typography.Text>
                    </ProCard>
                    <ProCard title="审计覆盖" colSpan="25%">
                      <Typography.Title level={2}>100%</Typography.Title>
                      <Typography.Text type="secondary">工具调用和模型请求全链路记录</Typography.Text>
                    </ProCard>
                    <ProCard title="合规策略" colSpan="25%">
                      <Progress percent={92} strokeColor="#1677ff" />
                    </ProCard>
                  </ProCard>

                  <ProCard className="section-card" title="模型中转与密钥配置" extra={<Button>测试连接</Button>}>
                    <ProForm
                      grid
                      submitter={{
                        searchConfig: { submitText: '保存配置' },
                        resetButtonProps: false,
                      }}
                      initialValues={{
                        provider: 'blector',
                        baseUrl: 'https://ai.blector.com/v1',
                        defaultModel: 'gpt-5-codex',
                        enabled: true,
                        monthlyLimit: 5000000,
                      }}
                    >
                      <ProFormSelect
                        name="provider"
                        label="模型供应商"
                        colProps={{ span: 8 }}
                        options={[
                          { label: 'Blector 中转', value: 'blector' },
                          { label: '本地私有模型', value: 'local' },
                          { label: 'Azure OpenAI', value: 'azure' },
                        ]}
                      />
                      <ProFormText name="baseUrl" label="Base URL" colProps={{ span: 8 }} />
                      <ProFormText.Password name="apiKey" label="API Key" placeholder="后台保存，前端不展示明文" colProps={{ span: 8 }} />
                      <ProFormText name="defaultModel" label="默认模型" colProps={{ span: 8 }} />
                      <ProFormDigit name="monthlyLimit" label="月度 Token 额度" colProps={{ span: 8 }} />
                      <ProFormSwitch name="enabled" label="启用该通道" colProps={{ span: 8 }} />
                      <ProFormDependency name={['provider']}>
                        {({ provider }) =>
                          provider === 'blector' ? (
                            <Tag color="blue">员工桌面端的 Codex runtime 将通过该中转地址发起模型请求</Tag>
                          ) : null
                        }
                      </ProFormDependency>
                    </ProForm>
                  </ProCard>

                  <Flex gap={16} align="stretch" className="two-columns">
                    <ProCard title="已配置模型通道" className="fill-card">
                      <ProTable<ModelProviderConfig>
                        rowKey="id"
                        search={false}
                        options={false}
                        pagination={false}
                        dataSource={providers}
                        columns={[
                          { title: '名称', dataIndex: 'name' },
                          { title: 'Base URL', dataIndex: 'baseUrl' },
                          { title: '默认模型', dataIndex: 'defaultModel' },
                          { title: 'Key', dataIndex: 'maskedApiKey' },
                          {
                            title: '状态',
                            dataIndex: 'enabled',
                            render: (_, row) => <Tag color={row.enabled ? 'green' : 'default'}>{row.enabled ? '启用' : '停用'}</Tag>,
                          },
                        ]}
                      />
                    </ProCard>

                    <ProCard title="企业策略" className="policy-card">
                      <ProDescriptions
                        column={1}
                        dataSource={{
                          dataBoundary: '企业内网',
                          externalSharing: '外发需审批',
                          highRiskTool: '默认人工确认',
                          retention: '审计保留 180 天',
                        }}
                        columns={[
                          { title: '数据边界', dataIndex: 'dataBoundary' },
                          { title: '外发策略', dataIndex: 'externalSharing' },
                          { title: '高风险工具', dataIndex: 'highRiskTool' },
                          { title: '审计保留', dataIndex: 'retention' },
                        ]}
                      />
                    </ProCard>
                  </Flex>

                  <ProCard className="section-card" title="组织架构同步">
                    <ProTable<Employee>
                      rowKey="id"
                      search={false}
                      options={false}
                      dataSource={employees}
                      pagination={false}
                      columns={[
                        { title: '员工', dataIndex: 'name' },
                        { title: '部门', dataIndex: 'department' },
                        { title: '岗位', dataIndex: 'title' },
                        {
                          title: '来源',
                          dataIndex: 'source',
                          render: (_, row) => {
                            const label = { wecom: '企业微信', lark: '飞书', dingtalk: '钉钉' }[row.source]
                            return <Tag>{label}</Tag>
                          },
                        },
                        { title: '直属上级', dataIndex: 'manager' },
                      ]}
                    />
                  </ProCard>
                </PageContainer>
              </Content>
            </Layout>
          </Layout>
        </App>
      </ProConfigProvider>
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>,
)
