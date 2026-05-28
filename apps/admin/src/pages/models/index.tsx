import { ApiOutlined } from '@ant-design/icons'
import {
  PageContainer,
  ProCard,
  ProForm,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
} from '@ant-design/pro-components'
import { App, Button, Tag } from 'antd'
import { useState } from 'react'
import type { ModelProviderConfig } from '@eaw/shared'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'
import { saveModelProvider } from '@/services/admin'

export default function ModelsPage() {
  const { message } = App.useApp()
  const snapshot = useAdminSnapshot()
  const [providers, setProviders] = useState<ModelProviderConfig[]>(snapshot.providers)
  const [activeProvider, setActiveProvider] = useState<ModelProviderConfig | undefined>()
  const [formSeed, setFormSeed] = useState(0)
  const modelProvider = activeProvider ?? snapshot.modelProvider
  const tableProviders = activeProvider ? providers : snapshot.providers
  const keyConfigured = Boolean(modelProvider.maskedApiKey && modelProvider.maskedApiKey !== '未配置')

  async function save(values: Record<string, unknown>) {
    try {
      const payload = await saveModelProvider(values)
      setActiveProvider(payload)
      setProviders((current) => [payload, ...current.filter((item) => item.id !== payload.id)])
      setFormSeed((current) => current + 1)
      message.success('模型配置已保存')
    } catch {
      message.warning('后台 API 暂不可用，已保留页面配置草稿')
    }
  }

  return (
    <PageContainer
      className="admin-page"
      extra={<Button icon={<ApiOutlined />} type="primary">测试连接</Button>}
      subTitle="配置企业统一模型中转、默认模型、密钥和桌面端下发策略"
      title="模型与密钥"
    >
      <ProCard title="模型中转配置">
        <ProForm
          grid
          initialValues={{
            apiKey: undefined,
            baseUrl: modelProvider.baseUrl,
            defaultModel: modelProvider.defaultModel,
            enabled: modelProvider.enabled,
            monthlyLimit: 5000000,
            provider: modelProvider.id,
          }}
          key={`${formSeed}-${modelProvider.id}-${modelProvider.baseUrl}-${modelProvider.defaultModel}`}
          onFinish={save}
          preserve={false}
          submitter={{
            resetButtonProps: false,
            searchConfig: { submitText: '保存配置' },
          }}
        >
          <ProFormSelect
            colProps={{ md: 8, xs: 24 }}
            label="模型供应商"
            name="provider"
            options={[
              { label: 'Blector 中转', value: 'blector' },
              { label: '本地私有模型', value: 'local' },
              { label: 'Azure OpenAI', value: 'azure' },
            ]}
          />
          <ProFormText colProps={{ md: 8, xs: 24 }} label="Base URL" name="baseUrl" />
          <ProFormText.Password
            colProps={{ md: 8, xs: 24 }}
            fieldProps={{ autoComplete: 'new-password', className: 'secret-input', spellCheck: false }}
            label="API Key"
            name="apiKey"
            placeholder={keyConfigured ? '已配置，留空沿用' : '请输入 API Key'}
          />
          <ProFormText colProps={{ md: 8, xs: 24 }} label="默认模型" name="defaultModel" />
          <ProFormDigit colProps={{ md: 8, xs: 24 }} label="月度 Token 额度" name="monthlyLimit" />
          <ProFormSwitch colProps={{ md: 8, xs: 24 }} label="启用该通道" name="enabled" />
        </ProForm>
      </ProCard>

      <ProCard className="section-card" title="已配置模型通道">
        <ProTable<ModelProviderConfig>
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: 'Base URL', dataIndex: 'baseUrl', ellipsis: true },
            { title: '默认模型', dataIndex: 'defaultModel' },
            { title: 'Key', dataIndex: 'maskedApiKey' },
            {
              title: '状态',
              dataIndex: 'enabled',
              render: (_, row) => <Tag color={row.enabled ? 'green' : 'default'}>{row.enabled ? '启用' : '停用'}</Tag>,
            },
          ]}
          dataSource={tableProviders}
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
