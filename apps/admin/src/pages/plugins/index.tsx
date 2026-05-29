import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import {
  ModalForm,
  PageContainer,
  ProCard,
  ProForm,
  ProFormList,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from '@ant-design/pro-components'
import { App, Button, Popconfirm, Space, Tag } from 'antd'
import { useEffect, useState } from 'react'
import type { PluginDefinition, PluginInputField } from '@eaw/shared'
import { useAdminSnapshot } from '@/hooks/useAdminSnapshot'
import { deletePlugin, savePlugin } from '@/services/admin'

const categoryOptions = [
  { label: '媒体', value: 'media' },
  { label: '数据源', value: 'data' },
  { label: '工作流', value: 'workflow' },
  { label: '开发者', value: 'developer' },
  { label: '自定义', value: 'custom' },
]

const fieldTypeOptions = [
  { label: '单行文本', value: 'text' },
  { label: '多行文本', value: 'textarea' },
  { label: '下拉选择', value: 'select' },
  { label: '数字', value: 'number' },
  { label: '开关', value: 'boolean' },
  { label: '图片上传', value: 'image' },
  { label: '视频上传', value: 'video' },
  { label: '文件上传', value: 'file' },
]

function statusTag(plugin: PluginDefinition) {
  if (plugin.status === 'ready') return <Tag color="green">已启用</Tag>
  if (plugin.status === 'needs_config') return <Tag color="orange">待配置</Tag>
  return <Tag>已停用</Tag>
}

function modeText(mode: PluginDefinition['interactionMode']) {
  return mode === 'requires_user_input' ? '用户补表单' : '自动执行'
}

function listText(values: string[]) {
  return values.join('\n')
}

function fieldValues(fields: PluginInputField[]) {
  return fields.map((field) => ({
    ...field,
    optionsText: field.options?.map((option) => option.value).join('\n') ?? '',
  }))
}

function formValues(plugin?: PluginDefinition) {
  return {
    category: plugin?.category ?? 'custom',
    description: plugin?.description ?? '',
    enabled: plugin?.enabled ?? false,
    handler: plugin?.handler ?? 'runtime',
    inputFields: fieldValues(plugin?.inputFields ?? []),
    interactionMode: plugin?.interactionMode ?? 'requires_user_input',
    name: plugin?.name ?? '',
    permissions: listText(plugin?.permissions ?? []),
    quotaType: plugin?.quotaType ?? 'task',
    triggerHints: listText(plugin?.triggerHints ?? []),
  }
}

export default function PluginsPage() {
  const { message } = App.useApp()
  const snapshot = useAdminSnapshot()
  const [plugins, setPlugins] = useState<PluginDefinition[]>([])
  const [editing, setEditing] = useState<PluginDefinition | undefined>()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setPlugins(snapshot.plugins)
  }, [snapshot.plugins])

  async function submit(values: Record<string, unknown>) {
    try {
      const payload = await savePlugin(values, editing?.id)
      setPlugins((current) => (editing ? current.map((item) => (item.id === payload.id ? payload : item)) : [payload, ...current]))
      setOpen(false)
      setEditing(undefined)
      message.success(editing ? '插件已保存' : '插件已创建')
      return true
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '插件保存失败')
      return false
    }
  }

  async function remove(plugin: PluginDefinition) {
    try {
      const payload = await deletePlugin(plugin.id)
      setPlugins(payload)
      message.success('插件已删除')
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '插件删除失败')
    }
  }

  function openEditor(plugin?: PluginDefinition) {
    setEditing(plugin)
    setOpen(true)
  }

  return (
    <PageContainer
      className="admin-page"
      extra={
        <Button icon={<PlusOutlined />} onClick={() => openEditor()} type="primary">
          新建插件
        </Button>
      }
      subTitle="管理 Codex 可调用的交互入口、表单字段和上传项"
      title="插件管理"
    >
      <ProCard>
        <ProTable<PluginDefinition>
          columns={[
            {
              title: '插件',
              dataIndex: 'name',
              render: (_, row) => (
                <div className="plugin-name-cell">
                  <strong>{row.name}</strong>
                  <span>{row.description}</span>
                </div>
              ),
            },
            { title: '状态', dataIndex: 'status', width: 100, render: (_, row) => statusTag(row) },
            { title: '交互', dataIndex: 'interactionMode', width: 120, renderText: (value) => modeText(value as PluginDefinition['interactionMode']) },
            {
              title: '表单字段',
              dataIndex: 'inputFields',
              render: (_, row) => (
                <Space wrap>
                  {row.inputFields.slice(0, 6).map((field) => (
                    <Tag color={field.type === 'image' || field.type === 'video' || field.type === 'file' ? 'purple' : undefined} key={field.id}>
                      {field.label}
                    </Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: '触发词',
              dataIndex: 'triggerHints',
              render: (_, row) => (
                <Space wrap>
                  {row.triggerHints.slice(0, 4).map((hint) => (
                    <Tag color="blue" key={hint}>{hint}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: '操作',
              valueType: 'option',
              width: 150,
              render: (_, row) => (
                <Space>
                  <Button icon={<EditOutlined />} onClick={() => openEditor(row)} size="small" />
                  <Popconfirm onConfirm={() => remove(row)} title="删除这个插件？">
                    <Button danger icon={<DeleteOutlined />} size="small" />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          dataSource={plugins}
          options={false}
          pagination={false}
          rowKey="id"
          search={false}
        />
      </ProCard>

      <ModalForm
        initialValues={formValues(editing)}
        key={editing?.id ?? 'new-plugin'}
        modalProps={{
          destroyOnClose: true,
          onCancel: () => {
            setOpen(false)
            setEditing(undefined)
          },
        }}
        onFinish={submit}
        open={open}
        title={editing ? '编辑插件' : '新建插件'}
        width={760}
      >
        <ProForm.Group>
          <ProFormText colProps={{ md: 12, xs: 24 }} label="插件名称" name="name" rules={[{ required: true }]} />
          <ProFormSelect colProps={{ md: 6, xs: 12 }} label="类别" name="category" options={categoryOptions} />
          <ProFormSelect
            colProps={{ md: 6, xs: 12 }}
            label="扣费类型"
            name="quotaType"
            options={[
              { label: '任务', value: 'task' },
              { label: '资源', value: 'asset' },
              { label: 'Token', value: 'token' },
            ]}
          />
        </ProForm.Group>
        <ProFormTextArea label="说明" name="description" rules={[{ required: true }]} />
        <ProForm.Group>
          <ProFormSelect
            colProps={{ md: 8, xs: 24 }}
            label="执行位置"
            name="handler"
            options={[
              { label: 'Runtime', value: 'runtime' },
              { label: '后台服务', value: 'server' },
              { label: '外部服务', value: 'external' },
            ]}
          />
          <ProFormSelect
            colProps={{ md: 8, xs: 24 }}
            label="交互方式"
            name="interactionMode"
            options={[
              { label: '用户补表单', value: 'requires_user_input' },
              { label: '自动执行', value: 'automatic' },
            ]}
          />
          <ProFormSwitch colProps={{ md: 8, xs: 24 }} label="启用插件" name="enabled" />
        </ProForm.Group>
        <ProFormTextArea label="触发词" name="triggerHints" placeholder="一行一个，例如：生成视频" />
        <ProFormTextArea label="权限说明" name="permissions" placeholder="一行一个，例如：读取用户上传素材" />
        <ProFormList
          creatorButtonProps={{ creatorButtonText: '添加表单字段' }}
          initialValue={[]}
          label="用户需要填写的表单"
          name="inputFields"
        >
          <ProForm.Group>
            <ProFormText colProps={{ md: 6, xs: 12 }} label="字段 ID" name="id" rules={[{ required: true }]} />
            <ProFormText colProps={{ md: 6, xs: 12 }} label="显示名称" name="label" rules={[{ required: true }]} />
            <ProFormSelect colProps={{ md: 6, xs: 12 }} label="类型" name="type" options={fieldTypeOptions} />
            <ProFormSwitch colProps={{ md: 6, xs: 12 }} label="必填" name="required" />
            <ProFormTextArea colProps={{ span: 24 }} label="选项" name="optionsText" placeholder="下拉选择可填写，一行一个" />
          </ProForm.Group>
        </ProFormList>
      </ModalForm>
    </PageContainer>
  )
}
