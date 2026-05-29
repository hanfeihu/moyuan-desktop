import { CheckCircleOutlined, CreditCardOutlined, DeleteOutlined, EditOutlined, PlusOutlined, WalletOutlined } from '@ant-design/icons'
import { ModalForm, PageContainer, ProCard, ProForm, ProFormCheckbox, ProFormDigit, ProFormSwitch, ProFormText, ProFormTextArea } from '@ant-design/pro-components'
import { App, Button, Popconfirm, Space, Table, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { PaymentGatewayConfig, RechargeOrder, TokenPlan } from '@eaw/shared'
import { defaultPaymentGateway, defaultTokenPlans } from '@/data/defaults'
import { deleteTokenPlan, loadRechargeOrders, loadTokenPlans, savePaymentGateway, saveTokenPlan } from '@/services/admin'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'

function formatTokens(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatMoney(value: number) {
  return `¥${value.toFixed(2)}`
}

export default function BillingPage() {
  const { message } = App.useApp()
  const snapshot = useAdminSnapshot()
  const [gateway, setGateway] = useState<PaymentGatewayConfig>(snapshot.paymentGateway ?? defaultPaymentGateway)
  const [plans, setPlans] = useState<TokenPlan[]>(snapshot.tokenPlans ?? defaultTokenPlans)
  const [orders, setOrders] = useState<RechargeOrder[]>([])
  const [editingPlan, setEditingPlan] = useState<TokenPlan | undefined>()
  const [planModalOpen, setPlanModalOpen] = useState(false)

  useEffect(() => {
    if (snapshot.paymentGateway) setGateway(snapshot.paymentGateway)
    if (snapshot.tokenPlans?.length) setPlans(snapshot.tokenPlans)
  }, [snapshot.paymentGateway, snapshot.tokenPlans])

  useEffect(() => {
    void Promise.all([loadTokenPlans(), loadRechargeOrders()]).then(([nextPlans, nextOrders]) => {
      setPlans(nextPlans)
      setOrders(nextOrders)
    })
  }, [])

  const gatewayReady = gateway.enabled && gateway.keyConfigured && Boolean(gateway.pid)
  const gatewayStatus = gatewayReady ? '可收款' : !gateway.keyConfigured ? '缺少密钥' : !gateway.enabled ? '未启用' : '缺少商户 ID'
  const enabledPlans = useMemo(() => plans.filter((plan) => plan.enabled), [plans])
  const paidOrders = orders.filter((order) => order.status === 'paid')
  const paidAmount = paidOrders.reduce((sum, order) => sum + order.amount, 0)
  const paidTokens = paidOrders.reduce((sum, order) => sum + order.tokens, 0)

  async function saveGateway(values: Record<string, unknown>) {
    try {
      const payload = await savePaymentGateway(values)
      setGateway(payload)
      message.success('支付网关配置已保存')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '支付网关保存失败')
    }
  }

  async function submitPlan(values: Record<string, unknown>) {
    try {
      await saveTokenPlan(values, editingPlan?.id)
      setPlans(await loadTokenPlans())
      setPlanModalOpen(false)
      setEditingPlan(undefined)
      message.success('套餐已保存')
      return true
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '套餐保存失败')
      return false
    }
  }

  async function removePlan(id: string) {
    try {
      const payload = await deleteTokenPlan(id)
      setPlans(payload)
      message.success('套餐已删除')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '套餐删除失败')
    }
  }

  return (
    <PageContainer
      className="admin-page"
      extra={
        <Button
          icon={<PlusOutlined />}
          onClick={() => {
            setEditingPlan(undefined)
            setPlanModalOpen(true)
          }}
          type="primary"
        >
          新增套餐
        </Button>
      }
      subTitle="充值入口、支付网关和 Token 套餐"
      title="支付与套餐"
    >
      <ProCard gutter={16} ghost>
        <ProCard>
          <div className="metric-card">
            <span>网关状态</span>
            <strong>{gatewayStatus}</strong>
            <Tag color={gatewayReady ? 'green' : 'orange'}>{gateway.provider.toUpperCase()}</Tag>
          </div>
        </ProCard>
        <ProCard>
          <div className="metric-card">
            <span>上架套餐</span>
            <strong>{enabledPlans.length}</strong>
            <small>共 {plans.length} 个套餐</small>
          </div>
        </ProCard>
        <ProCard>
          <div className="metric-card">
            <span>已支付订单</span>
            <strong>{paidOrders.length}</strong>
            <small>{formatMoney(paidAmount)}</small>
          </div>
        </ProCard>
        <ProCard>
          <div className="metric-card">
            <span>已发放 Token</span>
            <strong>{formatTokens(paidTokens)}</strong>
            <small>回调成功后自动发放</small>
          </div>
        </ProCard>
      </ProCard>

      <ProCard
        className="section-card"
        extra={
          <Space wrap>
            <Tag color={gatewayReady ? 'green' : 'orange'} icon={gatewayReady ? <CheckCircleOutlined /> : <CreditCardOutlined />}>
              {gatewayStatus}
            </Tag>
            <Tag>{gateway.maskedKey}</Tag>
          </Space>
        }
        title="支付网关 · ZPAYZ"
      >
        <ProForm
          autoComplete="off"
          grid
          initialValues={{
            enabled: gateway.enabled,
            gatewayUrl: gateway.gatewayUrl,
            key: undefined,
            pid: gateway.pid,
            supportedMethods: gateway.supportedMethods,
          }}
          key={`${gateway.gatewayUrl}-${gateway.pid}-${gateway.maskedKey}-${gateway.enabled}`}
          onFinish={saveGateway}
          preserve={false}
          submitter={{
            resetButtonProps: false,
            searchConfig: { submitText: '保存支付配置' },
          }}
        >
          <ProFormText colProps={{ md: 8, xs: 24 }} label="网关地址" name="gatewayUrl" placeholder="https://zpayz.cn" />
          <ProFormText colProps={{ md: 8, xs: 24 }} label="商户 ID（PID）" name="pid" />
          <ProFormText.Password
            colProps={{ md: 8, xs: 24 }}
            fieldProps={{ autoComplete: 'new-password', className: 'secret-input', spellCheck: false }}
            label="商户密钥（KEY）"
            name="key"
            placeholder={gateway.keyConfigured ? '已配置，留空沿用；输入新 KEY 会替换' : '请输入商户密钥'}
          />
          <ProFormCheckbox.Group
            colProps={{ md: 12, xs: 24 }}
            label="支付方式"
            name="supportedMethods"
            options={[
              { label: '支付宝', value: 'alipay' },
              { label: '微信支付', value: 'wxpay' },
            ]}
          />
          <ProFormSwitch colProps={{ md: 6, xs: 12 }} label="启用充值" name="enabled" />
        </ProForm>
      </ProCard>

      <ProCard
        className="section-card"
        extra={
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingPlan(undefined)
              setPlanModalOpen(true)
            }}
            type="primary"
          >
            新增套餐
          </Button>
        }
        title="Token 套餐"
      >
        <Table<TokenPlan>
          columns={[
            {
              dataIndex: 'name',
              title: '套餐',
              render: (_, record) => (
                <Space direction="vertical" size={0}>
                  <strong>{record.name}</strong>
                  <span className="muted-text">{record.description || '无描述'}</span>
                </Space>
              ),
            },
            { dataIndex: 'price', title: '价格', render: (value: number) => formatMoney(value) },
            { dataIndex: 'tokens', title: 'Token', render: (value: number) => formatTokens(value) },
            { dataIndex: 'sort', title: '排序', width: 90 },
            { dataIndex: 'enabled', title: '状态', render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? '上架' : '下架'}</Tag> },
            {
              title: '操作',
              width: 160,
              render: (_, record) => (
                <Space>
                  <Button
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditingPlan(record)
                      setPlanModalOpen(true)
                    }}
                    size="small"
                    type="text"
                  />
                  <Popconfirm onConfirm={() => removePlan(record.id)} title="删除这个套餐？">
                    <Button danger icon={<DeleteOutlined />} size="small" type="text" />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          dataSource={plans}
          pagination={false}
          rowKey="id"
        />
      </ProCard>

      <ProCard className="section-card" title="最近充值订单">
        <Table<RechargeOrder>
          columns={[
            { dataIndex: 'outTradeNo', title: '商户订单号' },
            { dataIndex: 'userEmail', title: '用户' },
            { dataIndex: 'planName', title: '套餐' },
            { dataIndex: 'amount', title: '金额', render: (value: number) => formatMoney(value) },
            { dataIndex: 'tokens', title: 'Token', render: (value: number) => formatTokens(value) },
            { dataIndex: 'method', title: '方式', render: (value: string) => (value === 'wxpay' ? '微信' : '支付宝') },
            { dataIndex: 'status', title: '状态', render: (value: RechargeOrder['status']) => <Tag color={value === 'paid' ? 'green' : value === 'pending' ? 'gold' : 'red'}>{value}</Tag> },
            { dataIndex: 'createdAt', title: '创建时间', render: (value: string) => new Date(value).toLocaleString() },
          ]}
          dataSource={orders}
          pagination={{ pageSize: 8 }}
          rowKey="id"
        />
      </ProCard>

      <ModalForm
        initialValues={{
          description: editingPlan?.description ?? '',
          enabled: editingPlan?.enabled ?? true,
          name: editingPlan?.name,
          price: editingPlan?.price ?? 9.9,
          sort: editingPlan?.sort ?? 100,
          tokens: editingPlan?.tokens ?? 100000,
        }}
        key={editingPlan?.id ?? 'new'}
        modalProps={{
          destroyOnClose: true,
          onCancel: () => {
            setEditingPlan(undefined)
            setPlanModalOpen(false)
          },
        }}
        onFinish={submitPlan}
        open={planModalOpen}
        submitter={{ searchConfig: { submitText: editingPlan ? '保存套餐' : '创建套餐' } }}
        title={editingPlan ? '编辑套餐' : '新增套餐'}
        width={560}
      >
        <ProFormText label="套餐名称" name="name" rules={[{ required: true }]} />
        <ProFormTextArea label="描述" name="description" />
        <ProFormDigit fieldProps={{ precision: 2 }} label="价格（元）" min={0.01} name="price" rules={[{ required: true }]} />
        <ProFormDigit label="Token 数量" min={1} name="tokens" rules={[{ required: true }]} />
        <ProFormDigit label="排序" min={0} name="sort" />
        <ProFormSwitch checkedChildren="上架" label="状态" name="enabled" unCheckedChildren="下架" />
      </ModalForm>

      <ProCard className="section-card" title="充值链路">
        <Space wrap>
          <Tag color="blue" icon={<WalletOutlined />}>客户端选择套餐</Tag>
          <Tag color="blue">服务端创建订单并签名</Tag>
          <Tag color="blue">ZPAYZ 收款</Tag>
          <Tag color="green">异步回调后发放 Token</Tag>
          <Tag>订单全量审计</Tag>
        </Space>
      </ProCard>
    </PageContainer>
  )
}
