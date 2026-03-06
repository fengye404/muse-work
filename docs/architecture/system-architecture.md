# AI Desktop Assistant 系统架构文档

> 最后更新：2026-02-28 | 基于 Agent SDK 迁移后的架构

## 1. 概述

AI Desktop Assistant 是一款基于 Electron 的跨平台 AI 协作桌面应用，定位为类似 Anthropic Cowork 的本地化 AI 助手。核心架构围绕 **Claude Agent SDK** 构建，通过协议翻译层支持 OpenAI 兼容的第三方模型提供商。

### 设计原则

- **SDK 优先**：AI 交互、工具执行、会话管理等核心能力由 Claude Agent SDK 驱动
- **分层解耦**：Main Process / Preload / Renderer 严格隔离，通过 IPC 契约通信
- **单一职责**：每个模块/服务只承担一项明确的职责
- **渐进增强**：OpenAI 兼容提供商通过协议翻译代理接入，不侵入核心流程

## 2. 技术栈

| 层 | 技术 | 版本 |
|------|------|------|
| 桌面运行时 | Electron | 28 |
| 语言 | TypeScript | 5.3 |
| 主进程构建 | esbuild | - |
| 渲染层构建 | Vite | 7 |
| UI 框架 | React | 19 |
| CSS 框架 | Tailwind CSS | v4 |
| UI 原语 | Radix UI (shadcn 风格) | - |
| 状态管理 | Zustand | - |
| AI 核心 | @anthropic-ai/claude-agent-sdk | - |
| 数据库 | SQLite (better-sqlite3) | - |
| 打包 | electron-builder | - |

## 3. 进程模型

