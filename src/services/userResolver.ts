/**
 * Dynamic User Resolution Service
 *
 * Fetches users from Monday.com and Slack, matches them by email,
 * and provides intelligent name-based lookup.
 *
 * No more hardcoded user IDs!
 */

import * as monday from './monday.js';
import * as slack from './slack.js';
import type { MondayUser } from '../types/index.js';
import type { SlackUser } from './slack.js';

export interface UnifiedUser {
  name: string;           // Primary name (from Monday)
  email: string;          // Email (used to match Monday + Slack)
  mondayId: number;       // Monday.com user ID
  slackId: string | null; // Slack user ID (null if not found)
  slackName: string | null; // Slack username
}

// Cache for users - refreshed periodically
let userCache: UnifiedUser[] = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load and merge users from Monday.com and Slack
 */
async function loadUsers(): Promise<UnifiedUser[]> {
  console.log('Loading users from Monday.com and Slack...');

  // Fetch from both services in parallel
  const [mondayUsers, slackUsers] = await Promise.all([
    monday.getAllUsers(),
    slack.getAllUsers(),
  ]);

  console.log(`Found ${mondayUsers.length} Monday users, ${slackUsers.length} Slack users`);

  // Build a map of Slack users by email for quick lookup
  const slackByEmail = new Map<string, SlackUser>();
  for (const user of slackUsers) {
    if (user.email) {
      slackByEmail.set(user.email.toLowerCase(), user);
    }
  }

  // Merge users - Monday is primary, match Slack by email
  const unifiedUsers: UnifiedUser[] = [];

  for (const mondayUser of mondayUsers) {
    if (!mondayUser.email) continue;

    const email = mondayUser.email.toLowerCase();
    const slackUser = slackByEmail.get(email);

    unifiedUsers.push({
      name: mondayUser.name,
      email: mondayUser.email,
      mondayId: typeof mondayUser.id === 'string' ? parseInt(mondayUser.id, 10) : mondayUser.id,
      slackId: slackUser?.id ?? null,
      slackName: slackUser?.name ?? null,
    });
  }

  console.log(`Merged ${unifiedUsers.length} users`);
  console.log('Available users:', unifiedUsers.map(u => u.name).join(', '));

  return unifiedUsers;
}

/**
 * Get all users (cached)
 */
export async function getAllUsers(): Promise<UnifiedUser[]> {
  const now = Date.now();

  if (userCache.length === 0 || now - lastCacheUpdate > CACHE_TTL) {
    userCache = await loadUsers();
    lastCacheUpdate = now;
  }

  return userCache;
}

/**
 * Force refresh the user cache
 */
export async function refreshUserCache(): Promise<void> {
  userCache = await loadUsers();
  lastCacheUpdate = Date.now();
}

/**
 * Find a user by name using fuzzy matching
 *
 * Supports:
 * - Exact match (case-insensitive): "Dayna" → dayna
 * - First name match: "John" → "John Smith"
 * - Partial match: "day" → "Dayna"
 * - With @ prefix: "@dayna" → "Dayna"
 */
export async function findUserByName(name: string): Promise<UnifiedUser | null> {
  const users = await getAllUsers();
  const searchName = name.toLowerCase().trim().replace(/^@/, '');

  // Try exact match first
  let match = users.find(u => u.name.toLowerCase() === searchName);
  if (match) return match;

  // Try first name match
  match = users.find(u => {
    const firstName = u.name.split(' ')[0].toLowerCase();
    return firstName === searchName;
  });
  if (match) return match;

  // Try partial match (name contains search term)
  match = users.find(u => u.name.toLowerCase().includes(searchName));
  if (match) return match;

  // Try Slack username match
  match = users.find(u => u.slackName?.toLowerCase() === searchName);
  if (match) return match;

  return null;
}

/**
 * Find a user by email
 */
export async function findUserByEmail(email: string): Promise<UnifiedUser | null> {
  const users = await getAllUsers();
  const searchEmail = email.toLowerCase().trim();

  return users.find(u => u.email.toLowerCase() === searchEmail) ?? null;
}

/**
 * Find a user by Monday.com ID
 */
export async function findUserByMondayId(mondayId: number): Promise<UnifiedUser | null> {
  const users = await getAllUsers();
  return users.find(u => u.mondayId === mondayId) ?? null;
}

/**
 * Get list of all user names (for Claude AI context)
 */
export async function getUserNames(): Promise<string[]> {
  const users = await getAllUsers();
  return users.map(u => u.name);
}

/**
 * Get user names as comma-separated string (for prompts)
 */
export async function getUserNamesString(): Promise<string> {
  const names = await getUserNames();
  return names.join(', ');
}
