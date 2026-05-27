import { defineConfig } from '@umijs/max'

export default defineConfig({
  access: {},
  antd: {},
  base: '/admin/',
  hash: true,
  history: {
    type: 'browser',
  },
  initialState: {},
  layout: {
    locale: false,
    title: '墨渊控制台',
  },
  model: {},
  npmClient: 'npm',
  outputPath: 'dist',
  publicPath: '/admin/',
  request: {},
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', name: '总览', icon: 'DashboardOutlined', component: './dashboard' },
    { path: '/models', name: '模型与密钥', icon: 'ApiOutlined', component: './models' },
    { path: '/organization', name: '组织同步', icon: 'TeamOutlined', component: './organization' },
    { path: '/runtime', name: 'Codex Runtime', icon: 'CodeOutlined', component: './runtime' },
    { path: '/security', name: '安全策略', icon: 'SafetyCertificateOutlined', component: './security' },
    { path: '/audit', name: '审计日志', icon: 'AuditOutlined', component: './audit' },
  ],
  title: '墨渊控制台',
})
