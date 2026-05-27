import {
  ApiOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { PageContainer, ProCard, ProTable, StatisticCard } from '@ant-design/pro-components'
import { history } from '@umijs/max'
import { Button, Progress, Space, Tag, Typography } from 'antd'
import { useMemo } from 'react'
import type { Employee } from '@eaw/shared'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'

const sourceLabel = { wecom: '企业微信', lark: '飞书', dingtalk: '钉钉' }

export default function DashboardPage() {
  const { apiState, employees, modelProvider, policy, providers } = useAdminSnapshot()
  const overview = useMemo(
    () => ({
      audit: policy.retention.includes('审计') ? 100 : 0,
      employees: employees.length,
      policyScore: modelProvider.enabled ? 92 : 68,
      providers: providers.filter((provider) => provider.enabled).length,
    }),
    [employees.length, modelProvider.enabled, policy.retention, providers],
  )

  return (
    <PageContainer
      className="admin-page"
      extra={[
        <Tag color={apiState === 'online' ? 'green' : apiState === 'checking' ? 'blue' : 'orange'} key="api">
          {apiState === 'online' ? '后台 API 已连接' : apiState === 'checking' ? '检查中' : '静态预览'}
        </Tag>,
        <Button key="publish" type="primary">
          发布策略
        </Button>,
      ]}
      subTitle="企业本地化部署、员工桌面端、模型通道和审计策略统一管控"
      title="企业 AI 后台"
    >
      <StatisticCard.Group className="dashboard-stats" direction="row">
        <StatisticCard
          statistic={{ title: '接入员工', value: overview.employees, icon: <TeamOutlined /> }}
          footer="企微、飞书、钉钉统一同步"
        />
        <StatisticCard
          statistic={{ title: '模型通道', value: overview.providers, icon: <ApiOutlined /> }}
          footer="可下发到员工桌面端"
        />
        <StatisticCard
          statistic={{ title: '审计覆盖', suffix: '%', value: overview.audit, icon: <CheckCircleOutlined /> }}
          footer="工具调用和模型请求留痕"
        />
        <StatisticCard
          statistic={{ title: '合规策略', value: overview.policyScore, icon: <SafetyCertificateOutlined /> }}
          chart={<Progress percent={overview.policyScore} showInfo={false} strokeColor="#1677ff" />}
        />
      </StatisticCard.Group>

      <ProCard className="section-card" gutter={16} wrap>
        <ProCard colSpan="65%" title="当前运行态">
          <Space direction="vertical" size={14}>
            <Typography.Text strong>
              <CloudServerOutlined /> Codex Runtime 与桌面端策略正在通过企业后台统一下发
            </Typography.Text>
            <Space wrap>
              <Tag color="blue">默认模型：{modelProvider.defaultModel}</Tag>
              <Tag color={modelProvider.enabled ? 'green' : 'default'}>
                {modelProvider.enabled ? '模型通道已启用' : '模型通道停用'}
              </Tag>
              <Tag>{policy.dataBoundary}</Tag>
              <Tag>{policy.externalSharing}</Tag>
            </Space>
          </Space>
        </ProCard>
        <ProCard colSpan="35%" title="快捷动作">
          <Space wrap>
            <Button onClick={() => history.push('/models')}>配置模型</Button>
            <Button onClick={() => history.push('/organization')}>同步组织</Button>
            <Button onClick={() => history.push('/security')}>安全策略</Button>
          </Space>
        </ProCard>
      </ProCard>

      <ProCard className="section-card" title="最近同步员工">
        <ProTable<Employee>
          columns={[
            { title: '员工', dataIndex: 'name' },
            { title: '部门', dataIndex: 'department' },
            { title: '岗位', dataIndex: 'title' },
            {
              title: '来源',
              dataIndex: 'source',
              render: (_, row) => <Tag>{sourceLabel[row.source]}</Tag>,
            },
            { title: '直属上级', dataIndex: 'manager' },
          ]}
          dataSource={employees}
          options={false}
          pagination={false}
          rowKey="id"
          search={false}
          scroll={{ x: 720 }}
        />
      </ProCard>
    </PageContainer>
  )
}
