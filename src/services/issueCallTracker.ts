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
  pingCount: number;  // Track how many pings sent
  claimed: boolean;
  claimedBy?: string;  // Slack user ID
  ownerSlackIds?: string[];  // Dayna + Ruzzell Slack IDs for pinging
  suggestedSupporterSlackId?: string;  // Mentioned user to ping first
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
 * If claimed/claimedBy are passed, the issue call starts as already claimed (no pings)
 */
type IssueCallRegistration = Omit<PendingIssueCall, 'claimed' | 'claimedBy' | 'pingCount'> & {
  claimed?: boolean;
  claimedBy?: string;
};

export function registerIssueCall(issueCall: IssueCallRegistration): void {
  const key = issueCall.slackThreadTs;
  const preClaimed = issueCall.claimed && issueCall.claimedBy;
  pendingIssueCalls.set(key, {
    ...issueCall,
    claimed: preClaimed ? true : false,
    claimedBy: preClaimed ? issueCall.claimedBy : undefined,
    pingCount: 0,
  });
  saveToDisk();
  console.log(`Registered issue call for tracking: ${key}${preClaimed ? ' (pre-claimed)' : ''}`);
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

  // Post confirmation to thread - this documents the claim permanently
  // Even if the user removes their 👀 reaction, this message stays
  console.log(`[IssueCallTracker] Posting claim confirmation for ${claimer.name} to thread ${issueCall.slackThreadTs}`);
  try {
    await slack.postToThread(
      issueCall.slackThreadTs,
      `✅ <@${claimerSlackId}> (${claimer.name}) claimed this issue call and has been assigned as supporter.`,
      issueCall.channelId
    );
    console.log(`[IssueCallTracker] Claim confirmation posted successfully`);
  } catch (postError) {
    console.error(`[IssueCallTracker] Failed to post claim confirmation:`, postError);
    // Don't fail the claim - it's already recorded in Monday and our tracker
  }

  console.log(`[IssueCallTracker] Issue call ${threadTs} claimed by ${claimer.name} (${claimerSlackId})`);
  return { success: true };
}

/**
 * Check if current time is within business hours
 * Business hours: Monday-Friday, 10am-6pm Eastern Time
 */
function isBusinessHours(): boolean {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

  const dayOfWeek = eastern.getDay(); // 0 = Sunday, 6 = Saturday
  const hour = eastern.getHours();

  // Skip weekends
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }

  // Skip outside 10am-6pm
  if (hour < 10 || hour >= 18) {
    return false;
  }

  return true;
}

/**
 * Ping for all unclaimed issue calls
 * - First ping: @suggested_supporter only (if mentioned in command)
 * - Second ping onward: @dayna + @ruzzell
 * - After 1 hour: Also include @edward
 */
