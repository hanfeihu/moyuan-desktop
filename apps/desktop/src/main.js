import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Bell, Bot, CheckCircle2, ChevronRight, FileText, FolderOpen, KeyRound, MessageSquareText, Play, Search, ShieldCheck, Sparkles, TerminalSquare, UserRound, } from 'lucide-react';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
const tasks = [
    {
        id: 'task-1',
        title: '生成今日客户跟进日报',
        status: 'needs_approval',
        workspace: '销售一组 / 华东客户',
        transcript: [
            { role: 'user', content: '根据今天企微和飞书沟通，生成客户跟进日报。', timestamp: '10:18' },
            { role: 'assistant', content: '已整理 3 个客户进展，发现 1 个审批延迟风险。需要读取客户报价表。', timestamp: '10:19' },
            { role: 'tool', content: '请求权限：读取 /客户资料/华东项目/报价表.xlsx', timestamp: '10:19' },
        ],
    },
    {
        id: 'task-2',
        title: '把会议纪要拆成待办',
        status: 'running',
        workspace: '交付中心 / 飞书项目',
        transcript: [
            { role: 'assistant', content: '正在从会议纪要中识别负责人、截止时间和风险项。', timestamp: '09:42' },
        ],
    },
    {
        id: 'task-3',
        title: '查询企业知识库里的报销规则',
        status: 'completed',
        workspace: '我的工作区',
        transcript: [
            { role: 'assistant', content: '已引用 2 篇制度文档，并生成可提交的报销说明。', timestamp: '09:12' },
        ],
    },
];
const workspaces = ['我的工作区', '销售一组', '华东客户项目', '日报周报', '企业知识库'];
function statusText(status) {
    return {
        queued: '排队中',
        running: '执行中',
        needs_approval: '待确认',
        completed: '已完成',
        failed: '失败',
    }[status];
}
function DesktopApp() {
    const [activeTask, setActiveTask] = useState(tasks[0]);
    const [prompt, setPrompt] = useState('帮我把今天的客户沟通、会议记录和任务进展整理成日报，风险项单独列出来。');
    return (_jsxs("main", { className: "desktop-shell", children: [_jsxs("aside", { className: "rail", children: [_jsxs("div", { className: "traffic-lights", "aria-hidden": "true", children: [_jsx("span", {}), _jsx("span", {}), _jsx("span", {})] }), _jsx("button", { className: "rail-action active", title: "AI \u5DE5\u4F5C\u533A", children: _jsx(Bot, { size: 20 }) }), _jsx("button", { className: "rail-action", title: "\u6587\u4EF6", children: _jsx(FolderOpen, { size: 20 }) }), _jsx("button", { className: "rail-action", title: "\u6D88\u606F", children: _jsx(MessageSquareText, { size: 20 }) }), _jsx("button", { className: "rail-action", title: "\u77E5\u8BC6\u5E93", children: _jsx(FileText, { size: 20 }) }), _jsx("button", { className: "rail-action bottom", title: "\u8D26\u53F7", children: _jsx(UserRound, { size: 20 }) })] }), _jsxs("aside", { className: "workspace-list", children: [_jsxs("div", { className: "desktop-brand", children: [_jsx(Sparkles, { size: 18 }), _jsx("strong", { children: "\u4F01\u4E1A Codex" })] }), _jsxs("label", { className: "search-box", children: [_jsx(Search, { size: 16 }), _jsx("input", { placeholder: "\u641C\u7D22\u5DE5\u4F5C\u533A\u6216\u4EFB\u52A1" })] }), _jsxs("div", { className: "workspace-section", children: [_jsx("span", { className: "caption", children: "\u5DE5\u4F5C\u533A" }), workspaces.map((name, index) => (_jsxs("button", { className: index === 0 ? 'workspace-item active' : 'workspace-item', children: [_jsx("span", { children: name }), _jsx(ChevronRight, { size: 16 })] }, name)))] }), _jsxs("div", { className: "workspace-section", children: [_jsx("span", { className: "caption", children: "\u6B63\u5728\u6267\u884C" }), tasks.map((task) => (_jsxs("button", { className: task.id === activeTask.id ? 'task-pill active' : 'task-pill', onClick: () => setActiveTask(task), children: [_jsx("span", { children: task.title }), _jsx("small", { children: statusText(task.status) })] }, task.id)))] })] }), _jsxs("section", { className: "conversation", children: [_jsxs("header", { className: "conversation-header", children: [_jsxs("div", { children: [_jsx("span", { className: "caption", children: "\u5F53\u524D\u4EFB\u52A1" }), _jsx("h1", { children: activeTask.title }), _jsx("p", { children: activeTask.workspace })] }), _jsxs("div", { className: "header-actions", children: [_jsx("button", { className: "icon-button", title: "\u901A\u77E5", children: _jsx(Bell, { size: 18 }) }), _jsxs("button", { className: "run-button", children: [_jsx(Play, { size: 16 }), "\u8FD0\u884C"] })] })] }), _jsxs("div", { className: "transcript", children: [activeTask.transcript.map((item, index) => (_jsxs("article", { className: `message ${item.role}`, children: [_jsxs("div", { className: "message-meta", children: [_jsx("span", { children: item.role === 'assistant' ? 'Codex' : item.role === 'tool' ? '工具请求' : '你' }), _jsx("small", { children: item.timestamp })] }), _jsx("p", { children: item.content })] }, `${item.timestamp}-${index}`))), _jsxs("article", { className: "message assistant", children: [_jsxs("div", { className: "message-meta", children: [_jsx("span", { children: "Codex" }), _jsx("small", { children: "\u73B0\u5728" })] }), _jsx("p", { children: "\u6211\u4F1A\u5728\u672C\u673A\u5DE5\u4F5C\u533A\u91CC\u6267\u884C\u4EFB\u52A1\uFF0C\u53EA\u8BBF\u95EE\u4F01\u4E1A\u7B56\u7565\u5141\u8BB8\u7684\u6570\u636E\u3002\u6D89\u53CA\u5916\u53D1\u3001\u5199\u5165\u7CFB\u7EDF\u3001\u8BFB\u53D6\u654F\u611F\u6587\u4EF6\u65F6\uFF0C\u4F1A\u5148\u505C\u4E0B\u6765\u8BA9\u4F60\u786E\u8BA4\u3002" })] })] }), _jsxs("footer", { className: "composer", children: [_jsx("textarea", { value: prompt, onChange: (event) => setPrompt(event.target.value) }), _jsxs("div", { className: "composer-footer", children: [_jsx("span", { children: "\u5DF2\u8FDE\u63A5\uFF1A\u4F01\u4E1A\u5FAE\u4FE1\u3001\u98DE\u4E66\u3001\u4F01\u4E1A\u77E5\u8BC6\u5E93\u3001Codex Runtime" }), _jsxs("button", { children: [_jsx(Sparkles, { size: 16 }), "\u4EA4\u7ED9 Codex"] })] })] })] }), _jsxs("aside", { className: "inspector", children: [_jsxs("section", { className: "inspector-card emphasis", children: [_jsxs("div", { className: "inspector-title", children: [_jsx(ShieldCheck, { size: 18 }), _jsx("strong", { children: "\u4F01\u4E1A\u7B56\u7565" })] }), _jsxs("div", { className: "policy-line", children: [_jsx("span", { children: "\u6A21\u578B\u4E2D\u8F6C" }), _jsx("strong", { children: "ai.blector.com" })] }), _jsxs("div", { className: "policy-line", children: [_jsx("span", { children: "\u6570\u636E\u51FA\u57DF" }), _jsx("strong", { children: "\u7981\u6B62" })] }), _jsxs("div", { className: "policy-line", children: [_jsx("span", { children: "\u5BA1\u8BA1" }), _jsx("strong", { children: "\u5168\u91CF\u5F00\u542F" })] })] }), _jsxs("section", { className: "inspector-card approval", children: [_jsxs("div", { className: "inspector-title", children: [_jsx(KeyRound, { size: 18 }), _jsx("strong", { children: "\u7B49\u5F85\u786E\u8BA4" })] }), _jsx("p", { children: "Codex \u8BF7\u6C42\u8BFB\u53D6\u5BA2\u6237\u62A5\u4EF7\u8868\uFF0C\u7528\u4E8E\u751F\u6210\u65E5\u62A5\u4E2D\u7684\u5BA2\u6237\u8FDB\u5C55\u548C\u98CE\u9669\u5224\u65AD\u3002" }), _jsxs("div", { className: "approval-actions", children: [_jsx("button", { className: "allow", children: "\u5141\u8BB8\u4E00\u6B21" }), _jsx("button", { className: "deny", children: "\u62D2\u7EDD" })] })] }), _jsxs("section", { className: "inspector-card", children: [_jsxs("div", { className: "inspector-title", children: [_jsx(TerminalSquare, { size: 18 }), _jsx("strong", { children: "Runtime" })] }), _jsxs("ul", { className: "runtime-list", children: [_jsxs("li", { children: [_jsx(CheckCircle2, { size: 15 }), "@openai/codex \u5DF2\u5185\u7F6E"] }), _jsxs("li", { children: [_jsx(CheckCircle2, { size: 15 }), "\u5DE5\u5177\u8C03\u7528\u8FDB\u5165\u5BA1\u8BA1\u6D41"] }), _jsxs("li", { children: [_jsx(CheckCircle2, { size: 15 }), "\u9AD8\u98CE\u9669\u52A8\u4F5C\u4EBA\u5DE5\u786E\u8BA4"] })] })] })] })] }));
}
ReactDOM.createRoot(document.getElementById('root')).render(_jsx(React.StrictMode, { children: _jsx(DesktopApp, {}) }));
