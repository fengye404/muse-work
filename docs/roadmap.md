# 产品路线图

> AI Desktop Assistant 未来发展方向与功能规划
> 参考: Claude Agent SDK / Claude Code

## 产品定位

**AI Desktop Assistant** 定位为一款类似 **Anthropic Claude Cowork** 的桌面 AI 协作工具，提供：

- 流畅的多轮对话体验
- 本地文件与项目的深度集成
- 工具调用和自动化能力
- MCP 协议支持，连接外部服务
- 多 AI 提供商支持

## 当前已实现 vs Claude Agent SDK

| 功能 | 当前状态 | Claude Agent SDK |
|------|----------|------------------|
| 多轮对话 | ✅ 已实现 | ✅ |
| 流式响应 | ✅ 已实现 | ✅ |
| 会话持久化 | ✅ SQLite | ✅ |
| 配置持久化 | ✅ SQLite | ✅ |
| 多 API 提供商 | ✅ 已实现 | ✅ |
| 文件读取工具 | ✅ 已实现 | ✅ |
| 文件写入工具 | ✅ 已实现 | ✅ |
| 文件编辑工具 | ✅ 已实现 | ✅ |
| Bash 执行工具 | ✅ 已实现 | ✅ |
| Glob 搜索 | ✅ 已实现 | ✅ |
| Grep 搜索 | ✅ 已实现 | ✅ |
| WebFetch | ✅ 已实现 | ✅ |
| 工具权限系统 | ✅ 已实现 | ✅ |
| 工具循环 (Agentic Loop) | ✅ 已实现 | ✅ |
| Git 集成 | ❌ | ✅ |
| MCP 协议 | ✅ 已实现 | ✅ |
| Hooks 系统 | ❌ | ✅ |
| 子代理 (Subagents) | ❌ | ✅ (最多 7 个并行) |
| 检查点/恢复 | ❌ | ✅ |
| 上下文压缩 | ✅ 基础版 | ✅ |
| @ 文件引用 | ✅ 基础版 | ✅ |
| 斜杠命令 | ✅ 基础版 | ✅ |
| Skill 系统 | 🟡 基础版已实现 | ✅ |
| IDE 集成 | ❌ | ✅ VS Code |

---

## 功能模块详细规划

### 阶段一: 工具系统 (v1.4) - ✅ 已完成

#### 1.1 内置工具

| 工具 | 功能 | 权限 | 优先级 | 状态 |
|------|------|------|--------|------|
| `Read` | 读取文件内容，支持行号范围 | allow | P0 | ✅ 已实现 |
| `Write` | 创建或覆盖整个文件 | ask | P0 | ✅ 已实现 |
| `Edit` | 精确字符串替换编辑 | ask | P0 | ✅ 已实现 |
| `Glob` | 按模式搜索文件 (如 `**/*.ts`) | allow | P0 | ✅ 已实现 |
| `Grep` | 正则表达式搜索文件内容 | allow | P0 | ✅ 已实现 |
| `Bash` | 执行 Shell 命令 | ask | P0 | ✅ 已实现 |
| `WebFetch` | 获取网页内容 | allow | P1 | ✅ 已实现 |
| `WebSearch` | 网络搜索 | allow | P2 | ❌ 待开发 |
| `ListDir` | 列出目录内容 | allow | - | ✅ 已实现 (额外) |
| `SystemInfo` | 获取系统信息 | allow | - | ✅ 已实现 (额外) |

#### 1.2 工具实现架构

```typescript
interface Tool {
  name: string;
  description: string;
  input_schema: JSONSchema;
  execute: (input: unknown) => Promise<ToolResult>;
}

interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}
```

#### 1.3 权限系统 - ✅ 已实现

```json
{
  "permissions": {
    "read": "allow",
    "write": "ask",
    "edit": "ask",
    "bash": "ask",
    "webfetch": "allow"
  },
  "allowedPaths": ["./src", "./docs"],
  "deniedPaths": ["./node_modules", "./.env"]
}
```

权限级别：
- `allow` - 自动允许，无需确认
- `ask` - 每次询问用户确认
- `deny` - 禁止使用

#### 1.4 工具循环 (Agentic Loop) - ✅ 已实现

```
用户输入
    ↓
AI 分析并选择工具
    ↓
执行工具 → 返回结果
    ↓
AI 继续分析（可能再次调用工具）
    ↓
最终响应
```

---

### 阶段二: 检查点与恢复 (v1.4.5)

#### 2.1 检查点系统

Claude Code 的检查点功能可以追踪所有文件修改，允许用户随时回滚。

