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
import { App, Button, ConfigProvider, Flex, Layout, Menu, Progress, Space, Tag, Typography, message, theme } from 'antd'
import React, { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { Employee, ModelProviderConfig } from '@eaw/shared'
import './styles.css'

const { Header, Sider, Content } = Layout

const apiBase = import.meta.env.VITE_ADMIN_API_BASE ?? '/admin-api'

const defaultProviders: ModelProviderConfig[] = [
  {
    id: 'blector',
    name: 'Blector 中转',
    baseUrl: 'https://ai.blector.com/v1',
    maskedApiKey: 'sk-************************demo',
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

const defaultEmployees: Employee[] = [
  { id: 'u-1001', name: '韩飞虎', department: '销售一组', title: '客户经理', source: 'wecom', manager: '王敏' },
  { id: 'u-1002', name: '林青', department: '交付中心', title: '实施顾问', source: 'lark', manager: '赵远' },
  { id: 'u-1003', name: '周然', department: '产品部', title: '产品经理', source: 'dingtalk', manager: '陈立' },
]

const defaultPolicy = {
  dataBoundary: '企业内网',
  externalSharing: '外发需审批',
  highRiskTool: '默认人工确认',
  retention: '审计保留 180 天',
}

async function getJson<T>(path: string) {
  const response = await fetch(`${apiBase}${path}`)
  if (!response.ok) throw new Error(`request failed: ${response.status}`)
  return (await response.json()) as { data: T }
}

function policyText(policy: { dataBoundary?: string; externalSharing?: string; highRiskToolMode?: string; auditEnabled?: boolean }) {
  return {
    dataBoundary: policy.dataBoundary === 'hybrid' ? '本地 + 企业服务' : '企业内网',
    externalSharing:
      policy.externalSharing === 'blocked' ? '禁止外发' : policy.externalSharing === 'allowed' ? '允许外发' : '外发需审批',
    highRiskTool: policy.highRiskToolMode === 'blocked' ? '默认禁止' : '默认人工确认',
    retention: policy.auditEnabled ? '审计保留 180 天' : '未启用审计',
  }
}

function AdminApp() {
  const [apiState, setApiState] = useState<'checking' | 'online' | 'offline'>('checking')
  const [modelProvider, setModelProvider] = useState<ModelProviderConfig>(defaultProviders[0])
  const [providers, setProviders] = useState<ModelProviderConfig[]>(defaultProviders)
  const [employees, setEmployees] = useState<Employee[]>(defaultEmployees)
  const [policy, setPolicy] = useState(defaultPolicy)
  useEffect(() => {
    Promise.all([
      getJson<ModelProviderConfig>('/model-provider'),
      getJson<Employee[]>('/employees'),
      getJson<{ dataBoundary: string; externalSharing: string; highRiskToolMode: string; auditEnabled: boolean }>('/policy'),
    ])
      .then(([modelPayload, employeePayload, policyPayload]) => {
        setApiState('online')
        setModelProvider(modelPayload.data)
        setProviders((current) => [modelPayload.data, ...current.filter((item) => item.id !== modelPayload.data.id)])
        setEmployees(employeePayload.data)
        setPolicy(policyText(policyPayload.data))
      })
      .catch(() => setApiState('offline'))
  }, [])

  const overview = useMemo(
    () => ({
      employees: employees.length,
      providers: providers.filter((provider) => provider.enabled).length,
      audit: policy.retention.includes('审计') ? 100 : 0,
      policyScore: modelProvider.enabled ? 92 : 68,
    }),
    [employees.length, modelProvider.enabled, policy.retention, providers],
  )

  async function saveModelConfig(values: Record<string, unknown>) {
    try {
      const response = await fetch(`${apiBase}/model-provider`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.provider === 'local' ? '本地私有模型' : 'Blector 中转',
          baseUrl: values.baseUrl,
          apiKey: values.apiKey || 'configured-in-admin',
          defaultModel: values.defaultModel,
          enabled: Boolean(values.enabled),
        }),
      })
      const payload = (await response.json()) as { data?: ModelProviderConfig; error?: string }
      if (!response.ok || !payload.data) throw new Error(payload.error ?? '保存失败')
      setApiState('online')
      setModelProvider(payload.data)
      setProviders((current) => [payload.data!, ...current.filter((item) => item.id !== payload.data!.id)])
      message.success('模型配置已保存')
    } catch {
      message.warning('后台 API 暂不可用，已保留页面配置草稿')
    }
  }

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
                  <Tag color={apiState === 'online' ? 'green' : apiState === 'checking' ? 'blue' : 'orange'}>
                    {apiState === 'online' ? '后台 API 已连接' : apiState === 'checking' ? '检查中' : '静态预览'}
                  </Tag>
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
                      <Typography.Title level={2}>{overview.employees}</Typography.Title>
                      <Typography.Text type="secondary">企微、飞书、钉钉统一同步</Typography.Text>
                    </ProCard>
                    <ProCard title="模型通道" colSpan="25%">
                      <Typography.Title level={2}>{overview.providers}</Typography.Title>
                      <Typography.Text type="secondary">已启用，可下发到桌面端</Typography.Text>
                    </ProCard>
                    <ProCard title="审计覆盖" colSpan="25%">
                      <Typography.Title level={2}>{overview.audit}%</Typography.Title>
                      <Typography.Text type="secondary">工具调用和模型请求全链路记录</Typography.Text>
                    </ProCard>
                    <ProCard title="合规策略" colSpan="25%">
                      <Progress percent={overview.policyScore} strokeColor="#1677ff" />
                    </ProCard>
                  </ProCard>

                  <ProCard className="section-card" title="模型中转与密钥配置" extra={<Button>测试连接</Button>}>
                    <ProForm
                      key={`${modelProvider.id}-${modelProvider.baseUrl}-${modelProvider.defaultModel}`}
                      grid
                      onFinish={saveModelConfig}
                      submitter={{
                        searchConfig: { submitText: '保存配置' },
                        resetButtonProps: false,
                      }}
                      initialValues={{
                        provider: modelProvider.id,
                        baseUrl: modelProvider.baseUrl,
                        defaultModel: modelProvider.defaultModel,
                        enabled: modelProvider.enabled,
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
                        dataSource={policy}
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
