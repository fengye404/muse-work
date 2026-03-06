/**
 * Stream transformer: converts OpenAI SSE stream chunks into
 * Anthropic SSE event format.
 *
 * OpenAI streams: `data: {"choices":[{"delta":{...}}]}`
 * Anthropic streams: `event: <type>\ndata: {...}\n\n`
 *
 * This transformer maintains internal state to track content block
 * indices and accumulate tool call arguments across deltas.
 */

import { openAIFinishReasonToAnthropic } from './tool-transformer';
import type { OpenAIStreamChunk } from '../types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StreamTransformerOptions {
  model: string;
  requestId?: string;
}

/**
 * Stateful transformer that converts a sequence of OpenAI stream chunks
 * into Anthropic SSE event strings.
 */
export class OpenAIToAnthropicStreamTransformer {
  private contentBlockIndex = 0;
  private currentTextBlockOpen = false;
  private toolCallBlocks = new Map<number, { id: string; name: string; index: number }>();
  private messageStarted = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private model: string;
  private messageId: string;
  private pendingFinishReason: string | null = null;

  constructor(options: StreamTransformerOptions) {
    this.model = options.model;
    this.messageId = options.requestId ?? `msg_proxy_${Date.now()}`;
  }

  /**
   * Convert a single OpenAI chunk to zero or more Anthropic SSE event strings.
   * Returns an array because one OpenAI chunk can produce multiple Anthropic events.
   *
   * When finish_reason arrives, we defer the final message_delta/message_stop
   * events so that a subsequent usage-only chunk can be incorporated first.
   */
  transformChunk(chunk: OpenAIStreamChunk): string[] {
    const events: string[] = [];
    this.updateUsageFromChunk(chunk);

    if (!this.messageStarted) {
      events.push(this.emitMessageStart(chunk));
      this.messageStarted = true;
    }

    const choice = chunk.choices?.[0];

    if (!choice) {
      if (this.pendingFinishReason !== null && chunk.usage) {
        events.push(...this.emitFinalEvents());
      }
      return events;
    }

    const delta = choice.delta;

    if (delta.content != null && delta.content !== '') {
      if (!this.currentTextBlockOpen) {
        events.push(this.emitContentBlockStart('text'));
        this.currentTextBlockOpen = true;
      }
      events.push(this.emitTextDelta(delta.content));
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!this.toolCallBlocks.has(tc.index)) {
          if (this.currentTextBlockOpen) {
            events.push(this.emitContentBlockStop());
            this.currentTextBlockOpen = false;
          }

          const toolId = tc.id ?? `toolu_proxy_${this.contentBlockIndex}`;
          const toolName = tc.function?.name ?? '';
          this.toolCallBlocks.set(tc.index, {
            id: toolId,
            name: toolName,
            index: this.contentBlockIndex,
          });
          events.push(this.emitToolUseStart(toolId, toolName));
        }

        if (tc.function?.arguments) {
          const block = this.toolCallBlocks.get(tc.index)!;
          events.push(this.emitToolInputDelta(block.index, tc.function.arguments));
        }
      }
    }

    if (choice.finish_reason != null) {
      if (this.currentTextBlockOpen) {
        events.push(this.emitContentBlockStop());
        this.currentTextBlockOpen = false;
      }
      for (const [, block] of this.toolCallBlocks) {
        events.push(
          sseEvent('content_block_stop', { type: 'content_block_stop', index: block.index }),
        );
        this.contentBlockIndex++;
      }
      this.toolCallBlocks.clear();

      if (chunk.usage) {
        events.push(this.emitMessageDelta(choice.finish_reason));
        events.push(sseEvent('message_stop', { type: 'message_stop' }));
      } else {
        this.pendingFinishReason = choice.finish_reason;
      }
    }

    return events;
  }

  /**
   * Flush any deferred message_delta/message_stop events.
   * Must be called after the last chunk to handle providers that send
   * usage separately from finish_reason.
   */
  finalize(): string[] {
    return this.emitFinalEvents();
  }

  private emitFinalEvents(): string[] {
    if (this.pendingFinishReason === null) return [];
    const reason = this.pendingFinishReason;
    this.pendingFinishReason = null;
    return [
      this.emitMessageDelta(reason),
      sseEvent('message_stop', { type: 'message_stop' }),
    ];
  }

  // -------------------------------------------------------------------------
  // SSE event builders
  // -------------------------------------------------------------------------

  private emitMessageStart(chunk: OpenAIStreamChunk): string {
    return sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: chunk.model ?? this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: 0,
        },
      },
    });
  }

  private emitContentBlockStart(_type: 'text'): string {
    const event = sseEvent('content_block_start', {
      type: 'content_block_start',
      index: this.contentBlockIndex,
      content_block: { type: 'text', text: '' },
    });
    return event;
  }

  private emitTextDelta(text: string): string {
    return sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: this.contentBlockIndex,
      delta: { type: 'text_delta', text },
    });
  }

  private emitContentBlockStop(): string {
    const event = sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: this.contentBlockIndex,
    });
    this.contentBlockIndex++;
    return event;
  }

  private emitToolUseStart(id: string, name: string): string {
    const event = sseEvent('content_block_start', {
      type: 'content_block_start',
      index: this.contentBlockIndex,
      content_block: { type: 'tool_use', id, name, input: {} },
    });
    return event;
  }

  private emitToolInputDelta(blockIndex: number, partialJson: string): string {
    return sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    });
  }

  private emitMessageDelta(finishReason: string): string {
    return sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: openAIFinishReasonToAnthropic(finishReason) },
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
      },
    });
  }

  private updateUsageFromChunk(chunk: OpenAIStreamChunk): void {
    const usage = chunk.usage;
    if (!usage) return;

    const promptTokens = readNumber(usage, 'prompt_tokens', 'input_tokens');
    const completionTokens = readNumber(usage, 'completion_tokens', 'output_tokens');
    const totalTokens = readNumber(usage, 'total_tokens');

    if (typeof promptTokens === 'number') {
      this.inputTokens = promptTokens;
    }
    if (typeof completionTokens === 'number') {
      this.outputTokens = completionTokens;
    } else if (typeof totalTokens === 'number' && this.inputTokens > 0 && totalTokens >= this.inputTokens) {
      this.outputTokens = totalTokens - this.inputTokens;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sseEvent(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Parse a single `data: ...` line from an OpenAI SSE stream.
 * Returns null for `[DONE]` or unparseable lines.
 */
export function parseOpenAISSELine(line: string): OpenAIStreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data: ')) return null;
  const payload = trimmed.slice(6).trim();
  if (payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as OpenAIStreamChunk;
  } catch {
    return null;
  }
}
