import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ApiOutlined, AuditOutlined, CloudServerOutlined, ControlOutlined, DeploymentUnitOutlined, SafetyCertificateOutlined, TeamOutlined, } from '@ant-design/icons';
import { PageContainer, ProCard, ProConfigProvider, ProDescriptions, ProForm, ProFormDependency, ProFormDigit, ProFormSelect, ProFormSwitch, ProFormText, ProTable, } from '@ant-design/pro-components';
import { App, Button, ConfigProvider, Flex, Layout, Menu, Progress, Space, Tag, Typography, theme } from 'antd';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
const { Header, Sider, Content } = Layout;
const providers = [
    {
        id: 'blector',
        name: 'Blector 中转',
        baseUrl: 'https://ai.blector.com/v1',
        maskedApiKey: 'sk-gJcO************************lsBi',
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
];
const employees = [
    { id: 'u-1001', name: '韩飞虎', department: '销售一组', title: '客户经理', source: 'wecom', manager: '王敏' },
    { id: 'u-1002', name: '林青', department: '交付中心', title: '实施顾问', source: 'lark', manager: '赵远' },
    { id: 'u-1003', name: '周然', department: '产品部', title: '产品经理', source: 'dingtalk', manager: '陈立' },
];
function AdminApp() {
    return (_jsx(ConfigProvider, { theme: {
            algorithm: theme.defaultAlgorithm,
            token: {
                colorPrimary: '#1677ff',
                borderRadius: 8,
                fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            },
        }, children: _jsx(ProConfigProvider, { hashed: false, children: _jsx(App, { children: _jsxs(Layout, { className: "admin-shell", children: [_jsxs(Sider, { width: 248, className: "admin-sider", children: [_jsxs("div", { className: "admin-brand", children: [_jsx(CloudServerOutlined, {}), _jsxs("div", { children: [_jsx("strong", { children: "\u4F01\u4E1A AI \u63A7\u5236\u53F0" }), _jsx("span", { children: "Admin Console" })] })] }), _jsx(Menu, { theme: "dark", mode: "inline", defaultSelectedKeys: ['overview'], items: [
                                        { key: 'overview', icon: _jsx(ControlOutlined, {}), label: '总览' },
                                        { key: 'models', icon: _jsx(ApiOutlined, {}), label: '模型与密钥' },
                                        { key: 'org', icon: _jsx(TeamOutlined, {}), label: '组织同步' },
                                        { key: 'runtime', icon: _jsx(DeploymentUnitOutlined, {}), label: 'Codex Runtime' },
                                        { key: 'policy', icon: _jsx(SafetyCertificateOutlined, {}), label: '安全策略' },
                                        { key: 'audit', icon: _jsx(AuditOutlined, {}), label: '审计日志' },
                                    ] })] }), _jsxs(Layout, { children: [_jsxs(Header, { className: "admin-header", children: [_jsx(Typography.Text, { strong: true, children: "\u672C\u5730\u5316\u90E8\u7F72 \u00B7 \u4F01\u4E1A\u53EF\u63A7 \u00B7 \u5458\u5DE5\u684C\u9762\u7AEF\u7EDF\u4E00\u7BA1\u63A7" }), _jsxs(Space, { children: [_jsx(Tag, { color: "green", children: "\u8FD0\u884C\u4E2D" }), _jsx(Button, { type: "primary", children: "\u53D1\u5E03\u7B56\u7565" })] })] }), _jsx(Content, { className: "admin-content", children: _jsxs(PageContainer, { title: "\u4F01\u4E1A AI \u540E\u53F0", subTitle: "\u914D\u7F6E\u6A21\u578B\u4E2D\u8F6C\u3001\u7EC4\u7EC7\u6765\u6E90\u3001Codex \u5185\u6838\u3001\u5DE5\u5177\u6743\u9650\u548C\u5BA1\u8BA1\u7B56\u7565", children: [_jsxs(ProCard, { gutter: 16, wrap: true, children: [_jsxs(ProCard, { title: "\u63A5\u5165\u5458\u5DE5", colSpan: "25%", children: [_jsx(Typography.Title, { level: 2, children: "1,426" }), _jsx(Typography.Text, { type: "secondary", children: "\u4F01\u5FAE\u3001\u98DE\u4E66\u3001\u9489\u9489\u7EDF\u4E00\u540C\u6B65" })] }), _jsxs(ProCard, { title: "Codex \u4EFB\u52A1", colSpan: "25%", children: [_jsx(Typography.Title, { level: 2, children: "238" }), _jsx(Typography.Text, { type: "secondary", children: "\u4ECA\u65E5\u6267\u884C\uFF0C37 \u6B21\u9700\u4EBA\u5DE5\u786E\u8BA4" })] }), _jsxs(ProCard, { title: "\u5BA1\u8BA1\u8986\u76D6", colSpan: "25%", children: [_jsx(Typography.Title, { level: 2, children: "100%" }), _jsx(Typography.Text, { type: "secondary", children: "\u5DE5\u5177\u8C03\u7528\u548C\u6A21\u578B\u8BF7\u6C42\u5168\u94FE\u8DEF\u8BB0\u5F55" })] }), _jsx(ProCard, { title: "\u5408\u89C4\u7B56\u7565", colSpan: "25%", children: _jsx(Progress, { percent: 92, strokeColor: "#1677ff" }) })] }), _jsx(ProCard, { className: "section-card", title: "\u6A21\u578B\u4E2D\u8F6C\u4E0E\u5BC6\u94A5\u914D\u7F6E", extra: _jsx(Button, { children: "\u6D4B\u8BD5\u8FDE\u63A5" }), children: _jsxs(ProForm, { grid: true, submitter: {
                                                        searchConfig: { submitText: '保存配置' },
                                                        resetButtonProps: false,
                                                    }, initialValues: {
                                                        provider: 'blector',
                                                        baseUrl: 'https://ai.blector.com/v1',
                                                        defaultModel: 'gpt-5-codex',
                                                        enabled: true,
                                                        monthlyLimit: 5000000,
                                                    }, children: [_jsx(ProFormSelect, { name: "provider", label: "\u6A21\u578B\u4F9B\u5E94\u5546", colProps: { span: 8 }, options: [
                                                                { label: 'Blector 中转', value: 'blector' },
                                                                { label: '本地私有模型', value: 'local' },
                                                                { label: 'Azure OpenAI', value: 'azure' },
                                                            ] }), _jsx(ProFormText, { name: "baseUrl", label: "Base URL", colProps: { span: 8 } }), _jsx(ProFormText.Password, { name: "apiKey", label: "API Key", placeholder: "\u540E\u53F0\u4FDD\u5B58\uFF0C\u524D\u7AEF\u4E0D\u5C55\u793A\u660E\u6587", colProps: { span: 8 } }), _jsx(ProFormText, { name: "defaultModel", label: "\u9ED8\u8BA4\u6A21\u578B", colProps: { span: 8 } }), _jsx(ProFormDigit, { name: "monthlyLimit", label: "\u6708\u5EA6 Token \u989D\u5EA6", colProps: { span: 8 } }), _jsx(ProFormSwitch, { name: "enabled", label: "\u542F\u7528\u8BE5\u901A\u9053", colProps: { span: 8 } }), _jsx(ProFormDependency, { name: ['provider'], children: ({ provider }) => provider === 'blector' ? (_jsx(Tag, { color: "blue", children: "\u5458\u5DE5\u684C\u9762\u7AEF\u7684 Codex runtime \u5C06\u901A\u8FC7\u8BE5\u4E2D\u8F6C\u5730\u5740\u53D1\u8D77\u6A21\u578B\u8BF7\u6C42" })) : null })] }) }), _jsxs(Flex, { gap: 16, align: "stretch", className: "two-columns", children: [_jsx(ProCard, { title: "\u5DF2\u914D\u7F6E\u6A21\u578B\u901A\u9053", className: "fill-card", children: _jsx(ProTable, { rowKey: "id", search: false, options: false, pagination: false, dataSource: providers, columns: [
                                                                { title: '名称', dataIndex: 'name' },
                                                                { title: 'Base URL', dataIndex: 'baseUrl' },
                                                                { title: '默认模型', dataIndex: 'defaultModel' },
                                                                { title: 'Key', dataIndex: 'maskedApiKey' },
                                                                {
                                                                    title: '状态',
                                                                    dataIndex: 'enabled',
                                                                    render: (_, row) => _jsx(Tag, { color: row.enabled ? 'green' : 'default', children: row.enabled ? '启用' : '停用' }),
                                                                },
                                                            ] }) }), _jsx(ProCard, { title: "\u4F01\u4E1A\u7B56\u7565", className: "policy-card", children: _jsx(ProDescriptions, { column: 1, dataSource: {
                                                                dataBoundary: '企业内网',
                                                                externalSharing: '外发需审批',
                                                                highRiskTool: '默认人工确认',
                                                                retention: '审计保留 180 天',
                                                            }, columns: [
                                                                { title: '数据边界', dataIndex: 'dataBoundary' },
                                                                { title: '外发策略', dataIndex: 'externalSharing' },
                                                                { title: '高风险工具', dataIndex: 'highRiskTool' },
                                                                { title: '审计保留', dataIndex: 'retention' },
                                                            ] }) })] }), _jsx(ProCard, { className: "section-card", title: "\u7EC4\u7EC7\u67B6\u6784\u540C\u6B65", children: _jsx(ProTable, { rowKey: "id", search: false, options: false, dataSource: employees, pagination: false, columns: [
                                                        { title: '员工', dataIndex: 'name' },
                                                        { title: '部门', dataIndex: 'department' },
                                                        { title: '岗位', dataIndex: 'title' },
                                                        {
                                                            title: '来源',
                                                            dataIndex: 'source',
                                                            render: (_, row) => {
                                                                const label = { wecom: '企业微信', lark: '飞书', dingtalk: '钉钉' }[row.source];
                                                                return _jsx(Tag, { children: label });
                                                            },
                                                        },
                                                        { title: '直属上级', dataIndex: 'manager' },
                                                    ] }) })] }) })] })] }) }) }) }));
}
ReactDOM.createRoot(document.getElementById('root')).render(_jsx(React.StrictMode, { children: _jsx(AdminApp, {}) }));
