import { BookOutlined, LinkOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { PageContainer, ProCard } from '@ant-design/pro-components'
import { App, Button, Space, Tag, Typography } from 'antd'

const mobileAuthDocUrl = '/admin/docs/mobile-auth-api.html'

export default function DeveloperDocsPage() {
  const { message } = App.useApp()

  async function copyDocUrl() {
    const url = `${window.location.origin}${mobileAuthDocUrl}`
    await navigator.clipboard.writeText(url)
    message.success('文档链接已复制')
  }

  return (
    <PageContainer
      className="admin-page"
      extra={
        <Space wrap>
          <Button icon={<LinkOutlined />} onClick={copyDocUrl}>
            复制文档链接
          </Button>
          <Button href={mobileAuthDocUrl} icon={<BookOutlined />} target="_blank" type="primary">
            打开 HTML 文档
          </Button>
        </Space>
      }
      subTitle="给手机 App 端使用的用户登录、注册和 Token 鉴权说明"
      title="接口文档"
    >
      <ProCard gutter={16} wrap>
        <ProCard colSpan={{ md: 8, sm: 24, xs: 24 }} className="developer-doc-card">
          <div className="developer-doc-icon">
            <BookOutlined />
          </div>
          <Typography.Title level={4}>手机端用户认证</Typography.Title>
          <Typography.Paragraph type="secondary">
            包含发送验证码、注册登录、获取当前用户、Token 过期和错误响应示例。
          </Typography.Paragraph>
          <Button href={mobileAuthDocUrl} target="_blank" type="primary">
            查看文档
          </Button>
        </ProCard>
        <ProCard colSpan={{ md: 8, sm: 24, xs: 24 }} className="developer-doc-card">
          <div className="developer-doc-icon muted">
            <LinkOutlined />
          </div>
          <Typography.Title level={4}>App 接入地址</Typography.Title>
          <Typography.Paragraph copyable code>
            http://codex.tminos.com:18080/admin-api
          </Typography.Paragraph>
          <Space wrap>
            <Tag color="blue">POST /auth/send-code</Tag>
            <Tag color="blue">POST /auth/register</Tag>
            <Tag color="blue">POST /auth/login</Tag>
            <Tag color="green">GET /me</Tag>
          </Space>
        </ProCard>
        <ProCard colSpan={{ md: 8, sm: 24, xs: 24 }} className="developer-doc-card">
          <div className="developer-doc-icon success">
            <SafetyCertificateOutlined />
          </div>
          <Typography.Title level={4}>Token 鉴权</Typography.Title>
          <Typography.Paragraph type="secondary">
            App 登录成功后保存 token，后续请求统一携带 Authorization 请求头。
          </Typography.Paragraph>
          <Typography.Text code>Authorization: Bearer &lt;token&gt;</Typography.Text>
        </ProCard>
      </ProCard>

      <ProCard className="section-card" title="给 App 开发者的接入顺序">
        <div className="developer-doc-steps">
          <div>
            <strong>1. 发送验证码</strong>
            <span>用户输入邮箱后调用发送验证码接口，成功后再允许填写验证码。</span>
          </div>
          <div>
            <strong>2. 注册或登录</strong>
            <span>新用户走注册接口，已有用户走登录接口；成功后都会返回 user 和 token。</span>
          </div>
          <div>
            <strong>3. 保存 Token</strong>
            <span>App 本地安全保存 token，所有需要登录态的接口都使用 Bearer Token。</span>
          </div>
          <div>
            <strong>4. 校验当前用户</strong>
            <span>App 启动或恢复前台时可调用 /me，401 时清除本地登录态并重新登录。</span>
          </div>
        </div>
      </ProCard>
    </PageContainer>
  )
}