```typescript
interface Checkpoint {
  id: string;
  timestamp: number;
  description: string;
  changes: FileChange[];
}

interface FileChange {
  path: string;
  type: 'create' | 'modify' | 'delete';
  before?: string;
  after?: string;
}
```

#### 2.2 恢复功能

- `/rewind` - 打开恢复菜单
- `Esc + Esc` - 快捷键打开恢复菜单
- 可选择恢复代码、对话或两者

**注意**: Bash 命令执行的修改不会被追踪，只有通过工具的文件编辑会被记录。

---

### 阶段三: @ 文件引用 (v1.5)

#### 3.1 基础引用

```
> 分析 @src/auth.ts 并建议改进

> 比较 @package.json 和 @package-lock.json

> 解释 @src/components/ 目录的架构
```

#### 3.2 行范围引用

```
> 修复 @src/utils.ts:42-58 中的 bug
```

#### 3.3 自动补全

按 `Tab` 键自动补全文件路径和命令。

---

### 阶段四: 斜杠命令 (v1.5)

#### 4.1 内置命令

| 命令 | 功能 | 状态 |
|------|------|------|
| `/help` | 显示所有可用命令 | ✅ 已实现（基础版） |
| `/init` | 扫描项目并创建 CLAUDE.md | 📋 计划 |
| `/clear` | 新建并切换空白会话 | ✅ 已实现 |
| `/compact` | 查询上下文压缩状态（SDK 自动管理） | ✅ 已实现 |
| `/memory` | 编辑项目记忆文件 | 📋 计划 |
| `/config` | 打开配置界面 | ✅ 已实现 |
| `/model` | 切换模型 | ✅ 已实现 |
| `/cost` | 查看当前 token 用量 | 📋 计划 |
| `/mcp` | 管理 MCP 服务器 | 📋 计划 |
| `/rewind` | 回滚到之前的检查点 | 📋 计划 |
| `/export` | 导出对话到文件 | 📋 计划 |

#### 4.2 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Escape` | 停止当前响应 |
| `Escape + Escape` | 打开恢复菜单 |
| `↑` (上箭头) | 浏览历史消息 |
| `Ctrl + V` | 粘贴图片 |
| `Tab` | 自动补全 |

---

## 2026-03 现状不足与治理路线图（新增）

> 本节用于沉淀当前版本的关键不足，作为后续迭代优化的执行基线。

### 核心不足清单（按优先级）

| 优先级 | 不足点 | 现象 | 风险 | 优化方向 |
|--------|--------|------|------|----------|
| P0 | 会话语义不一致 | `/clear`、清空会话、恢复相关能力与 SDK 实际行为存在偏差（部分操作为 no-op） | 用户以为上下文已清空，实际仍可能被复用，影响结果可信度 | 将“清空”改为显式新会话切换；对 SDK 不支持能力显示“不可用/降级” |
| P0 | 工程质量闸门失效 | lint 存在大规模错误，规范与主干代码状态不一致 | 迭代时回归风险高、代码评审成本高 | 建立 CI 必过门槛（lint/typecheck/tests）；先做一次基线清理 |
| P1 | 渲染层组件巨石化 | `ChatArea`、`SettingsDialog` 体积过大，状态与 UI 耦合 | 维护困难，改一个功能容易波及其它模块 | 以“消息区/输入区/模型选择/恢复菜单/设置分面板”进行分层拆分 |
| P1 | 重构中间态残留 | 存在未接入或重复职责组件，文档与实现存在偏差 | 团队认知负担增加，重复维护 | 清理无效组件，完成单一路径接入并更新架构文档 |
| P1 | 安全基线不够硬 | `safeStorage` 不可用时会降级明文存储 | 凭证保护不符合“默认安全”预期 | 增加降级拦截与显式风险提示；在窗口安全配置中补齐更严格选项 |
| P2 | 体验一致性不足 | 中英文混用、危险操作交互不统一、暗色模式硬编码 | 产品专业感与可预期性下降 | 建立文案规范与交互规范，统一 destructive 操作流程 |
| P2 | 前端包体与首屏负载偏大 | 主渲染 chunk 超过预警阈值 | 低配设备和冷启动体验下降 | 拆分重量模块（设置、Markdown 高亮、工具卡片详情）并引入手动分包策略 |
| P2 | 版本与平台口径不一致 | README、徽章、package 版本及平台描述不一致 | 影响发布可信度 | 建立“单一版本源”与发布前一致性检查脚本 |

### 治理里程碑（建议）

