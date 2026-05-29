import { Check, ExternalLink, Loader2, Wallet, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { RechargeOrder, TokenPlan } from '@eaw/shared'
import { enterpriseFetch } from '../../api'
import { errorLogDetails, logClientEvent } from '../../logger'
import { formatTokenNumber } from '../../utils/format'

type PaymentMethod = RechargeOrder['method']

function formatMoney(value: number) {
  return `¥${value.toFixed(2)}`
}

async function readJson<T>(response: Response) {
  const payload = (await response.json()) as { data?: T; error?: string }
  if (!response.ok || payload.data == null) throw new Error(payload.error ?? '请求失败')
  return payload.data
}

export function RechargeDialog({
  authToken,
  onClose,
  onRefreshUser,
  open,
}: {
  authToken: string
  onClose: () => void
  onRefreshUser: () => Promise<unknown>
  open: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('alipay')
  const [orders, setOrders] = useState<RechargeOrder[]>([])
  const [plans, setPlans] = useState<TokenPlan[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const selectedPlan = useMemo(() => plans.find((plan) => plan.id === selectedPlanId) ?? plans[0], [plans, selectedPlanId])

  useEffect(() => {
    if (!open || !authToken) return

    let cancelled = false
    setBusy(true)
    setError('')
    Promise.all([
      enterpriseFetch('/me/recharge-plans', authToken).then((response) => readJson<TokenPlan[]>(response)),
      enterpriseFetch('/me/recharge-orders', authToken).then((response) => readJson<RechargeOrder[]>(response)),
    ])
      .then(([nextPlans, nextOrders]) => {
        if (cancelled) return
        setPlans(nextPlans)
        setOrders(nextOrders)
        setSelectedPlanId((current) => current || nextPlans[0]?.id || '')
      })
      .catch((loadError) => {
        if (cancelled) return
        logClientEvent('billing.load.failed', errorLogDetails(loadError), 'warn')
        setError(loadError instanceof Error ? loadError.message : '充值配置加载失败')
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })

    return () => {
      cancelled = true
    }
  }, [authToken, open])

  async function createOrder() {
    if (!selectedPlan) return
    setBusy(true)
    setError('')
    logClientEvent('billing.order.create.start', { method, planId: selectedPlan.id })
    try {
      const response = await enterpriseFetch('/me/recharge-orders', authToken, {
        body: JSON.stringify({ method, planId: selectedPlan.id }),
        method: 'POST',
      })
      const order = await readJson<RechargeOrder>(response)
      setOrders((current) => [order, ...current.filter((item) => item.id !== order.id)])
      logClientEvent('billing.order.create.success', { orderId: order.id, outTradeNo: order.outTradeNo })
      if (order.payUrl) window.open(order.payUrl, '_blank', 'noopener,noreferrer')
    } catch (orderError) {
      logClientEvent('billing.order.create.failed', errorLogDetails(orderError, { method, planId: selectedPlan.id }), 'warn')
      setError(orderError instanceof Error ? orderError.message : '支付订单创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function refreshPaymentState() {
    setBusy(true)
    setError('')
    try {
      const nextOrders = await enterpriseFetch('/me/recharge-orders', authToken).then((response) => readJson<RechargeOrder[]>(response))
      setOrders(nextOrders)
      await onRefreshUser()
      logClientEvent('billing.refresh.success')
    } catch (refreshError) {
      logClientEvent('billing.refresh.failed', errorLogDetails(refreshError), 'warn')
      setError(refreshError instanceof Error ? refreshError.message : '支付状态刷新失败')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="recharge-overlay" role="presentation">
      <section aria-label="Token 充值" className="recharge-dialog">
        <header className="recharge-header">
          <div>
            <span>Token 充值</span>
            <strong>选择套餐后进入收银台</strong>
          </div>
          <button className="recharge-close" onClick={onClose} title="关闭" type="button">
            <X size={16} />
          </button>
        </header>

        {error ? <div className="recharge-error">{error}</div> : null}

        <div className="recharge-plans">
          {plans.map((plan) => (
            <button className={`recharge-plan ${selectedPlan?.id === plan.id ? 'selected' : ''}`} key={plan.id} onClick={() => setSelectedPlanId(plan.id)} type="button">
              <span>{plan.name}</span>
              <strong>{formatMoney(plan.price)}</strong>
              <em>{formatTokenNumber(plan.tokens)} Token</em>
              {plan.description ? <small>{plan.description}</small> : null}
            </button>
          ))}
          {!busy && plans.length === 0 ? <div className="recharge-empty">后台还没有上架套餐</div> : null}
        </div>

        <div className="recharge-methods">
          <button className={method === 'alipay' ? 'selected' : ''} onClick={() => setMethod('alipay')} type="button">
            支付宝
          </button>
          <button className={method === 'wxpay' ? 'selected' : ''} onClick={() => setMethod('wxpay')} type="button">
            微信支付
          </button>
        </div>

        <footer className="recharge-footer">
          <button className="recharge-secondary" disabled={busy} onClick={refreshPaymentState} type="button">
            <Check size={15} />
            我已完成支付
          </button>
          <button className="recharge-primary" disabled={busy || !selectedPlan} onClick={createOrder} type="button">
            {busy ? <Loader2 className="spin" size={16} /> : <Wallet size={16} />}
            去支付
            <ExternalLink size={14} />
          </button>
        </footer>

        {orders.length > 0 ? (
          <div className="recharge-orders">
            <span>最近订单</span>
            {orders.slice(0, 3).map((order) => (
              <div className="recharge-order" key={order.id}>
                <b>{order.planName}</b>
                <em>{formatMoney(order.amount)}</em>
                <small className={order.status}>{order.status === 'paid' ? '已到账' : order.status === 'pending' ? '待支付' : '未完成'}</small>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  )
}
