/**
 * Shared utilities for workflow modules
 *
 * Contains common functions and types used across all workflow types:
 * - Email forwarding workflow
 * - Slack /task workflow
 * - Gmail /emailtask workflow
 */

import type { Priority } from '../types/index.js';

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
