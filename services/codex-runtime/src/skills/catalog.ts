import { getImageConfig } from '../config.js'
import type { EnterpriseSkillSet } from './contracts.js'

export function localSkillSet(): EnterpriseSkillSet {
  const image = getImageConfig()
  return {
    imageGeneration: {
      apiKeyConfigured: image.apiKeyConfigured,
      defaultModel: image.defaultModel,
      enabled: image.apiKeyConfigured,
      name: '静态图片生成',
    },
  }
}
