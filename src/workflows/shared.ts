/**
 * Shared utilities for workflow modules
 *
 * Contains common functions and types used across all workflow types:
 * - Email forwarding workflow
 * - Slack /task workflow
 * - Gmail /emailtask workflow
 */

import type { Priority, WorkflowResult } from '../types/index.js';
import * as slack from '../services/slack.js';
import * as monday from '../services/monday.js';
import { applyIntentDrivenMode } from './intentModes.js';

/**
 * Map Claude priority to Monday urgency label
 */
export function mapPriorityToUrgency(priority: Priority): 'High' | 'Medium' | 'Low' {
  switch (priority) {
    case 'high': return 'High';
    case 'medium': return 'Medium';
    case 'low': return 'Low';
    default: return 'Medium';
  }
}

/**
 * Logger interface for workflow tracing
 */
export interface WorkflowLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Create a logger prefixed with Run ID for tracing
 */
export function createLogger(runId: string): WorkflowLogger {
  const prefix = `[${runId.substring(0, 8)}]`;
  return {
    log: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

/**
 * Post Run ID to Slack thread for tracing
 */
export async function postRunIdToSlack(slackThreadTs: string, runId: string): Promise<void> {
  await slack.postToThread(slackThreadTs, `🔗 _Run ID: ${runId.substring(0, 8)}_`);
}

/**
 * Apply intent-driven mode with logging and Monday update
 * Wraps applyIntentDrivenMode with error handling and update posting
 */
export async function applyIntentModeWithLogging(
  mondayItemId: string,
  taskType: string,
  taskName: string,
  log: WorkflowLogger
): Promise<void> {
  try {
    const intentMode = await applyIntentDrivenMode(mondayItemId, taskType, taskName, log);
    if (intentMode.mode !== 'none' && intentMode.actions.length > 0) {
      const intentUpdate = `🎯 *${intentMode.mode.charAt(0).toUpperCase() + intentMode.mode.slice(1)} Mode*\n${intentMode.actions.map(a => `• ${a}`).join('\n')}`;
      await monday.createUpdate(mondayItemId, intentUpdate);
    }
  } catch (error) {
    log.error('Intent-driven mode failed (non-fatal):', error);
  }
}

/**
 * Create a failed workflow result
 */
export function createFailedResult(errorMessage: string, runId: string): WorkflowResult {
  return {
    mondayItemId: '',
    slackThreadTs: '',
    success: false,
    error: errorMessage,
    runId,
  };
}