```
┌──────────────────────────────────────────────────────────────────┐
│                        Main Process                              │
│  main.ts → MainProcessContext                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Services                                                   │  │
│  │  AgentService         → Claude Agent SDK 交互              │  │
│  │  SessionStorage       → SQLite 配置与元数据持久化          │  │
│  │  ToolApprovalCoordinator → 工具审批请求/响应异步桥接       │  │
│  │  McpManager           → MCP 服务器配置管理                 │  │
│  │  FileReferenceResolver → @file 引用解析                    │  │
│  │  PathAutocompleteService → 路径补全                        │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ IPC Handlers (分域)                                        │  │
│  │  chat-handlers     │ session-handlers  │ config-handlers   │  │
│  │  security-handlers │ mcp-handlers      │ tool-approval     │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │ IPC (contextBridge, typed channels)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Preload Script                             │
│  preload.ts                                                      │
│  - contextBridge.exposeInMainWorld('electronAPI', ...)            │
│  - 单监听器替换策略                                              │
│  - 内联 IPC_CHANNELS（避免沙箱模块加载问题）                    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Renderer Process                            │
│  React 19 + Zustand + Tailwind v4                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Components                                                 │  │
│  │  App → Sidebar + ChatArea + SettingsDialog (lazy)          │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Stores (Zustand)                                           │  │
│  │  chat-store    │ session-store    │ config-store            │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Services                                                   │  │
│  │  electron-api-client → window.electronAPI 安全封装         │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Stream Pipeline                                            │  │
│  │  chat-stream-listener → chat-stream-state (pure reducers)  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## 4. 项目结构

```
src/
├── main.ts                           # Electron 主进程入口
├── preload.ts                        # 预加载脚本（IPC 桥接）
├── agent-service.ts                  # AI 核心服务（Claude Agent SDK 封装）
├── session-storage.ts                # SQLite 配置与会话元数据存储
├── types/
│   └── index.ts                      # 全局共享类型定义
├── utils/
│   └── errors.ts                     # 自定义错误类层次
├── shared/
│   └── branding.ts                   # 产品名称、图标路径
├── ai/
│   └── protocol-translator/          # Anthropic ↔ OpenAI 协议翻译
│       ├── proxy-server.ts           # HTTP 代理服务器
│       ├── types.ts                  # 统一消息类型
│       ├── index.ts                  # 导出入口
│       └── transformers/             # 消息/流/工具转换器
├── main-process/
│   ├── main-process-context.ts       # 运行时上下文容器
│   ├── window-factory.ts             # BrowserWindow 工厂
│   ├── branding-assets.ts            # Dock 图标路径解析
│   ├── tool-approval-coordinator.ts  # 工具审批异步桥接
│   ├── mcp/
│   │   └── mcp-manager.ts           # MCP 服务器配置管理
│   ├── chat-input/
│   │   ├── file-reference-resolver.ts  # @file 引用解析
│   │   └── path-autocomplete.ts        # 路径自动补全
│   └── ipc/
│       ├── register-ipc-handlers.ts  # IPC 注册总入口
│       ├── chat-handlers.ts          # 聊天消息 IPC
│       ├── session-handlers.ts       # 会话管理 IPC
│       ├── config-handlers.ts        # 配置管理 IPC
│       ├── security-handlers.ts      # 加密解密 IPC
│       ├── tool-approval-handlers.ts # 工具审批 IPC
│       └── mcp-handlers.ts          # MCP 管理 IPC
└── renderer/
    ├── main.tsx                      # React 入口
    ├── App.tsx                       # 根组件（Sidebar + ChatArea + Settings）
    ├── index.html                    # Vite HTML 入口
    ├── tsconfig.json                 # 渲染层 TS 配置
    ├── components/
    │   ├── ui/                       # shadcn/ui 基础组件
    │   │   ├── button.tsx
    │   │   ├── input.tsx
    │   │   ├── textarea.tsx
    │   │   ├── dialog.tsx
    │   │   └── scroll-area.tsx
    │   ├── Sidebar.tsx               # 会话侧边栏
    │   ├── ChatArea.tsx              # 聊天主区域
    │   ├── SettingsDialog.tsx        # 设置对话框
    │   ├── ToolCallBlock.tsx         # 工具调用卡片（含内联审批）
    │   ├── MarkdownRenderer.tsx      # Markdown 渲染
    │   ├── MarkdownCodeBlock.tsx     # 代码块语法高亮
    │   └── AppErrorBoundary.tsx      # React 错误边界
    ├── stores/
    │   ├── chat-store.ts             # 聊天状态与流程编排
    │   ├── session-store.ts          # 会话列表与切换
    │   ├── config-store.ts           # 模型/提供商配置
    │   ├── chat-stream-listener.ts   # 流式 chunk 缓冲消费
    │   └── chat-stream-state.ts      # 流式状态纯 reducer
    ├── services/
    │   └── electron-api-client.ts    # electronAPI 安全封装
    ├── lib/
    │   ├── utils.ts                  # cn() 等工具函数
    │   ├── slash-commands.ts         # 斜杠命令解析
    │   └── composer-autocomplete.ts  # 输入框自动补全
    └── styles/
        └── globals.css               # Tailwind + CSS 变量
```

## 5. 核心服务详解

### 5.1 AgentService

**职责**：封装 Claude Agent SDK，是 AI 交互的唯一入口。

**关键设计**：

- **延迟加载 SDK**：通过 `dynamic import` 在首次使用时加载 ESM 模块，避免启动时阻塞
- **统一流式接口**：将 SDK 的 `SDKMessage` 映射为应用内部的 `StreamChunk`
- **双提供商支持**：Anthropic 直连 SDK；OpenAI 通过本地协议翻译代理桥接
- **工具审批回调**：通过 `canUseTool` 委托给 `ToolApprovalCoordinator`
- **会话注册回调**：SDK `init` 消息触发 `onSessionInit`，将 session_id 注册到本地存储

```
AgentService
├── sendMessageStream()    → AsyncGenerator<StreamChunk>
├── listSessions()         → SDK 会话列表
├── getSessionMessages()   → SDK 会话消息
├── setConfig()            → 更新提供商/模型/密钥
├── setCanUseTool()        → 注册工具审批回调
├── setOnSessionInit()     → 注册会话初始化回调
├── setMcpServers()        → 配置 MCP 服务器
└── abort()                → 取消当前查询
```

**OpenAI 提供商流程**：

```
AgentService (provider=openai)
    → ensureProxy() → 启动本地 HTTP 代理
    → 配置 SDK options.env（ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY）
    → settingSources=['project','local']（避免读取 ~/.claude/settings.json）
    → SDK query() → 请求发向本地代理
    → 代理将 Anthropic 格式转为 OpenAI 格式 → 转发到目标 API
    → 响应逆向翻译回 Anthropic 格式 → 返回给 SDK
