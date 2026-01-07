/**
 * Digest Service
 *
 * Core functions for sending all digest types.
 * Queries Monday.com for tasks and sends formatted Slack messages.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config } from '../config/environment.js';
import { getClient } from './slack.js';
import * as blockKit from './blockKit.js';
import * as digestState from './digestState.js';
import * as workingHours from './workingHours.js';

// ============================================================================
// Constants
// ============================================================================

// User schedule overrides (Dayna gets digest at 12 PM instead of 10 AM)
export const USER_SCHEDULE_OVERRIDES: { [userId: string]: { morningDigestHour: number } } = {
  U05BRER83HT: { morningDigestHour: 12 }, // Dayna
};

export const DEFAULT_MORNING_DIGEST_HOUR = 10;

// Escalation recipients
export const ESCALATION_CONFIG = {
  regularTasks: {
    first: {
      hour: 12, // 12 PM EST
      recipients: ['U04CFCNAN4Q', 'U08FY4FAJ9J'], // Garet, Eliana
    },
    final: {
      hour: 13.5, // 1:30 PM EST
      recipients: ['U0144K906KA'], // Edward
    },
  },
  issueCalls: {
    claiming: {
      first: {
        afterMinutes: 60,
        recipients: ['U072TG6N57A', 'U05BRER83HT'], // Ruzzell, Dayna
      },
      final: {
        afterMinutes: 120,
        recipients: ['U0144K906KA', 'U08M6BP6X3N'], // Edward, Elia
      },
    },
    completion: {
      first: {
        hoursBeforeDeadline: 4,
        recipients: ['U072TG6N57A', 'U05BRER83HT'], // Ruzzell, Dayna
      },
      final: {
        hoursBeforeDeadline: 2,
        recipients: ['U0144K906KA', 'U08M6BP6X3N'], // Edward, Elia
      },
    },
  },
};

// Channels
export const CHANNELS = {
  issueCall: 'C07JS45GTQC', // Issue call digests (@closers)
  teamOverview: 'C08QCFC4Y0H', // Team overview (all task types)
};

// ============================================================================
// Monday.com Query Helpers
// ============================================================================

interface MondayTask {
  id: string;
  name: string;
  dueDate: Date | null;
  workflowStatus: string | null;
  taskType: string | null;
  slackThreadTs: string | null;
  channelId: string;
  ownerIds: string[];
  ownerNames: string[];
}

/**
 * Fetch all open tasks from Monday.com
 * Excludes completed/done tasks
 */
