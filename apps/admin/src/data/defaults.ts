import type { Employee, MailServiceConfig, ModelProviderConfig, VideoSkillConfig } from '@eaw/shared'
import type { PolicyView } from '@/services/admin'

export const defaultProviders: ModelProviderConfig[] = [
  {
    id: 'blector',
    name: 'Blector 中转',
    baseUrl: 'https://ai.blector.com/v1',
    maskedApiKey: 'sk-************************demo',
    defaultModel: 'gpt-5-codex',
    enabled: true,
  },
  {
    id: 'local',
    name: '本地私有模型',
    baseUrl: 'http://model-gateway:8000/v1',
    maskedApiKey: '未配置',
    defaultModel: 'qwen3-coder',
    enabled: false,
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
  defaultRatio: '16:9',
  defaultResolution: '720p',
  monthlyLimit: 100,
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

export const defaultPolicy: PolicyView = {
  dataBoundary: '企业内网',
  externalSharing: '外发需审批',
  highRiskTool: '默认人工确认',
  retention: '审计保留 180 天',
}