```

### 5.2 SessionStorage

**职责**：SQLite 持久化存储，管理应用级配置和会话元数据。

Agent SDK 迁移后，**消息持久化由 SDK 负责**，本模块只存储：

- **模型提供商配置**：多提供商注册、活跃提供商/模型选择
- **MCP 服务器配置**：JSON 格式存储
- **会话元数据**：自定义标题、软删除标记
- **数据迁移**：支持从旧版单配置 → model_instances → model_providers 的渐进迁移

**SQLite 表结构**：

| 表 | 用途 |
|------|------|
| `config` | 键值对配置（activeProviderId, activeModelId 等） |
| `model_providers` | 提供商信息（名称、协议、baseURL、apiKey） |
| `provider_models` | 提供商关联的模型列表 |
| `session_metadata` | SDK 会话的自定义标题和删除标记 |
| `model_instances` | 旧版遗留表，仅用于迁移 |

### 5.3 ToolApprovalCoordinator

**职责**：在 SDK 的同步 `canUseTool` 回调与渲染进程的异步 UI 审批之间架桥。

```
SDK canUseTool() 回调
    → ToolApprovalCoordinator.requestApproval()
    → 创建 Promise + 超时定时器
    → IPC 推送 tool-approval-request 到渲染层
    → 渲染层 ToolCallBlock 显示审批 UI
    → 用户操作 → IPC tool-approval-response
    → ToolApprovalCoordinator.respond() → resolve Promise
    → SDK 获得 PermissionResult
```

### 5.4 MainProcessContext

**职责**：运行时上下文容器，持有所有主进程服务实例。

- 初始化服务并建立回调关系
- 提供给 IPC handlers 访问服务的统一入口
- 管理应用窗口引用
- 解析用户消息中的 @file 引用

### 5.5 Protocol Translator

**职责**：HTTP 代理服务器，将 Anthropic Messages API 翻译为 OpenAI Chat Completions API。

```
src/ai/protocol-translator/
├── proxy-server.ts      # 启动本地 HTTP 服务器
├── types.ts             # 统一消息类型定义
├── index.ts             # 导出入口
└── transformers/
    ├── message-transformer.ts  # 消息格式转换
    ├── stream-transformer.ts   # SSE 流转换
    └── tool-transformer.ts     # 工具定义转换
