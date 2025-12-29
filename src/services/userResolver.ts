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
import { USER_CACHE_TTL_MS } from '../config/constants.js';
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

  if (userCache.length === 0 || now - lastCacheUpdate > USER_CACHE_TTL_MS) {
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
 * Find a user by name using smart matching
 *
 * Priority order (highest to lowest):
 * 1. Exact full name match: "Elia Smith" → Elia Smith
 * 2. Exact first name match: "elia" → Elia Smith (not Eliana!)
 * 3. Slack username match: "esmith" → Elia Smith
 * 4. Partial match (prefers shorter names): "eli" → Elia over Eliana
 *
 * Handles @ prefix: "@elia" → Elia Smith
 */
export async function findUserByName(name: string): Promise<UnifiedUser | null> {
  const users = await getAllUsers();
  const searchName = name.toLowerCase().trim().replace(/^@/, '');

  if (!searchName) return null;

  // 1. Exact full name match (highest priority)
  let match = users.find(u => u.name.toLowerCase() === searchName);
  if (match) {
    console.log(`User match: exact full name "${searchName}" → ${match.name}`);
    return match;
  }

  // 2. Exact first name match (important: "elia" matches "Elia", not "Eliana")
  const firstNameMatches = users.filter(u => {
    const firstName = u.name.split(' ')[0].toLowerCase();
    return firstName === searchName;
  });
  if (firstNameMatches.length === 1) {
    console.log(`User match: exact first name "${searchName}" → ${firstNameMatches[0].name}`);
    return firstNameMatches[0];
  }
  if (firstNameMatches.length > 1) {
    // Multiple people with same first name - return first but warn
    console.warn(`Multiple users with first name "${searchName}": ${firstNameMatches.map(u => u.name).join(', ')}. Using first match.`);
    return firstNameMatches[0];
  }

  // 3. Exact Slack username match
  match = users.find(u => u.slackName?.toLowerCase() === searchName);
  if (match) {
    console.log(`User match: Slack username "${searchName}" → ${match.name}`);
    return match;
  }

  // 4. Partial match - but prefer shorter names to avoid "eli" → "Eliana" when "Elia" exists
  const partialMatches = users.filter(u => {
    const fullName = u.name.toLowerCase();
    const firstName = fullName.split(' ')[0];
    return firstName.startsWith(searchName) || fullName.includes(searchName);
  });

  if (partialMatches.length > 0) {
    // Sort by first name length (shorter = better match for partial)
    partialMatches.sort((a, b) => {
      const aFirst = a.name.split(' ')[0].length;
      const bFirst = b.name.split(' ')[0].length;
      return aFirst - bFirst;
    });

    if (partialMatches.length > 1) {
      console.warn(`Partial match "${searchName}" found multiple users: ${partialMatches.map(u => u.name).join(', ')}. Using shortest first name.`);
    }
    console.log(`User match: partial "${searchName}" → ${partialMatches[0].name}`);
    return partialMatches[0];
  }

  // 5. Fuzzy match - handle typos/nicknames like "romeo" → "Rommel"
  // Check for names that share a significant common prefix (at least 3 chars)
  const fuzzyMatches = users.filter(u => {
    const firstName = u.name.split(' ')[0].toLowerCase();
    // Find common prefix length
    let commonPrefixLen = 0;
    const minLen = Math.min(firstName.length, searchName.length);
    for (let i = 0; i < minLen; i++) {
      if (firstName[i] === searchName[i]) {
        commonPrefixLen++;
      } else {
        break;
      }
    }
    // Match if they share at least 3 characters of prefix
    return commonPrefixLen >= 3;
  });

  if (fuzzyMatches.length === 1) {
    console.log(`User match: fuzzy prefix "${searchName}" → ${fuzzyMatches[0].name}`);
    return fuzzyMatches[0];
  }
  if (fuzzyMatches.length > 1) {
    // Sort by how close the first name length is to search term
    fuzzyMatches.sort((a, b) => {
      const aFirst = a.name.split(' ')[0].length;
      const bFirst = b.name.split(' ')[0].length;
      return Math.abs(aFirst - searchName.length) - Math.abs(bFirst - searchName.length);
    });
    console.warn(`Fuzzy match "${searchName}" found multiple users: ${fuzzyMatches.map(u => u.name).join(', ')}. Using closest length match.`);
    return fuzzyMatches[0];
  }

  console.warn(`No user found matching "${searchName}"`);
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
 * Find a user by Slack ID
 */
export async function findUserBySlackId(slackId: string): Promise<UnifiedUser | null> {
  const users = await getAllUsers();
  return users.find(u => u.slackId === slackId) ?? null;
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
