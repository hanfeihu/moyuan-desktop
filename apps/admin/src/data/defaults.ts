import { defaultVideoRatioForModel, type Employee, type ImageSkillConfig, type MailServiceConfig, type ModelProviderConfig, type PaymentGatewayConfig, type TokenPlan, type VideoSkillConfig } from '@eaw/shared'
import type { PolicyView } from '@/services/admin'

export const defaultProviders: ModelProviderConfig[] = [
  {
    id: 'blector',
    name: 'Blector 中转',
    baseUrl: 'https://ai.blector.com/v1',
    maskedApiKey: 'sk-************************demo',
    defaultModel: 'gpt-5.5',
    enabled: true,
    monthlyLimit: 5000000,
  },
  {
    id: 'local',
    name: '本地私有模型',
    baseUrl: 'http://model-gateway:8000/v1',
    maskedApiKey: '未配置',
    defaultModel: 'qwen3-coder',
    enabled: false,
    monthlyLimit: 5000000,
  },
]

export const defaultEmployees: Employee[] = [
  { id: 'u-1001', name: '韩飞虎', department: '销售一组', title: '客户经理', source: 'wecom', manager: '王敏' },
  { id: 'u-1002', name: '林青', department: '交付中心', title: '实施顾问', source: 'lark', manager: '赵远' },
  { id: 'u-1003', name: '周然', department: '产品部', title: '产品经理', source: 'dingtalk', manager: '陈立' },
]

export const defaultVideoSkill: VideoSkillConfig = {
  id: 'volcengine-seedance',
  name: '火山方舟 Seedance 视频生成',
  provider: 'volcengine-ark',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  maskedApiKey: '未配置',
  apiKeyConfigured: false,
  defaultModel: 'doubao-seedance-2-0-260128',
  enabled: false,
  allowImageInput: true,
  defaultDuration: 5,
  defaultRatio: defaultVideoRatioForModel('doubao-seedance-2-0-260128'),
  defaultResolution: '720p',
  monthlyLimit: 100,
}

export const defaultImageSkill: ImageSkillConfig = {
  id: 'gpt-image-2',
  name: 'gpt-image-2 图片生成',
  provider: 'openai-compatible-image',
  baseUrl: 'https://codex-manager.tminos.com/v1',
  maskedApiKey: '未配置',
  apiKeyConfigured: false,
  defaultModel: 'gpt-image-2',
  enabled: false,
  defaultSize: '1024x1024',
  monthlyLimit: 1000,
}

export const defaultMailSettings: MailServiceConfig = {
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  secure: true,
  username: '',
  fromName: '墨渊',
  maskedAuthCode: '未配置',
  authCodeConfigured: false,
  enabled: false,
}

export const defaultPaymentGateway: PaymentGatewayConfig = {
  id: 'zpayz',
  name: 'ZPAYZ 支付网关',
  provider: 'zpayz',
  gatewayUrl: 'https://zpayz.cn',
  pid: '',
  maskedKey: '未配置',
  keyConfigured: false,
  enabled: false,
  supportedMethods: ['alipay', 'wxpay'],
}

const now = new Date().toISOString()

export const defaultTokenPlans: TokenPlan[] = [
  {
    id: 'starter',
    name: '入门包',
    description: '适合轻量对话和少量图片生成',
    price: 9.9,
    tokens: 100000,
    enabled: true,
    sort: 10,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'standard',
    name: '标准包',
    description: '适合日常高频办公与技能调用',
    price: 39.9,
    tokens: 500000,
    enabled: true,
    sort: 20,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'pro',
    name: '专业包',
    description: '适合图片、视频等高消耗任务',
    price: 99,
    tokens: 1500000,
    enabled: true,
    sort: 30,
    createdAt: now,
    updatedAt: now,
  },
]

export const defaultPolicy: PolicyView = {
  dataBoundary: '企业内网',
  externalSharing: '外发需审批',
  highRiskTool: '默认人工确认',
  retention: '审计保留 180 天',
}
