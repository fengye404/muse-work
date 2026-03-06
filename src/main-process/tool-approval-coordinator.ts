/**
 * Tool Approval Coordinator — bridges SDK canUseTool callback to the renderer.
 *
 * When the SDK calls canUseTool, this coordinator:
 * 1. Sends an IPC event to the renderer with full tool details
 * 2. Waits for the user's structured response (allow/deny + optional permission updates)
 * 3. Returns the appropriate PermissionResult to the SDK
 */

import type { BrowserWindow } from 'electron';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ToolApprovalResponse } from '../types';
import { IPC_CHANNELS } from '../types';

const APPROVAL_TIMEOUT_MS = 120_000;

interface PendingApproval {
  resolve: (result: PermissionResult) => void;
  timer: ReturnType<typeof setTimeout>;
  input: Record<string, unknown>;
}

export class ToolApprovalCoordinator {
  private pendingApproval: PendingApproval | null = null;
  private readonly getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  /**
   * SDK canUseTool callback handler. Sends approval request to renderer,
   * waits for user response.
   */
  async requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      toolUseID: string;
      decisionReason?: string;
      blockedPath?: string;
    },
  ): Promise<PermissionResult> {
    if (this.pendingApproval) {
      this.resolvePending({ behavior: 'deny', message: 'Superseded by new request' });
    }

    const window = this.getWindow();
    if (!window || window.isDestroyed()) {
      return { behavior: 'allow' };
    }

    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApproval = null;
        resolve({ behavior: 'deny', message: 'Approval timed out' });
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApproval = { resolve, timer, input };

      const description = Object.entries(input)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join('\n');

      window.webContents.send(IPC_CHANNELS.TOOL_APPROVAL_REQUEST, {
        tool: toolName,
        input,
        description,
        toolUseID: options.toolUseID,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        suggestions: options.suggestions,
      });

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.resolvePending({ behavior: 'deny', message: 'Aborted' });
        }, { once: true });
      }
    });
  }

  /**
   * Called when renderer responds to an approval request.
   * Accepts a structured response with optional updatedPermissions.
   */
  respond(response: ToolApprovalResponse): void {
    if (!this.pendingApproval) return;

    const result: PermissionResult = response.approved
      ? {
          behavior: 'allow',
          updatedInput: this.pendingApproval.input,
          updatedPermissions: response.updatedPermissions as PermissionUpdate[] | undefined,
        }
      : { behavior: 'deny', message: 'User denied' };

    this.resolvePending(result);
  }

  dispose(): void {
    this.resolvePending({ behavior: 'deny', message: 'Coordinator disposed' });
  }

  private resolvePending(result: PermissionResult): void {
    if (!this.pendingApproval) return;
    clearTimeout(this.pendingApproval.timer);
    this.pendingApproval.resolve(result);
    this.pendingApproval = null;
  }
}
