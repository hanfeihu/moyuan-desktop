import { randomUUID } from 'node:crypto'
import type { AccountUser, BillingConfig, BillingMeterConfig, BillingMeterType, UsageLedgerEntry } from '@eaw/shared'

export type ChargeUsageInput = {
  assetId?: string
  completionTokens?: number
  model?: string
  promptTokens?: number
  provider?: string
  rawTokens: number
  reportId?: string
  source: BillingMeterType
  taskId?: string
}

export type ChargeUsageResult = {
  entry: UsageLedgerEntry
  remainingTokens: number
}

export type BillingUsageCalculation = {
  billableCny: number
  billableProviderTokens: number
  costCny: number
  deductionFactor: number
  meter: BillingMeterConfig
  platformTokenUnitPriceCny: number
  platformTokens: number
  rawTokens: number
}

export function defaultBillingConfig(): BillingConfig {
  const now = new Date().toISOString()
  return {
    platformPriceCny: 10,
    platformTokens: 10_000_000,
    updatedAt: now,
    meters: [
      {
        id: 'brain-default',
        type: 'brain',
        name: '大脑模型',
        costCny: 0.5,
        costUnitTokens: 1_000_000,
        deductionFactor: 1,
        markupRate: 0,
        enabled: true,
        updatedAt: now,
      },
      {
        id: 'image-default',
        type: 'image',
        name: '图片技能',
        costCny: 0.1,
        costUnitTokens: 1_000,
        deductionFactor: 1,
        markupRate: 0,
        enabled: true,
        updatedAt: now,
      },
      {
        id: 'video-seedance',
        type: 'video',
        name: '视频技能',
        provider: 'volcengine-ark',
        costCny: 2_800,
        costUnitTokens: 100_000_000,
        deductionFactor: 1.64285714,
        markupRate: 0,
        enabled: true,
        updatedAt: now,
      },
    ],
  }
}

export function normalizeBillingConfig(config?: Partial<BillingConfig> | null): BillingConfig {
  const fallback = defaultBillingConfig()
  const sourceMeters = config?.meters?.length ? config.meters : fallback.meters
  const platformPriceCny = positiveNumber(config?.platformPriceCny) ?? fallback.platformPriceCny
  const platformTokens = positiveInteger(config?.platformTokens) ?? fallback.platformTokens
  return {
    platformPriceCny,
    platformTokens,
    updatedAt: config?.updatedAt ?? fallback.updatedAt,
    meters: sourceMeters.map((meter, index) => normalizeMeter(meter, fallback.meters[index] ?? fallback.meters[0])),
  }
}

export function chargeUsage(user: AccountUser, billingConfig: BillingConfig, input: ChargeUsageInput): ChargeUsageResult {
  const calculation = calculateUsageCharge(billingConfig, input)
  const remainingTokens = user.tokenBudget - user.tokenUsed
  if (calculation.platformTokens > remainingTokens) {
    throw new Error('Token 额度不足，请联系管理员派发额度')
  }

  const now = new Date().toISOString()
  const entry: UsageLedgerEntry = {
    id: randomUUID(),
    userEmail: user.email,
    userId: user.id,
    userName: user.name,
    assetId: input.assetId,
    billableCny: calculation.billableCny,
    costCny: calculation.costCny,
    createdAt: now,
    markupRate: calculation.meter.markupRate,
    meterId: calculation.meter.id,
    meterName: calculation.meter.name,
    model: input.model,
    platformTokenUnitPriceCny: calculation.platformTokenUnitPriceCny,
    platformTokens: calculation.platformTokens,
    provider: input.provider ?? calculation.meter.provider,
    rawTokens: calculation.rawTokens,
    billableProviderTokens: calculation.billableProviderTokens,
    deductionFactor: calculation.deductionFactor,
    reportId: input.reportId,
    source: input.source,
    taskId: input.taskId,
  }

  if (input.source === 'brain') {
    const promptRawTokens = Math.max(0, input.promptTokens ?? 0)
    const completionRawTokens = Math.max(0, input.completionTokens ?? 0)
    const splitRawTokens = promptRawTokens + completionRawTokens
    if (splitRawTokens > 0) {
      const promptPlatformTokens = Math.floor((calculation.platformTokens * promptRawTokens) / splitRawTokens)
      user.promptTokens += promptPlatformTokens
      user.completionTokens += calculation.platformTokens - promptPlatformTokens
    } else {
      user.promptTokens += calculation.platformTokens
    }
  } else {
    user.skillTokens += calculation.platformTokens
  }
  user.tokenUsed += calculation.platformTokens

  return { entry, remainingTokens: remainingTokens - calculation.platformTokens }
}

