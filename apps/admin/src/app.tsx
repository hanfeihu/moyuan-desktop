import type { RunTimeLayoutConfig } from '@umijs/max'
import { history } from '@umijs/max'
import { LogoutOutlined } from '@ant-design/icons'
import { App, Button, ConfigProvider, Tag, theme } from 'antd'
import React from 'react'
import { clearAdminToken, isAdminSignedIn } from '@/services/admin'
import moyuanIcon from '@/assets/moyuan-icon.svg'
import './global.css'

export async function getInitialState() {
  return {
    name: '墨渊控制台',
  }
}

export const layout: RunTimeLayoutConfig = () => ({
  actionsRender: () => [
    <Tag bordered={false} color="blue" key="edition">
      企业本地化
    </Tag>,
    <Button
      icon={<LogoutOutlined />}
      key="logout"
      onClick={() => {
        clearAdminToken()
        history.push('/login')
      }}
      size="small"
      type="text"
    >
      退出
    </Button>,
  ],
  avatarProps: {
    title: '管理员',
  },
  disableContentMargin: false,
  footerRender: false,
  layout: 'side',
  logo: false,
  menu: {
    locale: false,
  },
  menuHeaderRender: () => (
    <div className="admin-menu-brand">
      <img alt="墨渊" className="admin-logo-mark" src={moyuanIcon} />
      <span>墨渊控制台</span>
    </div>
  ),
  navTheme: 'light',
  onMenuHeaderClick: () => history.push('/dashboard'),
  onPageChange: () => {
    const pathname = history.location.pathname
    if (!isAdminSignedIn() && !pathname.endsWith('/login')) {
      history.push('/login')
    }
  },
  primaryColor: '#1677ff',
  splitMenus: false,
  title: '墨渊控制台',
})

export function rootContainer(container: React.ReactNode) {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          borderRadius: 8,
          colorBgLayout: '#f4f7fb',
          colorPrimary: '#1677ff',
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      }}
    >
      <App>{container}</App>
    </ConfigProvider>
  )
}
