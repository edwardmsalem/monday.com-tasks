/**
 * Workflow Re-export Module
 *
 * This module re-exports all workflow functions for backward compatibility.
 * The actual implementations are now in the workflows/ directory:
 * - workflows/emailWorkflow.ts - Email forwarding workflow
 * - workflows/slackTaskWorkflow.ts - Slack /task command workflow
 * - workflows/emailTaskWorkflow.ts - Gmail /emailtask command workflow
 * - workflows/intentModes.ts - Intent-driven mode detection
 * - workflows/shared.ts - Shared utilities
 */

// Re-export intent mode functions for backward compatibility
export {
  RELOCATION_CHECKLIST,
  isRelocationTask,
  isExclusivePresaleTask,
  createRelocationSubitems,
  applyIntentDrivenMode,
  type RelocationChecklistResult,
} from './workflows/intentModes.js';

// Re-export email workflow functions for backward compatibility
export {
  executeWorkflow,
  executeWorkflowSafe,
  type WorkflowInput,
} from './workflows/emailWorkflow.js';

// Re-export Slack task workflow functions for backward compatibility
export {
  parseSlackTaskInput,
  executeSlackTaskWorkflow,
  executeSlackTaskWorkflowSafe,
  executeAISlackTaskWorkflow,
  executeAISlackTaskWorkflowSafe,
  type SlackTaskInput,
  type ParsedSlackTask,
  type SlackTaskWorkflowInput,
  type AISlackTaskInput,
} from './workflows/slackTaskWorkflow.js';

// Re-export email task workflow functions for backward compatibility
export {
  executeEmailTaskWorkflow,
  executeEmailTaskWorkflowSafe,
  type EmailTaskInput,
} from './workflows/emailTaskWorkflow.js';