async function fetchOpenTasks(): Promise<MondayTask[]> {
  // Dynamic import to avoid circular dependency
  const monday = await import('./monday.js');

  const query = `
    query GetOpenTasks($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: config.monday.apiToken,
        'API-Version': '2024-10',
      },
      body: JSON.stringify({
        query,
        variables: { boardId: config.monday.boardId },
      }),
    });

    const result = (await response.json()) as any;
    const items = result.data?.boards?.[0]?.items_page?.items ?? [];
    const tasks: MondayTask[] = [];

    for (const item of items) {
      const getValue = (colId: string): string | null => {
        const col = item.column_values.find((c: any) => c.id === colId);
        return col?.text || null;
      };

      const getRawValue = (colId: string): string | null => {
        const col = item.column_values.find((c: any) => c.id === colId);
        return col?.value || null;
      };

      const workflowStatus = getValue(config.monday.columns.workflowStatus);

      // Skip completed/done tasks
      const statusLower = workflowStatus?.toLowerCase() ?? '';
      if (statusLower === 'done' || statusLower === 'complete') {
        continue;
      }

      // Parse due date
      const dueDateStr = getValue(config.monday.columns.date);
      let dueDate: Date | null = null;
      if (dueDateStr) {
        dueDate = workingHours.parseDate(dueDateStr);
      }

      // Parse owners
      let ownerIds: string[] = [];
      let ownerNames: string[] = [];
      const ownerRaw = getRawValue(config.monday.columns.owner);
      const ownerText = getValue(config.monday.columns.owner);

      if (ownerRaw) {
        try {
          const parsed = JSON.parse(ownerRaw);
          ownerIds = parsed?.personsAndTeams?.map((p: { id: number }) => String(p.id)) ?? [];
        } catch {
          // Ignore parse errors
        }
      }
      if (ownerText) {
        ownerNames = ownerText.split(',').map((n: string) => n.trim());
      }

      // Parse Slack thread info
      const slackThreadRaw = getValue(config.monday.columns.slackThreadId);
      let slackThreadTs: string | null = null;
      let channelId = config.slack.channelId;

      if (slackThreadRaw) {
        const parsed = monday.parseSlackThreadValue(slackThreadRaw);
        if (parsed) {
          slackThreadTs = parsed.threadTs;
          channelId = parsed.channelId;
        }
      }

      tasks.push({
        id: item.id,
        name: item.name,
        dueDate,
        workflowStatus,
        taskType: getValue(config.monday.columns.type),
        slackThreadTs,
        channelId,
        ownerIds,
        ownerNames,
      });
    }

    return tasks;
  } catch (error) {
    console.error('[Digest] Error fetching tasks from Monday:', error);
    return [];
  }
}

/**
 * Convert Monday tasks to DigestTask format
 */
function toDigestTask(task: MondayTask, isConfirmed: boolean = false): blockKit.DigestTask {
  return {
    id: task.id,
    name: task.name,
    dueDate: task.dueDate ?? new Date(),
    workflowStatus: task.workflowStatus,
    taskType: task.taskType,
    slackThreadTs: task.slackThreadTs,
    channelId: task.channelId,
    ownerNames: task.ownerNames,
    isConfirmed,
  };
}

/**
 * Categorize tasks by due date
 */
function categorizeTasks(
  tasks: MondayTask[],
  now: Date = new Date()
): blockKit.TasksByCategory {
  const today = workingHours.getESTDateString(now);
  const overdue: blockKit.DigestTask[] = [];
  const dueToday: blockKit.DigestTask[] = [];
  const thisWeek: blockKit.DigestTask[] = [];

  for (const task of tasks) {
    if (!task.dueDate) continue;

    const taskDateStr = workingHours.getESTDateString(task.dueDate);
    const isConfirmed = digestState.isTaskConfirmed(task.id);

    if (taskDateStr < today) {
      // Overdue
      overdue.push(toDigestTask(task, isConfirmed));
    } else if (taskDateStr === today) {
      // Due today
      dueToday.push(toDigestTask(task, isConfirmed));
    } else if (workingHours.isWithinDays(task.dueDate, 7, now)) {
      // This week (next 7 days)
      thisWeek.push(toDigestTask(task, isConfirmed));
    }
  }

  // Sort by date
  overdue.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  dueToday.sort((a, b) => a.name.localeCompare(b.name));
  thisWeek.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  return { overdue, dueToday, thisWeek };
}

// ============================================================================
// Slack User Mapping
// ============================================================================

// Cache for Monday ID -> Slack ID mapping
let userMappingCache: Map<string, string> | null = null;

/**
 * Get Slack user ID from Monday person ID
 * Uses cached mapping or fetches from Slack
 */
async function getSlackUserIdFromMondayId(mondayId: string): Promise<string | null> {
  if (!userMappingCache) {
    // Build cache from Slack users and Monday users
    // This is a simplified version - in production you'd want
    // to match by email or have an explicit mapping
    userMappingCache = new Map();

    try {
      const slack = await import('./slack.js');
      const monday = await import('./monday.js');

      const slackUsers = await slack.getAllUsers();
      const mondayUsers = await monday.getAllUsers();

      // Match by email
      for (const mondayUser of mondayUsers) {
        if (mondayUser.email) {
          const slackUser = slackUsers.find(
            (u) => u.email?.toLowerCase() === mondayUser.email?.toLowerCase()
          );
          if (slackUser) {
            userMappingCache.set(String(mondayUser.id), slackUser.id);
          }
        }
      }

      console.log(`[Digest] Built user mapping cache: ${userMappingCache.size} users`);
    } catch (error) {
      console.error('[Digest] Error building user mapping:', error);
    }
  }

  return userMappingCache.get(mondayId) ?? null;
}

/**
 * Get user's first name from Slack
 */
async function getFirstName(slackUserId: string): Promise<string> {
  try {
    const client = getClient();
    const response = await client.users.info({ user: slackUserId });
    const realName = response.user?.real_name ?? response.user?.name ?? 'there';
    return realName.split(' ')[0]; // First name only
  } catch {
    return 'there';
  }
}

// ============================================================================
// DM Functions
// ============================================================================

/**
 * Send a DM to a user
 */
async function sendDM(
  userId: string,
  text: string,
  blocks?: any[]
): Promise<{ channel: string; ts: string } | null> {
  try {
    const client = getClient();

    // Open DM channel
    const openResponse = await client.conversations.open({
      users: userId,
    });

    if (!openResponse.ok || !openResponse.channel?.id) {
      console.error(`[Digest] Failed to open DM with ${userId}`);
      return null;
    }

    const channelId = openResponse.channel.id;

    // Send message
    const msgResponse = await client.chat.postMessage({
      channel: channelId,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });

    if (!msgResponse.ok || !msgResponse.ts) {
      console.error(`[Digest] Failed to send DM to ${userId}`);
      return null;
    }

    return { channel: channelId, ts: msgResponse.ts };
  } catch (error) {
    console.error(`[Digest] Error sending DM to ${userId}:`, error);
    return null;
  }
}

/**
 * Send a message to a channel
 */
async function sendToChannel(
  channelId: string,
  text: string,
  blocks?: any[]
): Promise<{ channel: string; ts: string } | null> {
  try {
    const client = getClient();

    const response = await client.chat.postMessage({
      channel: channelId,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });

    if (!response.ok || !response.ts) {
      console.error(`[Digest] Failed to send to channel ${channelId}`);
      return null;
    }

    return { channel: channelId, ts: response.ts };
  } catch (error) {
    console.error(`[Digest] Error sending to channel ${channelId}:`, error);
    return null;
  }
}

// ============================================================================
// Personal Morning Digest
// ============================================================================

/**
 * Send personal morning digest to a user
 */
export async function sendPersonalDigest(slackUserId: string): Promise<boolean> {
  console.log(`[Digest] Sending personal digest to ${slackUserId}`);

  try {
    // Get all tasks
    const allTasks = await fetchOpenTasks();

    // Filter to this user's tasks
    const userMondayIds: string[] = [];
    for (const [mondayId, slackId] of userMappingCache?.entries() ?? []) {
      if (slackId === slackUserId) {
        userMondayIds.push(mondayId);
      }
    }

    // Also build mapping if not cached
    if (userMondayIds.length === 0) {
      await getSlackUserIdFromMondayId('0'); // Force cache build
      for (const [mondayId, slackId] of userMappingCache?.entries() ?? []) {
        if (slackId === slackUserId) {
          userMondayIds.push(mondayId);
        }
      }
    }

    const userTasks = allTasks.filter((task) =>
      task.ownerIds.some((id) => userMondayIds.includes(id))
    );

    // Skip if user has no tasks
    if (userTasks.length === 0) {
      console.log(`[Digest] No tasks for ${slackUserId}, skipping digest`);
      return true;
    }

    // Categorize tasks
    const categorized = categorizeTasks(userTasks);

    // Get user's first name
    const firstName = await getFirstName(slackUserId);

    // Build blocks
    const blocks = blockKit.buildPersonalDigestBlocks(firstName, categorized);

    // Send DM
    const result = await sendDM(
      slackUserId,
      `Good morning ${firstName}! Here's your week:`,
      blocks
    );

    if (result) {
      // Save message reference for updates
      const key = digestState.getDigestMessageKey('morning', slackUserId);
      digestState.saveDigestMessage(key, result.channel, result.ts);
      console.log(`[Digest] Personal digest sent to ${slackUserId}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`[Digest] Error sending personal digest to ${slackUserId}:`, error);
    return false;
  }
}

/**
 * Send morning digests to all users with tasks
 */
export async function sendAllMorningDigests(): Promise<number> {
  console.log('[Digest] Starting morning digest run...');

  // Reset state for new day if needed
  digestState.checkAndResetForNewDay();

  // Get all tasks
  const allTasks = await fetchOpenTasks();

  // Get unique Slack user IDs from task owners
  const userSlackIds = new Set<string>();

  for (const task of allTasks) {
    for (const mondayId of task.ownerIds) {
      const slackId = await getSlackUserIdFromMondayId(mondayId);
      if (slackId) {
        userSlackIds.add(slackId);
      }
    }
  }

  console.log(`[Digest] Found ${userSlackIds.size} users with tasks`);

  let sent = 0;
  const currentHour = workingHours.getESTHour();

  for (const slackUserId of userSlackIds) {
    // Check if this user should get digest now (based on custom schedule)
    const userSchedule = USER_SCHEDULE_OVERRIDES[slackUserId];
    const userDigestHour = userSchedule?.morningDigestHour ?? DEFAULT_MORNING_DIGEST_HOUR;

    if (currentHour !== userDigestHour) {
      console.log(`[Digest] Skipping ${slackUserId} (digest hour is ${userDigestHour}, current is ${currentHour})`);
      continue;
    }

    const success = await sendPersonalDigest(slackUserId);
    if (success) {
      sent++;
    }

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log(`[Digest] Morning digest complete: ${sent}/${userSlackIds.size} sent`);
  return sent;
}

// ============================================================================
// Team Overview
// ============================================================================

/**
 * Send team overview to channel
 */
export async function sendTeamOverview(): Promise<boolean> {
  console.log('[Digest] Sending team overview...');

  try {
    // Get all tasks
    const allTasks = await fetchOpenTasks();
    const categorized = categorizeTasks(allTasks);

    // Build team status by user
    const userStats = new Map<string, blockKit.TeamMemberStatus>();

    for (const task of allTasks) {
      for (const ownerName of task.ownerNames) {
        if (!userStats.has(ownerName)) {
          userStats.set(ownerName, {
            userId: '',
            name: ownerName,
            overdueCount: 0,
            dueTodayCount: 0,
            unconfirmedCount: 0,
            weekCount: 0,
            oldestOverdueDays: 0,
          });
        }

        const stat = userStats.get(ownerName)!;
        stat.weekCount++;

        if (!task.dueDate) continue;

        const today = workingHours.getESTDateString();
        const taskDateStr = workingHours.getESTDateString(task.dueDate);

        if (taskDateStr < today) {
          stat.overdueCount++;
          const daysLate = workingHours.getDaysLate(task.dueDate);
          if (daysLate > stat.oldestOverdueDays) {
            stat.oldestOverdueDays = daysLate;
          }
        } else if (taskDateStr === today) {
          stat.dueTodayCount++;
          if (!digestState.isTaskConfirmed(task.id)) {
            stat.unconfirmedCount++;
          }
        }
      }
    }

    // Categorize team members
    const needsAttention: blockKit.TeamMemberStatus[] = [];
    const heavyLoad: blockKit.TeamMemberStatus[] = [];
    const onTrack: blockKit.TeamMemberStatus[] = [];

    for (const stat of userStats.values()) {
      if (stat.overdueCount > 0 || stat.unconfirmedCount > 0) {
        needsAttention.push(stat);
      } else if (stat.weekCount >= 5) {
        heavyLoad.push(stat);
      } else {
        onTrack.push(stat);
      }
    }

    // Sort
    needsAttention.sort((a, b) => b.overdueCount - a.overdueCount);
    heavyLoad.sort((a, b) => b.weekCount - a.weekCount);
    onTrack.sort((a, b) => a.name.localeCompare(b.name));

    // Issue call summary (simplified - actual implementation would query issue calls)
    const issueCallSummary = {
      overdueCount: 0,
      unclaimedCount: 0,
      dueTodayCount: 0,
    };

    // Count issue calls from tasks with type "Issue Call"
    for (const task of allTasks) {
      if (task.taskType === 'Issue Call') {
        if (!task.dueDate) continue;

        const today = workingHours.getESTDateString();
        const taskDateStr = workingHours.getESTDateString(task.dueDate);

        if (taskDateStr < today) {
          issueCallSummary.overdueCount++;
        } else if (taskDateStr === today) {
          issueCallSummary.dueTodayCount++;
        }

        // Check if unclaimed (no owners)
        if (task.ownerIds.length === 0) {
          issueCallSummary.unclaimedCount++;
        }
      }
    }

    const teamStatus: blockKit.TeamStatus = {
      needsAttention,
      heavyLoad,
      onTrack,
      issueCallSummary,
      totals: {
        total: allTasks.length,
        overdue: categorized.overdue.length,
        dueToday: categorized.dueToday.length,
      },
    };

    // Build blocks
    const blocks = blockKit.buildTeamOverviewBlocks(teamStatus);

    // Send to channel
    const result = await sendToChannel(
      CHANNELS.teamOverview,
      'Team Status Update',
      blocks
    );

    if (result) {
      const key = digestState.getDigestMessageKey('team');
      digestState.saveDigestMessage(key, result.channel, result.ts);
      console.log('[Digest] Team overview sent');
      return true;
    }

    return false;
  } catch (error) {
    console.error('[Digest] Error sending team overview:', error);
    return false;
  }
}

// ============================================================================
// Issue Call Digest
// ============================================================================

/**
 * Send issue call digest to channel
 */
export async function sendIssueCallDigest(): Promise<boolean> {
  console.log('[Digest] Sending issue call digest...');

  try {
    // Get all tasks and filter to Issue Calls
    const allTasks = await fetchOpenTasks();
    const issueCalls = allTasks.filter((t) => t.taskType === 'Issue Call');

    // Convert to IssueCall format
    const issueCallData: blockKit.IssueCall[] = issueCalls.map((task) => ({
      id: task.id,
      customerName: task.name.split(' - ')[0] ?? task.name,
      issue: task.name.split(' - ')[1] ?? '',
      dueDate: task.dueDate ?? new Date(),
      assignee: task.ownerNames[0] ?? null,
      assigneeSlackId: null, // Would need to look up
      slackThreadTs: task.slackThreadTs,
      channelId: task.channelId,
      isUnclaimed: task.ownerIds.length === 0,
      createdAt: new Date(), // Would need to get from Monday
    }));

    // Categorize
    const today = workingHours.getESTDateString();
    const categorized: blockKit.IssueCallsByCategory = {
      overdue: [],
      dueToday: [],
      thisWeek: [],
      unclaimed: [],
    };

    for (const ic of issueCallData) {
      const icDateStr = workingHours.getESTDateString(ic.dueDate);

      if (ic.isUnclaimed) {
        categorized.unclaimed.push(ic);
      }

      if (icDateStr < today) {
        categorized.overdue.push(ic);
      } else if (icDateStr === today) {
        categorized.dueToday.push(ic);
      } else if (workingHours.isWithinDays(ic.dueDate, 7)) {
        categorized.thisWeek.push(ic);
      }
    }

    // Build blocks
    const blocks = blockKit.buildIssueCallDigestBlocks(categorized);

    // Send to channel
    const result = await sendToChannel(
      CHANNELS.issueCall,
      'Issue Call Status',
      blocks
    );

    if (result) {
      const key = digestState.getDigestMessageKey('issue-call');
      digestState.saveDigestMessage(key, result.channel, result.ts);
      console.log('[Digest] Issue call digest sent');
      return true;
    }

    return false;
  } catch (error) {
    console.error('[Digest] Error sending issue call digest:', error);
    return false;
  }
}

// ============================================================================
// Tomorrow Prep
// ============================================================================

/**
 * Send tomorrow prep to a user
 */
export async function sendTomorrowPrep(slackUserId: string): Promise<boolean> {
  console.log(`[Digest] Sending tomorrow prep to ${slackUserId}`);

  try {
    // Get all tasks
    const allTasks = await fetchOpenTasks();

    // Filter to this user's tasks
    const userMondayIds: string[] = [];
    for (const [mondayId, slackId] of userMappingCache?.entries() ?? []) {
      if (slackId === slackUserId) {
        userMondayIds.push(mondayId);
      }
    }

    const userTasks = allTasks.filter((task) =>
      task.ownerIds.some((id) => userMondayIds.includes(id))
    );

    // Get tomorrow's tasks
    const tomorrow = workingHours.getTomorrow();
    const tomorrowStr = workingHours.getESTDateString(tomorrow);

    const tomorrowTasks = userTasks
      .filter((t) => t.dueDate && workingHours.getESTDateString(t.dueDate) === tomorrowStr)
      .map((t) => toDigestTask(t));

    // Get unacknowledged tasks from today
    const today = workingHours.getESTDateString();
    const unackedToday = userTasks
      .filter((t) => {
        if (!t.dueDate) return false;
        const dateStr = workingHours.getESTDateString(t.dueDate);
        if (dateStr !== today) return false;
        const status = t.workflowStatus?.toLowerCase() ?? '';
        return status !== 'acknowledged' && status !== 'working on it' && status !== 'done';
      })
      .map((t) => toDigestTask(t));

    // Skip if nothing to report
    if (tomorrowTasks.length === 0 && unackedToday.length === 0) {
      console.log(`[Digest] No tomorrow prep needed for ${slackUserId}`);
      return true;
    }

    // Check if it's Friday (tomorrow prep will be for Monday)
    const now = new Date();
    const isFriday = workingHours.getESTDayOfWeek(now) === 5;

    // Build blocks
    const blocks = blockKit.buildTomorrowPrepBlocks(tomorrowTasks, unackedToday, isFriday);

    // Send DM
    const dayLabel = isFriday ? 'Monday' : 'tomorrow';
    const result = await sendDM(
      slackUserId,
      `Wrapping up! Here's ${dayLabel}:`,
      blocks
    );

    if (result) {
      const key = digestState.getDigestMessageKey('tomorrow', slackUserId);
      digestState.saveDigestMessage(key, result.channel, result.ts);
      console.log(`[Digest] Tomorrow prep sent to ${slackUserId}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`[Digest] Error sending tomorrow prep to ${slackUserId}:`, error);
    return false;
  }
}

/**
 * Send tomorrow prep to all users with tasks
 */
export async function sendAllTomorrowPrep(): Promise<number> {
  console.log('[Digest] Starting tomorrow prep run...');

  // Get all tasks
  const allTasks = await fetchOpenTasks();

  // Get unique Slack user IDs from task owners
  const userSlackIds = new Set<string>();

  for (const task of allTasks) {
    for (const mondayId of task.ownerIds) {
      const slackId = await getSlackUserIdFromMondayId(mondayId);
      if (slackId) {
        userSlackIds.add(slackId);
      }
    }
  }

  let sent = 0;

  for (const slackUserId of userSlackIds) {
    const success = await sendTomorrowPrep(slackUserId);
    if (success) {
      sent++;
    }

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log(`[Digest] Tomorrow prep complete: ${sent}/${userSlackIds.size} sent`);
  return sent;
}

// ============================================================================
// Issue Call EOD
// ============================================================================

/**
 * Send issue call end of day summary
 */
export async function sendIssueCallEOD(): Promise<boolean> {
  console.log('[Digest] Sending issue call EOD...');

  try {
    // Get all Issue Call tasks
    const allTasks = await fetchOpenTasks();
    const issueCalls = allTasks.filter((t) => t.taskType === 'Issue Call');

    // Convert to IssueCall format and categorize
    const completed: blockKit.IssueCall[] = [];
    const carrying: blockKit.IssueCall[] = [];
    const unclaimed: blockKit.IssueCall[] = [];

    for (const task of issueCalls) {
      const ic: blockKit.IssueCall = {
        id: task.id,
        customerName: task.name.split(' - ')[0] ?? task.name,
        issue: task.name.split(' - ')[1] ?? '',
        dueDate: task.dueDate ?? new Date(),
        assignee: task.ownerNames[0] ?? null,
        assigneeSlackId: null,
        slackThreadTs: task.slackThreadTs,
        channelId: task.channelId,
        isUnclaimed: task.ownerIds.length === 0,
        createdAt: new Date(),
      };

      const status = task.workflowStatus?.toLowerCase() ?? '';

      if (status === 'done' || status === 'complete') {
        completed.push(ic);
      } else if (ic.isUnclaimed) {
        unclaimed.push(ic);
      } else {
        carrying.push(ic);
      }
    }

    // Build blocks
    const blocks = blockKit.buildIssueCallEODBlocks(completed, carrying, unclaimed);

    // Send to channel
    const result = await sendToChannel(
      CHANNELS.issueCall,
      'End of Day - Issue Calls',
      blocks
    );

    if (result) {
      const key = digestState.getDigestMessageKey('issue-call-eod');
      digestState.saveDigestMessage(key, result.channel, result.ts);
      console.log('[Digest] Issue call EOD sent');
      return true;
    }

    return false;
  } catch (error) {
    console.error('[Digest] Error sending issue call EOD:', error);
    return false;
  }
}

// ============================================================================
// Escalations
// ============================================================================

/**
 * Check and send regular task escalations
 */
export async function checkRegularTaskEscalations(): Promise<void> {
  console.log('[Digest] Checking regular task escalations...');

  const currentHour = workingHours.getESTHour();
  const currentMinutes = new Date().getMinutes();
  const currentTime = currentHour + currentMinutes / 60;

  // Get all tasks
  const allTasks = await fetchOpenTasks();

  // Group tasks by user
  const tasksByUser = new Map<string, MondayTask[]>();

  for (const task of allTasks) {
    for (const mondayId of task.ownerIds) {
      const slackId = await getSlackUserIdFromMondayId(mondayId);
      if (slackId) {
        if (!tasksByUser.has(slackId)) {
          tasksByUser.set(slackId, []);
        }
        tasksByUser.get(slackId)!.push(task);
      }
    }
  }

  // Check each user for unconfirmed due-today tasks
  for (const [slackUserId, tasks] of tasksByUser) {
    const today = workingHours.getESTDateString();
    const dueTodayUnconfirmed = tasks.filter((t) => {
      if (!t.dueDate) return false;
      const taskDateStr = workingHours.getESTDateString(t.dueDate);
      return taskDateStr === today && !digestState.isTaskConfirmed(t.id);
    });

    if (dueTodayUnconfirmed.length === 0) continue;

    // Check for first escalation (12 PM)
    if (currentTime >= ESCALATION_CONFIG.regularTasks.first.hour) {
      const firstKey = digestState.getEscalationKey('regular', 'first', slackUserId);

      if (!digestState.hasEscalationBeenSent(firstKey)) {
        // Get user name
        const firstName = await getFirstName(slackUserId);
        const digestTasks = dueTodayUnconfirmed.map((t) => toDigestTask(t));
        const blocks = blockKit.buildFirstEscalationBlocks(firstName, digestTasks);

        // Send to first escalation recipients
        for (const recipientId of ESCALATION_CONFIG.regularTasks.first.recipients) {
          await sendDM(recipientId, `Due-Today Alert for ${firstName}`, blocks);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        digestState.markEscalationSent(firstKey);
        console.log(`[Digest] First escalation sent for ${slackUserId}`);
      }
    }

    // Check for final escalation (1:30 PM)
    if (currentTime >= ESCALATION_CONFIG.regularTasks.final.hour) {
      const finalKey = digestState.getEscalationKey('regular', 'final', slackUserId);

      if (!digestState.hasEscalationBeenSent(finalKey)) {
        const firstName = await getFirstName(slackUserId);
        const digestTasks = dueTodayUnconfirmed.map((t) => toDigestTask(t));
        const blocks = blockKit.buildFinalEscalationBlocks(firstName, digestTasks);

        // Send to final escalation recipients
        for (const recipientId of ESCALATION_CONFIG.regularTasks.final.recipients) {
          await sendDM(recipientId, `Escalation Required for ${firstName}`, blocks);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        digestState.markEscalationSent(finalKey);
        console.log(`[Digest] Final escalation sent for ${slackUserId}`);
      }
    }
  }
}

/**
 * Check and send issue call escalations
 */
export async function checkIssueCallEscalations(): Promise<void> {
  console.log('[Digest] Checking issue call escalations...');

  // Get all Issue Call tasks
  const allTasks = await fetchOpenTasks();
  const issueCalls = allTasks.filter((t) => t.taskType === 'Issue Call');

  for (const task of issueCalls) {
    const escState = digestState.getIssueCallEscalation(task.id);
    const isUnclaimed = task.ownerIds.length === 0;

    // Skip if completed
    const status = task.workflowStatus?.toLowerCase() ?? '';
    if (status === 'done' || status === 'complete') {
      digestState.clearIssueCallEscalation(task.id);
      continue;
    }

    // Convert to IssueCall format for blocks
    const ic: blockKit.IssueCall = {
      id: task.id,
      customerName: task.name.split(' - ')[0] ?? task.name,
      issue: task.name.split(' - ')[1] ?? '',
      dueDate: task.dueDate ?? new Date(),
      assignee: task.ownerNames[0] ?? null,
      assigneeSlackId: null, // Would need lookup
      slackThreadTs: task.slackThreadTs,
      channelId: task.channelId,
      isUnclaimed,
      createdAt: new Date(), // Would need actual creation time
    };

    if (isUnclaimed) {
      // Claiming escalation
      // We'd need the actual creation time to check how long it's been unclaimed
      // For now, we'll use escalation state to track levels
      const cfg = ESCALATION_CONFIG.issueCalls.claiming;

      if (escState.claimLevel < 1) {
        // Check if should escalate to first level
        // This would normally check creation time
        // For demo, escalate if not at level 1 yet
        const blocks = blockKit.buildIssueCallClaimEscalationBlocks(ic, 1, true);

        for (const recipientId of cfg.first.recipients) {
          await sendDM(recipientId, 'Unclaimed Issue Call', blocks);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        digestState.setIssueCallClaimEscalation(task.id, 1);
        console.log(`[Digest] Issue call ${task.id} claim escalation level 1 sent`);
      } else if (escState.claimLevel < 2) {
        // Check if should escalate to final level
        const blocks = blockKit.buildIssueCallClaimEscalationBlocks(ic, 2, false);

        for (const recipientId of cfg.final.recipients) {
          await sendDM(recipientId, 'Issue Call Needs Immediate Attention', blocks);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        digestState.setIssueCallClaimEscalation(task.id, 2);
        console.log(`[Digest] Issue call ${task.id} claim escalation level 2 sent`);
      }
    } else {
      // Completion escalation (for claimed issue calls)
      const deadline = workingHours.get4PMDeadline();
      const hoursRemaining = workingHours.getWorkingHoursUntil(deadline);
      const cfg = ESCALATION_CONFIG.issueCalls.completion;

      if (hoursRemaining <= cfg.final.hoursBeforeDeadline && escState.completionLevel < 2) {
        // Final completion escalation
        const blocks = blockKit.buildIssueCallCompletionEscalationBlocks(
          ic,
          hoursRemaining,
          false
        );

        for (const recipientId of cfg.final.recipients) {
          await sendDM(recipientId, 'Issue Call Critical', blocks);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        digestState.setIssueCallCompletionEscalation(task.id, 2);
        console.log(`[Digest] Issue call ${task.id} completion escalation level 2 sent`);
      } else if (hoursRemaining <= cfg.first.hoursBeforeDeadline && escState.completionLevel < 1) {
        // First completion escalation
        const blocks = blockKit.buildIssueCallCompletionEscalationBlocks(
          ic,
          hoursRemaining,
          true
        );

        for (const recipientId of cfg.first.recipients) {
          await sendDM(recipientId, 'Issue Call At Risk', blocks);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        digestState.setIssueCallCompletionEscalation(task.id, 1);
        console.log(`[Digest] Issue call ${task.id} completion escalation level 1 sent`);
      }
    }
  }
}
