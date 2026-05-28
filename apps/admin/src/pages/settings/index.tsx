import { CheckCircleOutlined, ExclamationCircleOutlined, MailOutlined } from '@ant-design/icons'
import { PageContainer, ProCard, ProForm, ProFormDigit, ProFormSwitch, ProFormText } from '@ant-design/pro-components'
import { App, Button, Space, Tag } from 'antd'
import { useEffect, useState } from 'react'
import type { MailServiceConfig } from '@eaw/shared'
import { defaultMailSettings } from '@/data/defaults'
import { loadMailSettings, saveMailSettings, sendTestMail } from '@/services/admin'

export default function SettingsPage() {
  const { message } = App.useApp()
  const [mailSettings, setMailSettings] = useState<MailServiceConfig>(defaultMailSettings)
  const [formSeed, setFormSeed] = useState(0)
  const [testMailBusy, setTestMailBusy] = useState(false)

  useEffect(() => {
    void loadMailSettings().then(setMailSettings)
  }, [])

  async function save(values: Record<string, unknown>) {
    try {
      const payload = await saveMailSettings(values)
      setMailSettings(payload)
      setFormSeed((current) => current + 1)
      message.success('系统设置已保存')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '系统设置保存失败')
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

  return (
    <PageContainer
      className="admin-page"
      extra={
        <Button disabled={!mailSettings.enabled || !mailSettings.authCodeConfigured} icon={<MailOutlined />} loading={testMailBusy} onClick={testMail} type="primary">
          发送测试邮件
        </Button>
      }
      subTitle="登录、邮件和基础服务"
      title="系统设置"
    >
      <ProCard
        extra={
          <Space wrap>
            <Tag color={mailSettings.enabled ? 'green' : 'default'}>{mailSettings.enabled ? '邮箱已启用' : '邮箱未启用'}</Tag>
            <Tag color={mailSettings.authCodeConfigured ? 'green' : 'orange'}>
              {mailSettings.authCodeConfigured ? '授权码已配置' : '授权码未配置'}
            </Tag>
          </Space>
        }
        title="邮箱验证码"
      >
        <div className={mailSettings.authCodeConfigured ? 'skill-key-status configured' : 'skill-key-status missing'}>
          <div className="skill-key-icon">
            {mailSettings.authCodeConfigured ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
          </div>
          <div className="skill-key-copy">
            <strong>{mailSettings.authCodeConfigured ? '授权码已配置' : '授权码未配置'}</strong>
            <span>{mailSettings.authCodeConfigured ? '留空保存会沿用当前授权码。' : '保存授权码后即可启用邮箱登录。'}</span>
          </div>
          <Tag color={mailSettings.authCodeConfigured ? 'green' : 'orange'}>{mailSettings.maskedAuthCode}</Tag>
        </div>

        <ProForm
          autoComplete="off"
          grid
          initialValues={{
            authCode: undefined,
            enabled: mailSettings.enabled,
            fromName: mailSettings.fromName,
            secure: mailSettings.secure,
            smtpHost: mailSettings.smtpHost,
            smtpPort: mailSettings.smtpPort,
            username: mailSettings.username,
          }}
          key={`${formSeed}-${mailSettings.username}-${mailSettings.enabled}-${mailSettings.authCodeConfigured}`}
          onFinish={save}
          preserve={false}
          submitter={{
            resetButtonProps: false,
            searchConfig: { submitText: '保存系统设置' },
          }}
        >
          <ProFormText colProps={{ md: 8, xs: 24 }} label="SMTP 服务器" name="smtpHost" />
          <ProFormDigit colProps={{ md: 4, xs: 12 }} label="端口" name="smtpPort" />
          <ProFormSwitch colProps={{ md: 4, xs: 12 }} label="SSL" name="secure" />
          <ProFormText colProps={{ md: 8, xs: 24 }} label="QQ 邮箱账号" name="username" placeholder="你的 QQ 邮箱完整地址" />
          <ProFormText.Password
            colProps={{ md: 8, xs: 24 }}
            fieldProps={{ autoComplete: 'new-password', className: 'secret-input', spellCheck: false }}
            label="授权码"
            name="authCode"
            placeholder={mailSettings.authCodeConfigured ? '已配置，留空沿用' : '请输入 QQ 邮箱授权码'}
          />
          <ProFormText colProps={{ md: 4, xs: 12 }} label="发件名称" name="fromName" />
          <ProFormSwitch colProps={{ md: 4, xs: 12 }} label="启用邮箱登录" name="enabled" />
        </ProForm>
      </ProCard>
    </PageContainer>
  )
}
