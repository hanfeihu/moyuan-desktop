import { history } from '@umijs/max'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { Button, Form, Input, message, Segmented } from 'antd'
import { useEffect, useState } from 'react'
import { loadAdminAuthState, loginAdmin, setupAdmin } from '@/services/admin'

type LoginMode = 'login' | 'setup'

export default function LoginPage() {
  const [form] = Form.useForm<{ password: string; username: string }>()
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(true)
  const [mode, setMode] = useState<LoginMode>('login')
  const [configuredUser, setConfiguredUser] = useState('')

  useEffect(() => {
    loadAdminAuthState()
      .then((state) => {
        setMode(state.configured ? 'login' : 'setup')
        setConfiguredUser(state.username)
        if (state.username) form.setFieldsValue({ username: state.username })
      })
      .catch(() => {
        setMode('setup')
      })
      .finally(() => setChecking(false))
  }, [form])

  async function submit(values: { password: string; username: string }) {
    setBusy(true)
    try {
      if (mode === 'setup') {
        await setupAdmin(values)
        message.success('管理员账号已初始化')
      } else {
        await loginAdmin(values)
        message.success('已进入墨渊控制台')
      }
      history.replace('/dashboard')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : mode === 'setup' ? '初始化失败' : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="admin-login-shell">
      <section className="admin-login-panel">
        <div className="admin-login-brand">
          <div className="admin-login-mark">墨</div>
          <div>
            <strong>墨渊控制台</strong>
            <span>企业 AI 能力与员工额度管理</span>
          </div>
        </div>

        <div className="admin-login-copy">
          <h1>{mode === 'setup' ? '初始化管理员' : '管理员登录'}</h1>
          <p>{mode === 'setup' ? '首次部署需要创建管理员账号，后续可在后台管理模型、技能和额度。' : '登录后配置模型、技能、系统设置和员工 Token 额度。'}</p>
        </div>

        <Segmented
          block
          className="admin-login-switch"
          disabled={checking || Boolean(configuredUser)}
          onChange={(value) => setMode(value as LoginMode)}
          options={[
            { label: '登录', value: 'login' },
            { label: '初始化', value: 'setup' },
          ]}
          value={mode}
        />

        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item label="管理员账号" name="username" rules={[{ message: '请输入管理员账号', required: true }]}>
            <Input autoComplete="username" disabled={checking || Boolean(configuredUser)} prefix={<UserOutlined />} size="large" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ message: '请输入至少 8 位密码', min: 8, required: true }]}>
            <Input.Password autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} prefix={<LockOutlined />} size="large" />
          </Form.Item>
          <Button block htmlType="submit" loading={busy || checking} size="large" type="primary">
            {mode === 'setup' ? '创建并进入' : '登录控制台'}
          </Button>
        </Form>
      </section>
    </main>
  )
}
