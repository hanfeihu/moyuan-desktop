import { EyeOutlined, LinkOutlined, PictureOutlined, VideoCameraOutlined } from '@ant-design/icons'
import { PageContainer, ProCard, ProTable, StatisticCard } from '@ant-design/pro-components'
import { Button, Image, Modal, Space, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { GeneratedAssetRecord } from '@eaw/shared'
import { loadAssets } from '@/services/admin'

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatDate(value: string) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  }).format(new Date(value))
}

function statusTag(status: GeneratedAssetRecord['status']) {
  if (status === 'succeeded') return <Tag color="green">成功</Tag>
  if (status === 'failed') return <Tag color="red">失败</Tag>
  return <Tag color="blue">生成中</Tag>
}

function assetPreviewUrl(asset: GeneratedAssetRecord) {
  return asset.url || asset.storageUrl || ''
}

export default function AssetsPage() {
  const [assets, setAssets] = useState<GeneratedAssetRecord[]>([])
  const [previewAsset, setPreviewAsset] = useState<GeneratedAssetRecord | null>(null)
  const previewUrl = previewAsset ? assetPreviewUrl(previewAsset) : ''

  useEffect(() => {
    void loadAssets().then(setAssets)
  }, [])

  const summary = useMemo(
    () =>
      assets.reduce(
        (total, asset) => ({
          images: total.images + (asset.type === 'image' ? 1 : 0),
          tokens: total.tokens + asset.tokenUsage,
          videos: total.videos + (asset.type === 'video' ? 1 : 0),
        }),
        { images: 0, tokens: 0, videos: 0 },
      ),
    [assets],
  )

  return (
    <PageContainer className="admin-page" subTitle="图片、视频、模型与 Token 用量" title="资源记录">
      <StatisticCard.Group className="dashboard-stats">
        <StatisticCard statistic={{ title: '图片资源', value: summary.images, icon: <PictureOutlined /> }} />
        <StatisticCard statistic={{ title: '视频资源', value: summary.videos, icon: <VideoCameraOutlined /> }} />
        <StatisticCard statistic={{ title: '技能 Token', value: summary.tokens }} />
      </StatisticCard.Group>

      <ProCard className="section-card">
        <ProTable<GeneratedAssetRecord>
          columns={[
            {
              title: '资源',
              dataIndex: 'url',
              width: 120,
              render: (_, row) => {
                const url = assetPreviewUrl(row)
                if (row.type === 'image' && url) {
                  return (
                    <button className="asset-preview-trigger" onClick={() => setPreviewAsset(row)} type="button">
                      <img alt={row.prompt || '图片资源'} className="asset-thumb" height={64} src={url} width={84} />
                    </button>
                  )
                }

                return (
                  <button className={`asset-thumb-placeholder ${row.type}`} disabled={!url} onClick={() => setPreviewAsset(row)} type="button">
                    {row.type === 'video' ? <VideoCameraOutlined /> : <PictureOutlined />}
                  </button>
                )
              },
            },
            {
              title: '类型',
              dataIndex: 'type',
              width: 96,
              render: (_, row) => <Tag color={row.type === 'video' ? 'purple' : 'blue'}>{row.type === 'video' ? '视频' : '图片'}</Tag>,
            },
            {
              title: '用户',
              dataIndex: 'userEmail',
              width: 220,
              render: (_, row) => (
                <div className="asset-user">
                  <strong>{row.userName || row.userEmail}</strong>
                  <span>{row.userEmail}</span>
                </div>
              ),
            },
            {
              title: '模型',
              dataIndex: 'model',
              width: 230,
              ellipsis: true,
            },
            {
              title: '提示词',
              dataIndex: 'prompt',
              ellipsis: true,
            },
            {
              title: 'Token',
              dataIndex: 'tokenUsage',
              width: 130,
              sorter: (a, b) => a.tokenUsage - b.tokenUsage,
              renderText: (value) => formatNumber(Number(value ?? 0)),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (_, row) => statusTag(row.status),
            },
            {
              title: '时间',
              dataIndex: 'updatedAt',
              width: 130,
              renderText: formatDate,
            },
            {
              title: '操作',
              valueType: 'option',
              width: 120,
              render: (_, row) => (
                <Space>
                  <Button disabled={!assetPreviewUrl(row)} icon={<EyeOutlined />} onClick={() => setPreviewAsset(row)} size="small" type="text" />
                  <Button disabled={!row.storageUrl} href={row.storageUrl} icon={<LinkOutlined />} size="small" target="_blank" type="text" />
                </Space>
              ),
            },
          ]}
          dataSource={assets}
          options={false}
          pagination={{ pageSize: 8 }}
          rowKey="id"
          search={false}
          scroll={{ x: 1280 }}
        />
      </ProCard>

      <Modal
        centered
        className="asset-preview-modal"
        footer={null}
        onCancel={() => setPreviewAsset(null)}
        open={Boolean(previewAsset)}
        title={previewAsset?.type === 'video' ? '视频预览' : '图片预览'}
        width={previewAsset?.type === 'video' ? 920 : 760}
      >
        {previewAsset?.type === 'video' && previewUrl ? (
          <video autoPlay className="asset-preview-video" controls src={previewUrl} />
        ) : previewAsset?.type === 'image' && previewUrl ? (
          <Image alt={previewAsset.prompt || '图片资源'} className="asset-preview-image" preview={false} src={previewUrl} />
        ) : null}
        {previewAsset?.prompt ? <p className="asset-preview-prompt">{previewAsset.prompt}</p> : null}
      </Modal>
    </PageContainer>
  )
}
