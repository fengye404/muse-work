import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  Send,
  Square,
  Trash2,
  Settings,
  Sparkles,
  Bot,
  AlertTriangle,
  TerminalSquare,
  FolderOpen,
  FileCode2,
  ImagePlus,
  RotateCcw,
  X,
  ChevronDown,
  Check,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { ScrollArea } from './ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallBlock } from './ToolCallBlock';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { useConfigStore } from '@/stores/config-store';
import { electronApiClient } from '@/services/electron-api-client';
import type { ChatImageAttachment } from '../../types';
import { BRANDING } from '../../shared/branding';
import {
  applyAutocompleteReplacement,
  extractAutocompleteTarget,
  type ComposerAutocompleteTarget,
} from '@/lib/composer-autocomplete';
import {
  getSlashCommandSuggestions,
  parseSlashCommand,
} from '@/lib/slash-commands';

const THINKING_MESSAGES = [
  '思考中',
  '正在分析',
  '组织思路',
  '准备回答',
];

const TOOL_PROCESSING_MESSAGES = [
  '处理中',
  '执行操作',
  '等待结果',
  '继续处理',
];
const WAIT_TIME_HINT_THRESHOLD_SEC = 8;
const DOUBLE_ESCAPE_INTERVAL_MS = 450;
const MAX_ATTACHMENT_IMAGES = 6;
const MAX_ATTACHMENT_IMAGE_SIZE_BYTES = 8 * 1024 * 1024;
const IMAGE_FILE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.heic',
  '.heif',
]);

type WaitStage = 'approval' | 'model' | null;

interface ComposerAutocompleteItem {
  key: string;
  kind: 'slash' | 'path';
  insertValue: string;
  label: string;
  description: string;
  appendTrailingSpace: boolean;
  isDirectory?: boolean;
}

interface ComposerAutocompleteState {
  target: ComposerAutocompleteTarget;
  items: ComposerAutocompleteItem[];
  selectedIndex: number;
}

type PastedImageDraft = ChatImageAttachment;

function formatSizeLabel(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes}B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))}KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}


function isLikelyImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  if (file.type.startsWith('image/')) {
    return true;
  }

  const dotIndex = file.name.lastIndexOf('.');
  if (dotIndex < 0) {
    return false;
  }

  const extension = file.name.slice(dotIndex).toLowerCase();
  return IMAGE_FILE_EXTENSIONS.has(extension);
}

function hasImageInDataTransfer(dataTransfer: DataTransfer): boolean {
  const items = Array.from(dataTransfer.items ?? []);
  if (items.some((item) => item.kind === 'file' && (item.type.startsWith('image/') || !item.type))) {
    return true;
  }

  const files = Array.from(dataTransfer.files ?? []);
  return files.some((file) => isLikelyImageFile(file));
}

function collectImageFiles(dataTransfer: DataTransfer): File[] {
  const itemFiles = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
    .filter((file) => isLikelyImageFile(file));

  if (itemFiles.length > 0) {
    return itemFiles;
  }

  return Array.from(dataTransfer.files ?? []).filter((file) => isLikelyImageFile(file));
}

function pickAutocompleteSelectedIndex(
  previousState: ComposerAutocompleteState | null,
  target: ComposerAutocompleteTarget,
  nextItems: ComposerAutocompleteItem[],
): number {
  if (!previousState || previousState.items.length === 0 || nextItems.length === 0) {
    return 0;
  }

  if (previousState.target.kind !== target.kind) {
    return 0;
  }

  const previousSelected = previousState.items[previousState.selectedIndex];
  if (!previousSelected) {
    return 0;
  }

  const sameKeyIndex = nextItems.findIndex((item) => item.key === previousSelected.key);
  if (sameKeyIndex >= 0) {
    return sameKeyIndex;
  }

  return Math.min(previousState.selectedIndex, nextItems.length - 1);
}

function renderHighlightedLabel(label: string, query: string) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return label;
  }

  const lowerLabel = label.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const matchIndex = lowerLabel.indexOf(lowerQuery);
  if (matchIndex < 0) {
    return label;
  }

  const prefix = label.slice(0, matchIndex);
  const matched = label.slice(matchIndex, matchIndex + normalizedQuery.length);
  const suffix = label.slice(matchIndex + normalizedQuery.length);

  return (
    <>
      {prefix}
      <span className="rounded-sm bg-[hsl(var(--cool-accent)/0.22)] px-0.5 text-[hsl(var(--cool-accent))] font-medium">{matched}</span>
      {suffix}
    </>
  );
}

// 检查是否有文本内容输出
const hasTextContent = (items: { type: string }[]) => {
  return items.some(item => item.type === 'text');
};

const hasToolContent = (items: { type: string }[]) => {
  return items.some(item => item.type === 'tool');
};

const hasPendingToolApproval = (items: Array<{ type: string; toolCall?: { status?: string } }>) => {
  return items.some(item => item.type === 'tool' && item.toolCall?.status === 'pending');
};

