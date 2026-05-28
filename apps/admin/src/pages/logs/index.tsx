import { BugOutlined, DesktopOutlined, WarningOutlined } from '@ant-design/icons'
import { PageContainer, ProCard, ProTable, StatisticCard } from '@ant-design/pro-components'
import { Button, Drawer, Space, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { ClientLogRecord } from '@eaw/shared'
import { loadClientLogs } from '@/services/admin'

function formatDate(value: string) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function levelTag(level: ClientLogRecord['level']) {
  const color = level === 'error' ? 'red' : level === 'warn' ? 'orange' : level === 'debug' ? 'default' : 'blue'
  const label = level === 'error' ? '错误' : level === 'warn' ? '警告' : level === 'debug' ? '调试' : '信息'
  return <Tag color={color}>{label}</Tag>
}

function compactDevice(log: ClientLogRecord) {
  return `${log.platform || 'unknown'} / ${log.appVersion || '-'}`
}

export default function LogsPage() {
  const [logs, setLogs] = useState<ClientLogRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedLog, setSelectedLog] = useState<ClientLogRecord | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      setLogs(await loadClientLogs({ limit: 500 }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const summary = useMemo(
    () =>
      logs.reduce(
        (total, log) => {
          total.devices.add(log.deviceId)
          if (log.level === 'error') total.errors += 1
          if (log.level === 'warn') total.warnings += 1
          return total
        },
        { devices: new Set<string>(), errors: 0, warnings: 0 },
      ),
    [logs],
  )

  return (
    <PageContainer
      className="admin-page"
      extra={<Button onClick={refresh} type="primary">刷新日志</Button>}
      subTitle="集中查看桌面端运行状态、设备、系统、IP、会话和错误现场"
      title="日志管理"
    >
      <StatisticCard.Group className="dashboard-stats">
        <StatisticCard statistic={{ title: '最近日志', value: logs.length, icon: <BugOutlined /> }} />
        <StatisticCard statistic={{ title: '错误', value: summary.errors, icon: <WarningOutlined /> }} />
        <StatisticCard statistic={{ title: '警告', value: summary.warnings }} />
        <StatisticCard statistic={{ title: '设备', value: summary.devices.size, icon: <DesktopOutlined /> }} />
      </StatisticCard.Group>

      <ProCard className="section-card">
        <ProTable<ClientLogRecord>
          columns={[
            {
              title: '级别',
              dataIndex: 'level',
              width: 88,
              filters: [
                { text: '错误', value: 'error' },
                { text: '警告', value: 'warn' },
                { text: '信息', value: 'info' },
                { text: '调试', value: 'debug' },
              ],
              onFilter: (value, row) => row.level === value,
              render: (_, row) => levelTag(row.level),
            },
            {
              title: '事件',
              dataIndex: 'event',
              width: 240,
              ellipsis: true,
            },
            {
              title: '用户',
              dataIndex: 'userEmail',
              width: 220,
              render: (_, row) => (
                <div className="log-user">
                  <strong>{row.userName || row.userEmail || '未识别用户'}</strong>
                  <span>{row.userEmail || row.userId || '-'}</span>
                </div>
              ),
            },
            {
              title: '设备',
              dataIndex: 'deviceId',
              width: 250,
              ellipsis: true,
              render: (_, row) => (
                <div className="log-device">
                  <strong>{compactDevice(row)}</strong>
                  <span>{row.deviceId}</span>
                </div>
              ),
            },
            {
              title: 'IP',
              dataIndex: 'ip',
              width: 140,
              ellipsis: true,
            },
            {
              title: '任务',
              dataIndex: 'taskId',
              width: 190,
              ellipsis: true,
              renderText: (value) => value || '-',
            },
            {
              title: '时间',
              dataIndex: 'receivedAt',
              width: 160,
              sorter: (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
              defaultSortOrder: 'descend',
              renderText: formatDate,
            },
            {
              title: '操作',
              valueType: 'option',
              width: 96,
              render: (_, row) => (
                <Space>
                  <Button onClick={() => setSelectedLog(row)} size="small" type="text">详情</Button>
                </Space>
              ),
            },
          ]}
          dataSource={logs}
          loading={loading}
          options={false}
          pagination={{ pageSize: 12 }}
          rowKey="id"
          search={false}
          scroll={{ x: 1360 }}
        />
      </ProCard>

      <Drawer onClose={() => setSelectedLog(null)} open={Boolean(selectedLog)} title="日志详情" width={640}>
        {selectedLog ? (
          <div className="log-detail">
            <Typography.Text type="secondary">事件</Typography.Text>
            <Typography.Title level={5}>{selectedLog.event}</Typography.Title>
            <div className="log-detail-grid">
              <span>级别</span><strong>{selectedLog.level}</strong>
              <span>用户</span><strong>{selectedLog.userEmail || '-'}</strong>
              <span>设备</span><strong>{selectedLog.deviceId}</strong>
              <span>系统</span><strong>{compactDevice(selectedLog)}</strong>
              <span>IP</span><strong>{selectedLog.ip || '-'}</strong>
              <span>任务</span><strong>{selectedLog.taskId || '-'}</strong>
              <span>会话</span><strong>{selectedLog.sessionId || '-'}</strong>
              <span>时间</span><strong>{formatDate(selectedLog.receivedAt)}</strong>
            </div>
            <Typography.Text type="secondary">详情</Typography.Text>
            <pre className="log-detail-json">{JSON.stringify(selectedLog.details ?? {}, null, 2)}</pre>
            <Typography.Text type="secondary">User Agent</Typography.Text>
            <pre className="log-detail-json">{selectedLog.userAgent || '-'}</pre>
          </div>
        ) : null}
      </Drawer>
    </PageContainer>
  )
}
