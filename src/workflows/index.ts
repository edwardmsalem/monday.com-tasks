/**
 * Workflow Module Index
 *
 * Re-exports all workflow functions and types from their respective modules.
 * This is the canonical entry point for workflow functionality.
 */

// Shared utilities (priority mapping, logger)
export * from './shared.js';

// Intent-driven modes (Relocation, Presale detection)
export * from './intentModes.js';

// Email forwarding workflow (inbox → Monday/Slack)
export * from './emailWorkflow.js';

// Slack /task command workflow
export * from './slackTaskWorkflow.js';

// Gmail /emailtask command workflow
export * from './emailTaskWorkflow.js';