| 里程碑 | 周期 | 目标 | 验收标准 |
|--------|------|------|----------|
| v2.0.1（稳定性修复） | 1 周 | 修复会话语义和 no-op 行为，统一用户可见提示 | 清空/恢复/压缩行为与实际一致；关键路径 e2e 用例通过 |
| v2.0.2（质量基线） | 1 周 | 清理 lint 基线并启用 CI 门禁 | 主分支 lint/typecheck/tests 全绿；新增 PR 不允许回退 |
| v2.1.0（架构收敛） | 2 周 | 完成 ChatArea/SettingsDialog 模块化拆分并移除冗余组件 | 核心组件行数和职责下降；文档更新到位 |
| v2.1.1（体验一致性） | 1 周 | 统一文案、危险操作确认流程、主题策略 | 中英文策略统一； destructive 操作可预测；UX 回归通过 |
| v2.1.2（性能与发布治理） | 1 周 | 优化包体与启动路径，打通发布口径校验 | 主 chunk 明显下降；版本/平台信息自动校验通过 |

### 执行原则

- 先修“语义正确性”再做“视觉优化”，避免 UI 看起来正确但行为错误。
- 每个里程碑都要求可量化验收，不接受“主观感觉好一些”。
- 文档必须与实现同步更新，避免再次出现路线图与代码状态脱节。

---

### 阶段五: Git 集成 (v1.6)

#### 5.1 Git 操作支持

| 操作 | 功能 |
|------|------|
| 状态查看 | `git status`, `git diff` |
| 提交 | 生成提交消息并提交 |
| 分支 | 创建、切换、合并分支 |
| Pull Request | 创建 PR 并生成描述 |
| 代码审查 | 分析变更并提供建议 |

#### 5.2 智能提交

AI 自动分析变更并生成有意义的提交消息：

```
> 提交当前更改

AI: 分析变更...
建议提交消息: "feat(auth): add OAuth2 login support"
确认提交？[Y/n]
```

---

### 阶段六: Hooks 系统 (v1.7)

#### 6.1 生命周期事件

Hooks 允许在 AI 操作的各个阶段执行自定义逻辑：

| 事件 | 触发时机 |
|------|----------|
| `SessionStart` | 会话开始 |
| `UserPromptSubmit` | 用户提交消息后 |
| `PreToolUse` | 工具执行前 |
| `PostToolUse` | 工具执行后 |
| `PreFileEdit` | 文件编辑前 |
| `PostFileEdit` | 文件编辑后 |
| `PreBashExecute` | Bash 命令执行前 |
| `PostBashExecute` | Bash 命令执行后 |

#### 6.2 Hook 配置

```json
{
  "hooks": {
    "PostFileEdit": {
      "command": "npx prettier --write $FILE",
      "description": "自动格式化编辑后的文件"
    },
    "PreBashExecute": {
      "command": "echo $COMMAND | grep -v 'rm -rf'",
      "description": "阻止危险命令"
    }
  }
}
```

#### 6.3 用例

- **自动格式化**: 文件编辑后自动运行 Prettier/ESLint
- **命令安全**: 阻止危险的 Bash 命令执行
- **日志记录**: 记录所有工具调用
- **通知**: 长时间任务完成后发送通知

---

### 阶段八: 沙箱执行环境 (v1.8) - 🟡 基础版已实现

#### 8.0 当前实现（2026-03）

- 已支持执行模式切换：`local` / `sandbox`
- `sandbox` 模式通过 Claude Agent SDK `query(options.sandbox)` 原生接入
- 应用层不再改写 `command/cmd`，不再拼接 `docker run`
- 审批链路仅负责 allow/deny 与权限建议（`CanUseTool` / `PermissionResult`）
- 快捷命令：
  - `/sandbox status` 查看状态
  - `/sandbox on` 开启沙箱
  - `/sandbox off` 关闭沙箱

> 说明：沙箱边界由 SDK 提供，应用层不再维护自建容器执行路径。

#### 8.1 双执行模式

任务执行支持两种模式，用户可根据安全需求选择：

| 模式 | 隔离级别 | 性能 | 适用场景 |
|------|----------|------|----------|
| **本地模式** | 无隔离 | ⚡ 最快 | 信任的项目、日常开发 |
| **沙箱模式** | SDK 沙箱隔离 | 取决于 SDK 后端实现 | 不信任的代码、敏感操作 |

#### 8.2 沙箱技术方案

