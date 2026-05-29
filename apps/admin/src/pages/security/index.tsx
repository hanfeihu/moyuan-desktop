import { PageContainer, ProCard, ProDescriptions, ProForm, ProFormRadio, ProFormSwitch } from '@ant-design/pro-components'
import { Button, Tag } from 'antd'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'

export default function SecurityPage() {
  const { policy } = useAdminSnapshot()

  return (
    <PageContainer
      className="admin-page"
      extra={<Button type="primary">发布安全策略</Button>}
      subTitle="控制员工桌面端的数据边界、外发行为、高风险工具和审计保留"
      title="安全策略"
    >
      <ProCard gutter={16} wrap>
        <ProCard colSpan="40%" title="当前策略">
          <ProDescriptions
            column={1}
            columns={[
              { title: '数据边界', dataIndex: 'dataBoundary' },
              { title: '外发策略', dataIndex: 'externalSharing' },
              { title: '高风险工具', dataIndex: 'highRiskTool' },
              { title: '审计保留', dataIndex: 'retention' },
            ]}
            dataSource={policy}
          />
        </ProCard>
        <ProCard colSpan="60%" title="策略编辑">
          <ProForm
            initialValues={{
              auditEnabled: true,
              dataBoundary: 'local',
              externalSharing: 'allowed',
              highRiskToolMode: 'auto',
            }}
            submitter={{
              resetButtonProps: false,
              searchConfig: { submitText: '保存草稿' },
            }}
          >
            <ProFormRadio.Group
              label="数据边界"
              name="dataBoundary"
              options={[
                { label: '企业内网', value: 'local' },
                { label: '本地 + 企业服务', value: 'hybrid' },
              ]}
            />
            <ProFormRadio.Group
              label="外发策略"
              name="externalSharing"
              options={[
                { label: '允许外发', value: 'allowed' },
                { label: '禁止外发', value: 'blocked' },
              ]}
            />
            <ProFormRadio.Group
              label="高风险工具"
              name="highRiskToolMode"
              options={[
                { label: '自动执行', value: 'auto' },
                { label: '默认禁止', value: 'blocked' },
              ]}
            />
            <ProFormSwitch label="启用审计" name="auditEnabled" />
            <Tag className="hint-tag" color="blue">
              发布后会在员工桌面端下一次启动或策略刷新时生效
            </Tag>
          </ProForm>
        </ProCard>
      </ProCard>
    </PageContainer>
  )
}
