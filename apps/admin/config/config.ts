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
    { path: '/login', layout: false, component: './login' },
    { path: '/dashboard', name: '总览', icon: 'DashboardOutlined', component: './dashboard' },
    { path: '/models', name: '模型与密钥', icon: 'ApiOutlined', component: './models' },
    { path: '/skills', name: '技能配置', icon: 'VideoCameraOutlined', component: './skills' },
    { path: '/plugins', name: '插件管理', icon: 'AppstoreOutlined', component: './plugins' },
    { path: '/billing', name: '支付与套餐', icon: 'CreditCardOutlined', component: './billing' },
    { path: '/assets', name: '资源记录', icon: 'PictureOutlined', component: './assets' },
    { path: '/logs', name: '日志管理', icon: 'BugOutlined', component: './logs' },
    { path: '/accounts', name: '账号与用量', icon: 'UserOutlined', component: './accounts' },
    { path: '/settings', name: '系统设置', icon: 'SettingOutlined', component: './settings' },
    { path: '/organization', name: '组织同步', icon: 'TeamOutlined', component: './organization' },
    { path: '/runtime', name: 'Codex Runtime', icon: 'CodeOutlined', component: './runtime' },
    { path: '/security', name: '安全策略', icon: 'SafetyCertificateOutlined', component: './security' },
    { path: '/audit', name: '审计日志', icon: 'AuditOutlined', component: './audit' },
  ],
  title: '墨渊控制台',
})
