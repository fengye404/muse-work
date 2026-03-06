/**
 * Lightweight HTTP reverse proxy that receives Anthropic Messages API
 * requests from the Claude Agent SDK and translates them to OpenAI
 * Chat Completions API before forwarding to the target provider.
 *
 * Runs on localhost with a random available port.
 */

import * as http from 'http';
import { anthropicRequestToOpenAI } from './transformers/message-transformer';
import {
  OpenAIToAnthropicStreamTransformer,
  parseOpenAISSELine,
} from './transformers/stream-transformer';
import type { AnthropicRequest } from './types';

export interface ProxyServerOptions {
  targetBaseURL: string;
  targetApiKey: string;
  modelMapping?: Record<string, string>;
}

export interface ProxyServerHandle {
  port: number;
  baseURL: string;
  stop: () => Promise<void>;
}

export async function startProxyServer(
  options: ProxyServerOptions,
): Promise<ProxyServerHandle> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, options).catch((err) => {
      console.error('[protocol-translator] Unhandled error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const port = addr.port;
      console.log(`[protocol-translator] Proxy listening on 127.0.0.1:${port}`);
      resolve({
        port,
        baseURL: `http://127.0.0.1:${port}`,
        stop: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ProxyServerOptions,
): Promise<void> {
  console.log(`[protocol-translator] ${req.method} ${req.url}`);

  // Accept both /v1/messages and /v1/messages?beta=true etc.
  if (req.method !== 'POST' || !req.url?.match(/^\/v1\/messages/)) {
    // Also accept the root path for health checks
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${req.url}` } }));
    return;
  }

  const body = await readBody(req);
  let anthropicReq: AnthropicRequest;
  try {
    anthropicReq = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
    return;
  }

  console.log(`[protocol-translator] model=${anthropicReq.model}, stream=${anthropicReq.stream}, messages=${anthropicReq.messages?.length ?? 0}`);

  if (options.modelMapping && options.modelMapping[anthropicReq.model]) {
    anthropicReq.model = options.modelMapping[anthropicReq.model];
  }

  const openAIReq = anthropicRequestToOpenAI(anthropicReq);

  const targetURL = normalizeBaseURL(options.targetBaseURL) + '/chat/completions';
  const isStream = anthropicReq.stream === true;

  console.log(`[protocol-translator] Forwarding to ${targetURL} (stream=${isStream})`);

  let fetchRes: Response;
  try {
    fetchRes = await forwardOpenAIRequest(targetURL, options.targetApiKey, openAIReq);
  } catch (err) {
    console.error('[protocol-translator] Fetch failed:', err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Failed to reach provider: ${err instanceof Error ? err.message : String(err)}`,
        },
      }),
    );
    return;
  }

  console.log(`[protocol-translator] Provider responded: ${fetchRes.status}`);

  if (!fetchRes.ok) {
    const initialErrorBody = await fetchRes.text();
    if (
      isStream
      && openAIReq.stream_options?.include_usage
      && looksLikeUnsupportedStreamOptions(fetchRes.status, initialErrorBody)
    ) {
      console.warn('[protocol-translator] Provider does not support stream_options.include_usage, retrying without it');
      const fallbackReq = { ...openAIReq };
      delete fallbackReq.stream_options;
      fetchRes = await forwardOpenAIRequest(targetURL, options.targetApiKey, fallbackReq);
      console.log(`[protocol-translator] Fallback provider response: ${fetchRes.status}`);
    } else {
      console.error(`[protocol-translator] Provider error ${fetchRes.status}:`, initialErrorBody);
      res.writeHead(fetchRes.status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: `Provider returned ${fetchRes.status}: ${initialErrorBody}`,
          },
        }),
      );
      return;
    }
  }

  if (!fetchRes.ok) {
    const fallbackErrorBody = await fetchRes.text();
    console.error(`[protocol-translator] Provider error ${fetchRes.status}:`, fallbackErrorBody);
    res.writeHead(fetchRes.status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Provider returned ${fetchRes.status}: ${fallbackErrorBody}`,
        },
      }),
    );
    return;
  }

  if (isStream) {
    await handleStreamResponse(fetchRes, res, anthropicReq.model);
  } else {
    await handleNonStreamResponse(fetchRes, res, anthropicReq.model);
  }
}

// ---------------------------------------------------------------------------
// Stream response handler
// ---------------------------------------------------------------------------

async function handleStreamResponse(
  fetchRes: Response,
  res: http.ServerResponse,
  model: string,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const transformer = new OpenAIToAnthropicStreamTransformer({ model });
  const reader = fetchRes.body?.getReader();
  if (!reader) {
    console.error('[protocol-translator] No readable body in stream response');
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;
  let eventCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const chunk = parseOpenAISSELine(line);
        if (!chunk) continue;
        chunkCount++;

        const sseEvents = transformer.transformChunk(chunk);
        for (const event of sseEvents) {
          eventCount++;
          res.write(event);
        }
      }
    }

    if (buffer.trim()) {
      const chunk = parseOpenAISSELine(buffer);
      if (chunk) {
        chunkCount++;
        const sseEvents = transformer.transformChunk(chunk);
        for (const event of sseEvents) {
          eventCount++;
          res.write(event);
        }
      }
    }

    const finalEvents = transformer.finalize();
    for (const event of finalEvents) {
      eventCount++;
      res.write(event);
    }

    console.log(`[protocol-translator] Stream complete: ${chunkCount} OpenAI chunks → ${eventCount} Anthropic events`);
  } catch (err) {
    console.error('[protocol-translator] Stream error:', err);
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Non-stream response handler
// ---------------------------------------------------------------------------

async function handleNonStreamResponse(
  fetchRes: Response,
  res: http.ServerResponse,
  model: string,
): Promise<void> {
  const openAIRes = (await fetchRes.json()) as Record<string, any>;
  const choice = openAIRes.choices?.[0];

  const contentBlocks: unknown[] = [];
  if (choice?.message?.content) {
    contentBlocks.push({ type: 'text', text: choice.message.content });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { raw: tc.function.arguments };
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const stopReasonMap: Record<string, string> = {
    stop: 'end_turn',
    tool_calls: 'tool_use',
    length: 'max_tokens',
  };

  const anthropicRes = {
    id: openAIRes.id ?? `msg_proxy_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
    model: openAIRes.model ?? model,
    stop_reason: stopReasonMap[choice?.finish_reason ?? 'stop'] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: openAIRes.usage?.prompt_tokens ?? 0,
      output_tokens: openAIRes.usage?.completion_tokens ?? 0,
    },
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(anthropicRes));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function normalizeBaseURL(url: string): string {
  let normalized = url.replace(/\/+$/, '');
  // Strip trailing /chat/completions if present (user may have pasted the full endpoint)
  normalized = normalized.replace(/\/chat\/completions$/, '');
  // Add /v1 only if the URL doesn't already end with a versioned path segment
  if (!normalized.match(/\/v\d+$/)) {
    normalized += '/v1';
  }
  return normalized;
}

async function forwardOpenAIRequest(
  targetURL: string,
  targetApiKey: string,
  payload: unknown,
): Promise<Response> {
  return fetch(targetURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${targetApiKey}`,
    },
    body: JSON.stringify(payload),
  });
}

function looksLikeUnsupportedStreamOptions(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const lowered = body.toLowerCase();
  return (
    lowered.includes('stream_options')
    || lowered.includes('include_usage')
    || (lowered.includes('unknown') && lowered.includes('stream'))
    || (lowered.includes('unsupported') && lowered.includes('stream'))
  );
}