export function ChatArea() {
  const currentMessages = useSessionStore((s) => s.currentMessages);

  const isLoading = useChatStore((s) => s.isLoading);
  const streamItems = useChatStore((s) => s.streamItems);
  const pendingApprovalId = useChatStore((s) => s.pendingApprovalId);
  const isWaitingResponse = useChatStore((s) => s.isWaitingResponse);
  const usageStats = useChatStore((s) => s.usageStats);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const cancelStream = useChatStore((s) => s.cancelStream);
  const clearHistory = useChatStore((s) => s.clearHistory);
  const rewindLastTurn = useChatStore((s) => s.rewindLastTurn);
  const initStreamListener = useChatStore((s) => s.initStreamListener);
  const approveToolCall = useChatStore((s) => s.approveToolCall);
  const rejectToolCall = useChatStore((s) => s.rejectToolCall);

  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const apiKey = useConfigStore((s) => s.apiKey);
  const providers = useConfigStore((s) => s.providers);
  const activeProviderId = useConfigStore((s) => s.activeProviderId);
  const activeModelId = useConfigStore((s) => s.activeModelId);
  const setActiveModel = useConfigStore((s) => s.setActiveModel);
  const saveConfig = useConfigStore((s) => s.saveConfig);
  const allowToolForSession = useConfigStore((s) => s.allowToolForSession);
  const setAllowAllForSession = useConfigStore((s) => s.setAllowAllForSession);
  const [input, setInput] = useState('');
  const [thinkingText, setThinkingText] = useState(THINKING_MESSAGES[0]);
  const [waitElapsedSec, setWaitElapsedSec] = useState(0);
  const [autocomplete, setAutocomplete] = useState<ComposerAutocompleteState | null>(null);
  const [pastedImages, setPastedImages] = useState<PastedImageDraft[]>([]);
  const [isDropActive, setIsDropActive] = useState(false);
  const [composerHint, setComposerHint] = useState('');
  const [brandIconLoadFailed, setBrandIconLoadFailed] = useState(false);
  const [isRecoveryDialogOpen, setIsRecoveryDialogOpen] = useState(false);
  const [recoveryActionBusy, setRecoveryActionBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
  const modelSelectorMenuId = 'chat-model-selector-menu';
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const listenerInitialized = useRef(false);
  const waitStartTimestampRef = useRef<number | null>(null);
  const inputRef = useRef(input);
  const pastedImagesRef = useRef<PastedImageDraft[]>([]);
  const pathAutocompleteRequestSeqRef = useRef(0);
  const suppressCursorAutocompleteRefreshRef = useRef(false);
  const composerDragDepthRef = useRef(0);
  const lastEscapePressedAtRef = useRef<number>(0);
  const inputHistoryRef = useRef<string[]>([]);
  const inputHistoryIndexRef = useRef<number | null>(null);
  const inputHistoryDraftRef = useRef('');
  const hasPendingApproval = pendingApprovalId !== null || hasPendingToolApproval(streamItems);
  const hasStreamText = hasTextContent(streamItems);
  const hasStreamTool = hasToolContent(streamItems);
  const hasAnyStreamOutput = hasStreamText || hasStreamTool;
  const shouldShowThinking = !hasPendingApproval && !hasAnyStreamOutput && (isLoading || isWaitingResponse);
  const activeWaitStage: WaitStage = hasPendingApproval ? 'approval' : (shouldShowThinking ? 'model' : null);
  const showWaitDurationHint = waitElapsedSec >= WAIT_TIME_HINT_THRESHOLD_SEC;
  const hasComposedContent = input.trim().length > 0 || pastedImages.length > 0;
  const displayInputTokens = (usageStats.totalInputTokens ?? 0) + (usageStats.currentTurnInputTokens ?? 0);
  const displayOutputTokens = (usageStats.totalOutputTokens ?? 0) + (usageStats.currentTurnOutputTokens ?? 0);
  const hasAnyUsage = usageStats.totalInputTokens !== null || usageStats.currentTurnInputTokens !== null;
  const totalInputTokensLabel = hasAnyUsage ? formatTokenCount(displayInputTokens) : '--';
  const totalOutputTokensLabel = hasAnyUsage ? formatTokenCount(displayOutputTokens) : '--';

  const contextUsedPercent = usageStats.contextRemainingPercent !== null
    ? Math.max(0, Math.min(100, 100 - usageStats.contextRemainingPercent))
    : null;

  const scrollToBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: 'auto',
    });
  }, []);

  // 只初始化一次流式监听器
  useEffect(() => {
    if (!listenerInitialized.current) {
      try {
        initStreamListener();
        listenerInitialized.current = true;
      } catch (error) {
        console.error('[chat-area] Failed to initialize stream listener:', error);
      }
    }
  }, [initStreamListener]);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    pastedImagesRef.current = pastedImages;
  }, [pastedImages]);

  useEffect(() => {
    if (!autocomplete) return;
    requestAnimationFrame(() => {
      const active = document.querySelector<HTMLElement>('[data-autocomplete-active="true"]');
      active?.scrollIntoView({ block: 'nearest' });
    });
  }, [autocomplete]);

  // 动态切换思考文字，带淡入淡出效果
  useEffect(() => {
    if (shouldShowThinking) {
      const messages = isWaitingResponse ? TOOL_PROCESSING_MESSAGES : THINKING_MESSAGES;
      const interval = setInterval(() => {
        setThinkingText(prev => {
          const currentIndex = messages.indexOf(prev);
          // 如果当前文字不在当前消息列表中，从第一个开始
          if (currentIndex === -1) {
            return messages[0];
          }
          const nextIndex = (currentIndex + 1) % messages.length;
          return messages[nextIndex];
        });
      }, 1500);
      return () => clearInterval(interval);
    }
  }, [shouldShowThinking, isWaitingResponse]);

  useEffect(() => {
    if (!activeWaitStage) {
      waitStartTimestampRef.current = null;
      setWaitElapsedSec(0);
      return;
    }

    waitStartTimestampRef.current = Date.now();
    setWaitElapsedSec(0);

    const timer = setInterval(() => {
      if (!waitStartTimestampRef.current) return;
      const elapsedMs = Date.now() - waitStartTimestampRef.current;
      setWaitElapsedSec(Math.floor(elapsedMs / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, [activeWaitStage]);

  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      scrollToBottom();
    });
    return () => cancelAnimationFrame(rafId);
  }, [currentMessages, streamItems, scrollToBottom]);

  useEffect(() => {
    if (!composerHint) return;
    const timer = window.setTimeout(() => {
      setComposerHint('');
    }, 4200);
    return () => window.clearTimeout(timer);
  }, [composerHint]);

  useEffect(() => {
    if (!isModelSelectorOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (modelSelectorRef.current && !modelSelectorRef.current.contains(e.target as Node)) {
        setIsModelSelectorOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isModelSelectorOpen]);

  useEffect(() => {
    if (!isModelSelectorOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsModelSelectorOpen(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isModelSelectorOpen]);

  const handleSelectModel = useCallback(async (providerId: string, modelId: string) => {
    setActiveModel(providerId, modelId);
    setIsModelSelectorOpen(false);
    await saveConfig();
  }, [setActiveModel, saveConfig]);

  const currentModelLabel = useMemo(() => {
    if (!activeModelId) return '选择模型';
    const parts = activeModelId.split('/');
    return parts[parts.length - 1] || activeModelId;
  }, [activeModelId]);

  const activeProvider = useMemo(() => {
    return providers.find((provider) => provider.id === activeProviderId) ?? null;
  }, [providers, activeProviderId]);

  const activeProviderName = activeProvider?.name?.trim() || '未配置供应商';
  const activeProtocolLabel = activeProvider?.protocol.toUpperCase() || 'N/A';
  const hasModelOptions = providers.some((provider) => provider.models.length > 0);

  const handleAllowAllForSession = useCallback(() => {
    setAllowAllForSession(true);
  }, [setAllowAllForSession]);

  const handleOpenSettingsFromModelSelector = useCallback(() => {
    setIsModelSelectorOpen(false);
    setSettingsOpen(true);
  }, [setSettingsOpen]);

  const navigateInputHistory = useCallback((direction: 'prev' | 'next') => {
    const history = inputHistoryRef.current;
    if (history.length === 0) {
      return null;
    }

    const currentIndex = inputHistoryIndexRef.current;
    if (direction === 'prev') {
      if (currentIndex === null) {
        inputHistoryDraftRef.current = input;
        inputHistoryIndexRef.current = history.length - 1;
        return history[history.length - 1] ?? null;
      }
      if (currentIndex <= 0) {
        inputHistoryIndexRef.current = 0;
        return history[0] ?? null;
      }
      inputHistoryIndexRef.current = currentIndex - 1;
      return history[currentIndex - 1] ?? null;
    }

    if (currentIndex === null) {
      return null;
    }

    if (currentIndex >= history.length - 1) {
      inputHistoryIndexRef.current = null;
      return inputHistoryDraftRef.current;
    }

    inputHistoryIndexRef.current = currentIndex + 1;
    return history[currentIndex + 1] ?? null;
  }, [input]);

  const updateAutocomplete = useCallback(async (value: string, cursor: number) => {
    const target = extractAutocompleteTarget(value, cursor);
    if (!target) {
      pathAutocompleteRequestSeqRef.current += 1;
      setAutocomplete(null);
      return;
    }

    if (target.kind === 'slash') {
      pathAutocompleteRequestSeqRef.current += 1;
      const commandSuggestions = getSlashCommandSuggestions(target.query)
        .slice(0, 8)
        .map<ComposerAutocompleteItem>((command) => ({
          key: `slash:${command.name}`,
          kind: 'slash',
          insertValue: `/${command.name}`,
          label: command.usage,
          description: command.description,
          appendTrailingSpace: true,
        }));

      if (commandSuggestions.length === 0) {
        setAutocomplete(null);
        return;
      }

      setAutocomplete((previous) => ({
        target,
        items: commandSuggestions,
        selectedIndex: pickAutocompleteSelectedIndex(previous, target, commandSuggestions),
      }));
      return;
    }

    const requestId = pathAutocompleteRequestSeqRef.current + 1;
    pathAutocompleteRequestSeqRef.current = requestId;

    const rootedQuery = target.query.startsWith('/') ? target.query : `/${target.query}`;
    const pathSuggestions = await electronApiClient.autocompletePaths(rootedQuery);
    if (requestId !== pathAutocompleteRequestSeqRef.current) {
      return;
    }

    if (inputRef.current !== value) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    if ((textarea.selectionStart ?? value.length) !== cursor) {
      return;
    }

    const pathItems = pathSuggestions
      .slice(0, 8)
      .map<ComposerAutocompleteItem>((item) => ({
        key: `path:${item.value}`,
        kind: 'path',
        insertValue: `@${item.value}`,
        label: item.value,
        description: item.isDirectory ? '目录' : '文件',
        appendTrailingSpace: !item.isDirectory,
        isDirectory: item.isDirectory,
      }));

    if (pathItems.length === 0) {
      setAutocomplete(null);
      return;
    }

    setAutocomplete((previous) => ({
      target,
      items: pathItems,
      selectedIndex: pickAutocompleteSelectedIndex(previous, target, pathItems),
    }));
  }, []);

  const refreshAutocompleteFromTextarea = useCallback((valueOverride?: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const value = valueOverride ?? textarea.value;
    const cursor = textarea.selectionStart ?? value.length;
    void updateAutocomplete(value, cursor);
  }, [updateAutocomplete]);

  const applyAutocompleteItem = useCallback((index: number) => {
    if (!autocomplete) return false;

    const item = autocomplete.items[index];
    if (!item) return false;

    const next = applyAutocompleteReplacement(
      input,
      autocomplete.target,
      item.insertValue,
      item.appendTrailingSpace,
    );

    setInput(next.value);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(next.cursor, next.cursor);
      void updateAutocomplete(next.value, next.cursor);
    });
    return true;
  }, [autocomplete, input, updateAutocomplete]);

  const readImageAsDataUrl = useCallback((file: File) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
          return;
        }
        reject(new Error('读取图片失败：无效的 DataURL'));
      };
      reader.onerror = () => {
        reject(new Error('读取图片失败'));
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const appendImageFiles = useCallback(async (files: File[], sourceLabel: '粘贴' | '拖拽' | '选择') => {
    if (files.length === 0) {
      return;
    }

    const normalizedFiles = files.filter((file) => isLikelyImageFile(file));
    if (normalizedFiles.length === 0) {
      setComposerHint('未检测到可用图片，请选择图片文件后重试。');
      return;
    }

    const existingImages = pastedImagesRef.current;
    const remainingSlots = Math.max(0, MAX_ATTACHMENT_IMAGES - existingImages.length);
    if (remainingSlots <= 0) {
      setComposerHint(`最多添加 ${MAX_ATTACHMENT_IMAGES} 张图片，请先移除部分附件。`);
      return;
    }

    const selectedFiles = normalizedFiles.slice(0, remainingSlots);
    const skippedByLimit = Math.max(0, normalizedFiles.length - selectedFiles.length);
    const nextImages: PastedImageDraft[] = [];
    let skippedOversizeCount = 0;
    let hasReadFailure = false;

    for (const file of selectedFiles) {
      if (file.size > MAX_ATTACHMENT_IMAGE_SIZE_BYTES) {
        skippedOversizeCount += 1;
        continue;
      }

      try {
        const dataUrl = await readImageAsDataUrl(file);
        nextImages.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          name: file.name || '未命名图片',
          mimeType: file.type || 'image/*',
          sizeBytes: file.size,
          dataUrl,
        });
      } catch {
        hasReadFailure = true;
      }
    }

    if (nextImages.length > 0) {
      setPastedImages((previous) => [...previous, ...nextImages].slice(0, MAX_ATTACHMENT_IMAGES));
    }

    const hintParts: string[] = [];
    if (nextImages.length > 0) {
      hintParts.push(`${sourceLabel}添加 ${nextImages.length} 张图片`);
    }
    if (skippedByLimit > 0) {
      hintParts.push(`${skippedByLimit} 张超出上限已跳过`);
    }
    if (skippedOversizeCount > 0) {
      hintParts.push(`${skippedOversizeCount} 张超过 ${formatSizeLabel(MAX_ATTACHMENT_IMAGE_SIZE_BYTES)} 已跳过`);
    }
    if (hasReadFailure) {
      hintParts.push('部分图片读取失败');
    }

    if (hintParts.length > 0) {
      setComposerHint(`${hintParts.join('，')}。`);
    }

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [readImageAsDataUrl]);

  const handleRemovePastedImage = useCallback((id: string) => {
    setPastedImages((previous) => previous.filter((image) => image.id !== id));
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = collectImageFiles(e.clipboardData);
    if (files.length === 0) {
      return;
    }

    e.preventDefault();
    await appendImageFiles(files, '粘贴');
  }, [appendImageFiles]);

  const handleOpenImagePicker = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  const handleImageInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      await appendImageFiles(files, '选择');
    }
    e.target.value = '';
  }, [appendImageFiles]);

  const resetComposerDropState = useCallback(() => {
    composerDragDepthRef.current = 0;
    setIsDropActive(false);
  }, []);

  const handleComposerDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!hasImageInDataTransfer(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    composerDragDepthRef.current += 1;
    if (!isDropActive) {
      setIsDropActive(true);
    }
  }, [isDropActive]);

  const handleComposerDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!hasImageInDataTransfer(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    if (!isDropActive) {
      setIsDropActive(true);
    }
  }, [isDropActive]);

  const handleComposerDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) {
      setIsDropActive(false);
    }
  }, []);

  const handleComposerDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const hasImage = hasImageInDataTransfer(e.dataTransfer);
    if (!hasImage) {
      resetComposerDropState();
      return;
    }
    resetComposerDropState();

    const files = collectImageFiles(e.dataTransfer);
    await appendImageFiles(files, '拖拽');
  }, [appendImageFiles, resetComposerDropState]);

  const handleOpenRecoveryMenu = useCallback(() => {
    setRecoveryMessage('');
    setIsRecoveryDialogOpen(true);
  }, []);

  const handleRewind = useCallback(async () => {
    setRecoveryActionBusy(true);
    try {
      const result = await rewindLastTurn();
      if (result.skipped) {
        setRecoveryMessage(result.reason ?? '当前没有可恢复的最近轮次。');
        return;
      }

      setRecoveryMessage(`已回退最近轮次，移除 ${result.removedMessageCount} 条消息。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRecoveryMessage(`回退失败：${message}`);
    } finally {
      setRecoveryActionBusy(false);
    }
  }, [rewindLastTurn]);

  const handleSend = useCallback(async () => {
    if (isLoading) return;

    const inputMessage = input.trim();
    if (!inputMessage && pastedImages.length === 0) return;

    const isSlashCommand = Boolean(parseSlashCommand(inputMessage));
    const attachmentsForSend = !isSlashCommand && pastedImages.length > 0 ? pastedImages : undefined;
    const message = inputMessage;

    if (!isSlashCommand && !apiKey) {
      setSettingsOpen(true);
      return;
    }

    if (isSlashCommand && pastedImages.length > 0) {
      setComposerHint('斜杠命令已执行，粘贴的图片将被忽略。');
    }
    const shouldKeepHintAfterSend = isSlashCommand && pastedImages.length > 0;

    if (inputMessage) {
      const history = inputHistoryRef.current;
      if (history.length === 0 || history[history.length - 1] !== inputMessage) {
        history.push(inputMessage);
        if (history.length > 100) {
          history.shift();
        }
      }
    }
    inputHistoryIndexRef.current = null;
    inputHistoryDraftRef.current = '';

    pathAutocompleteRequestSeqRef.current += 1;
    setAutocomplete(null);
    setInput('');
    setPastedImages([]);
    if (!shouldKeepHintAfterSend) {
      setComposerHint('');
    }
    setThinkingText(THINKING_MESSAGES[0]); // 发送新消息时重置为初始思考文字
    await sendMessage(message, attachmentsForSend);
  }, [input, pastedImages, isLoading, apiKey, setSettingsOpen, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (autocomplete && autocomplete.items.length > 0) {
      const isNextKey = e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'));
      const isPrevKey = e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'));

      if (isNextKey) {
        suppressCursorAutocompleteRefreshRef.current = true;
        e.preventDefault();
        setAutocomplete((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            selectedIndex: (prev.selectedIndex + 1) % prev.items.length,
          };
        });
        return;
      }

      if (isPrevKey) {
        suppressCursorAutocompleteRefreshRef.current = true;
        e.preventDefault();
        setAutocomplete((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            selectedIndex: (prev.selectedIndex - 1 + prev.items.length) % prev.items.length,
          };
        });
        return;
      }

      if (e.key === 'Escape') {
        suppressCursorAutocompleteRefreshRef.current = true;
        e.preventDefault();
        setAutocomplete(null);
        return;
      }

      if (e.key === 'Tab') {
        suppressCursorAutocompleteRefreshRef.current = true;
        e.preventDefault();
        applyAutocompleteItem(autocomplete.selectedIndex);
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        suppressCursorAutocompleteRefreshRef.current = true;
        e.preventDefault();
        applyAutocompleteItem(autocomplete.selectedIndex);
        return;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (e.repeat) {
        return;
      }

      if (isLoading) {
        void cancelStream();
        lastEscapePressedAtRef.current = 0;
        setComposerHint('已停止当前响应。');
        return;
      }

      const now = Date.now();
      if (now - lastEscapePressedAtRef.current <= DOUBLE_ESCAPE_INTERVAL_MS) {
        lastEscapePressedAtRef.current = 0;
        handleOpenRecoveryMenu();
      } else {
        lastEscapePressedAtRef.current = now;
        setComposerHint('再按一次 Esc 打开恢复菜单。');
      }
      return;
    }

    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Backspace' && input.length === 0 && pastedImages.length > 0) {
      e.preventDefault();
      setPastedImages((previous) => previous.slice(0, -1));
      setComposerHint('已移除最后一张图片。');
      return;
    }

    const hasModifier = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
    if (!hasModifier && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const textarea = textareaRef.current;
      if (textarea) {
        const selectionStart = textarea.selectionStart ?? 0;
        const selectionEnd = textarea.selectionEnd ?? 0;
        const hasSelection = selectionStart !== selectionEnd;
        const atInputStart = selectionStart === 0 && selectionEnd === 0;
        const atInputEnd = selectionStart === input.length && selectionEnd === input.length;

        if (e.key === 'ArrowUp' && !hasSelection && atInputStart && (input.length === 0 || inputHistoryIndexRef.current !== null)) {
          const previousInput = navigateInputHistory('prev');
          if (previousInput !== null) {
            e.preventDefault();
            setInput(previousInput);
            requestAnimationFrame(() => {
              const nextTextarea = textareaRef.current;
              if (!nextTextarea) return;
              const cursor = previousInput.length;
              nextTextarea.setSelectionRange(cursor, cursor);
            });
          }
          return;
        }

        if (e.key === 'ArrowDown' && !hasSelection && atInputEnd && inputHistoryIndexRef.current !== null) {
          const nextInput = navigateInputHistory('next');
          if (nextInput !== null) {
            e.preventDefault();
            setInput(nextInput);
            requestAnimationFrame(() => {
              const nextTextarea = textareaRef.current;
              if (!nextTextarea) return;
              const cursor = nextInput.length;
              nextTextarea.setSelectionRange(cursor, cursor);
            });
          }
          return;
        }
      }
    }

    if (e.key === 'Tab') {
      const textarea = textareaRef.current;
      if (textarea) {
        const value = textarea.value;
        const cursor = textarea.selectionStart ?? value.length;
        const target = extractAutocompleteTarget(value, cursor);
        if (target) {
          e.preventDefault();
          void updateAutocomplete(value, cursor);
        }
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value;
    if (inputHistoryIndexRef.current !== null) {
      inputHistoryIndexRef.current = null;
      inputHistoryDraftRef.current = '';
    }
    setInput(nextValue);
    void updateAutocomplete(nextValue, e.target.selectionStart ?? nextValue.length);
  };

  const handleInputCursorChange = () => {
    if (suppressCursorAutocompleteRefreshRef.current) {
      suppressCursorAutocompleteRefreshRef.current = false;
      return;
    }
    refreshAutocompleteFromTextarea();
  };

  const handleInputKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' || e.key === 'Enter' || e.key === 'Escape') {
      return;
    }

    if ((e.ctrlKey && (e.key === 'n' || e.key === 'N' || e.key === 'p' || e.key === 'P')) && autocomplete) {
      return;
    }

    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && autocomplete) {
      return;
    }
    refreshAutocompleteFromTextarea();
  };

  const promptSuggestions = [
    '帮我快速分析这个项目结构',
    '生成今天的开发任务清单',
    '帮我审查一段 TypeScript 代码',
  ];

  return (
    <main className="chat-canvas relative flex flex-1 flex-col">
      <div className="drag-region relative z-[60] flex h-14 items-center justify-between border-b border-border/55 bg-background/55 px-5 backdrop-blur-xl">
        <div className="flex items-center gap-2 no-drag">
          <div className="h-8 w-8 overflow-hidden rounded-lg border border-border/60 bg-[linear-gradient(135deg,hsl(var(--primary)/0.24),hsl(var(--cool-accent)/0.2))] shadow-[0_6px_16px_hsl(var(--cool-accent)/0.14)]">
            {brandIconLoadFailed ? (
              <div className="flex h-full w-full items-center justify-center">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
            ) : (
              <img
                src={BRANDING.rendererIconUrl}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setBrandIconLoadFailed(true)}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <h1 className="font-semibold text-sm tracking-[0.04em] text-foreground/95">{BRANDING.headerName}</h1>
            <span className="text-[10px] uppercase tracking-[0.16em] px-2 py-0.5 rounded-full border border-border/50 bg-secondary/60 text-muted-foreground/80">
              Agent Mode
            </span>
          </div>
        </div>

        <div className="relative no-drag" ref={modelSelectorRef}>
          <button
            type="button"
            onClick={() => setIsModelSelectorOpen(!isModelSelectorOpen)}
            aria-haspopup="listbox"
            aria-expanded={isModelSelectorOpen}
            aria-controls={modelSelectorMenuId}
            className={[
              'group flex min-h-[38px] min-w-[190px] max-w-[280px] items-center gap-2.5 rounded-xl border px-3 py-1.5 text-left transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-0',
              isModelSelectorOpen
                ? 'border-[hsl(var(--cool-accent)/0.65)] bg-[linear-gradient(140deg,hsl(var(--secondary)/0.92),hsl(var(--secondary)/0.78))] shadow-[0_10px_24px_hsl(var(--background)/0.45)]'
                : 'border-border/55 bg-[linear-gradient(140deg,hsl(var(--secondary)/0.52),hsl(var(--secondary)/0.36))] hover:border-border/80 hover:bg-secondary/70',
            ].join(' ')}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] leading-none text-muted-foreground/90">
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--cool-accent))] shadow-[0_0_0_3px_hsl(var(--cool-accent)/0.2)]" />
                <span className="truncate">{activeProviderName}</span>
              </div>
              <div className="mt-0.5 truncate text-[13px] font-semibold leading-tight text-foreground/95">
                {currentModelLabel}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="rounded-md border border-border/70 bg-background/45 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-[0.09em] leading-none text-muted-foreground/85">
                {activeProtocolLabel}
              </span>
              <ChevronDown
                className={[
                  'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
                  isModelSelectorOpen ? 'rotate-180 text-foreground/90' : 'rotate-0',
                ].join(' ')}
              />
            </div>
          </button>

          {isModelSelectorOpen && (
            <div
              id={modelSelectorMenuId}
              role="listbox"
              className="model-selector-panel absolute right-0 top-full mt-2 w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/75 bg-[linear-gradient(160deg,hsl(var(--secondary)/0.97),hsl(222_18%_11%/0.97))] shadow-[0_20px_38px_hsl(var(--background)/0.6)] z-[100]"
            >
              <div className="border-b border-border/65 bg-background/30 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/85">模型选择器</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold text-foreground/95">{activeProviderName}</p>
                  <span className="rounded-md border border-border/70 bg-secondary/65 px-2 py-0.5 text-[11px] font-medium text-muted-foreground/90">
                    {activeModelId ? `当前: ${currentModelLabel}` : '未选择模型'}
                  </span>
                </div>
              </div>

              {providers.length === 0 || !hasModelOptions ? (
                <div className="px-4 py-5">
                  <p className="text-sm font-medium text-foreground/90">还没有可用模型</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground/80">
                    先在设置中添加供应商并填写模型 ID，然后就可以在这里快速切换。
                  </p>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={handleOpenSettingsFromModelSelector}
                    className="mt-3 inline-flex h-8 items-center justify-center rounded-lg border border-border/70 bg-secondary/70 px-3 text-xs font-medium text-foreground/90 transition-colors hover:bg-secondary/90"
                  >
                    打开设置
                  </button>
                </div>
              ) : (
                <div className="max-h-[360px] space-y-2 overflow-y-auto p-2">
                  {providers.map((provider) => (
                    <section
                      key={provider.id}
                      className="rounded-xl border border-border/65 bg-[linear-gradient(160deg,hsl(var(--secondary)/0.58),hsl(var(--secondary)/0.4))] p-1.5"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2 px-1.5 py-1">
                        <p className="truncate text-[11px] uppercase tracking-[0.12em] text-muted-foreground/90">
                          {provider.name || '未命名供应商'}
                        </p>
                        <span className="rounded-md border border-border/70 bg-background/40 px-1.5 py-0.5 text-[10px] text-muted-foreground/80">
                          {provider.models.length} 个模型
                        </span>
                      </div>

                      {provider.models.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-muted-foreground/65">暂无模型</div>
                      ) : (
                        <div className="space-y-1">
                          {provider.models.map((modelId) => {
                            const isActive = provider.id === activeProviderId && modelId === activeModelId;
                            const segments = modelId.split('/');
                            const modelShortName = segments[segments.length - 1] || modelId;
                            return (
                              <button
                                key={`${provider.id}-${modelId}`}
                                type="button"
                                role="option"
                                aria-selected={isActive}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onClick={() => {
                                  void handleSelectModel(provider.id, modelId);
                                }}
                                className={[
                                  'flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left transition-all duration-150',
                                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-0',
                                  isActive
                                    ? 'border-[hsl(var(--cool-accent)/0.55)] bg-[linear-gradient(130deg,hsl(var(--cool-accent)/0.22),hsl(var(--secondary)/0.92))] text-foreground shadow-[inset_0_1px_0_hsl(0_0%_100%/0.04)]'
                                    : 'border-transparent bg-transparent text-foreground/88 hover:border-border/75 hover:bg-secondary/65',
                                ].join(' ')}
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-[13px] font-medium">{modelShortName}</p>
                                  {modelShortName !== modelId && (
                                    <p className="truncate text-[11px] text-muted-foreground/75">{modelId}</p>
                                  )}
                                </div>
                                {isActive && (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--cool-accent)/0.45)] bg-[hsl(var(--cool-accent)/0.16)] px-1.5 py-0.5 text-[10px] font-semibold text-[hsl(var(--cool-accent))]">
                                    <Check className="h-3 w-3 shrink-0" />
                                    当前
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              )}
              <div className="border-t border-border/65 bg-background/25 px-3 py-2 text-[11px] text-muted-foreground/75">
                在设置中可管理供应商、模型列表与 API 凭证。
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 no-drag">
          <Button
            variant="ghost"
            size="icon"
            onClick={clearHistory}
            title="清除对话"
            aria-label="清除当前对话"
            className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-secondary/70 rounded-lg"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            title="设置"
            aria-label="打开设置"
            className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-secondary/70 rounded-lg"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1" viewportRef={scrollViewportRef}>
        <div className="max-w-4xl mx-auto px-6 py-7 space-y-4">
          {currentMessages.length === 0 && streamItems.length === 0 && !isLoading && (
            <div className="text-center py-20">
              {brandIconLoadFailed ? (
                <div className="w-20 h-20 rounded-2xl border border-border/60 bg-[linear-gradient(145deg,hsl(var(--primary)/0.2),hsl(var(--cool-accent)/0.16))] flex items-center justify-center mx-auto mb-6 shadow-[0_18px_32px_hsl(var(--background)/0.58)]">
                  <Sparkles className="h-10 w-10 text-[hsl(var(--foreground))]" />
                </div>
              ) : (
                <img
                  src={BRANDING.rendererIconUrl}
                  alt={BRANDING.productName}
                  className="mx-auto mb-6 h-20 w-20 rounded-2xl border border-border/60 object-cover shadow-[0_18px_32px_hsl(var(--background)/0.58)]"
                  onError={() => setBrandIconLoadFailed(true)}
                />
              )}
              <h2 className="text-2xl font-semibold mb-3 text-foreground tracking-tight">开始新对话</h2>
              <p className="text-muted-foreground text-[15px] max-w-xl mx-auto leading-7">
                一个面向开发效率的 AI 对话工作台。你可以直接提问，也可以从下面的快捷提示开始。
              </p>
              <div className="mt-7 grid gap-2 sm:grid-cols-3">
                {promptSuggestions.map((prompt, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => setInput(prompt)}
                    className="no-drag rounded-xl border border-border/60 bg-secondary/45 hover:bg-secondary/75 text-left px-3 py-2.5 text-sm text-foreground/85 transition-all duration-200"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {currentMessages.map((msg, i) => (
            msg.role === 'user' ? (
              // 用户消息
              <div
                key={`${msg.role}-${msg.timestamp ?? i}-${i}`}
                className="message-enter flex justify-end"
              >
                <div className="px-4 py-3.5 rounded-2xl max-w-[82%] user-message rounded-br-md shadow-[0_12px_30px_hsl(var(--primary)/0.12)]">
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mb-2.5 flex flex-wrap gap-2">
                      {msg.attachments.map((attachment) => (
                        <a
                          key={attachment.id}
                          href={attachment.dataUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="group block overflow-hidden rounded-lg"
                          title={attachment.name}
                        >
                          <img
                            src={attachment.dataUrl}
                            alt={attachment.name}
                            className="h-24 max-w-[180px] rounded-lg object-cover ring-1 ring-white/15 transition-transform duration-200 group-hover:scale-[1.03]"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  {msg.content.trim() ? (
                    <MarkdownRenderer content={msg.content} />
                  ) : (
                    msg.attachments && msg.attachments.length > 0 && (
                      <p className="text-xs text-muted-foreground/75">[图片消息]</p>
                    )
                  )}
                </div>
              </div>
            ) : msg.items && msg.items.length > 0 ? (
              // Assistant 消息带有 items（工具调用记录）
              <div key={`${msg.role}-${msg.timestamp ?? i}-${i}`} className="space-y-2">
                {msg.items.map((item, j) => (
                  item.type === 'text' ? (
                    <div key={`${i}-text-${j}`} className="flex justify-start message-enter">
                      <div className="px-4 py-3.5 rounded-2xl rounded-bl-md assistant-message max-w-[82%]">
                        <MarkdownRenderer content={item.content} />
                      </div>
                    </div>
                  ) : (
                    <div key={`${i}-tool-${item.toolCall.id}`} className="flex justify-start message-enter">
                      <div className="w-full max-w-[85%]">
                        <ToolCallBlock toolCall={item.toolCall} />
                      </div>
                    </div>
                  )
                ))}
              </div>
            ) : (
              // 普通 assistant 消息（旧格式，只有 content）
              <div
                key={`${msg.role}-${msg.timestamp ?? i}-${i}`}
                className="message-enter flex justify-start"
              >
                <div className="px-4 py-3.5 rounded-2xl max-w-[82%] assistant-message rounded-bl-md">
                  <MarkdownRenderer content={msg.content} />
                </div>
              </div>
            )
          ))}

          {/* 流式内容和工具调用按顺序穿插展示 */}
          {streamItems.map((item, i) => (
            item.type === 'text' ? (
              <div key={`text-${i}`} className="flex justify-start message-enter">
                <div className="px-4 py-3.5 rounded-2xl rounded-bl-md assistant-message max-w-[82%]">
                  <MarkdownRenderer content={item.content} />
                </div>
              </div>
            ) : (
              <div key={`tool-${item.toolCall.id}`} className="flex justify-start message-enter">
                <div className="w-full max-w-[85%]">
                  <ToolCallBlock 
                    toolCall={item.toolCall}
                    onApprove={approveToolCall}
                    onReject={rejectToolCall}
                    onAllowForSession={allowToolForSession}
                    onAllowAllForSession={handleAllowAllForSession}
                  />
                </div>
              </div>
            )
          ))}

          {hasPendingApproval && (
            <div className="flex justify-start message-enter">
              <div className="px-4 py-3 rounded-2xl rounded-bl-md assistant-message border border-primary/35 bg-primary/12">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-primary" />
                  <span className="text-sm text-foreground/85">等待你确认工具调用</span>
                </div>
                {showWaitDurationHint && activeWaitStage === 'approval' && (
                  <div className="mt-1 text-xs text-primary/85">
                    已等待 {waitElapsedSec} 秒
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 思考中提示：仅在等待模型继续输出时显示 */}
          {shouldShowThinking && (
            <div className="flex justify-start message-enter">
              <div className="px-4 py-3 rounded-2xl rounded-bl-md assistant-message">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Bot className="h-5 w-5 text-primary animate-pulse" />
                    <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-primary rounded-full animate-ping" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-foreground/80 thinking-text-fade">{thinkingText}</span>
                    <div className="flex items-center gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary/60 loading-dot" />
                      <div className="w-1.5 h-1.5 rounded-full bg-primary/60 loading-dot" />
                      <div className="w-1.5 h-1.5 rounded-full bg-primary/60 loading-dot" />
                    </div>
                  </div>
                </div>
                {showWaitDurationHint && activeWaitStage === 'model' && (
                  <div className="mt-1.5 text-xs text-foreground/55">
                    当前阶段已等待 {waitElapsedSec} 秒
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </ScrollArea>

      <div className="border-t border-border/55 bg-background/45 p-4 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto">
          <div className="relative">
            {autocomplete && autocomplete.items.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 mb-2 no-drag rounded-xl border border-border/70 bg-[linear-gradient(160deg,hsl(var(--secondary)/0.96),hsl(222_18%_11%/0.96))] shadow-[0_14px_30px_hsl(var(--background)/0.55)] overflow-hidden z-20">
                <div className="max-h-56 overflow-y-auto p-1.5 space-y-1">
                  {autocomplete.items.map((item, index) => {
                    const selected = index === autocomplete.selectedIndex;
                    const icon = item.kind === 'slash'
                      ? <TerminalSquare className="h-3.5 w-3.5 text-foreground/70" />
                      : item.isDirectory
                        ? <FolderOpen className="h-3.5 w-3.5 text-[hsl(var(--cool-accent))]" />
                        : <FileCode2 className="h-3.5 w-3.5 text-primary" />;
                    const highlightedLabel = renderHighlightedLabel(item.label, autocomplete.target.query);
                    return (
                      <button
                        key={item.key}
                        type="button"
                        data-autocomplete-active={selected ? 'true' : 'false'}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          applyAutocompleteItem(index);
                        }}
                        className={[
                          'w-full text-left px-3 py-2.5 rounded-lg transition-all duration-150',
                          selected
                            ? 'bg-[linear-gradient(125deg,hsl(var(--cool-accent)/0.2),hsl(var(--secondary)/0.84))] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--cool-accent)/0.36),0_6px_12px_hsl(var(--background)/0.28)]'
                            : 'bg-transparent text-foreground/88 hover:bg-secondary/72',
                        ].join(' ')}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm break-all flex items-center gap-2">
                            {icon}
                            <span>{highlightedLabel}</span>
                          </span>
                          <span className={[
                            'text-[11px] uppercase tracking-[0.08em] shrink-0',
                            selected ? 'text-foreground/85' : 'text-muted-foreground/80',
                          ].join(' ')}>
                            {item.description}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="px-3 py-1.5 text-[11px] text-muted-foreground/75 border-t border-border/45 flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <span className="rounded-md border border-border/65 bg-secondary/65 px-1.5 py-0.5 text-[10px] text-foreground/85">Tab</span>
                    <span>补全</span>
                    <span className="rounded-md border border-border/65 bg-secondary/65 px-1.5 py-0.5 text-[10px] text-foreground/85">↑ ↓</span>
                    <span>选择</span>
                    <span className="rounded-md border border-border/65 bg-secondary/65 px-1.5 py-0.5 text-[10px] text-foreground/85">Enter</span>
                    <span>应用</span>
                  </span>
                  <span className="text-[hsl(var(--cool-accent))]">
                    {autocomplete.selectedIndex + 1}/{autocomplete.items.length}
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleImageInputChange}
              />

              <div
                className={[
                  'relative composer-shell rounded-xl border border-border/60 p-2.5 transition-all',
                  isDropActive ? 'border-primary/55 bg-[hsl(var(--primary)/0.08)]' : '',
                ].join(' ')}
                onDragEnter={handleComposerDragEnter}
                onDragOver={handleComposerDragOver}
                onDragLeave={handleComposerDragLeave}
                onDrop={handleComposerDrop}
                onDragEnd={resetComposerDropState}
              >
                {pastedImages.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2 px-0.5">
                    {pastedImages.map((image) => (
                      <div
                        key={image.id}
                        className="group relative shrink-0"
                      >
                        <img
                          src={image.dataUrl}
                          alt={image.name}
                          title={image.name}
                          className="h-16 w-16 rounded-lg object-cover ring-1 ring-border/50"
                        />
                        <button
                          type="button"
                          onClick={() => handleRemovePastedImage(image.id)}
                          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-foreground/80 text-background shadow-sm opacity-0 transition-opacity group-hover:opacity-100"
                          aria-label={`移除 ${image.name}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-3 items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleOpenImagePicker}
                    disabled={pastedImages.length >= MAX_ATTACHMENT_IMAGES}
                    title="添加图片"
                    aria-label="添加图片"
                    className="h-10 w-10 shrink-0 rounded-xl text-muted-foreground hover:text-foreground disabled:opacity-35"
                  >
                    <ImagePlus className="h-4 w-4" />
                  </Button>
                  <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onClick={handleInputCursorChange}
                    onKeyUp={handleInputKeyUp}
                    onSelect={handleInputCursorChange}
                    onPaste={handlePaste}
                    onBlur={() => setAutocomplete(null)}
                    placeholder="输入消息… (Enter 发送，Ctrl+V/拖拽/按钮添加图片)"
                    className="flex-1 min-h-[40px] max-h-[200px] resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-[0.95rem] placeholder:text-muted-foreground/60"
                    rows={1}
                  />
                  <div className="shrink-0 rounded-lg border border-border/60 bg-secondary/40 px-2.5 py-1.5 text-[10px] leading-tight text-foreground/82 min-w-[90px]">
                    {contextUsedPercent !== null ? (
                      <div className="flex items-center gap-1.5 mb-1">
                        <div className="flex-1 h-1.5 rounded-full bg-muted/60 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${contextUsedPercent}%`,
                              backgroundColor: contextUsedPercent > 90 ? 'hsl(var(--destructive))' : contextUsedPercent > 70 ? 'hsl(var(--chart-4))' : 'hsl(var(--primary))',
                            }}
                          />
                        </div>
                        <span className="text-muted-foreground/70 tabular-nums">{contextUsedPercent.toFixed(0)}%</span>
                      </div>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-0.5">
                        <ArrowUp className="h-2.5 w-2.5 text-primary/70" />
                        <span className="tabular-nums">{totalInputTokensLabel}</span>
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <ArrowDown className="h-2.5 w-2.5 text-primary/70" />
                        <span className="tabular-nums">{totalOutputTokensLabel}</span>
                      </span>
                    </div>
                  </div>
                  {isLoading ? (
                    <Button
                      variant="destructive"
                      size="icon"
                      onClick={cancelStream}
                      aria-label="停止生成"
                      className="h-10 w-10 rounded-xl shrink-0"
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      onClick={handleSend}
                      disabled={!hasComposedContent}
                      aria-label="发送消息"
                      className="h-10 w-10 rounded-xl shrink-0 text-primary-foreground shadow-primary/20 disabled:opacity-30"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                {isDropActive && (
                  <div className="pointer-events-none absolute inset-0 rounded-xl border border-primary/50 bg-[hsl(var(--background)/0.7)] backdrop-blur-sm flex items-center justify-center">
                    <div className="flex items-center gap-2 text-sm text-primary">
                      <ImagePlus className="h-4 w-4" />
                      松开以添加图片附件
                    </div>
                  </div>
                )}
              </div>

              {composerHint && (
                <p className="text-[11px] text-[hsl(var(--cool-accent))]">{composerHint}</p>
              )}
            </div>
          </div>
          <p className="text-center text-[11px] text-muted-foreground/65 mt-2 tracking-[0.04em]">
            Shift+Enter 换行 · Esc 停止生成 · Esc+Esc 恢复菜单 · Ctrl+V/拖拽/按钮添加图片 · Backspace 可删除最后一张附件 · 结果可能有误，请核实关键操作
          </p>
        </div>
      </div>

      <Dialog open={isRecoveryDialogOpen} onOpenChange={setIsRecoveryDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-primary" />
              恢复菜单
            </DialogTitle>
            <DialogDescription>
              你可以撤销最近一轮对话，或直接清空当前会话。快捷键：`Esc + Esc`。
            </DialogDescription>
          </DialogHeader>

          <div className="px-6 pb-1 space-y-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void handleRewind();
              }}
              disabled={recoveryActionBusy}
              className="w-full justify-start gap-2"
            >
              <RotateCcw className="h-4 w-4" />
              撤销最近一轮对话
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                void clearHistory();
                setIsRecoveryDialogOpen(false);
              }}
              disabled={recoveryActionBusy}
              className="w-full justify-start gap-2"
            >
              <Trash2 className="h-4 w-4" />
              清空当前会话
            </Button>
            {recoveryMessage && (
              <p className="text-xs text-muted-foreground">{recoveryMessage}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsRecoveryDialogOpen(false)}
              disabled={recoveryActionBusy}
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