```

## 6. IPC 通信架构

### 6.1 通道分域

| 域 | Handler 文件 | 通道 |
|------|------------|------|
| 聊天 | `chat-handlers.ts` | `send-message-stream`, `send-message`, `abort-stream`, `set-model-config`, `test-connection`, `clear-history`, `get-history`, `compact-history`, `rewind-last-turn`, `autocomplete-paths` |
| 会话 | `session-handlers.ts` | `session-list`, `session-get`, `session-create`, `session-delete`, `session-switch`, `session-rename` |
| 配置 | `config-handlers.ts` | `config-save`, `config-load` |
| 安全 | `security-handlers.ts` | `encrypt-data`, `decrypt-data` |
| MCP | `mcp-handlers.ts` | `mcp-list-servers`, `mcp-list-tools`, `mcp-refresh`, `mcp-upsert-server`, `mcp-remove-server` |
| 工具审批 | `tool-approval-handlers.ts` | `tool-approval-response` |

### 6.2 通信模式

- **请求/响应**：`ipcRenderer.invoke()` ↔ `ipcMain.handle()` — 大部分操作
- **推送**：`webContents.send()` → `ipcRenderer.on()` — `stream-chunk`, `tool-approval-request`
- **单向发送**：`ipcRenderer.send()` — `tool-approval-response`

### 6.3 类型安全

- IPC 通道名定义在 `src/types/index.ts` 的 `IPC_CHANNELS` 常量中
- `preload.ts` 因沙箱限制内联了一份相同的常量（无法直接导入 src 模块）
- `ElectronAPI` 接口定义了渲染层可用的完整 API 类型签名

## 7. 渲染层架构

### 7.1 组件层次

```
App
├── Sidebar                    # 会话列表、新建/切换/删除/重命名
├── sidebar-resizer            # 可拖拽分隔线
├── ChatArea                   # 核心聊天界面
│   ├── 消息列表
│   │   ├── 用户消息气泡
│   │   ├── 助手消息气泡 (MarkdownRenderer)
│   │   └── ToolCallBlock (工具调用卡片 + 内联审批)
│   ├── 自动补全弹出层 (@ 路径 / 斜杠命令)
│   └── Composer (输入框 + 发送 + 图片附件 + 模型选择)
└── SettingsDialog (lazy)      # 提供商/模型配置
```

### 7.2 状态管理

| Store | 职责 | 关键状态 |
|-------|------|----------|
| `chat-store` | 聊天流程编排 | `isLoading`, `streamItems`, `pendingApprovalId`, `isWaitingResponse` |
| `session-store` | 会话管理 | `sessions`, `currentSessionId`, `currentMessages` |
| `config-store` | 配置管理 | `providers`, `activeProviderId`, `activeModelId`, `isSettingsOpen` |

**Store 交互模式**：
- Store 通过 `useXStore.getState()` 跨 store 读取状态
- 副作用（IPC 调用）通过 `electron-api-client` 统一执行
- 流式状态使用纯 reducer 模式（`chat-stream-state.ts`）

### 7.3 流式消息处理管线

```
Main Process stream-chunk IPC
    ↓
electronApiClient.onStreamChunk
    ↓
chat-stream-listener.handleChunk()
    ├── 文本 chunk → 缓冲，定时刷新
    ├── 工具事件 → 立即更新 streamItems
    ├── 工具审批 → 设置 pendingApprovalId
    └── done → 触发 onDone 回调
    ↓
chat-stream-state.ts (pure reducers)
    ├── applyTextChunk()
    ├── applyToolUseChunk()
    ├── applyToolStartChunk()
    ├── applyToolInputDeltaChunk()
    └── applyToolResultChunk()
    ↓
chat-store 更新 streamItems → UI 重渲染
```

### 7.4 API 客户端层

`electron-api-client.ts` 封装 `window.electronAPI`：

- **安全降级**：检测 `electronAPI` 是否存在，缺失时提供 fallback
- **统一入口**：Store 不直接访问 `window.electronAPI`
- **一次性警告**：bridge 缺失时仅打印一次控制台警告

## 8. 数据流全景

### 8.1 用户发送消息

```
用户输入 → ChatArea Composer
    → chat-store.sendMessage()
    → electronApiClient.sendMessageStream(message, systemPrompt, attachments)
    → preload: ipcRenderer.invoke('send-message-stream', ...)
    → chat-handlers: context.resolveUserMessage() (@ 引用解析)
    → AgentService.sendMessageStream(prompt, options)
    → loadSDK() + buildEnv() + buildPrompt()
    → SDK query({ prompt, options })
    → for each SDKMessage: mapSdkMessageToChunks() → StreamChunk[]
    → sendStreamChunk() → webContents.send('stream-chunk', chunk)
    → preload: ipcRenderer.on('stream-chunk', callback)
    → chat-stream-listener → chat-store → UI
```

### 8.2 工具审批

```
SDK canUseTool(toolName, input, options)
    → AgentService.canUseToolCallback
    → ToolApprovalCoordinator.requestApproval()
    → IPC push: tool-approval-request → 渲染层
    → chat-stream-listener.handleToolApprovalRequest()
    → chat-store 更新 pendingApprovalId
    → ToolCallBlock 渲染审批按钮
    → 用户点击允许/拒绝
    → electronApiClient.respondToolApproval()
    → IPC: tool-approval-response
    → tool-approval-handlers → ToolApprovalCoordinator.respond()
    → Promise resolve → SDK 继续执行