```
┌─────────────────────────────────────────────────────────────┐
│                    Host (macOS/Windows)                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Electron Main Process                   │    │
│  │  ┌─────────────┐     ┌────────────────────────┐     │    │
│  │  │ Local Mode  │     │   Sandbox Mode (SDK)   │     │    │
│  │  │ (直接执行)   │     │  options.sandbox 注入  │     │    │
│  │  │             │     │  SDK 内部执行隔离策略   │     │    │
│  │  │ - Bash      │     │  - network/filesystem  │     │    │
│  │  │ - File R/W  │     │  - allow/deny checks   │     │    │
│  │  │ - Git       │     │  - permission updates  │     │    │
│  │  └─────────────┘     └────────────────────────┘     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**核心组件（仅 SDK 公共接口）：**

| 组件 | 技术选型 | 说明 |
|------|----------|------|
| `Options.sandbox` | `@anthropic-ai/claude-agent-sdk` | 注入沙箱配置 |
| `CanUseTool` | SDK 回调 | 处理审批请求 |
| `PermissionResult` | SDK 类型 | 返回 allow/deny 与权限更新 |
| `permissionMode` | SDK 选项 | 与审批策略联动 |

#### 8.3 执行流程

**本地模式（local）：**
```
用户请求 → AI 调用 Bash 工具 → 直接执行 → 返回结果
```

**沙箱模式（sandbox）：**
```
用户请求 → AI 调用 Bash 工具
    ↓
应用层注入 options.sandbox
    ↓
SDK 内部执行沙箱与策略检查
    ↓
canUseTool 审批（allow/deny）
    ↓
返回结果
```

#### 8.4 配置接口（RuntimeConfig.sandbox）

```typescript
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

interface SandboxConfig {
  mode: 'local' | 'sandbox';
  sandboxSettings: SandboxSettings;
}
```

默认值：
- `mode: 'local'`
- `sandboxSettings.enabled: false`
- `sandboxSettings.allowUnsandboxedCommands: false`
- 其余字段按 SDK 默认（未设置即 `undefined`）

#### 8.5 安全边界

| 威胁 | 本地模式 | 沙箱模式 |
|------|----------|----------|
| 恶意脚本删除文件 | ❌ 有风险 | ✅ 受 SDK 沙箱策略限制 |
| 越权文件读写 | ❌ 有风险 | ✅ 可通过 filesystem 规则限制 |
| 网络外连风险 | ❌ 有风险 | ✅ 可通过 network 规则限制 |
| 审批绕过 | ❌ 有风险 | ✅ 由 canUseTool + PermissionResult 控制 |

---

### 阶段九: MCP 协议支持 (v1.9)

#### 9.1 MCP 概述

Model Context Protocol (MCP) 是 Anthropic 提出的开放协议，允许 AI 应用连接外部工具和数据源。

#### 9.2 传输类型

| 类型 | 用途 | 示例 |
|------|------|------|
| HTTP | 远程服务器（推荐） | Notion, GitHub, Sentry |
| Stdio | 本地进程 | PostgreSQL, 文件系统 |

#### 9.3 常用 MCP 服务器

| 服务器 | 功能 | 安装命令 |
|--------|------|----------|
| filesystem | 文件系统访问 | `npx @anthropic/mcp-server-filesystem` |
| github | GitHub 集成 | `npx @anthropic/mcp-server-github` |
| postgres | 数据库查询 | `npx @anthropic/mcp-server-postgres` |
| slack | Slack 消息 | `npx @anthropic/mcp-server-slack` |
| notion | Notion 文档 | HTTP: `https://mcp.notion.com/mcp` |
| brave-search | 网络搜索 | `npx @modelcontextprotocol/server-brave-search` |

