import type { UserMapping } from '../types/index.js';

/**
 * Unified user mapping - maps names to both Monday.com and Slack IDs
 * This eliminates the need for separate lookups and API calls
 *
 * To add a new user:
 * 1. Get their Monday.com user ID from the Monday admin panel
 * 2. Get their Slack member ID (click on their profile -> "Copy member ID")
 * 3. Add their email for fallback lookups
 */
export const USER_MAPPINGS: UserMapping[] = [
  {
    name: 'dayna',
    mondayId: 52969342,
    slackId: '', // TODO: Add Slack ID
    email: '',   // TODO: Add email
  },
  {
    name: 'ruzzell',
    mondayId: 60625739,
    slackId: '', // TODO: Add Slack ID
    email: '',   // TODO: Add email
  },
  {
    name: 'garet',
    mondayId: 63291818,
    slackId: '', // TODO: Add Slack ID
    email: '',   // TODO: Add email
  },
  {
    name: 'elia',
    mondayId: 75370319,
    slackId: '', // TODO: Add Slack ID
    email: '',   // TODO: Add email
  },
  {
    name: 'eliana',
    mondayId: 72940829,
    slackId: '', // TODO: Add Slack ID
    email: '',   // TODO: Add email
  },
  {
    name: 'chinedu',
    mondayId: 67009895,
    slackId: '', // TODO: Add Slack ID
    email: '',   // TODO: Add email
  },
];

/**
 * Find user by name (case-insensitive, handles @ prefix)
 */
export function findUserByName(name: string): UserMapping | undefined {
  const normalizedName = name.toLowerCase().trim().replace(/^@/, '');
  return USER_MAPPINGS.find(u => u.name.toLowerCase() === normalizedName);
}

/**
 * Find user by Monday.com ID
 */
export function findUserByMondayId(mondayId: number): UserMapping | undefined {
  return USER_MAPPINGS.find(u => u.mondayId === mondayId);
}

/**
 * Find user by email
 */
export function findUserByEmail(email: string): UserMapping | undefined {
  const normalizedEmail = email.toLowerCase().trim();
  return USER_MAPPINGS.find(u => u.email.toLowerCase() === normalizedEmail);
}
