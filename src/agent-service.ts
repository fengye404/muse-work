/**
 * AgentService — Core AI service backed by the Claude Agent SDK.
 *
 * Replaces the old ClaudeService. Instead of manually managing Anthropic/OpenAI
 * API calls, tool execution, agentic loops, and history, this service delegates
 * everything to the SDK's `query()` function.
 *
 * For OpenAI-compatible providers, a local protocol translation proxy is started
 * and the SDK connects to it via ANTHROPIC_BASE_URL.
 */

import type {
  Query,
  Options as SDKOptions,
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKPartialAssistantMessage,
  SDKSessionInfo,
  SDKToolProgressMessage,
  SDKUserMessage,
  CanUseTool,
  McpServerConfig as SDKMcpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { startProxyServer } from './ai/protocol-translator/proxy-server';
import type { ProxyServerHandle } from './ai/protocol-translator/proxy-server';
import type {
  StreamChunk,
  Provider,
  McpServerConfig as AppMcpServerConfig,
  McpServersConfig,
} from './types';

// Lazy-loaded SDK functions (ESM module loaded via dynamic import at runtime)
let _sdkLoaded = false;
let _query: typeof import('@anthropic-ai/claude-agent-sdk').query;
let _listSessions: typeof import('@anthropic-ai/claude-agent-sdk').listSessions;
let _getSessionMessages: typeof import('@anthropic-ai/claude-agent-sdk').getSessionMessages;

async function loadSDK(): Promise<void> {
  if (_sdkLoaded) return;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  _query = sdk.query;
  _listSessions = sdk.listSessions;
  _getSessionMessages = sdk.getSessionMessages;
  _sdkLoaded = true;
}

export interface AgentServiceConfig {
  provider: Provider;
  apiKey: string;
  baseURL?: string;
  model: string;
  maxTokens?: number;
}

export interface ChatAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface SendMessageOptions {
  systemPrompt?: string;
  attachments?: ChatAttachment[];
}

export class AgentService {
  private config: AgentServiceConfig;
  private activeQuery: Query | null = null;
  private proxyHandle: ProxyServerHandle | null = null;
  private currentSessionId: string | null = null;
  private slashCommands: SlashCommand[] = [];
  private mcpServersConfig: Record<string, SDKMcpServerConfig> = {};
  private workingDirectory: string = process.cwd();

  private canUseToolCallback: CanUseTool | null = null;
  private onSessionInitCallback: ((sessionId: string) => void) | null = null;

  constructor() {
    this.config = {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: 'claude-sonnet-4-6',
    };
  }

  setConfig(config: Partial<AgentServiceConfig>): void {
    this.config = { ...this.config, ...config };
    this.stopProxy();
  }

  setWorkingDirectory(dir: string): void {
    this.workingDirectory = dir;
  }

  setCanUseTool(callback: CanUseTool): void {
    this.canUseToolCallback = callback;
  }

  setOnSessionInit(callback: (sessionId: string) => void): void {
    this.onSessionInitCallback = callback;
  }

  setMcpServers(servers: McpServersConfig): void {
    this.mcpServersConfig = {};
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;
      const sdkConfig = this.convertMcpConfig(config);
      if (sdkConfig) {
        this.mcpServersConfig[name] = sdkConfig;
      }
    }
  }

  getSlashCommands(): SlashCommand[] {
    return this.slashCommands;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
  }

  async listSessions(): Promise<SDKSessionInfo[]> {
    await loadSDK();
    return _listSessions({ dir: this.workingDirectory });
  }

  async getSessionMessages(sessionId: string) {
    await loadSDK();
    return _getSessionMessages(sessionId, { dir: this.workingDirectory });
  }

  abort(): void {
    if (this.activeQuery) {
      this.activeQuery.close();
      this.activeQuery = null;
    }
  }

  /**
   * Send a message and yield StreamChunk events compatible with the renderer.
   */
  async *sendMessageStream(
    message: string,
    options?: SendMessageOptions,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const isOpenAI = this.config.provider === 'openai';
    const settingSources: SDKOptions['settingSources'] = isOpenAI
      ? ['project', 'local']
      : ['user', 'project', 'local'];

    const env = await this.buildEnv();

    const sdkOptions: SDKOptions = {
      model: this.config.model,
      cwd: this.workingDirectory,
      env,
      tools: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      permissionMode: 'default',
      settingSources,
      stderr: (data: string) => {
        console.error('[claude-code-cli]', data.trimEnd());
      },
    };

    if (this.canUseToolCallback) {
      sdkOptions.canUseTool = this.canUseToolCallback;
    }

    if (this.currentSessionId) {
      sdkOptions.resume = this.currentSessionId;
    }

    if (Object.keys(this.mcpServersConfig).length > 0) {
      sdkOptions.mcpServers = this.mcpServersConfig;
    }

    if (options?.systemPrompt) {
      sdkOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: options.systemPrompt,
      };
    }

    await loadSDK();
    console.log(`[agent-service] Starting query: model=${this.config.model}, provider=${this.config.provider}, cwd=${this.workingDirectory}`);

    const prompt = this.buildPrompt(message, options?.attachments);
    const q = _query({ prompt, options: sdkOptions });
    this.activeQuery = q;

    try {
      for await (const msg of q) {
        const chunks = this.mapSdkMessageToChunks(msg);
        for (const chunk of chunks) {
          yield chunk;
        }
      }
      console.log('[agent-service] Query stream finished normally');
    } catch (err) {
      console.error('[agent-service] Query stream error:', err);
      throw err;
    } finally {
      this.activeQuery = null;
    }
  }

  async cleanup(): Promise<void> {
    this.abort();
    await this.stopProxy();
  }

  // ---------------------------------------------------------------------------
  // Prompt construction (text + images)
  // ---------------------------------------------------------------------------

  private buildPrompt(
    message: string,
    attachments?: ChatAttachment[],
  ): string | AsyncIterable<SDKUserMessage> {
    if (!attachments || attachments.length === 0) {
      return message;
    }

    const contentBlocks: Array<Record<string, unknown>> = [];

    for (const att of attachments) {
      const match = att.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) continue;

      const mediaType = match[1] as string;
      const data = match[2] as string;

      const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!supportedTypes.includes(mediaType)) continue;

      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
    }

    if (message.trim()) {
      contentBlocks.push({ type: 'text', text: message });
    }

    if (contentBlocks.length === 0) {
      return message;
    }

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      } as unknown as SDKUserMessage['message'],
      parent_tool_use_id: null,
      session_id: this.currentSessionId || '',
    };

    async function* singleMessage() {
      yield userMessage;
    }

    return singleMessage();
  }

  // ---------------------------------------------------------------------------
  // Environment setup
  // ---------------------------------------------------------------------------

  private async buildEnv(): Promise<Record<string, string | undefined>> {
    const env = { ...process.env };

    if (this.config.provider === 'anthropic') {
      env.ANTHROPIC_API_KEY = this.config.apiKey;
      if (this.config.baseURL) {
        env.ANTHROPIC_BASE_URL = this.config.baseURL;
      }
    } else if (this.config.provider === 'openai') {
      const proxy = await this.ensureProxy();
      env.ANTHROPIC_API_KEY = 'proxy-key-not-used';
      env.ANTHROPIC_BASE_URL = proxy.baseURL;
    }

    env.DEBUG_CLAUDE_AGENT_SDK = '1';

    return env;
  }

  private async ensureProxy(): Promise<ProxyServerHandle> {
    if (this.proxyHandle) return this.proxyHandle;

    if (!this.config.baseURL) {
      throw new Error('OpenAI provider requires a baseURL');
    }

    this.proxyHandle = await startProxyServer({
      targetBaseURL: this.config.baseURL,
      targetApiKey: this.config.apiKey,
    });

    return this.proxyHandle;
  }

  private async stopProxy(): Promise<void> {
    if (this.proxyHandle) {
      await this.proxyHandle.stop();
      this.proxyHandle = null;
    }
  }

  // ---------------------------------------------------------------------------
  // SDK Message → StreamChunk mapping
  // ---------------------------------------------------------------------------

  /**
   * Maps content-block index → tool { id, name } so that subsequent
   * input_json_delta events can be associated with the correct tool.
   * Also accumulates partial JSON per index.
   */
  private contentBlockToolMap = new Map<number, { id: string; name: string }>();
  private contentBlockAccumulator = new Map<number, string>();
  private hasStreamedText = false;

  /**
   * Set of tool IDs that were already emitted via streaming events.
   * Used to avoid duplicating them when the full assistant message arrives.
   */
  private streamedToolIds = new Set<string>();

  /**
   * Per-turn accumulated token counters tracked from stream events
   * (message_start / message_delta). Used as both a real-time source
   * and a fallback when the SDK result message lacks usage data.
   */
  private turnInputTokens = 0;
  private turnOutputTokens = 0;
  private turnHasStreamUsage = false;

  private resetStreamingState(): void {
    this.contentBlockToolMap.clear();
    this.contentBlockAccumulator.clear();
    this.streamedToolIds.clear();
    this.hasStreamedText = false;
    this.turnInputTokens = 0;
    this.turnOutputTokens = 0;
    this.turnHasStreamUsage = false;
  }

  private mapSdkMessageToChunks(msg: SDKMessage): StreamChunk[] {
    switch (msg.type) {
      case 'system':
        return this.handleSystemMessage(msg as SDKSystemMessage);

      case 'assistant':
        return this.handleAssistantMessage(msg as SDKAssistantMessage);

      case 'stream_event':
        return this.handleStreamEvent(msg as SDKPartialAssistantMessage);

      case 'result':
        return this.handleResultMessage(msg as SDKResultSuccess | SDKResultError);

      case 'user':
        return this.handleUserMessage(msg as SDKUserMessage);

      case 'tool_progress':
        return this.handleToolProgress(msg as SDKToolProgressMessage);

      default:
        return [];
    }
  }

  private handleSystemMessage(msg: SDKSystemMessage): StreamChunk[] {
    if (msg.subtype === 'init') {
      this.currentSessionId = msg.session_id;
      this.slashCommands = (msg.slash_commands || []).map((name) => ({
        name,
        description: '',
        argumentHint: '',
      }));
      if (msg.session_id && this.onSessionInitCallback) {
        this.onSessionInitCallback(msg.session_id);
      }
    }
    return [];
  }

  /**
   * Full assistant message (arrives after streaming is complete, or for
   * non-streaming responses). We skip tool_use blocks that were already
   * emitted via streaming to prevent duplicates.
   */
  private handleAssistantMessage(msg: SDKAssistantMessage): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    const content = msg.message?.content;

    if (!Array.isArray(content)) return chunks;

    for (const block of content) {
      if (block.type === 'text' && 'text' in block) {
        if (!this.hasStreamedText) {
          chunks.push({ type: 'text', content: block.text });
        }
      } else if (block.type === 'tool_use' && 'id' in block) {
        if (this.streamedToolIds.has(block.id)) {
          chunks.push({
            type: 'tool_use',
            content: '',
            toolUse: {
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            },
            toolUseComplete: true,
          });
        } else {
          chunks.push({
            type: 'tool_use',
            content: '',
            toolUse: {
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            },
          });
        }
      } else if (block.type === 'thinking' && 'thinking' in block) {
        if (this.streamedToolIds.size === 0) {
          chunks.push({ type: 'thinking', content: String((block as unknown as Record<string, unknown>).thinking || '') });
        }
      }
    }

    this.resetStreamingState();
    return chunks;
  }

  private handleStreamEvent(msg: SDKPartialAssistantMessage): StreamChunk[] {
    const event = msg.event;
    if (!event) return [];

    const chunks: StreamChunk[] = [];
    const eventAny = event as unknown as Record<string, unknown>;

    switch (event.type) {
      case 'content_block_start': {
        const index = eventAny.index as number | undefined;
        const contentBlock = eventAny.content_block as Record<string, unknown> | undefined;
        if (contentBlock?.type === 'tool_use' && index !== undefined) {
          const toolId = String(contentBlock.id || '');
          const toolName = String(contentBlock.name || '');

          this.contentBlockToolMap.set(index, { id: toolId, name: toolName });
          this.contentBlockAccumulator.set(index, '');
          this.streamedToolIds.add(toolId);

          chunks.push({
            type: 'tool_use',
            content: '',
            toolUse: { id: toolId, name: toolName, input: {} },
            toolUseComplete: false,
          });
        }
        break;
      }

      case 'content_block_delta': {
        const index = eventAny.index as number | undefined;
        const delta = eventAny.delta as Record<string, unknown> | undefined;

        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.hasStreamedText = true;
          chunks.push({ type: 'text', content: delta.text });
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && index !== undefined) {
          const toolInfo = this.contentBlockToolMap.get(index);
          if (toolInfo) {
            const prev = this.contentBlockAccumulator.get(index) || '';
            const accumulated = prev + delta.partial_json;
            this.contentBlockAccumulator.set(index, accumulated);

            chunks.push({
              type: 'tool_input_delta',
              content: '',
              toolInputDelta: {
                id: toolInfo.id,
                name: toolInfo.name,
                delta: delta.partial_json,
                accumulated,
              },
            });
          }
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          chunks.push({ type: 'thinking', content: delta.thinking });
        }
        break;
      }

      case 'content_block_stop': {
        const index = eventAny.index as number | undefined;
        if (index !== undefined) {
          const toolInfo = this.contentBlockToolMap.get(index);
          if (toolInfo) {
            chunks.push({
              type: 'tool_use',
              content: '',
              toolUse: {
                id: toolInfo.id,
                name: toolInfo.name,
                input: {},
              },
              toolUseComplete: true,
            });
          }
        }
        break;
      }

      case 'message_start': {
        const msgBody = eventAny.message as Record<string, unknown> | undefined;
        const startUsage = this.toRecord(msgBody?.usage);
        if (startUsage) {
          const inputTokens = this.readNumber(startUsage, 'input_tokens', 'inputTokens') ?? 0;
          this.turnInputTokens += inputTokens;
          this.turnHasStreamUsage = true;
          chunks.push({
            type: 'usage',
            content: '',
            usage: {
              inputTokens: this.turnInputTokens,
              outputTokens: this.turnOutputTokens,
            },
          });
        }
        break;
      }

      case 'message_delta': {
        const deltaUsage = this.toRecord(eventAny.usage);
        if (deltaUsage) {
          const outputTokens = this.readNumber(deltaUsage, 'output_tokens', 'outputTokens') ?? 0;
          this.turnOutputTokens += outputTokens;
          this.turnHasStreamUsage = true;
          chunks.push({
            type: 'usage',
            content: '',
            usage: {
              inputTokens: this.turnInputTokens,
              outputTokens: this.turnOutputTokens,
            },
          });
        }
        break;
      }

      case 'message_stop':
        break;

      default:
        break;
    }

    return chunks;
  }

  /**
   * User messages from the SDK carry tool results in their content.
   */
  private handleUserMessage(msg: SDKUserMessage): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    const msgParam = msg.message;

    if (!msgParam || typeof msgParam !== 'object') return chunks;

    const content = (msgParam as unknown as Record<string, unknown>).content;
    if (!Array.isArray(content)) return chunks;

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'tool_result') {
        const toolUseId = String(b.tool_use_id || '');
        let resultText = '';

        if (typeof b.content === 'string') {
          resultText = b.content;
        } else if (Array.isArray(b.content)) {
          resultText = (b.content as Array<Record<string, unknown>>)
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)
            .join('\n');
        }

        if (b.is_error) {
          resultText = resultText || 'Tool execution failed';
        }

        chunks.push({
          type: 'tool_result',
          content: resultText,
          toolUse: { id: toolUseId, name: '', input: {} },
        });
      }
    }

    return chunks;
  }

  private handleToolProgress(msg: SDKToolProgressMessage): StreamChunk[] {
    return [{
      type: 'tool_start',
      content: '',
      toolUse: {
        id: msg.tool_use_id,
        name: msg.tool_name,
        input: {},
      },
    }];
  }

  private handleResultMessage(msg: SDKResultSuccess | SDKResultError): StreamChunk[] {
    const usage = this.buildUsagePayload(msg);

    if (msg.subtype === 'success') {
      return [{
        type: 'done',
        content: '',
        usage,
      }];
    }

    const errors = 'errors' in msg ? (msg as SDKResultError).errors : [];
    const errorMsg = errors.length > 0 ? errors.join('; ') : `SDK error: ${msg.subtype}`;
    return [{
      type: 'error',
      content: errorMsg,
      usage,
    }];
  }

  private buildUsagePayload(msg: SDKResultSuccess | SDKResultError): StreamChunk['usage'] | undefined {
    const usageRecord = this.toRecord((msg as unknown as Record<string, unknown>).usage);

    let inputTokens = 0;
    let outputTokens = 0;
    let contextWindowTokens: number | undefined;
    let contextUsedTokens: number | undefined;

    if (usageRecord) {
      const usageInputTokens = this.readNumber(usageRecord, 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
      const usageOutputTokens = this.readNumber(usageRecord, 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');

      const modelUsageContainer = this.toRecord((msg as unknown as Record<string, unknown>).modelUsage)
        ?? this.toRecord((msg as unknown as Record<string, unknown>).model_usage);

      const modelUsageEntries = Object.values(modelUsageContainer ?? {})
        .map((entry) => this.toRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));

      const aggregatedInputTokens = modelUsageEntries.reduce((sum, current) => {
        return sum + (this.readNumber(current, 'inputTokens', 'input_tokens') ?? 0);
      }, 0);
      const aggregatedOutputTokens = modelUsageEntries.reduce((sum, current) => {
        return sum + (this.readNumber(current, 'outputTokens', 'output_tokens') ?? 0);
      }, 0);

      inputTokens = aggregatedInputTokens > 0 ? aggregatedInputTokens : (usageInputTokens ?? 0);
      outputTokens = aggregatedOutputTokens > 0 ? aggregatedOutputTokens : (usageOutputTokens ?? 0);

      const primaryModelUsage = modelUsageEntries.reduce<Record<string, unknown> | null>((selected, current) => {
        const currentWindow = this.readNumber(current, 'contextWindow', 'context_window') ?? 0;
        if (currentWindow <= 0) return selected;
        if (!selected) return current;
        const selectedWindow = this.readNumber(selected, 'contextWindow', 'context_window') ?? 0;
        return currentWindow > selectedWindow ? current : selected;
      }, null);

      contextWindowTokens = primaryModelUsage
        ? this.readNumber(primaryModelUsage, 'contextWindow', 'context_window')
        : this.readNumber(usageRecord, 'contextWindow', 'context_window');

      contextUsedTokens = primaryModelUsage
        ? (this.readNumber(primaryModelUsage, 'inputTokens', 'input_tokens') ?? 0)
          + (this.readNumber(primaryModelUsage, 'outputTokens', 'output_tokens') ?? 0)
        : undefined;
    }

    if (inputTokens === 0 && outputTokens === 0 && this.turnHasStreamUsage) {
      inputTokens = this.turnInputTokens;
      outputTokens = this.turnOutputTokens;
      console.log(`[agent-service] Using stream-tracked usage: input=${inputTokens}, output=${outputTokens}`);
    }

    if (inputTokens === 0 && outputTokens === 0 && !contextWindowTokens) {
      return undefined;
    }

    const contextRemainingTokens = (
      typeof contextWindowTokens === 'number' && typeof contextUsedTokens === 'number'
    ) ? Math.max(0, contextWindowTokens - contextUsedTokens) : undefined;

    const contextRemainingPercent = (
      typeof contextWindowTokens === 'number'
      && contextWindowTokens > 0
      && typeof contextRemainingTokens === 'number'
    ) ? Number(((contextRemainingTokens / contextWindowTokens) * 100).toFixed(1)) : undefined;

    return {
      inputTokens,
      outputTokens,
      contextWindowTokens,
      contextUsedTokens,
      contextRemainingTokens,
      contextRemainingPercent,
    };
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
      const rawValue = record[key];
      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        return rawValue;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // MCP config conversion
  // ---------------------------------------------------------------------------

  private convertMcpConfig(config: AppMcpServerConfig): SDKMcpServerConfig | null {
    const transport = config.transport ?? 'stdio';

    switch (transport) {
      case 'stdio': {
        if (!config.command) return null;
        const stdioConfig: McpStdioServerConfig = {
          command: config.command,
          args: config.args,
          env: config.env,
        };
        return stdioConfig;
      }
      case 'sse': {
        if (!config.url) return null;
        const sseConfig: McpSSEServerConfig = {
          type: 'sse',
          url: config.url,
          headers: config.headers,
        };
        return sseConfig;
      }
      case 'streamable-http': {
        if (!config.url) return null;
        const httpConfig: McpHttpServerConfig = {
          type: 'http',
          url: config.url,
          headers: config.headers,
        };
        return httpConfig;
      }
      default:
        return null;
    }
  }
}
