import { CheckCircleOutlined, CreditCardOutlined, DeleteOutlined, EditOutlined, PlusOutlined, WalletOutlined } from '@ant-design/icons'
import { ModalForm, PageContainer, ProCard, ProForm, ProFormCheckbox, ProFormDigit, ProFormSwitch, ProFormText, ProFormTextArea } from '@ant-design/pro-components'
import { App, Button, Popconfirm, Space, Table, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { BillingConfig, PaymentGatewayConfig, RechargeOrder, TokenPlan, UsageLedgerEntry } from '@eaw/shared'
import { defaultBillingConfig, defaultPaymentGateway, defaultTokenPlans } from '@/data/defaults'
import { deleteTokenPlan, loadBillingConfig, loadRechargeOrders, loadTokenPlans, loadUsageLedger, saveBillingConfig, savePaymentGateway, saveTokenPlan } from '@/services/admin'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'

function formatTokens(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatMoney(value: number) {
  return `¥${value.toFixed(2)}`
}

function sourceText(value: UsageLedgerEntry['source']) {
  if (value === 'brain') return '大脑'
  if (value === 'image') return '图片'
  return '视频'
}

export default function BillingPage() {
  const { message } = App.useApp()
  const snapshot = useAdminSnapshot()
  const [gateway, setGateway] = useState<PaymentGatewayConfig>(snapshot.paymentGateway ?? defaultPaymentGateway)
  const [billing, setBilling] = useState<BillingConfig>(snapshot.billingConfig ?? defaultBillingConfig)
  const [plans, setPlans] = useState<TokenPlan[]>(snapshot.tokenPlans ?? defaultTokenPlans)
  const [orders, setOrders] = useState<RechargeOrder[]>([])
  const [ledger, setLedger] = useState<UsageLedgerEntry[]>([])
  const [editingPlan, setEditingPlan] = useState<TokenPlan | undefined>()
  const [planModalOpen, setPlanModalOpen] = useState(false)

  useEffect(() => {
    if (snapshot.paymentGateway) setGateway(snapshot.paymentGateway)
    if (snapshot.billingConfig) setBilling(snapshot.billingConfig)
    if (snapshot.tokenPlans?.length) setPlans(snapshot.tokenPlans)
  }, [snapshot.billingConfig, snapshot.paymentGateway, snapshot.tokenPlans])

  useEffect(() => {
    void Promise.all([loadTokenPlans(), loadRechargeOrders(), loadBillingConfig(), loadUsageLedger()]).then(([nextPlans, nextOrders, nextBilling, nextLedger]) => {
      setPlans(nextPlans)
      setOrders(nextOrders)
      setBilling(nextBilling)
      setLedger(nextLedger)
    })
  }, [])

  const gatewayReady = gateway.enabled && gateway.keyConfigured && Boolean(gateway.pid)
  const gatewayStatus = gatewayReady ? '可收款' : !gateway.keyConfigured ? '缺少密钥' : !gateway.enabled ? '未启用' : '缺少商户 ID'
  const enabledPlans = useMemo(() => plans.filter((plan) => plan.enabled), [plans])
  const paidOrders = orders.filter((order) => order.status === 'paid')
  const paidAmount = paidOrders.reduce((sum, order) => sum + order.amount, 0)
  const paidTokens = paidOrders.reduce((sum, order) => sum + order.tokens, 0)
  const ledgerSummary = ledger.reduce(
    (total, entry) => ({
      billableCny: total.billableCny + entry.billableCny,
      costCny: total.costCny + entry.costCny,
      platformTokens: total.platformTokens + entry.platformTokens,
    }),
    { billableCny: 0, costCny: 0, platformTokens: 0 },
  )

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

  async function submitBilling(values: Record<string, unknown>) {
    try {
      const nextBilling: BillingConfig = {
        platformPriceCny: Number(values.platformPriceCny),
        platformTokens: Number(values.platformTokens),
        updatedAt: billing.updatedAt,
          meters: billing.meters.map((meter) => ({
            ...meter,
            costCny: Number(values[`${meter.id}.costCny`]),
            costUnitTokens: Number(values[`${meter.id}.costUnitTokens`]),
            deductionFactor: Number(values[`${meter.id}.deductionFactor`]) || 1,
            enabled: Boolean(values[`${meter.id}.enabled`]),
            markupRate: Number(values[`${meter.id}.markupRate`]) / 100,
            modelPattern: String(values[`${meter.id}.modelPattern`] ?? '').trim() || undefined,
        })),
      }
      const payload = await saveBillingConfig(nextBilling)
      setBilling(payload)
      message.success('计费规则已保存')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '计费规则保存失败')
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

      <ProCard className="section-card" title="平台 Token 计费规则">
        <ProForm
          grid
          initialValues={{
            platformPriceCny: billing.platformPriceCny,
            platformTokens: billing.platformTokens,
            ...Object.fromEntries(
              billing.meters.flatMap((meter) => [
                [`${meter.id}.costCny`, meter.costCny],
                [`${meter.id}.costUnitTokens`, meter.costUnitTokens],
                [`${meter.id}.deductionFactor`, meter.deductionFactor ?? 1],
                [`${meter.id}.enabled`, meter.enabled],
                [`${meter.id}.markupRate`, Math.round(meter.markupRate * 10000) / 100],
                [`${meter.id}.modelPattern`, meter.modelPattern ?? ''],
              ]),
            ),
          }}
          key={billing.updatedAt}
          onFinish={submitBilling}
          submitter={{
            resetButtonProps: false,
            searchConfig: { submitText: '保存计费规则' },
          }}
        >
          <ProFormDigit colProps={{ md: 8, xs: 24 }} fieldProps={{ precision: 2 }} label="平台定价（元）" min={0.01} name="platformPriceCny" rules={[{ required: true }]} />
          <ProFormDigit colProps={{ md: 8, xs: 24 }} label="平台 Token 数" min={1} name="platformTokens" rules={[{ required: true }]} />
          <ProFormText colProps={{ md: 8, xs: 24 }} disabled label="平台单价" name="unitPricePreview" placeholder={`${formatMoney(billing.platformPriceCny)} / ${formatTokens(billing.platformTokens)} Token`} />
          {billing.meters.map((meter) => (
            <ProCard bordered className="billing-meter-card" key={meter.id} title={`${sourceText(meter.type)} · ${meter.name}`}>
              <ProForm.Group>
                <ProFormDigit fieldProps={{ precision: 6 }} label="成本价（元）" min={0.000001} name={`${meter.id}.costCny`} rules={[{ required: true }]} width="sm" />
                <ProFormDigit label="计价单位 Token" min={1} name={`${meter.id}.costUnitTokens`} rules={[{ required: true }]} width="sm" />
                <ProFormDigit fieldProps={{ precision: 8 }} label="抵扣系数" min={0.000001} name={`${meter.id}.deductionFactor`} rules={[{ required: true }]} width="xs" />
                <ProFormDigit fieldProps={{ precision: 2 }} label="加价率（%）" min={0} name={`${meter.id}.markupRate`} rules={[{ required: true }]} width="xs" />
                <ProFormText label="模型匹配" name={`${meter.id}.modelPattern`} placeholder="可选，如 seedance-2" width="sm" />
                <ProFormSwitch checkedChildren="启用" label="状态" name={`${meter.id}.enabled`} unCheckedChildren="停用" />
              </ProForm.Group>
            </ProCard>
          ))}
        </ProForm>
      </ProCard>

      <ProCard
        className="section-card"
        extra={
          <Space wrap>
            <Tag color="blue">扣费 {formatTokens(ledgerSummary.platformTokens)} Token</Tag>
            <Tag color="green">收入 {formatMoney(ledgerSummary.billableCny)}</Tag>
            <Tag color="orange">成本 {formatMoney(ledgerSummary.costCny)}</Tag>
          </Space>
        }
        title="扣费明细账"
      >
        <Table<UsageLedgerEntry>
          columns={[
            { dataIndex: 'createdAt', title: '时间', width: 170, render: (value: string) => new Date(value).toLocaleString() },
            { dataIndex: 'source', title: '来源', width: 90, render: (value: UsageLedgerEntry['source']) => <Tag>{sourceText(value)}</Tag> },
            { dataIndex: 'userEmail', title: '用户', width: 220 },
            { dataIndex: 'model', title: '模型', ellipsis: true },
            { dataIndex: 'rawTokens', title: '原始 Token', width: 130, render: (value: number) => formatTokens(value) },
            { dataIndex: 'deductionFactor', title: '抵扣系数', width: 110, render: (value?: number) => value?.toFixed(8) ?? '1.00000000' },
            { dataIndex: 'billableProviderTokens', title: '上游计费 Token', width: 150, render: (value: number, row) => formatTokens(value ?? row.rawTokens) },
            { dataIndex: 'platformTokens', title: '扣平台 Token', width: 150, render: (value: number) => formatTokens(value) },
            { dataIndex: 'costCny', title: '成本', width: 110, render: (value: number) => formatMoney(value) },
            { dataIndex: 'billableCny', title: '计费', width: 110, render: (value: number) => formatMoney(value) },
          ]}
          dataSource={ledger}
          pagination={{ pageSize: 8 }}
          rowKey="id"
          scroll={{ x: 1420 }}
        />
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