export function calculateUsageCharge(billingConfig: BillingConfig, input: ChargeUsageInput): BillingUsageCalculation {
  const rawTokens = positiveInteger(input.rawTokens)
  if (!rawTokens) throw new Error('用量没有返回有效原始 Token，无法计费')

  const meter = resolveMeter(billingConfig, input)
  const platformTokenUnitPriceCny = billingConfig.platformPriceCny / billingConfig.platformTokens
  const deductionFactor = positiveNumber(meter.deductionFactor) ?? 1
  const billableProviderTokens = roundUsageTokens(rawTokens * deductionFactor)
  const costCny = roundMoney((billableProviderTokens / meter.costUnitTokens) * meter.costCny)
  const billableCny = roundMoney(costCny * (1 + meter.markupRate))
  const platformTokens = Math.max(1, Math.ceil(billableCny / platformTokenUnitPriceCny))

  return {
    billableCny,
    billableProviderTokens,
    costCny,
    deductionFactor,
    meter,
    platformTokenUnitPriceCny,
    platformTokens,
    rawTokens,
  }
}

function normalizeMeter(meter: Partial<BillingMeterConfig>, fallback: BillingMeterConfig): BillingMeterConfig {
  return {
    id: stringValue(meter.id) ?? fallback.id,
    type: meter.type ?? fallback.type,
    name: stringValue(meter.name) ?? fallback.name,
    provider: stringValue(meter.provider),
    modelPattern: stringValue(meter.modelPattern),
    costCny: positiveNumber(meter.costCny) ?? fallback.costCny,
    costUnitTokens: positiveInteger(meter.costUnitTokens) ?? fallback.costUnitTokens,
    deductionFactor: positiveNumber(meter.deductionFactor) ?? fallback.deductionFactor ?? 1,
    markupRate: nonNegativeNumber(meter.markupRate) ?? fallback.markupRate,
    enabled: meter.enabled ?? fallback.enabled,
    updatedAt: meter.updatedAt ?? fallback.updatedAt,
  }
}

function resolveMeter(config: BillingConfig, input: ChargeUsageInput) {
  const enabled = config.meters.filter((meter) => meter.enabled && meter.type === input.source)
  const matchedByModel = enabled.find((meter) => meter.modelPattern && input.model && modelMatches(input.model, meter.modelPattern))
  const matchedByProvider = enabled.find((meter) => meter.provider && input.provider && meter.provider === input.provider)
  const meter = matchedByModel ?? matchedByProvider ?? enabled[0]
  if (!meter) throw new Error(`未配置 ${input.source} 计费规则，无法计费`)
  return meter
}

function modelMatches(model: string, pattern: string) {
  const normalizedModel = model.toLowerCase()
  const normalizedPattern = pattern.toLowerCase().trim()
  if (!normalizedPattern) return false
  if (normalizedPattern.includes('*')) {
    const escaped = normalizedPattern.split('*').map(escapeRegExp).join('.*')
    return new RegExp(`^${escaped}$`).test(normalizedModel)
  }
  return normalizedModel.includes(normalizedPattern)
}

function roundMoney(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function roundUsageTokens(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function positiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined
}

function nonNegativeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