export async function pingUnclaimedIssueCalls(): Promise<{ pinged: number; removed: number }> {
  // Only ping during business hours (M-F 10am-6pm ET)
  if (!isBusinessHours()) {
    return { pinged: 0, removed: 0 };
  }

  const now = Date.now();
  let pingedCount = 0;
  let removedCount = 0;
  const toRemove: string[] = [];

  for (const [threadTs, issueCall] of pendingIssueCalls.entries()) {
    // Skip if already claimed
    if (issueCall.claimed) continue;

    // Skip if pinged less than 20 minutes ago
    const lastPing = issueCall.lastPingAt || issueCall.createdAt;
    if (now - lastPing < PING_INTERVAL_MS) continue;

    // Calculate time since creation for escalation
    const timeSinceCreation = now - issueCall.createdAt;
    const shouldEscalateToEdward = timeSinceCreation >= ESCALATION_THRESHOLD_MS;

    // Build ping message based on ping count
    let mentions: string;

    if (issueCall.pingCount === 0 && issueCall.suggestedSupporterSlackId) {
      // First ping: just the suggested supporter
      mentions = `<@${issueCall.suggestedSupporterSlackId}>`;
    } else {
      // Second ping onward: Dayna + Ruzzell
      mentions = (issueCall.ownerSlackIds || [])
        .map(id => `<@${id}>`)
        .join(' ');
    }

    // Add Edward after 1 hour
    if (shouldEscalateToEdward) {
      mentions += ` <@${EDWARD_SLACK_ID}>`;
    }

    const message = `${mentions} This issue call is still waiting for someone to claim it. React with 👀 or reply to this thread to be assigned.`;

    // Send ping to thread
    try {
      await slack.postToThread(
        threadTs,
        message,
        issueCall.channelId
      );

      issueCall.lastPingAt = now;
      issueCall.pingCount = (issueCall.pingCount || 0) + 1;
      pingedCount++;
      console.log(`Pinged for unclaimed issue call ${threadTs} (ping #${issueCall.pingCount}, escalated: ${shouldEscalateToEdward})`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStr = JSON.stringify(error);

      // Check if this is a "thread deleted" or "channel not found" error
      const isDeletedError =
        errorMessage.includes('channel_not_found') ||
        errorMessage.includes('message_not_found') ||
        errorMessage.includes('thread_not_found') ||
        errorMessage.includes('not_in_channel') ||
        errorMessage.includes('is_archived') ||
        errorStr.includes('channel_not_found') ||
        errorStr.includes('message_not_found') ||
        errorStr.includes('thread_not_found');

      if (isDeletedError) {
        console.log(`[IssueCallTracker] Thread ${threadTs} appears deleted, removing from tracking`);
        toRemove.push(threadTs);
        removedCount++;
      } else {
        console.error(`Failed to ping for issue call ${threadTs}:`, error);
      }
    }
  }

  // Remove deleted issue calls
  for (const threadTs of toRemove) {
    pendingIssueCalls.delete(threadTs);
  }

  if (pingedCount > 0 || removedCount > 0) {
    saveToDisk();
  }

  if (removedCount > 0) {
    console.log(`[IssueCallTracker] Removed ${removedCount} issue calls with deleted threads`);
  }

  return { pinged: pingedCount, removed: removedCount };
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
 * Remove an issue call from tracking by thread timestamp
 * Use this to manually clean up deleted/orphaned issue calls
 */
export function removeIssueCall(threadTs: string): boolean {
  if (pendingIssueCalls.has(threadTs)) {
    pendingIssueCalls.delete(threadTs);
    saveToDisk();
    console.log(`[IssueCallTracker] Manually removed issue call ${threadTs}`);
    return true;
  }
  return false;
}

/**
 * Clear all pending (unclaimed) issue calls
 * Use this to reset the tracker after cleanup
 */
export function clearAllPendingIssueCalls(): number {
  let cleared = 0;
  for (const [key, issueCall] of pendingIssueCalls.entries()) {
    if (!issueCall.claimed) {
      pendingIssueCalls.delete(key);
      cleared++;
    }
  }
  if (cleared > 0) {
    saveToDisk();
    console.log(`[IssueCallTracker] Cleared ${cleared} pending issue calls`);
  }
  return cleared;
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

/**
 * Check if a thread is an issue call (claimed or not)
 */
export function isIssueCall(threadTs: string): boolean {
  return pendingIssueCalls.has(threadTs);
}

/**
 * Get an issue call by thread timestamp (claimed or not)
 */
export function getIssueCall(threadTs: string): PendingIssueCall | undefined {
  return pendingIssueCalls.get(threadTs);
}

/**
 * Mark an issue call as complete via ✅ reaction
 * This also claims it if not already claimed
 */
export async function completeIssueCall(
  threadTs: string,
  completerSlackId: string
): Promise<{ success: boolean; error?: string }> {
  const issueCall = pendingIssueCalls.get(threadTs);

  if (!issueCall) {
    return { success: false, error: 'Issue call not found' };
  }

  // If not claimed yet, claim it first
  if (!issueCall.claimed) {
    const claimer = await findUserBySlackId(completerSlackId);
    if (claimer) {
      try {
        await monday.addSupporter(issueCall.mondayItemId, claimer.mondayId);
        console.log(`Added ${claimer.name} as supporter on Monday item ${issueCall.mondayItemId}`);
      } catch (error) {
        console.error('Failed to add supporter on Monday:', error);
      }
    }
    issueCall.claimed = true;
    issueCall.claimedBy = completerSlackId;
  }

  saveToDisk();

  // Post completion confirmation to thread
  const completer = issueCall.claimedBy === completerSlackId
    ? `<@${completerSlackId}>`
    : `<@${completerSlackId}> (claimed by <@${issueCall.claimedBy}>)`;

  await slack.postToThread(
    issueCall.slackThreadTs,
    `✅ Issue call marked complete by ${completer}.`,
    issueCall.channelId
  );

  console.log(`Issue call ${threadTs} marked complete by ${completerSlackId}`);
  return { success: true };
}