```

### 8.3 会话管理

```
会话创建：
    Sidebar "新对话" → session-store.createSession()
    → electronApiClient.sessionCreate()
    → session-handlers: abort 当前查询，重置 currentSessionId
    → 返回临时会话 { id: 'new_${timestamp}', ... }
    → 用户发送第一条消息 → SDK init → onSessionInit 回调
    → sessionStorage.registerSession(real_session_id)

会话切换：
    Sidebar 点击会话 → session-store.switchSession(id)
    → electronApiClient.sessionSwitch(id)
    → session-handlers: abort, 查找 SDK 会话, 加载消息
    → 返回 Session { messages: convertSdkSessionMessages() }

会话列表：
    → electronApiClient.sessionList()
    → session-handlers: AgentService.listSessions()
    → 过滤: isKnownSession() && !isSessionDeleted()
    → 合并 SessionStorage 的自定义标题
```

## 9. 安全设计

### 9.1 进程隔离

| 措施 | 说明 |
|------|------|
| `contextIsolation: true` | 渲染层无法直接访问 Node.js |
| `nodeIntegration: false` | 禁用 Node.js 集成 |
| `sandbox: true` | 预加载脚本在沙箱中运行 |
| `contextBridge` | 仅暴露声明的 API 方法 |

### 9.2 API Key 加密

- macOS: Keychain Access (`safeStorage`)
- Windows: DPAPI (`safeStorage`)
- Linux: Secret Service (`safeStorage`)
- 降级: `plain:` 前缀明文存储

### 9.3 IPC 安全

- 预加载脚本仅暴露有限方法集合
- 单监听器替换策略防止事件泄漏
- 工具审批超时机制防止无限等待

## 10. 构建与打包

### 10.1 构建流程

| 目标 | 工具 | 入口 | 产物 |
|------|------|------|------|
| 主进程 | esbuild | `src/main.ts` | `dist/main.js` |
| 预加载 | esbuild | `src/preload.ts` | `dist/preload.js` |
| 渲染层 | Vite | `src/renderer/index.html` | `dist/renderer/` |

### 10.2 开发模式

```bash
npm run dev
# concurrently:
#   Vite dev server (port 5173)
#   esbuild watch (main + preload)
#   Electron with VITE_DEV_SERVER=true
```

### 10.3 打包配置

- macOS: DMG + ZIP (x64/arm64)，Hardened Runtime
- Windows: NSIS 安装程序 + 便携版
- Linux: AppImage + deb
- better-sqlite3 从 asar 解包（原生模块）

## 11. 架构决策记录

### 11.1 为什么选择 Agent SDK

| 维度 | SDK 前（手动实现） | SDK 后 |
|------|-------------------|--------|
| 工具执行 | 自建 ToolExecutor（9 个工具） | SDK 内置 claude_code 工具集 |
| Agentic Loop | 手动循环 + 消息历史维护 | SDK 自动管理 |
| 会话持久化 | 全部存入 SQLite | SDK 管理消息，SQLite 仅存元数据 |
| 上下文压缩 | 手动实现 compact | SDK 自动管理 |
| 流式处理 | 手工 SSE 解析 | SDK `query()` AsyncIterable |

### 11.2 为什么 preload 内联 IPC_CHANNELS

Electron 沙箱环境的预加载脚本无法通过 `require` 或 `import` 加载 `src/` 下的模块。将通道常量内联是技术约束下的权衡选择，通过类型系统（`ElectronAPI` 接口）保证两端一致性。

### 11.3 为什么使用协议翻译代理

OpenAI 兼容提供商无法直接使用 Claude Agent SDK。协议翻译代理在本地启动 HTTP 服务器，将 SDK 发出的 Anthropic 格式请求翻译为 OpenAI 格式，实现对第三方模型的透明接入。
