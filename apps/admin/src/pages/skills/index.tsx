import { CheckCircleOutlined, ExclamationCircleOutlined, KeyOutlined, VideoCameraOutlined } from '@ant-design/icons'
import {
  PageContainer,
  ProCard,
  ProForm,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
} from '@ant-design/pro-components'
import { Alert, App, Button, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import type { VideoSkillConfig } from '@eaw/shared'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'
import { saveVideoSkill } from '@/services/admin'

export default function SkillsPage() {
  const { message } = App.useApp()
  const snapshot = useAdminSnapshot()
  const [activeSkill, setActiveSkill] = useState<VideoSkillConfig | undefined>()
  const videoSkill = activeSkill ?? snapshot.videoSkill
  const apiKeyConfigured = videoSkill.apiKeyConfigured

  async function save(values: Record<string, unknown>) {
    try {
      const payload = await saveVideoSkill(values)
      setActiveSkill(payload)
      message.success('视频生成技能配置已保存')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '后台 API 暂不可用，配置未保存')
    }
  }

  return (
    <PageContainer
      className="admin-page"
      extra={<Button icon={<VideoCameraOutlined />} type="primary">测试视频通道</Button>}
      subTitle="把火山方舟 Seedance 视频生成作为墨渊大脑可调用的企业技能"
      title="技能配置"
    >
      <ProCard
        extra={
          <Space wrap>
            <Tag color={videoSkill.enabled ? 'green' : 'default'}>{videoSkill.enabled ? '技能已启用' : '技能未启用'}</Tag>
            <Tag color={apiKeyConfigured ? 'green' : 'orange'}>{apiKeyConfigured ? 'KEY 已配置' : 'KEY 未配置'}</Tag>
          </Space>
        }
        title="视频生成 · 火山方舟 Seedance"
      >
        <div className={apiKeyConfigured ? 'skill-key-status configured' : 'skill-key-status missing'}>
          <div className="skill-key-icon">
            {apiKeyConfigured ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
          </div>
          <div className="skill-key-copy">
            <strong>{apiKeyConfigured ? 'API Key 已配置' : 'API Key 未配置'}</strong>
            <span>
              {apiKeyConfigured
                ? `当前使用 ${videoSkill.maskedApiKey}，输入新 KEY 后会替换；留空保存会沿用现有 KEY。`
                : '还没有保存可用的火山方舟 KEY。请输入 KEY 后再启用视频技能。'}
            </span>
          </div>
          <Tag color={apiKeyConfigured ? 'green' : 'orange'} icon={<KeyOutlined />}>
            {videoSkill.maskedApiKey}
          </Tag>
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
            label="API Key"
            name="apiKey"
            placeholder={apiKeyConfigured ? `已配置 ${videoSkill.maskedApiKey}，留空沿用` : '请输入火山方舟 API Key'}
          />
          <ProFormText colProps={{ md: 12, xs: 24 }} label="默认视频模型" name="defaultModel" />
          <ProFormDigit colProps={{ md: 6, xs: 12 }} label="默认时长（秒）" name="defaultDuration" />
          <ProFormSelect
            colProps={{ md: 6, xs: 12 }}
            label="默认比例"
            name="defaultRatio"
            options={[
              { label: '16:9', value: '16:9' },
              { label: '9:16', value: '9:16' },
              { label: '1:1', value: '1:1' },
              { label: '4:3', value: '4:3' },
              { label: '3:4', value: '3:4' },
            ]}
          />
          <ProFormSelect
            colProps={{ md: 6, xs: 12 }}
            label="默认清晰度"
            name="defaultResolution"
            options={[
              { label: '720p', value: '720p' },
              { label: '1080p', value: '1080p' },
            ]}
          />
          <ProFormDigit colProps={{ md: 6, xs: 12 }} label="月度任务额度" name="monthlyLimit" />
          <ProFormSwitch colProps={{ md: 6, xs: 12 }} label="启用视频技能" name="enabled" />
          <ProFormSwitch colProps={{ md: 6, xs: 12 }} label="允许图生视频" name="allowImageInput" />
        </ProForm>
      </ProCard>

      <ProCard className="section-card" title="大脑调用方式">
        <Typography.Paragraph>
          用户在桌面端要求生成视频、让图片动起来、制作产品短片时，墨渊会把这个能力作为工具调用；KEY 只在企业后台服务端保存，桌面端不直接持有明文。
        </Typography.Paragraph>
        <Space wrap>
          <Tag color="blue">文生视频</Tag>
          <Tag color="blue">图生视频</Tag>
          <Tag>异步任务</Tag>
          <Tag>企业审计</Tag>
        </Space>
      </ProCard>
    </PageContainer>
  )
}