#### 9.4 配置示例

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "./"]
    },
    "github": {
      "transport": "http",
      "url": "https://mcp.github.com",
      "oauth": {
        "clientId": "xxx",
        "scope": "repo"
      }
    }
  }
}
```

---

### 阶段九点五: Skill 系统 (v1.9.5) - 🟡 基础版已完成

#### 9.5.1 目标

- 支持从本地目录发现技能（`SKILL.md`）
- 支持在会话中按需启用/停用技能
- 将启用技能内容自动注入系统提示词，影响后续回答行为

#### 9.5.2 当前实现（2026-03）

- 技能扫描目录：
  - `./.claude/skills`
  - `~/.claude/skills`
  - `$CODEX_HOME/skills`
- 斜杠命令：
  - `/skills` 查看技能列表与启用状态
  - `/skill on <skill-id|name>` 启用技能
  - `/skill off <skill-id|name>` 停用技能
- 运行时配置持久化：
  - 已启用技能列表持久化到本地配置
  - 下次启动后自动恢复

#### 9.5.3 后续增强

- Skill UI 管理面板（搜索、筛选、标签）
- 技能优先级与冲突检测
- 技能热重载与变更提醒

---

### 阶段十: Agent 系统 (v2.0)

#### 10.1 主代理模式

| 模式 | 权限 | 用途 |
|------|------|------|
| Build | 完整权限 | 开发、修改文件、执行命令 |
| Plan | 只读 | 规划、分析、代码审查 |

按 `Tab` 键切换主代理模式。

#### 10.2 子代理 (Subagents)

Claude Code 支持最多 **7 个并行子代理**：

| 代理 | 功能 | 权限 |
|------|------|------|
| General | 通用研究，复杂问题分解 | 完整 |
| Explore | 快速代码探索 | 只读 |
| Custom | 用户自定义代理 | 可配置 |

使用 `@agent-name` 调用子代理：

```
> @explore 找出所有使用 useState 的组件
```

#### 10.3 自定义 Agent

```markdown
---
name: code-reviewer
description: 代码审查专家
mode: subagent
model: claude-sonnet-4-5
tools:
  write: false
  edit: false
  bash: false
---

你是一个代码审查专家，专注于：
- 代码质量和最佳实践
- 潜在的 bug 和边界情况
- 性能和安全问题
```

---

### 阶段十一: 上下文管理 (v2.1)

#### 11.1 上下文压缩 (/compact)

当对话过长时，自动压缩保留关键信息：

```
> /compact

AI: 压缩对话历史...
- 原始: 150,000 tokens
- 压缩后: 45,000 tokens
- 保留了关键决策和代码变更记录
```

#### 11.2 项目记忆 (CLAUDE.md)

```markdown
# Project: AI Desktop Assistant

## Tech Stack
- Electron 28
- TypeScript 5.3
- SQLite (better-sqlite3)

## Coding Conventions
- 使用英文注释
- 遵循 ESLint 规则

## Important Files
- src/claude-service.ts - AI 服务核心
- src/session-storage.ts - 会话存储
```

#### 11.3 200K 上下文窗口

Claude 支持 200K token 的上下文窗口，可以理解整个代码库结构。

---

### 阶段十二: IDE 集成 (v2.2)

#### 12.1 VS Code 扩展

- 侧边栏聊天界面
- @ 引用打开的文件
- 选中代码直接询问
- 内联代码建议

#### 12.2 GitHub 集成

- `@claude` 在 PR 中触发审查
- 自动生成 PR 描述
- Issue 分析和建议

---

## 实现优先级总结

| 版本 | 功能 | 优先级 | 状态 |
|------|------|--------|------|
| v1.4 | 工具系统 (Read/Write/Edit/Bash/Grep/WebFetch) | P0 | ✅ 已完成 |
| v1.4.5 | 检查点与恢复 | P0 | ❌ 未开始 |
| v1.5 | @ 文件引用 + 斜杠命令 | P0 | ✅ 基础能力已完成 |
| v1.6 | Git 集成 | P1 | ❌ 未开始 |
| v1.7 | Hooks 系统 | P1 | ❌ 未开始 |
| v1.8 | **沙箱执行环境** | P1 | 🟡 基础版已实现（SDK 原生沙箱） |
| v1.9 | MCP 协议支持 | P1 | ✅ 已完成 |
| v1.9.5 | Skill 系统 | P1 | 🟡 基础版已实现 |
| v2.0 | Agent 系统 | P2 | ❌ 未开始 |
| v2.1 | 上下文管理 | P2 | 🟡 部分完成（/compact） |
| v2.2 | IDE 集成 | P3 | ❌ 未开始 |

---

## 技术参考

### Claude Agent SDK 官方文档

| 文档 | 链接 |
|------|------|
| SDK 概览 | https://platform.claude.com/docs/zh-CN/agent-sdk/overview |
| 快速开始 | https://platform.claude.com/docs/zh-CN/agent-sdk/quickstart |
| TypeScript SDK | https://platform.claude.com/docs/zh-CN/agent-sdk/typescript |
| Python SDK | https://platform.claude.com/docs/zh-CN/agent-sdk/python |

> **Note**: 如果中文文档无法访问，可将 URL 中的 `zh-CN` 替换为 `en` 使用英文文档。

### 其他参考

- [MCP 规范](https://modelcontextprotocol.io)
- [Anthropic API](https://docs.anthropic.com)

---

*最后更新: 2026-03-07*
