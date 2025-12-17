import type { TaskTypeMapping } from '../types/index.js';

/**
 * Task type mappings - maps various aliases to their display names
 * Used for the Monday.com status column
 */
export const TASK_TYPE_MAPPINGS: TaskTypeMapping[] = [
  {
    aliases: ['general'],
    displayName: 'General',
  },
  {
    aliases: ['pp', 'payment plan'],
    displayName: 'Payment Plan',
  },
  {
    aliases: ['refund'],
    displayName: 'Refund',
  },
  {
    aliases: ['decline'],
    displayName: 'Decline',
  },
  {
    aliases: ['revoked'],
    displayName: 'Revoked',
  },
  {
    aliases: ['renewal'],
    displayName: 'Renewal',
  },
  {
    aliases: ['relo', 'relocation'],
    displayName: 'Relocation',
  },
  {
    aliases: ['opp', 'opportunity'],
    displayName: 'Opportunity',
  },
  {
    aliases: ['ic', 'issue call'],
    displayName: 'Issue Call',
  },
];

/**
 * Default task type when no match is found
 */
export const DEFAULT_TASK_TYPE = 'General';

/**
 * Get the display name for a task type
 * @param rawType - The raw task type string from the email
 * @returns The formatted display name
 */
export function getTaskTypeDisplayName(rawType: string): string {
  const normalizedType = rawType.toLowerCase().trim();

  const mapping = TASK_TYPE_MAPPINGS.find(m =>
    m.aliases.some(alias => alias === normalizedType)
  );

  return mapping?.displayName ?? DEFAULT_TASK_TYPE;
}

/**
 * Get all valid task type aliases (for validation/help text)
 */
export function getAllTaskTypeAliases(): string[] {
  return TASK_TYPE_MAPPINGS.flatMap(m => m.aliases);
}

/**
 * Get all display names
 */
export function getAllTaskTypeDisplayNames(): string[] {
  return TASK_TYPE_MAPPINGS.map(m => m.displayName);
}
