import { ApiOutlined } from '@ant-design/icons'
import {
  PageContainer,
  ProCard,
  ProForm,
  ProFormDigit,
  ProFormSwitch,
  ProFormText,
  ProTable,
} from '@ant-design/pro-components'
import { App, Button, Popconfirm, Space, Tag } from 'antd'
import { useEffect, useState } from 'react'
import type { ModelProviderConfig } from '@eaw/shared'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'
import { deleteModelProvider, saveModelProvider } from '@/services/admin'

function keySuffix(maskedApiKey: string) {
  if (!maskedApiKey || maskedApiKey === '未配置' || maskedApiKey === '已配置') return ''
  const suffix = maskedApiKey.match(/[A-Za-z0-9]{3,8}$/)?.[0]
  return suffix ? `尾号 ${suffix}` : ''
}

export default function ModelsPage() {
  const { message } = App.useApp()
  const snapshot = useAdminSnapshot()
  const [providers, setProviders] = useState<ModelProviderConfig[]>(snapshot.providers)
  const [editingProvider, setEditingProvider] = useState<ModelProviderConfig | undefined>()
  const [activeProvider, setActiveProvider] = useState<ModelProviderConfig>(snapshot.modelProvider)
  const [formSeed, setFormSeed] = useState(0)
  const modelProvider = editingProvider ?? activeProvider
  const keyConfigured = Boolean(modelProvider.maskedApiKey && modelProvider.maskedApiKey !== '未配置')

  useEffect(() => {
    if (snapshot.apiState === 'checking') return
    setProviders(snapshot.providers)
    setActiveProvider(snapshot.modelProvider)
    setEditingProvider(snapshot.modelProvider)
    setFormSeed((current) => current + 1)
  }, [snapshot.apiState, snapshot.modelProvider, snapshot.providers])

  async function save(values: Record<string, unknown>) {
    try {
      const payload = await saveModelProvider(values)
      setActiveProvider(payload.active)
      setEditingProvider(payload.provider)
      setProviders(payload.providers)
      setFormSeed((current) => current + 1)
      message.success('模型配置已保存')
    } catch {
      message.warning('后台 API 暂不可用，已保留页面配置草稿')
    }
  }

  async function enable(provider: ModelProviderConfig) {
    try {
      const payload = await saveModelProvider({ ...provider, apiKey: undefined, enabled: true })
      setActiveProvider(payload.active)
      setEditingProvider(payload.provider)
      setProviders(payload.providers)
      setFormSeed((current) => current + 1)
      message.success('已启用该模型通道')
    } catch {
      message.warning('启用失败，请稍后重试')
    }
  }

  async function remove(provider: ModelProviderConfig) {
    try {
      const payload = await deleteModelProvider(provider.id)
      setActiveProvider(payload.active)
      setEditingProvider(payload.active)
      setProviders(payload.providers)
      setFormSeed((current) => current + 1)
      message.success('模型通道已删除')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '删除失败')
    }
  }

  function createProvider() {
    setEditingProvider({
      id: '',
      name: '新模型通道',
      baseUrl: '',
      maskedApiKey: '未配置',
      defaultModel: '',
      enabled: false,
      monthlyLimit: 5000000,
    })
    setFormSeed((current) => current + 1)
  }

  return (
    <PageContainer
      className="admin-page"
      extra={<Button icon={<ApiOutlined />} type="primary">测试连接</Button>}
      subTitle="配置企业统一模型中转、默认模型、密钥和桌面端下发策略"
      title="模型与密钥"
    >
      <ProCard
        extra={<Button onClick={createProvider}>新增通道</Button>}
        title={modelProvider.id ? `模型中转配置：${modelProvider.name}` : '新增模型通道'}
      >
        <ProForm
          grid
          initialValues={{
            id: modelProvider.id,
            apiKey: undefined,
            baseUrl: modelProvider.baseUrl,
            defaultModel: modelProvider.defaultModel,
            enabled: modelProvider.enabled,
            monthlyLimit: modelProvider.monthlyLimit,
            name: modelProvider.name,
          }}
          key={`${formSeed}-${modelProvider.id}-${modelProvider.baseUrl}-${modelProvider.defaultModel}-${modelProvider.enabled}`}
          onFinish={save}
          preserve={false}
          submitter={{
            resetButtonProps: false,
            searchConfig: { submitText: '保存配置' },
          }}
        >
          <ProFormText name="id" hidden />
          <ProFormText colProps={{ md: 8, xs: 24 }} label="通道名称" name="name" rules={[{ required: true, message: '请输入通道名称' }]} />
          <ProFormText colProps={{ md: 8, xs: 24 }} label="Base URL" name="baseUrl" />
          <ProFormText.Password
            colProps={{ md: 8, xs: 24 }}
            fieldProps={{ autoComplete: 'new-password', className: 'secret-input', spellCheck: false }}
            label="API Key"
            name="apiKey"
            placeholder={keyConfigured ? '留空则不修改现有密钥' : '粘贴 API Key'}
          />
          <ProFormText colProps={{ md: 8, xs: 24 }} label="默认模型" name="defaultModel" />
          <ProFormDigit colProps={{ md: 8, xs: 24 }} label="月度 Token 额度" name="monthlyLimit" />
          <ProFormSwitch
            colProps={{ md: 8, xs: 24 }}
            fieldProps={{ checkedChildren: '启用', unCheckedChildren: '停用' }}
            label="启用该通道"
            name="enabled"
          />
        </ProForm>
      </ProCard>

      <ProCard className="section-card" title="已配置模型通道">
        <ProTable<ModelProviderConfig>
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: 'Base URL', dataIndex: 'baseUrl', ellipsis: true },
            { title: '默认模型', dataIndex: 'defaultModel' },
            { title: '月度额度', dataIndex: 'monthlyLimit' },
            {
              title: 'Key',
              dataIndex: 'maskedApiKey',
              width: 170,
              render: (_, row) => {
                const configured = Boolean(row.maskedApiKey && row.maskedApiKey !== '未配置')
                return configured ? (
                  <span className="model-key-state">
                    <Tag color="blue">已配置</Tag>
                    {keySuffix(row.maskedApiKey) ? <small>{keySuffix(row.maskedApiKey)}</small> : null}
                  </span>
                ) : (
                  <span className="model-key-empty">未配置</span>
                )
              },
            },
            {
              title: '状态',
              dataIndex: 'enabled',
              width: 110,
              render: (_, row) => <Tag color={row.enabled ? 'green' : 'default'}>{row.enabled ? '启用' : '停用'}</Tag>,
            },
            {
              title: '操作',
              width: 220,
              valueType: 'option',
              render: (_, row) => (
                <Space>
                  <Button
                    size="small"
                    type={editingProvider?.id === row.id ? 'primary' : 'link'}
                    onClick={() => {
                      setEditingProvider(row)
                      setFormSeed((current) => current + 1)
                    }}
                  >
                    编辑
                  </Button>
                  {!row.enabled ? (
                    <Button size="small" type="link" onClick={() => enable(row)}>
                      启用
                    </Button>
                  ) : null}
                  <Popconfirm
                    disabled={providers.length <= 1}
                    okText="删除"
                    onConfirm={() => remove(row)}
                    title={providers.length <= 1 ? '至少保留一个模型通道' : `删除 ${row.name}？`}
                  >
                    <Button danger disabled={providers.length <= 1} size="small" type="link">
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          dataSource={providers}
          options={false}
          pagination={false}
          rowKey="id"
          search={false}
          scroll={{ x: 860 }}
        />
      </ProCard>
    </PageContainer>
  )
}
