import type { RunTimeLayoutConfig } from '@umijs/max'
import { history } from '@umijs/max'
import { App, ConfigProvider, Tag, theme } from 'antd'
import React from 'react'
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
  ],
  avatarProps: {
    title: '管理员',
  },
  disableContentMargin: false,
  footerRender: false,
  layout: 'mix',
  logo: <div className="admin-logo-mark">墨</div>,
  menu: {
    locale: false,
  },
  menuHeaderRender: (_, title) => <div className="admin-logo-title">{title}</div>,
  navTheme: 'light',
  onMenuHeaderClick: () => history.push('/dashboard'),
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
