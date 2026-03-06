import { create } from 'zustand';
import { electronApiClient } from '@/services/electron-api-client';
import { formatSlashCommandHelp, parseSlashCommand } from '@/lib/slash-commands';
import { useConfigStore } from './config-store';
import { useSessionStore } from './session-store';
import type {
  ChatImageAttachment,
  MessageItem,
  RewindHistoryResult,
  StreamUsageInfo,
  ToolCallRecord,
} from '../../types';
import { createChatStreamListener, type ChatStreamListener } from './chat-stream-listener';
import {
  applyApproveToolCallToStreamState,
  applyRejectToolCallToStreamState,
  getInitialChatStreamState,
  getTextContentFromStreamItems,
  type ChatStreamState,
} from './chat-stream-state';

export type ToolCall = ToolCallRecord;
export type StreamItem = MessageItem;

export interface RuntimeUsageStats {
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  currentTurnInputTokens: number | null;
  currentTurnOutputTokens: number | null;
  contextWindowTokens: number | null;
  contextRemainingTokens: number | null;
  contextRemainingPercent: number | null;
}

const EMPTY_USAGE_STATS: RuntimeUsageStats = {
  totalInputTokens: null,
  totalOutputTokens: null,
  currentTurnInputTokens: null,
  currentTurnOutputTokens: null,
  contextWindowTokens: null,
  contextRemainingTokens: null,
  contextRemainingPercent: null,
};

function applyInterimUsage(current: RuntimeUsageStats, usage: StreamUsageInfo): RuntimeUsageStats {
  return {
    ...current,
    currentTurnInputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : current.currentTurnInputTokens,
    currentTurnOutputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : current.currentTurnOutputTokens,
  };
}

function applyFinalUsage(current: RuntimeUsageStats, usage: StreamUsageInfo): RuntimeUsageStats {
  const turnInputTokens = typeof usage.inputTokens === 'number' ? Math.max(0, usage.inputTokens) : null;
  const turnOutputTokens = typeof usage.outputTokens === 'number' ? Math.max(0, usage.outputTokens) : null;
  return {
    totalInputTokens: turnInputTokens === null
      ? current.totalInputTokens
      : (current.totalInputTokens ?? 0) + turnInputTokens,
    totalOutputTokens: turnOutputTokens === null
      ? current.totalOutputTokens
      : (current.totalOutputTokens ?? 0) + turnOutputTokens,
    currentTurnInputTokens: null,
    currentTurnOutputTokens: null,
    contextWindowTokens: typeof usage.contextWindowTokens === 'number' ? usage.contextWindowTokens : current.contextWindowTokens,
    contextRemainingTokens: typeof usage.contextRemainingTokens === 'number' ? usage.contextRemainingTokens : current.contextRemainingTokens,
    contextRemainingPercent: typeof usage.contextRemainingPercent === 'number' ? usage.contextRemainingPercent : current.contextRemainingPercent,
  };
}

interface ChatState {
  isLoading: boolean;
  streamItems: StreamItem[];
  pendingApprovalId: string | null;
  isWaitingResponse: boolean;
  usageStats: RuntimeUsageStats;

  sendMessage: (message: string, attachments?: ChatImageAttachment[]) => Promise<void>;
  cancelStream: () => Promise<void>;
  clearHistory: () => Promise<void>;
  rewindLastTurn: () => Promise<RewindHistoryResult>;
  approveToolCall: (id: string, updatedPermissions?: import('../../types').PermissionSuggestion[]) => void;
  rejectToolCall: (id: string) => void;
  initStreamListener: () => void;
  resetStreamState: () => void;
  resetUsageStats: () => void;
}

type StreamStateSlice = Pick<ChatState, 'streamItems' | 'pendingApprovalId' | 'isWaitingResponse'>;

function createEmptyStreamState(): StreamStateSlice {
  const initial = getInitialChatStreamState();
  return {
    streamItems: initial.streamItems,
    pendingApprovalId: initial.pendingApprovalId,
    isWaitingResponse: initial.isWaitingResponse,
  };
}

