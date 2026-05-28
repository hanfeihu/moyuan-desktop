import { KeyOutlined, PictureOutlined, VideoCameraOutlined } from '@ant-design/icons'
import {
  PageContainer,
  ProCard,
  ProForm,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
} from '@ant-design/pro-components'
import { Alert, App, Button, Space, Tag } from 'antd'
import { useState } from 'react'
import { videoRatioOptions, videoResolutionOptions, type ImageSkillConfig, type VideoRatio, type VideoResolution, type VideoSkillConfig } from '@eaw/shared'
import { defaultImageSkill, defaultVideoSkill } from '@/data/defaults'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'
import { saveImageSkill, saveVideoSkill } from '@/services/admin'

const ratioLabels: Record<VideoRatio, string> = {
  adaptive: 'adaptive（Seedance 2.0 推荐）',
  '16:9': '16:9 横屏',
  '4:3': '4:3 标准横屏',
  '1:1': '1:1 方形',
  '3:4': '3:4 竖向',
  '9:16': '9:16 短视频竖屏',
  '21:9': '21:9 超宽屏',
}

const resolutionLabels: Record<VideoResolution, string> = {
  '480p': '480p',
  '720p': '720p',
  '1080p': '1080p',
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export default function SkillsPage() {
  const { message } = App.useApp()
  const snapshot = useAdminSnapshot()
  const [activeImageSkill, setActiveImageSkill] = useState<ImageSkillConfig | undefined>()
  const [activeSkill, setActiveSkill] = useState<VideoSkillConfig | undefined>()
  const imageSkill = activeImageSkill ?? snapshot.imageSkill ?? defaultImageSkill
  const videoSkill = activeSkill ?? snapshot.videoSkill ?? defaultVideoSkill
  const imageReady = imageSkill.enabled && imageSkill.apiKeyConfigured
  const imageStatus = imageReady ? '可用' : !imageSkill.apiKeyConfigured ? '缺少 KEY' : '未启用'
  const imageStatusColor = imageReady ? 'green' : !imageSkill.apiKeyConfigured ? 'orange' : 'default'
  const apiKeyConfigured = videoSkill.apiKeyConfigured
  const skillReady = videoSkill.enabled && apiKeyConfigured
  const skillStatus = skillReady ? '可用' : !apiKeyConfigured ? '缺少 KEY' : '未启用'
  const skillStatusColor = skillReady ? 'green' : !apiKeyConfigured ? 'orange' : 'default'

  async function save(values: Record<string, unknown>) {
    try {
      const payload = await saveVideoSkill(values)
      setActiveSkill(payload)
      message.success('视频生成技能配置已保存')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '后台 API 暂不可用，配置未保存')
    }
  }

  async function saveImage(values: Record<string, unknown>) {
    try {
      const payload = await saveImageSkill(values)
      setActiveImageSkill(payload)
      message.success('图片生成技能配置已保存')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '后台 API 暂不可用，配置未保存')
    }
  }

  return (
    <PageContainer
      className="admin-page"
      extra={
        <Button disabled={!skillReady} icon={<VideoCameraOutlined />} title={skillReady ? '测试视频通道' : `暂不可测试：${skillStatus}`} type="primary">
          测试视频通道
        </Button>
      }
      subTitle="把火山方舟 Seedance 视频生成作为墨渊大脑可调用的企业技能"
      title="技能配置"
    >
      <ProCard
        extra={
          <Space wrap>
            <Tag color={imageStatusColor}>{imageStatus}</Tag>
          </Space>
        }
        title="图片生成 · gpt-image-2"
      >
        <div className="skill-summary">
          <div>
            <span>默认模型</span>
            <strong>{imageSkill.defaultModel}</strong>
          </div>
          <div>
            <span>API Key</span>
            <Tag color={imageSkill.apiKeyConfigured ? 'green' : 'orange'} icon={<KeyOutlined />}>
              {imageSkill.apiKeyConfigured ? imageSkill.maskedApiKey : '未配置'}
            </Tag>
          </div>
          <div>
            <span>默认尺寸</span>
            <strong>{imageSkill.defaultSize}</strong>
          </div>
          <div>
            <span>月度额度</span>
            <strong>{formatNumber(imageSkill.monthlyLimit)} 次</strong>
          </div>
        </div>
        {!imageSkill.apiKeyConfigured && imageSkill.enabled ? (
          <Alert className="skill-alert" message="图片技能已启用但缺少 KEY，请补齐后保存。" showIcon type="warning" />
        ) : null}
        <ProForm
          grid
          initialValues={{
            apiKey: '',
            baseUrl: imageSkill.baseUrl,
            defaultModel: imageSkill.defaultModel,
            defaultSize: imageSkill.defaultSize,
            enabled: imageSkill.enabled,
            monthlyLimit: imageSkill.monthlyLimit,
          }}
          key={`${imageSkill.baseUrl}-${imageSkill.defaultModel}-${imageSkill.maskedApiKey}`}
          onFinish={saveImage}
          submitter={{
            resetButtonProps: false,
            searchConfig: { submitText: '保存图片技能' },
          }}
        >
          <ProFormText colProps={{ md: 12, xs: 24 }} label="Base URL" name="baseUrl" />
          <ProFormText.Password
            colProps={{ md: 12, xs: 24 }}
            fieldProps={{ autoComplete: 'new-password', className: 'secret-input', spellCheck: false }}
            label="API Key"
            name="apiKey"
            placeholder={imageSkill.apiKeyConfigured ? '已配置，留空沿用；输入新 KEY 会替换' : '请输入图片接口 API Key'}
          />
          <ProFormText colProps={{ md: 12, xs: 24 }} label="默认图片模型" name="defaultModel" />
          <ProFormSelect
            colProps={{ md: 6, xs: 12 }}
            label="默认尺寸"
            name="defaultSize"
            options={[
              { label: '1024x1024', value: '1024x1024' },
              { label: '1024x1536', value: '1024x1536' },
              { label: '1536x1024', value: '1536x1024' },
            ]}
          />
          <ProFormDigit colProps={{ md: 6, xs: 12 }} label="月度任务额度" name="monthlyLimit" />
          <ProFormSwitch colProps={{ md: 6, xs: 12 }} label="启用图片技能" name="enabled" />
        </ProForm>
      </ProCard>

      <ProCard
        className="section-card"
        extra={
          <Space wrap>
            <Tag color={skillStatusColor}>{skillStatus}</Tag>
          </Space>
        }
        title="视频生成 · 火山方舟 Seedance"
      >
        <div className="skill-summary">
          <div>
            <span>默认模型</span>
            <strong>{videoSkill.defaultModel}</strong>
          </div>
          <div>
            <span>API Key</span>
            <Tag color={apiKeyConfigured ? 'green' : 'orange'} icon={<KeyOutlined />}>
              {apiKeyConfigured ? videoSkill.maskedApiKey : '未配置'}
            </Tag>
          </div>
          <div>
            <span>默认规格</span>
            <strong>{videoSkill.defaultRatio} · {videoSkill.defaultResolution}</strong>
          </div>
          <div>
            <span>月度额度</span>
            <strong>{formatNumber(videoSkill.monthlyLimit)} 次</strong>
          </div>
        </div>
        {!apiKeyConfigured && videoSkill.enabled ? (
          <Alert className="skill-alert" message="当前显示启用但缺少 KEY，请重新保存配置。" showIcon type="warning" />
        ) : null}
        <ProForm
          grid
          initialValues={{
            allowImageInput: videoSkill.allowImageInput,
            apiKey: '',
            baseUrl: videoSkill.baseUrl,
            defaultDuration: videoSkill.defaultDuration,
            defaultModel: videoSkill.defaultModel,
            defaultRatio: videoSkill.defaultRatio,
            defaultResolution: videoSkill.defaultResolution,
            enabled: videoSkill.enabled,
            monthlyLimit: videoSkill.monthlyLimit,
          }}
          key={`${videoSkill.baseUrl}-${videoSkill.defaultModel}-${videoSkill.maskedApiKey}`}
          onFinish={save}
          submitter={{
            resetButtonProps: false,
            searchConfig: { submitText: '保存技能配置' },
          }}
        >
          <ProFormText colProps={{ md: 12, xs: 24 }} label="Base URL" name="baseUrl" />
          <ProFormText.Password
            colProps={{ md: 12, xs: 24 }}
            fieldProps={{ autoComplete: 'new-password', className: 'secret-input', spellCheck: false }}
            label="API Key"
            name="apiKey"
            placeholder={apiKeyConfigured ? '已配置，留空沿用；输入新 KEY 会替换' : '请输入火山方舟 API Key'}
          />
          <ProFormText colProps={{ md: 12, xs: 24 }} label="默认视频模型" name="defaultModel" />
          <ProFormDigit colProps={{ md: 6, xs: 12 }} label="默认时长（秒）" name="defaultDuration" />
          <ProFormSelect
            colProps={{ md: 6, xs: 12 }}
            label="默认比例"
            name="defaultRatio"
            fieldProps={{ optionLabelProp: 'value' }}
            options={videoRatioOptions.map((value) => ({ label: ratioLabels[value], value }))}
          />
          <ProFormSelect
            colProps={{ md: 6, xs: 12 }}
            label="默认清晰度"
            name="defaultResolution"
            options={videoResolutionOptions.map((value) => ({ label: resolutionLabels[value], value }))}
          />
          <ProFormDigit colProps={{ md: 6, xs: 12 }} label="月度任务额度" name="monthlyLimit" />
          <ProFormSwitch colProps={{ md: 6, xs: 12 }} label="启用视频技能" name="enabled" />
          <ProFormSwitch colProps={{ md: 6, xs: 12 }} label="允许图生视频" name="allowImageInput" />
        </ProForm>
      </ProCard>

      <ProCard className="section-card" title="大脑调用方式">
        <Space wrap>
          <Tag color="blue" icon={<PictureOutlined />}>图片生成</Tag>
          <Tag color="blue">文生视频</Tag>
          <Tag color="blue">图生视频</Tag>
          <Tag>异步任务</Tag>
          <Tag>企业审计</Tag>
        </Space>
      </ProCard>
    </PageContainer>
  )
}
