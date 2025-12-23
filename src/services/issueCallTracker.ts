/**
 * Issue Call Tracker Service
 *
 * Tracks pending issue calls and handles:
 * - Auto-assigning supporter when someone reacts 👀 or replies
 * - Hourly @closers ping until claimed
 * - Persistence across restarts
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/environment.js';
import * as slack from './slack.js';
import * as monday from './monday.js';
import { findUserBySlackId } from './userResolver.js';

// @closers Slack group ID
export const CLOSERS_GROUP_ID = 'S07QVQVMQMB';

// Edward's Slack ID for escalation after 1 hour
const EDWARD_SLACK_ID = 'U0144K906KA';

// Ping intervals
const PING_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const ESCALATION_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour - when to start pinging Edward

export interface PendingIssueCall {
  mondayItemId: string;
  slackThreadTs: string;
  channelId: string;
  createdAt: number;
  lastPingAt?: number;
  claimed: boolean;
  claimedBy?: string;  // Slack user ID
  ownerSlackIds?: string[];  // Dayna + Ruzzell Slack IDs for pinging
}

// In-memory store of pending issue calls
const pendingIssueCalls = new Map<string, PendingIssueCall>();

// Persistence file path
const PERSISTENCE_FILE = path.join(process.cwd(), '.issue-calls.json');

/**
 * Load pending issue calls from disk
 */
function loadFromDisk(): void {
  try {
    if (fs.existsSync(PERSISTENCE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSISTENCE_FILE, 'utf-8'));
      for (const [key, value] of Object.entries(data)) {
        pendingIssueCalls.set(key, value as PendingIssueCall);
      }
      console.log(`Loaded ${pendingIssueCalls.size} pending issue calls from disk`);
    }
  } catch (error) {
    console.error('Failed to load issue calls from disk:', error);
  }
}

/**
 * Save pending issue calls to disk
 */
function saveToDisk(): void {
  try {
    const data: Record<string, PendingIssueCall> = {};
    for (const [key, value] of pendingIssueCalls.entries()) {
      data[key] = value;
    }
    fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Failed to save issue calls to disk:', error);
  }
}

/**
 * Register a new issue call for tracking
 */
export function registerIssueCall(issueCall: Omit<PendingIssueCall, 'claimed'>): void {
  const key = issueCall.slackThreadTs;
  pendingIssueCalls.set(key, {
    ...issueCall,
    claimed: false,
  });
  saveToDisk();
  console.log(`Registered issue call for tracking: ${key}`);
}

/**
 * Check if a thread is a pending issue call
 */
export function isPendingIssueCall(threadTs: string): boolean {
  const issueCall = pendingIssueCalls.get(threadTs);
  return !!issueCall && !issueCall.claimed;
}

/**
 * Get a pending issue call by thread timestamp
 */
export function getPendingIssueCall(threadTs: string): PendingIssueCall | undefined {
  return pendingIssueCalls.get(threadTs);
}

/**
 * Handle a reaction or reply to claim an issue call
 * Called from the relay events handler when we detect activity on an issue call thread
 */
export async function claimIssueCall(
  threadTs: string,
  claimerSlackId: string
): Promise<{ success: boolean; error?: string }> {
  const issueCall = pendingIssueCalls.get(threadTs);

  if (!issueCall) {
    return { success: false, error: 'Issue call not found' };
  }

  if (issueCall.claimed) {
    return { success: false, error: 'Issue call already claimed' };
  }

  // Look up the claimer
  const claimer = await findUserBySlackId(claimerSlackId);
  if (!claimer) {
    console.log(`Unknown user ${claimerSlackId} tried to claim issue call`);
    return { success: false, error: 'User not found in system' };
  }

  // Update Monday.com - add as supporter
  try {
    await monday.addSupporter(issueCall.mondayItemId, claimer.mondayId);
    console.log(`Added ${claimer.name} as supporter on Monday item ${issueCall.mondayItemId}`);
  } catch (error) {
    console.error('Failed to add supporter on Monday:', error);
    return { success: false, error: 'Failed to update Monday.com' };
  }

  // Mark as claimed
  issueCall.claimed = true;
  issueCall.claimedBy = claimerSlackId;
  saveToDisk();

  // Post confirmation to thread
  await slack.postToThread(
    issueCall.slackThreadTs,
    `✅ <@${claimerSlackId}> claimed this issue call and has been assigned as supporter.`,
    issueCall.channelId
  );

  console.log(`Issue call ${threadTs} claimed by ${claimer.name}`);
  return { success: true };
}

/**
 * Ping for all unclaimed issue calls
 * - Every 20 minutes: @closers + Dayna + Ruzzell
 * - After 1 hour: Also include Edward
 */
export async function pingUnclaimedIssueCalls(): Promise<{ pinged: number }> {
  const now = Date.now();
  let pingedCount = 0;

  for (const [threadTs, issueCall] of pendingIssueCalls.entries()) {
    // Skip if already claimed
    if (issueCall.claimed) continue;

    // Skip if pinged less than 20 minutes ago
    const lastPing = issueCall.lastPingAt || issueCall.createdAt;
    if (now - lastPing < PING_INTERVAL_MS) continue;

    // Calculate time since creation for escalation
    const timeSinceCreation = now - issueCall.createdAt;
    const shouldEscalateToEdward = timeSinceCreation >= ESCALATION_THRESHOLD_MS;

    // Build ping message
    const ownerMentions = (issueCall.ownerSlackIds || [])
      .map(id => `<@${id}>`)
      .join(' ');

    let message = `<!subteam^${CLOSERS_GROUP_ID}>`;
    if (ownerMentions) {
      message += ` ${ownerMentions}`;
    }
    if (shouldEscalateToEdward) {
      message += ` <@${EDWARD_SLACK_ID}>`;
    }
    message += ` This issue call is still waiting for someone to claim it. React with 👀 or reply to this thread to be assigned.`;

    // Send ping to thread
    try {
      await slack.postToThread(
        threadTs,
        message,
        issueCall.channelId
      );

      issueCall.lastPingAt = now;
      pingedCount++;
      console.log(`Pinged for unclaimed issue call ${threadTs} (escalated: ${shouldEscalateToEdward})`);
    } catch (error) {
      console.error(`Failed to ping for issue call ${threadTs}:`, error);
    }
  }

  if (pingedCount > 0) {
    saveToDisk();
  }

  return { pinged: pingedCount };
}

/**
 * Clean up old claimed issue calls (older than 7 days)
 */
export function cleanupOldIssueCalls(): void {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let cleaned = 0;

  for (const [key, issueCall] of pendingIssueCalls.entries()) {
    if (issueCall.claimed && now - issueCall.createdAt > SEVEN_DAYS) {
      pendingIssueCalls.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    saveToDisk();
    console.log(`Cleaned up ${cleaned} old issue calls`);
  }
}

/**
 * Initialize the issue call tracker
 * Call this at startup
 */
export function initializeIssueCallTracker(): void {
  loadFromDisk();

  // Run cleanup daily
  setInterval(cleanupOldIssueCalls, 24 * 60 * 60 * 1000);
}

/**
 * Get all pending (unclaimed) issue calls
 */
export function getAllPendingIssueCalls(): PendingIssueCall[] {
  return Array.from(pendingIssueCalls.values()).filter(ic => !ic.claimed);
}