function pickStreamState(state: ChatState): ChatStreamState {
  return {
    streamItems: state.streamItems,
    pendingApprovalId: state.pendingApprovalId,
    isWaitingResponse: state.isWaitingResponse,
  };
}

function toStreamStateSlice(next: ChatStreamState): StreamStateSlice {
  return {
    streamItems: next.streamItems,
    pendingApprovalId: next.pendingApprovalId,
    isWaitingResponse: next.isWaitingResponse,
  };
}

export const useChatStore = create<ChatState>((set, get) => {
  let streamListener: ChatStreamListener | null = null;

  const updateStreamState = (updater: (state: ChatStreamState) => ChatStreamState) => {
    set((state) => toStreamStateSlice(updater(pickStreamState(state))));
  };

  const getStreamState = (): ChatStreamState => {
    return pickStreamState(get());
  };

  const appendAssistantMessage = (content: string) => {
    const sessionStore = useSessionStore.getState();
    sessionStore.setCurrentMessages([
      ...sessionStore.currentMessages,
      {
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
    ]);
  };

  const executeSlashCommand = async (input: string): Promise<boolean> => {
    const command = parseSlashCommand(input);
    if (!command) {
      return false;
    }

    if (command.name === 'help') {
      appendAssistantMessage(formatSlashCommandHelp());
      return true;
    }

    if (command.name === 'clear') {
      await get().clearHistory();
      return true;
    }

    if (command.name === 'compact') {
      set({ isLoading: true, ...createEmptyStreamState() });
      try {
        const result = await electronApiClient.compactHistory();
        const history = await electronApiClient.getHistory();
        const sessionStore = useSessionStore.getState();
        sessionStore.setCurrentMessages(history);

        if (result.skipped) {
          appendAssistantMessage(`上下文压缩已跳过：${result.reason ?? '暂无可压缩内容。'}`);
        } else {
          appendAssistantMessage(
            `上下文压缩完成：消息 ${result.beforeMessageCount} -> ${result.afterMessageCount}，估算 token ${result.beforeEstimatedTokens} -> ${result.afterEstimatedTokens}。`,
          );
        }

        await sessionStore.refreshSessions();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        appendAssistantMessage(`❌ 上下文压缩失败：${errorMessage}`);
      } finally {
        set({ isLoading: false, ...createEmptyStreamState() });
      }
      return true;
    }

    if (command.name === 'config') {
      useConfigStore.getState().setSettingsOpen(true);
      appendAssistantMessage('已打开设置面板。');
      return true;
    }

    if (command.name === 'model') {
      const targetModel = command.args.join(' ').trim();
      if (!targetModel) {
        appendAssistantMessage('用法：`/model <model-id>`');
        return true;
      }

      try {
        const configStore = useConfigStore.getState();
        const { providers, activeProviderId } = configStore;

        // First try to find the model in any provider
        let foundProvider = providers.find(
          (p) => p.id === activeProviderId && p.models.includes(targetModel),
        );
        if (!foundProvider) {
          foundProvider = providers.find((p) => p.models.includes(targetModel));
        }

        if (foundProvider) {
          configStore.setActiveModel(foundProvider.id, targetModel);
        } else {
          configStore.setModel(targetModel);
        }

        await configStore.saveConfig();
        appendAssistantMessage(`模型已切换为 \`${targetModel}\``);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        appendAssistantMessage(`❌ 模型切换失败：${errorMessage}`);
      }
      return true;
    }

    appendAssistantMessage(`未知命令：\`/${command.name}\`。输入 \`/help\` 查看可用命令。`);
    return true;
  };

  return {
    isLoading: false,
    ...createEmptyStreamState(),
    usageStats: { ...EMPTY_USAGE_STATS },

    sendMessage: async (message: string, attachments?: ChatImageAttachment[]) => {
      const trimmedMessage = message.trim();
      const safeAttachments = attachments && attachments.length > 0 ? attachments : undefined;
      if (!trimmedMessage && !safeAttachments) {
        return;
      }

      if (await executeSlashCommand(trimmedMessage)) {
        return;
      }

      const sessionStore = useSessionStore.getState();
      const currentMessages = sessionStore.currentMessages;
      sessionStore.setCurrentMessages([
        ...currentMessages,
        { role: 'user', content: trimmedMessage, attachments: safeAttachments, timestamp: Date.now() },
      ]);

      set({ isLoading: true, ...createEmptyStreamState() });

      try {
        await electronApiClient.sendMessageStream(trimmedMessage, undefined, safeAttachments);
      } catch (error) {
        console.error('[chat-store] Send message error:', error);
        set({ isLoading: false, ...createEmptyStreamState() });
      }
    },

    cancelStream: async () => {
      await electronApiClient.abortStream();
      streamListener?.dispose();
      set({ isLoading: false, ...createEmptyStreamState() });
    },

    clearHistory: async () => {
      await electronApiClient.clearHistory();
      useSessionStore.getState().setCurrentMessages([]);
      streamListener?.dispose();
      set({ ...createEmptyStreamState(), usageStats: { ...EMPTY_USAGE_STATS } });
      await useSessionStore.getState().refreshSessions();
    },

    rewindLastTurn: async () => {
      const result = await electronApiClient.rewindLastTurn();

      const history = await electronApiClient.getHistory();
      const sessionStore = useSessionStore.getState();
      sessionStore.setCurrentMessages(history);

      streamListener?.dispose();
      set({ isLoading: false, ...createEmptyStreamState() });
      await sessionStore.refreshSessions();

      return result;
    },

    approveToolCall: (id: string, updatedPermissions?: import('../../types').PermissionSuggestion[]) => {
      updateStreamState((state) => applyApproveToolCallToStreamState(state, id));
      electronApiClient.respondToolApproval({ approved: true, updatedPermissions });
    },

    rejectToolCall: (id: string) => {
      updateStreamState((state) => applyRejectToolCallToStreamState(state, id));
      electronApiClient.respondToolApproval({ approved: false });
    },

    resetStreamState: () => {
      streamListener?.dispose();
      set({ isLoading: false, ...createEmptyStreamState() });
    },

    resetUsageStats: () => {
      set({ usageStats: { ...EMPTY_USAGE_STATS } });
    },

    initStreamListener: () => {
      streamListener?.dispose();
      streamListener = createChatStreamListener({
        getState: getStreamState,
        updateState: updateStreamState,
        onDone: (streamItems) => {
          const sessionStore = useSessionStore.getState();
          const textContent = getTextContentFromStreamItems(streamItems);

          if (streamItems.length > 0) {
            const currentMessages = sessionStore.currentMessages;
            sessionStore.setCurrentMessages([
              ...currentMessages,
              {
                role: 'assistant',
                content: textContent,
                items: streamItems,
                timestamp: Date.now(),
              },
            ]);
          }

          set({ isLoading: false, ...createEmptyStreamState() });
          void sessionStore.refreshSessions();
        },
        onError: (message) => {
          console.error('[chat-store] Stream error:', message);
          const sessionStore = useSessionStore.getState();
          const currentMessages = sessionStore.currentMessages;
          sessionStore.setCurrentMessages([
            ...currentMessages,
            { role: 'assistant', content: `❌ ${message}`, timestamp: Date.now() },
          ]);
          set({ isLoading: false, ...createEmptyStreamState() });
        },
        isToolAllowed: (tool) => useConfigStore.getState().isToolAllowed(tool),
        respondToolApproval: (response) => electronApiClient.respondToolApproval(response),
      });

      electronApiClient.onStreamChunk((chunk) => {
        if (chunk.usage) {
          const isFinal = chunk.type === 'done' || chunk.type === 'error';
          set((state) => ({
            usageStats: isFinal
              ? applyFinalUsage(state.usageStats, chunk.usage!)
              : applyInterimUsage(state.usageStats, chunk.usage!),
          }));
        }
        streamListener?.handleChunk(chunk);
      });
      electronApiClient.onToolApprovalRequest(streamListener.handleToolApprovalRequest);
    },
  };
});
