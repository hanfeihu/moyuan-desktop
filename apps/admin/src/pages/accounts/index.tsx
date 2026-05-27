import { MailOutlined, PlusCircleOutlined, ThunderboltOutlined, UserOutlined } from '@ant-design/icons'
import { PageContainer, ProCard, ProForm, ProFormDigit, ProFormSwitch, ProFormText, ProTable, StatisticCard } from '@ant-design/pro-components'
import { App, Button, InputNumber, Modal, Progress, Segmented, Space, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { AccountUser, MailServiceConfig } from '@eaw/shared'
import { defaultMailSettings } from '@/data/defaults'
import { loadMailSettings, loadUsers, saveMailSettings, saveUserQuota, sendTestMail } from '@/services/admin'

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export default function AccountsPage() {
  const { message } = App.useApp()
  const [mailSettings, setMailSettings] = useState<MailServiceConfig>(defaultMailSettings)
  const [users, setUsers] = useState<AccountUser[]>([])
  const [quotaTarget, setQuotaTarget] = useState<AccountUser | null>(null)
  const [quotaMode, setQuotaMode] = useState<'grant' | 'set'>('grant')
  const [quotaAmount, setQuotaAmount] = useState<number | null>(100000)
  const [quotaBusy, setQuotaBusy] = useState(false)
  const [testMailBusy, setTestMailBusy] = useState(false)

  useEffect(() => {
    void loadMailSettings().then(setMailSettings)
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

  async function save(values: Record<string, unknown>) {
    try {
      const payload = await saveMailSettings(values)
      setMailSettings(payload)
      message.success('邮箱服务配置已保存')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '邮箱服务配置保存失败')
    }
  }

  async function testMail() {
    setTestMailBusy(true)
    try {
      await sendTestMail()
      message.success('测试邮件已发送到发件邮箱')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '测试邮件发送失败')
    } finally {
      setTestMailBusy(false)
    }
  }

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
      extra={
        <Button disabled={!mailSettings.enabled || !mailSettings.authCodeConfigured} icon={<MailOutlined />} loading={testMailBusy} onClick={testMail} type="primary">
          发送测试邮件
        </Button>
      }
      subTitle="管理员工邮箱注册登录、SMTP 授权码和企业 Token 额度"
      title="账号与用量"
    >
      <StatisticCard.Group className="dashboard-stats">
        <StatisticCard statistic={{ title: '注册用户', value: usage.users, icon: <UserOutlined /> }} />
        <StatisticCard statistic={{ title: '已用 Token', value: usage.used }} footer={formatNumber(usage.used)} />
        <StatisticCard statistic={{ title: '总额度', value: usage.budget }} footer={formatNumber(usage.budget)} />
      </StatisticCard.Group>

      <ProCard
        className="section-card"
        extra={
          <Space wrap>
            <Tag color={mailSettings.enabled ? 'green' : 'default'}>{mailSettings.enabled ? '邮箱已启用' : '邮箱未启用'}</Tag>
            <Tag color={mailSettings.authCodeConfigured ? 'green' : 'orange'}>
              {mailSettings.authCodeConfigured ? '授权码已配置' : '授权码未配置'}
            </Tag>
          </Space>
        }
        title="邮箱验证码服务"
      >
        <div className={mailSettings.authCodeConfigured ? 'skill-key-status configured' : 'skill-key-status missing'}>
          <div className="skill-key-icon">
            <MailOutlined />
          </div>
          <div className="skill-key-copy">
            <strong>{mailSettings.authCodeConfigured ? 'QQ 邮箱授权码已配置' : 'QQ 邮箱授权码未配置'}</strong>
            <span>
              {mailSettings.authCodeConfigured
                ? `当前使用 ${mailSettings.maskedAuthCode}，留空保存会沿用现有授权码。`
                : '请填写 QQ 邮箱完整地址和授权码，客户端注册登录验证码会从这个邮箱发出。'}
            </span>
          </div>
          <Tag color={mailSettings.authCodeConfigured ? 'green' : 'orange'}>{mailSettings.maskedAuthCode}</Tag>
        </div>

        <ProForm
          grid
          initialValues={{
            authCode: '',
            enabled: mailSettings.enabled,
            fromName: mailSettings.fromName,
            secure: mailSettings.secure,
            smtpHost: mailSettings.smtpHost,
            smtpPort: mailSettings.smtpPort,
            username: mailSettings.username,
          }}
          key={`${mailSettings.username}-${mailSettings.maskedAuthCode}-${mailSettings.enabled}`}
          onFinish={save}
          submitter={{
            resetButtonProps: false,
            searchConfig: { submitText: '保存邮箱配置' },
          }}
        >
          <ProFormText colProps={{ md: 8, xs: 24 }} label="SMTP 服务器" name="smtpHost" />
          <ProFormDigit colProps={{ md: 4, xs: 12 }} label="端口" name="smtpPort" />
          <ProFormSwitch colProps={{ md: 4, xs: 12 }} label="SSL" name="secure" />
          <ProFormText colProps={{ md: 8, xs: 24 }} label="QQ 邮箱账号" name="username" placeholder="你的 QQ 邮箱完整地址" />
          <ProFormText.Password
            colProps={{ md: 8, xs: 24 }}
            label="授权码"
            name="authCode"
            placeholder={mailSettings.authCodeConfigured ? `已配置 ${mailSettings.maskedAuthCode}，留空沿用` : '请输入 QQ 邮箱授权码'}
          />
          <ProFormText colProps={{ md: 4, xs: 12 }} label="发件名称" name="fromName" />
          <ProFormSwitch colProps={{ md: 4, xs: 12 }} label="启用邮箱登录" name="enabled" />
        </ProForm>
      </ProCard>

      <ProCard className="section-card" title="用户与 Token 用量">
        <ProTable<AccountUser>
          columns={[
            { title: '邮箱', dataIndex: 'email' },
            { title: '姓名', dataIndex: 'name' },
            { title: '状态', dataIndex: 'status', render: (_, row) => <Tag color={row.status === 'active' ? 'green' : 'default'}>{row.status === 'active' ? '启用' : '停用'}</Tag> },
            {
              title: 'Token 水位',
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
                return (
                  <Tag className="quota-tag" color={remaining > 0 ? 'blue' : 'orange'}>
                    {remaining > 0 ? `${formatNumber(remaining)} 可用` : '等待派发'}
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
          新注册用户默认没有额度，需要管理员在后台派发；客户端每次任务完成后只上报本轮估算用量。
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
