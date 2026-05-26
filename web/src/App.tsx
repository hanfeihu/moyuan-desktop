import { useMemo, useState } from 'react'
import './App.css'

type ReportStatus = 'draft' | 'review' | 'submitted'

type WorkReport = {
  id: number
  owner: string
  team: string
  title: string
  summary: string
  status: ReportStatus
  score: number
  updatedAt: string
}

type Connector = {
  name: string
  status: 'connected' | 'pending' | 'disabled'
  scope: string
  synced: string
}

const reports: WorkReport[] = [
  {
    id: 1,
    owner: '韩飞虎',
    team: '销售一组',
    title: '重点客户推进日报',
    summary: '跟进 3 个重点客户，完成报价材料更新，发现华东项目审批链路存在延迟风险。',
    status: 'review',
    score: 88,
    updatedAt: '10:20',
  },
  {
    id: 2,
    owner: '林青',
    team: '交付中心',
    title: '项目交付周报',
    summary: '完成企业微信组织同步联调，剩余飞书审批回调和钉钉待办映射待确认。',
    status: 'submitted',
    score: 93,
    updatedAt: '09:46',
  },
  {
    id: 3,
    owner: '周然',
    team: '产品部',
    title: '企业 AI 客户访谈记录',
    summary: '客户更关注可控审计、知识权限继承、员工日报自动汇总，不希望被描述成监控。',
    status: 'draft',
    score: 76,
    updatedAt: '08:35',
  },
]

const connectors: Connector[] = [
  { name: '企业微信', status: 'connected', scope: '通讯录、群聊、日程、微盘', synced: '2 分钟前' },
  { name: '飞书', status: 'connected', scope: '组织架构、文档、任务、审批', synced: '8 分钟前' },
  { name: '钉钉', status: 'pending', scope: '通讯录、待办、OA 审批', synced: '待授权' },
]

const auditItems = [
  '韩飞虎生成日报并提交主管复核',
  '销售一组知识库检索命中 12 篇客户资料',
  'AI 尝试读取飞书审批，被策略要求人工确认',
  '管理员调整研发部高级模型额度',
]

const prompts = [
  '根据今天的客户沟通，帮我生成日报',
  '总结销售一组本周进展和风险',
  '哪些项目需要主管介入？',
  '把会议纪要拆成待办并分配负责人',
]

function statusLabel(status: ReportStatus) {
  return {
    draft: '草稿',
    review: '待复核',
    submitted: '已提交',
  }[status]
}

function App() {
  const [activePrompt, setActivePrompt] = useState(prompts[0])
  const [message, setMessage] = useState('')

  const teamAverage = useMemo(() => {
    return Math.round(reports.reduce((sum, item) => sum + item.score, 0) / reports.length)
  }, [])

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>企业 AI 工作台</strong>
            <span>本地化部署版</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <button className="nav-item active">工作助手</button>
          <button className="nav-item">日报周报</button>
          <button className="nav-item">团队看板</button>
          <button className="nav-item">知识库</button>
          <button className="nav-item">审计中心</button>
          <button className="nav-item">系统设置</button>
        </nav>

        <section className="control-panel">
          <span className="section-label">企业可控</span>
          <div className="policy-row">
            <span>数据出域</span>
            <strong>禁止</strong>
          </div>
          <div className="policy-row">
            <span>高风险动作</span>
            <strong>需确认</strong>
          </div>
          <div className="policy-row">
            <span>审计日志</span>
            <strong>开启</strong>
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>员工提效，企业可控</h1>
            <p>把员工每天散落在聊天、会议、文档、任务里的工作过程，沉淀成可复盘的工作成果。</p>
          </div>
          <button className="primary-action">新建日报</button>
        </header>

        <section className="metric-grid" aria-label="今日概览">
          <article className="metric-card">
            <span>今日日报</span>
            <strong>128</strong>
            <small>其中 24 条待主管复核</small>
          </article>
          <article className="metric-card">
            <span>团队效能分</span>
            <strong>{teamAverage}</strong>
            <small>基于任务闭环和工作成果</small>
          </article>
          <article className="metric-card">
            <span>接入员工</span>
            <strong>1,426</strong>
            <small>来自企微、飞书、钉钉</small>
          </article>
          <article className="metric-card">
            <span>受控工具</span>
            <strong>36</strong>
            <small>14 个动作需要人工确认</small>
          </article>
        </section>

        <section className="content-grid">
          <article className="assistant-panel">
            <div className="panel-header">
              <div>
                <span className="section-label">员工端</span>
                <h2>AI 工作助手</h2>
              </div>
              <span className="live-badge">私有环境</span>
            </div>

            <div className="prompt-list">
              {prompts.map((prompt) => (
                <button
                  className={prompt === activePrompt ? 'prompt active' : 'prompt'}
                  key={prompt}
                  onClick={() => setActivePrompt(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>

            <div className="chat-preview">
              <div className="chat-bubble user">{activePrompt}</div>
              <div className="chat-bubble ai">
                我会先读取你有权限的聊天、会议和任务记录，生成草稿后交给你确认。涉及客户金额、审批和外发动作时，会进入企业策略复核。
              </div>
            </div>

            <label className="composer">
              <span>输入工作需求</span>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="例如：帮我根据今天的飞书沟通和客户资料生成日报"
              />
            </label>
          </article>

          <article className="manager-panel">
            <div className="panel-header">
              <div>
                <span className="section-label">管理端</span>
                <h2>团队工作看板</h2>
              </div>
              <button className="ghost-action">生成团队周报</button>
            </div>

            <div className="report-list">
              {reports.map((report) => (
                <div className="report-item" key={report.id}>
                  <div className="report-main">
                    <span className={`status ${report.status}`}>{statusLabel(report.status)}</span>
                    <strong>{report.title}</strong>
                    <p>{report.summary}</p>
                    <small>
                      {report.owner} · {report.team} · {report.updatedAt}
                    </small>
                  </div>
                  <div className="score-ring" aria-label={`效能分 ${report.score}`}>
                    {report.score}
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="bottom-grid">
          <article className="integration-panel">
            <div className="panel-header">
              <div>
                <span className="section-label">数据来源</span>
                <h2>组织与办公系统接入</h2>
              </div>
            </div>
            <div className="connector-list">
              {connectors.map((connector) => (
                <div className="connector" key={connector.name}>
                  <div>
                    <strong>{connector.name}</strong>
                    <span>{connector.scope}</span>
                  </div>
                  <small className={connector.status}>{connector.synced}</small>
                </div>
              ))}
            </div>
          </article>

          <article className="audit-panel">
            <div className="panel-header">
              <div>
                <span className="section-label">可追溯</span>
                <h2>审计事件</h2>
              </div>
            </div>
            <ul className="audit-list">
              {auditItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        </section>
      </section>
    </main>
  )
}

export default App
