import { PlusCircleOutlined, ThunderboltOutlined, UserOutlined } from '@ant-design/icons'
import { PageContainer, ProCard, ProTable, StatisticCard } from '@ant-design/pro-components'
import { App, Button, InputNumber, Modal, Progress, Segmented, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { AccountUser } from '@eaw/shared'
import { loadUsers, saveUserQuota } from '@/services/admin'

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export default function AccountsPage() {
  const { message } = App.useApp()
  const [users, setUsers] = useState<AccountUser[]>([])
  const [quotaTarget, setQuotaTarget] = useState<AccountUser | null>(null)
  const [quotaMode, setQuotaMode] = useState<'grant' | 'set'>('grant')
  const [quotaAmount, setQuotaAmount] = useState<number | null>(100000)
  const [quotaBusy, setQuotaBusy] = useState(false)

  useEffect(() => {
    void loadUsers().then(setUsers)
  }, [])

  const usage = useMemo(
    () =>
      users.reduce(
        (total, user) => ({
          budget: total.budget + user.tokenBudget,
          used: total.used + user.tokenUsed,
          users: total.users + 1,
        }),
        { budget: 0, used: 0, users: 0 },
      ),
    [users],
  )

  function openQuotaModal(user: AccountUser) {
    setQuotaTarget(user)
    setQuotaMode('grant')
    setQuotaAmount(100000)
  }

  async function submitQuota() {
    if (!quotaTarget || quotaAmount === null) return
    setQuotaBusy(true)
    try {
      const updated = await saveUserQuota(quotaTarget.id, { amount: quotaAmount, mode: quotaMode })
      setUsers((current) => current.map((user) => (user.id === updated.id ? updated : user)))
      setQuotaTarget(null)
      message.success(quotaMode === 'grant' ? '额度已派发' : '总额度已调整')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '额度保存失败')
    } finally {
      setQuotaBusy(false)
    }
  }

  return (
    <PageContainer
      className="admin-page"
      subTitle="管理员工注册用户和企业 Token 额度"
      title="账号与用量"
    >
      <StatisticCard.Group className="dashboard-stats">
        <StatisticCard statistic={{ title: '注册用户', value: usage.users, icon: <UserOutlined /> }} />
        <StatisticCard statistic={{ title: '已用 Token', value: usage.used }} />
        <StatisticCard statistic={{ title: '总额度', value: usage.budget }} />
      </StatisticCard.Group>

      <ProCard className="section-card" title="用户与 Token 用量">
        <ProTable<AccountUser>
          columns={[
            { title: '邮箱', dataIndex: 'email' },
            { title: '姓名', dataIndex: 'name' },
            { title: '状态', dataIndex: 'status', render: (_, row) => <Tag color={row.status === 'active' ? 'green' : 'default'}>{row.status === 'active' ? '启用' : '停用'}</Tag> },
            {
              title: 'Token 使用进度',
              dataIndex: 'tokenUsed',
              render: (_, row) => {
                const percent = row.tokenBudget > 0 ? Math.min(100, Math.round((row.tokenUsed / row.tokenBudget) * 100)) : 0
                const depleted = row.tokenBudget <= row.tokenUsed
                return (
                  <div className="quota-cell">
                    <div>
                      <strong>{formatNumber(row.tokenUsed)}</strong>
                      <span>/ {formatNumber(row.tokenBudget)}</span>
                    </div>
                    <Progress percent={percent} showInfo={false} size="small" status={depleted ? 'exception' : 'active'} />
                  </div>
                )
              },
            },
            {
              title: '剩余额度',
              dataIndex: 'tokenBudget',
              render: (_, row) => {
                const remaining = Math.max(0, row.tokenBudget - row.tokenUsed)
                const quotaState = row.tokenBudget <= 0 ? '尚未派发' : remaining <= 0 ? '已耗尽' : `${formatNumber(remaining)} 可用`
                const quotaColor = row.tokenBudget <= 0 ? 'default' : remaining <= 0 ? 'red' : 'blue'
                return (
                  <Tag className="quota-tag" color={quotaColor}>
                    {quotaState}
                  </Tag>
                )
              },
            },
            { title: '最后登录', dataIndex: 'lastLoginAt', renderText: (value) => value || '-' },
            {
              title: '额度派发',
              valueType: 'option',
              width: 130,
              render: (_, row) => (
                <Button icon={<PlusCircleOutlined />} onClick={() => openQuotaModal(row)} size="small" type="primary">
                  派发
                </Button>
              ),
            },
          ]}
          dataSource={users}
          options={false}
          pagination={{ pageSize: 8 }}
          rowKey="id"
          search={false}
          scroll={{ x: 980 }}
        />
        <Typography.Paragraph className="quiet-note">
          新注册用户默认没有额度，需要管理员在后台派发。
        </Typography.Paragraph>
      </ProCard>

      <Modal
        confirmLoading={quotaBusy}
        okText={quotaMode === 'grant' ? '确认派发' : '保存总额度'}
        onCancel={() => setQuotaTarget(null)}
        onOk={submitQuota}
        open={Boolean(quotaTarget)}
        title="派发 Token 额度"
      >
        {quotaTarget ? (
          <div className="quota-modal">
            <div className="quota-user-card">
              <div className="quota-user-icon">
                <ThunderboltOutlined />
              </div>
              <div>
                <strong>{quotaTarget.name || quotaTarget.email}</strong>
                <span>
                  已用 {formatNumber(quotaTarget.tokenUsed)}，总额 {formatNumber(quotaTarget.tokenBudget)}
                </span>
              </div>
            </div>
            <Segmented
              block
              onChange={(value) => setQuotaMode(value as 'grant' | 'set')}
              options={[
                { label: '追加额度', value: 'grant' },
                { label: '设置总额', value: 'set' },
              ]}
              value={quotaMode}
            />
            <InputNumber
              addonAfter="Token"
              className="quota-input"
              min={quotaMode === 'grant' ? 1 : quotaTarget.tokenUsed}
              onChange={(value) => setQuotaAmount(typeof value === 'number' ? value : null)}
              placeholder={quotaMode === 'grant' ? '输入要追加的额度' : '输入新的总额度'}
              precision={0}
              step={10000}
              value={quotaAmount}
            />
            <Typography.Paragraph className="quiet-note">
              {quotaMode === 'grant'
                ? '追加额度会叠加到该用户现有总额，适合按月或按项目发放。'
                : '设置总额不能低于用户已使用 Token，避免出现账面倒挂。'}
            </Typography.Paragraph>
          </div>
        ) : null}
      </Modal>
    </PageContainer>
  )
}
