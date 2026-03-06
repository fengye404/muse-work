# Agent SDK 迁移总览

> 创建日期: 2026-02-26  
> 状态: **已完成**

## 背景

AI Desktop Assistant 立项之初定位为基于 Claude Code SDK（现 Claude Agent SDK）的桌面 AI 助手，但实际开发中直接使用了 `@anthropic-ai/sdk` 和 `openai` 包，手动实现了 agentic 循环、工具系统、MCP 客户端等。本次迁移将应用改造为真正基于 `@anthropic-ai/claude-agent-sdk` 的架构。

## 迁移范围

### 被 SDK 替代的模块

| 模块 | 当前实现 | 迁移后 |
|------|----------|--------|
| Agentic 循环 | `provider-streams.ts` 手动迭代 tool_use → executeTool → 再次 API 调用 | SDK `query()` 自动处理 |
| 工具系统 | `tool-executor.ts` 定义 9 个工具 + 手动执行 | SDK 内置工具 (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch) |
| MCP 客户端 | `mcp-stdio-client.ts` / `mcp-sse-client.ts` / `mcp-streamable-http-client.ts` | SDK `mcpServers` 选项 |
| 工具审批 | `ToolApprovalCoordinator` + IPC + `ToolApprovalDialog` | SDK `canUseTool` 回调 |
| 斜杠命令 | `slash-commands.ts` 硬编码 5 个命令 | SDK 内置 + `.claude/commands/*.md` |
| 会话管理 | SQLite 完整消息持久化 | SDK session（文件系统）+ SQLite 元数据 |
| 历史压缩 | 自定义 compact 逻辑 | SDK `/compact` 命令 |

### 新增模块

| 模块 | 说明 |
|------|------|
| 协议转换层 | `src/ai/protocol-translator/` — OpenAI ↔ Anthropic 双向协议转换 |
| 自定义斜杠命令 | `.claude/commands/` 目录 |

## 架构决策记录 (ADR)

### ADR-1: 使用 Claude Agent SDK 作为核心

**决策**: 将 `@anthropic-ai/claude-agent-sdk` 的 `query()` 作为唯一的 AI 调用入口。

**理由**: SDK 提供了完整的 agentic 循环、工具执行、MCP 集成、会话管理和权限控制，避免重复造轮子。

### ADR-2: 自建协议转换层替代 LiteLLM

**决策**: 在 Electron 主进程内自建 HTTP 反向代理，实现 Anthropic ↔ OpenAI 协议转换。

**理由**:
- LiteLLM 需要 Python 运行时，对 Electron 应用过重
- 只需 OpenAI ↔ Anthropic 单一转换路径，不需要 100+ provider 支持
- TypeScript 同技术栈，可深度集成，零外部依赖
- 参考 `@musistudio/llms` (212 stars, 4.7K 周下载量) 和 `claude-code-router` 的成熟架构

### ADR-3: SDK Session + SQLite 元数据混合管理

**决策**: SDK 管理对话上下文和消息持久化，SQLite 仅存轻量映射。

**理由**:
- SDK 的 `listSessions()` 提供 `sessionId`、`summary`、`lastModified`
- SDK 支持 `resume`（恢复）和 `forkSession`（分支）
- SQLite 仅补充 SDK 缺失的功能：自定义标题、删除标记

### ADR-4: 环境变量动态切换 Provider

