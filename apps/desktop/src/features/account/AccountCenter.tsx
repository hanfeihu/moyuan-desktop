import { Check, Copy, CreditCard, Download, Image, Images, LogOut, Play, Search, User, Video, Wallet, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AccountUser, CodexTask, GeneratedAssetRecord, UsageLedgerEntry, UserWorkspaceSummary } from '@eaw/shared'
import { enterpriseFetch } from '../../api'
import { errorLogDetails, logClientEvent } from '../../logger'
import { formatTokenNumber } from '../../utils/format'
import { taskResources } from '../chat/ResourceCards'

type AccountResource = {
  billableCny?: number
  deductionFactor?: number
  createdAt: string
  id: string
  model?: string
  prompt?: string
  title: string
  type: 'image' | 'video'
  usageTokens?: number
  url?: string
}

type AccountSection = 'resources' | 'billing' | 'profile'
type ResourceFilter = 'all' | 'image' | 'video'

function readPayload<T>(response: Response) {
  return response.json().then((payload: { data?: T; error?: string }) => {
    if (!response.ok || payload.data == null) throw new Error(payload.error ?? '请求失败')
    return payload.data
  })
}

function money(value?: number) {
  return typeof value === 'number' ? `¥${value.toFixed(4)}` : '待结算'
}