**决策**: 每次调用 `query()` 前通过 `options.env` 动态注入 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL`。

**理由**: SDK 可通过 `options.env` 读取认证信息，桌面应用需支持多 Provider 配置切换；OpenAI 模式下同时将 `settingSources` 限制为 `['project', 'local']`，避免读取用户级 `~/.claude/settings.json`。

## 迁移阶段

| Phase | 内容 | 依赖 |
|-------|------|------|
| 0 | 文档基线 | 无 |
| 1 | 协议转换层 | 无 |
| 2 | 依赖更新 | Phase 1 |
| 3 | AgentService 核心 | Phase 1, 2 |
| 4 | 清理旧文件 | Phase 3 |
| 5 | 工具审批 | Phase 3 |
| 6 | 会话存储简化 | Phase 3 |
| 7 | MCP 配置管理 | Phase 3 |
| 8 | IPC Handlers | Phase 3-7 |
| 9 | 斜杠命令 | Phase 3 |
| 10 | 渲染层流处理 | Phase 3 |
| 11 | Types / Preload / Config UI | Phase 3-10 |
| 12 | 文档收尾 | Phase 全部 |

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| SDK spawn 子进程在 Electron 打包后路径错误 | 测试 asar 解包、extraResources 配置 |
| 协议转换层遗漏字段 | 参考 API 文档 + musistudio/llms 实现 + 完善单测 |
| 旧会话数据无法迁移 | 首次启动清理或标记旧数据 |
| SDK 版本更新 breaking change | 锁定版本，关注 CHANGELOG |

## 迁移完成摘要

所有 12 个阶段已全部完成。以下是最终的文件变更清单：

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/agent-service.ts` | 核心 AI 服务，基于 SDK `query()` |
| `src/ai/protocol-translator/types.ts` | 统一中间类型定义 |
| `src/ai/protocol-translator/transformers/message-transformer.ts` | 消息格式转换 |
| `src/ai/protocol-translator/transformers/tool-transformer.ts` | 工具定义转换 |
| `src/ai/protocol-translator/transformers/stream-transformer.ts` | SSE 流式转换 |
| `src/ai/protocol-translator/proxy-server.ts` | HTTP 反向代理服务器 |
| `src/ai/protocol-translator/index.ts` | 模块入口 |
| `.claude/commands/` | SDK 自定义斜杠命令目录 |
| `docs/architecture/agent-sdk-migration-overview-2026-02-26.md` | 本文档 |
| `docs/architecture/protocol-translator-design-2026-02-26.md` | 协议转换层设计文档 |

### 删除文件

| 文件 | 原因 |
|------|------|
| `src/claude-service.ts` | 被 `agent-service.ts` 替代 |
| `src/tool-executor.ts` | SDK 内置工具替代 |
| `src/ai/provider-streams.ts` | SDK `query()` 替代 |
| `src/ai/providers/*.ts` (4 files) | SDK + 协议转换层替代 |
| `src/ai/claude-service-constants.ts` | SDK 内部管理 |
| `src/main-process/mcp/mcp-stdio-client.ts` | SDK 内置 MCP 支持 |
| `src/main-process/mcp/mcp-sse-client.ts` | SDK 内置 MCP 支持 |
| `src/main-process/mcp/mcp-streamable-http-client.ts` | SDK 内置 MCP 支持 |

### 大幅重构文件

| 文件 | 变更说明 |
|------|----------|
| `src/main-process/main-process-context.ts` | 替换 ClaudeService 为 AgentService，重写服务初始化 |
| `src/main-process/tool-approval-coordinator.ts` | 适配 SDK `canUseTool` 回调签名 |
| `src/session-storage.ts` | 移除消息表，改为 session_metadata 轻量映射 |
| `src/main-process/mcp/mcp-manager.ts` | 简化为纯配置持有者 |
| `src/main-process/ipc/chat-handlers.ts` | 委托 AgentService 处理 |
| `src/main-process/ipc/session-handlers.ts` | 集成 SDK 会话列表 + 本地元数据 |
| `src/renderer/lib/slash-commands.ts` | 支持 SDK 命令 + UI 命令混合模式 |
| `src/types/index.ts` | 移除旧工具类型，更新审批接口 |

### 依赖变更

```diff
+ @anthropic-ai/claude-agent-sdk: ^0.2.56
+ @anthropic-ai/sdk: ^0.30.0 (SDK 类型依赖)
- openai: ^4.104.0
```