function shortDate(value?: string) {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function accountInitial(user: AccountUser) {
  const source = (user.name || user.email || '墨').trim()
  return Array.from(source)[0] ?? '墨'
}

function assetToResource(asset: GeneratedAssetRecord): AccountResource | undefined {
  const url = asset.storageUrl || asset.url
  const lastFrameUrl = typeof asset.metadata?.lastFrameUrl === 'string' ? asset.metadata.lastFrameUrl : undefined
  if (!url && !lastFrameUrl) return undefined
  return {
    billableCny: asset.billableCny,
    deductionFactor: asset.deductionFactor,
    createdAt: asset.createdAt,
    id: asset.id,
    model: asset.model,
    prompt: asset.prompt,
    title: asset.type === 'video' ? '生成视频' : '生成图片',
    type: asset.type,
    usageTokens: asset.tokenUsage,
    url: url || lastFrameUrl,
  }
}

function localTaskResources(tasks: CodexTask[]) {
  return tasks.flatMap((task) =>
    taskResources(task)
      .filter((resource) => resource.type === 'image' || resource.type === 'video')
      .map((resource) => ({
        billableCny: resource.billableCny,
        deductionFactor: resource.deductionFactor,
        createdAt: resource.createdAt,
        id: `${task.id}-${resource.id}`,
        model: resource.model,
        prompt: resource.prompt,
        title: resource.title,
        type: resource.type as 'image' | 'video',
        usageTokens: resource.usageTokens,
        url: resource.url,
      })),
  )
}

export function AccountCenter({
  authToken,
  onClose,
  onLogout,
  onRecharge,
  open,
  tasks,
  user,
}: {
  authToken: string
  onClose: () => void
  onLogout: () => void
  onRecharge: () => void
  open: boolean
  tasks: CodexTask[]
  user: AccountUser
}) {
  const [activeSection, setActiveSection] = useState<AccountSection>('resources')
  const [copiedId, setCopiedId] = useState('')
  const [loading, setLoading] = useState(false)
  const [resourceFilter, setResourceFilter] = useState<ResourceFilter>('all')
  const [resourceQuery, setResourceQuery] = useState('')
  const [summary, setSummary] = useState<UserWorkspaceSummary | null>(null)
  const localResources = useMemo(() => localTaskResources(tasks), [tasks])
  const remoteResources = useMemo(() => (summary?.assets ?? []).map(assetToResource).filter(Boolean) as AccountResource[], [summary?.assets])
  const resources = useMemo(() => {
    const seen = new Set<string>()
    return [...remoteResources, ...localResources]
      .filter((resource) => {
        const key = resource.url || resource.id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
  }, [localResources, remoteResources])
  const ledger = summary?.usageLedger ?? []
  const imageCount = totalsCount(resources, 'image')
  const videoCount = totalsCount(resources, 'video')
  const remaining = Math.max(0, user.tokenBudget - user.tokenUsed)
  const usedPercent = user.tokenBudget > 0 ? Math.min(100, Math.round((user.tokenUsed / user.tokenBudget) * 100)) : 0
  const totals = summary?.totals
  const platformTokenTotal = totals?.platformTokens ?? ledger.reduce((sum, item) => sum + item.platformTokens, 0)
  const filteredResources = useMemo(() => {
    const query = resourceQuery.trim().toLowerCase()
    return resources.filter((resource) => {
      if (resourceFilter !== 'all' && resource.type !== resourceFilter) return false
      if (!query) return true
      return [resource.title, resource.model, resource.prompt, shortDate(resource.createdAt)]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(query))
    })
  }, [resourceFilter, resourceQuery, resources])

  useEffect(() => {
    if (!open || !authToken) return
    let cancelled = false
    setLoading(true)
    enterpriseFetch('/me/workspace', authToken, { timeoutMs: 8000 })
      .then((response) => readPayload<UserWorkspaceSummary>(response))
      .then((payload) => {
        if (!cancelled) setSummary(payload)
      })
      .catch((loadError) => {
        if (cancelled) return
        logClientEvent('account.workspace.load_failed', errorLogDetails(loadError), 'warn')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authToken, open])

  if (!open) return null

  async function copyUrl(resource: AccountResource) {
    if (!resource.url) return
    await navigator.clipboard.writeText(resource.url)
    setCopiedId(resource.id)
    window.setTimeout(() => setCopiedId(''), 1200)
  }

  return (
    <div className="account-center-backdrop" onMouseDown={onClose}>
      <section className="account-center-panel" aria-label="我的中心" aria-modal="true" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <button aria-label="关闭" className="account-center-close" onClick={onClose} type="button">
          <X size={18} />
        </button>
        <div className="account-center-layout">
          <aside className="account-center-sidebar">
            <header className="account-center-head">
              <span className="account-avatar" aria-hidden="true">{accountInitial(user)}</span>
              <div>
                <span>我的中心</span>
                <strong>{user.name || user.email}</strong>
                <small>{user.email}</small>
              </div>
            </header>
            <nav className="account-menu" aria-label="个人中心菜单">
              <button className={activeSection === 'resources' ? 'active' : ''} onClick={() => setActiveSection('resources')} type="button">
                <Images size={16} />
                <span>资源</span>
                <em>{resources.length}</em>
              </button>
              <button className={activeSection === 'billing' ? 'active' : ''} onClick={() => setActiveSection('billing')} type="button">
                <CreditCard size={16} />
                <span>扣费</span>
                <em>{ledger.length}</em>
              </button>
              <button className={activeSection === 'profile' ? 'active' : ''} onClick={() => setActiveSection('profile')} type="button">
                <User size={16} />
                <span>账号</span>
              </button>
            </nav>
            <button className="account-logout-button" onClick={onLogout} type="button">
              <LogOut size={14} />
              退出登录
            </button>
          </aside>

          <div className="account-center-main">
            <section className="account-quota-card">
              <div>
                <span>Token 余额</span>
                <strong>{formatTokenNumber(remaining)}</strong>
                <small>已用 {formatTokenNumber(user.tokenUsed)} / 总额 {formatTokenNumber(user.tokenBudget)}</small>
              </div>
              <div className="account-quota-side">
                <button onClick={onRecharge} type="button">
                  <Wallet size={15} />
                  充值
                </button>
                <span>{usedPercent}% 已用</span>
              </div>
              <div className="account-quota-bar">
                <i style={{ width: `${usedPercent}%` }} />
              </div>
            </section>

            {activeSection === 'resources' ? (
              <section className="account-section account-resources-section">
                <div className="account-content-head">
                  <div>
                    <strong>生成资源</strong>
                    <span>{loading ? '同步中' : resourceQuery || resourceFilter !== 'all' ? `已显示 ${filteredResources.length} 个` : `共 ${resources.length} 个资源`}</span>
                  </div>
                </div>
                <div className="account-resource-toolbar">
                  <div className="account-resource-filters">
                    <button className={resourceFilter === 'all' ? 'active' : ''} onClick={() => setResourceFilter('all')} type="button">全部</button>
                    <button className={resourceFilter === 'image' ? 'active' : ''} onClick={() => setResourceFilter('image')} type="button">图片 {totals?.images ?? imageCount}</button>
                    <button className={resourceFilter === 'video' ? 'active' : ''} onClick={() => setResourceFilter('video')} type="button">视频 {totals?.videos ?? videoCount}</button>
                  </div>
                  <label className="account-resource-search">
                    <Search size={14} />
                    <input onChange={(event) => setResourceQuery(event.target.value)} placeholder="搜索资源" value={resourceQuery} />
                  </label>
                </div>
                <div className="account-resource-list">
                  {filteredResources.slice(0, 12).map((resource) => (
                    <article className="account-resource-card" key={resource.id}>
                      <div className={`account-resource-preview ${resource.type}`}>
                        {resource.type === 'video' && resource.url ? <video muted preload="metadata" src={resource.url} /> : resource.url ? <img alt="" src={resource.url} /> : resource.type === 'video' ? <Video size={20} /> : <Image size={20} />}
                        <span className="account-resource-badge">{resource.type === 'video' ? <><Play size={11} /> 视频</> : '图片'}</span>
                      </div>
                      <div className="account-resource-main">
                        <strong>{resource.title}</strong>
                        <span>{resource.model || '默认模型'}</span>
                        <small>{resource.usageTokens ? `${formatTokenNumber(resource.usageTokens)} Token` : 'Token 待结算'}</small>
                        <small>{shortDate(resource.createdAt)} {resource.billableCny ? `· ${money(resource.billableCny)}` : ''}</small>
                      </div>
                      <div className="account-resource-actions">
                        {resource.url ? <button onClick={() => void copyUrl(resource)} title="复制链接" type="button">{copiedId === resource.id ? <Check size={14} /> : <Copy size={14} />}</button> : null}
                        {resource.url ? <a href={resource.url} download rel="noreferrer" target="_blank" title="下载"><Download size={14} /></a> : null}
                      </div>
                    </article>
                  ))}
                  {!filteredResources.length ? <div className="account-empty">还没有符合条件的资源</div> : null}
                </div>
              </section>
            ) : null}

            {activeSection === 'billing' ? (
              <section className="account-section account-ledger-section">
                <div className="account-content-head">
                  <div>
                    <strong>扣费明细</strong>
                    <span>{ledger.length ? `${formatTokenNumber(platformTokenTotal)} Token · ${money(totals?.billableCny)}` : '暂无记录'}</span>
                  </div>
                </div>
                <div className="account-ledger-list">
                  {ledger.slice(0, 12).map((entry) => <LedgerRow entry={entry} key={entry.id} />)}
                  {!ledger.length ? <div className="account-empty">完成生成或对话后会显示扣费</div> : null}
                </div>
              </section>
            ) : null}

            {activeSection === 'profile' ? (
              <section className="account-section account-profile-section">
                <div className="account-content-head">
                  <div>
                    <strong>账号信息</strong>
                    <span>当前登录与资源统计</span>
                  </div>
                </div>
                <div className="account-stat-grid">
                  <div><span>资源</span><strong>{totals?.assets ?? resources.length}</strong></div>
                  <div><span>图片</span><strong>{totals?.images ?? imageCount}</strong></div>
                  <div><span>视频</span><strong>{totals?.videos ?? videoCount}</strong></div>
                  <div><span>扣费</span><strong>{formatTokenNumber(platformTokenTotal)}</strong></div>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}

function totalsCount(resources: AccountResource[], type: AccountResource['type']) {
  return resources.filter((resource) => resource.type === type).length
}

function LedgerRow({ entry }: { entry: UsageLedgerEntry }) {
  const label = entry.source === 'video' ? '视频生成' : entry.source === 'image' ? '图片生成' : '大脑调用'
  return (
    <div className="account-ledger-row">
      <span>{label}</span>
      <strong>{formatTokenNumber(entry.platformTokens)} Token</strong>
      <small>{money(entry.billableCny)} · 系数 {(entry.deductionFactor ?? 1).toFixed(4)} · {shortDate(entry.createdAt)}</small>
    </div>
  )
}
