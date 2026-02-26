/**
 * Block Kit Message Builders
 *
 * Builds Slack Block Kit messages for all digest types.
 * All blocks are typed as any[] for Slack API compatibility.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config, configCompat } from '../config/environment.js';
import { formatDateEST, getDayName, getDaysLate, getESTDateString } from './workingHours.js';

// ============================================================================
// Types
// ============================================================================

export interface DigestTask {
  id: string;
  name: string;
  dueDate: Date;
  workflowStatus: string | null;
  taskType: string | null;
  slackThreadTs: string | null;
  channelId: string;
  ownerNames?: string[]; // For team overview
  isConfirmed?: boolean;
  lastUpdate: Date | null; // When the task was last updated
  // Assignee info for acknowledgment tracking
  assigneeSlackIds?: string[]; // All assignees (owners + supporters) Slack IDs
  assigneeNames?: { id: string; name: string }[]; // For displaying who has/hasn't acknowledged
  acknowledgmentStatus?: string | null; // Pre-computed acknowledgment status text
}

export interface TasksByCategory {
  overdue: DigestTask[];
  dueToday: DigestTask[];
  thisWeek: DigestTask[];
}

export interface IssueCall {
  id: string;
  customerName: string;
  issue: string;
  dueDate: Date;
  assignee: string | null;
  assigneeSlackId: string | null;
  slackThreadTs: string | null;
  channelId: string;
  isUnclaimed: boolean;
  createdAt: Date;
  lastUpdate: Date | null; // When the issue call was last updated
}

export interface IssueCallsByCategory {
  overdue: IssueCall[];
  dueToday: IssueCall[];
  thisWeek: IssueCall[];
  unclaimed: IssueCall[];
}

export interface TeamMemberTasks {
  userId: string;
  name: string;
  overdueTasks: DigestTask[];
  dueTodayTasks: DigestTask[];
  thisWeekTasks: DigestTask[];
}

export interface TeamStatus {
  needsAttention: TeamMemberTasks[];
  heavyLoad: TeamMemberTasks[];
  onTrack: TeamMemberTasks[];
  issueCalls: IssueCall[];
  totals: {
    total: number;
    overdue: number;
    dueToday: number;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function getMondayUrl(itemId: string): string {
  return `${configCompat.monday.boardUrl}/pulses/${itemId}`;
}

// Always use Monday.com links for tasks
function getViewLink(task: DigestTask): string {
  return getMondayUrl(task.id);
}

// Always use Monday.com links for issue calls
function getIssueCallViewLink(ic: IssueCall): string {
  return getMondayUrl(ic.id);
}

// Get formatted Monday.com link for a task
function getTaskLinks(task: DigestTask): string {
  const mondayUrl = getMondayUrl(task.id);
  return `<${mondayUrl}|Monday>`;
}

// Get formatted Monday.com link for an issue call
function getIssueCallLinks(ic: IssueCall): string {
  const mondayUrl = getMondayUrl(ic.id);
  return `<${mondayUrl}|Monday>`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Format a last update timestamp as relative text
 * Returns: "today", "yesterday", "2d ago", "1w ago", etc.
 */
function formatLastUpdate(lastUpdate: Date | null, now: Date = new Date()): string {
  if (!lastUpdate) {
    return 'no updates';
  }

  const todayStr = getESTDateString(now);
  const updateStr = getESTDateString(lastUpdate);

  // Check if today
  if (updateStr === todayStr) {
    return 'today';
  }

  // Calculate days difference
  const diffMs = now.getTime() - lastUpdate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 1) {
    return 'yesterday';
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks === 1 ? '1w ago' : `${weeks}w ago`;
  } else {
    const months = Math.floor(diffDays / 30);
    return months === 1 ? '1mo ago' : `${months}mo ago`;
  }
}

// ============================================================================
// Block Builders - Common
// ============================================================================

function headerBlock(text: string): any {
  return {
    type: 'header',
    text: {
      type: 'plain_text',
      text,
      emoji: true,
    },
  };
}

function dividerBlock(): any {
  return { type: 'divider' };
}

function contextBlock(text: string): any {
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text,
      },
    ],
  };
}

function sectionBlock(text: string): any {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text,
    },
  };
}

// ============================================================================
// Task Action Buttons
// ============================================================================

/**
 * Encode acknowledge button value with task ID and all assignee Slack IDs
 * Format: taskId|slackId1,slackId2,slackId3
 */
function encodeAcknowledgeValue(taskId: string, assigneeSlackIds?: string[]): string {
  if (!assigneeSlackIds || assigneeSlackIds.length === 0) {
    return taskId;
  }
  return `${taskId}|${assigneeSlackIds.join(',')}`;
}

/**
 * Build action buttons for overdue tasks
 * [Acknowledge] [Complete] [Stuck]
 */
function buildOverdueTaskActions(taskId: string, assigneeSlackIds?: string[]): any {
  return {
    type: 'actions',
    block_id: `task_${taskId}_overdue`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '👀 Acknowledge', emoji: true },
        action_id: 'task_acknowledge',
        value: encodeAcknowledgeValue(taskId, assigneeSlackIds),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Complete', emoji: true },
        style: 'primary',
        action_id: 'task_complete',
        value: taskId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔴 Stuck', emoji: true },
        style: 'danger',
        action_id: 'task_stuck',
        value: taskId,
      },
    ],
  };
}

/**
 * Build action buttons for due-today tasks
 * [Will complete today] [Reschedule]
 */
function buildDueTodayTaskActions(taskId: string): any {
  return {
    type: 'actions',
    block_id: `task_${taskId}_today`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Will complete today', emoji: true },
        style: 'primary',
        action_id: 'task_confirm_today',
        value: taskId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '📅 Reschedule', emoji: true },
        action_id: 'task_reschedule',
        value: taskId,
      },
    ],
  };
}

/**
 * Build claim button for unclaimed issue calls
 */
function buildClaimButton(issueCallId: string): any {
  return {
    type: 'actions',
    block_id: `issue_call_${issueCallId}_claim`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🙋 Claim This', emoji: true },
        style: 'primary',
        action_id: 'issue_call_claim',
        value: issueCallId,
      },
    ],
  };
}

// ============================================================================
// Personal Morning Digest
// ============================================================================

/**
 * Build blocks for personal morning digest
 */
export function buildPersonalDigestBlocks(
  firstName: string,
  tasks: TasksByCategory
): any[] {
  const blocks: any[] = [];

  // Header
  blocks.push(headerBlock(`Good morning ${firstName}! Here's your week:`));

  // Overdue section - needs individual action buttons per task
  if (tasks.overdue.length > 0) {
    blocks.push(sectionBlock(`*⚠️ OVERDUE (${tasks.overdue.length})*`));

    for (const task of tasks.overdue) {
      const daysLate = getDaysLate(task.dueDate);
      const viewLink = `<${getViewLink(task)}|↗>`;
      const ackStatus = task.acknowledgmentStatus ? ` · ${task.acknowledgmentStatus}` : '';

      blocks.push(
        sectionBlock(
          `• ${truncate(task.name, 50)} — ${daysLate}d late · ${formatLastUpdate(task.lastUpdate)}${ackStatus} ${viewLink}`
        )
      );
      blocks.push(buildOverdueTaskActions(task.id, task.assigneeSlackIds));
    }

    blocks.push(dividerBlock());
  }

  // Due today - needs individual action buttons per task
  if (tasks.dueToday.length > 0) {
    blocks.push(sectionBlock(`*🔴 DUE TODAY (${tasks.dueToday.length})*`));

    for (const task of tasks.dueToday) {
      const confirmedTag = task.isConfirmed ? ' ✓' : '';
      const viewLink = `<${getViewLink(task)}|↗>`;

      blocks.push(
        sectionBlock(`• ${truncate(task.name, 50)} · ${formatLastUpdate(task.lastUpdate)}${confirmedTag} ${viewLink}`)
      );

      if (!task.isConfirmed) {
        blocks.push(buildDueTodayTaskActions(task.id));
      }
    }

    blocks.push(dividerBlock());
  }

  // This week - no buttons, group into one block
  if (tasks.thisWeek.length > 0) {
    const lines = tasks.thisWeek.map(task => {
      const dayName = getDayName(task.dueDate);
      const viewLink = `<${getViewLink(task)}|↗>`;
      return `• ${dayName}: ${truncate(task.name, 40)} · ${formatLastUpdate(task.lastUpdate)} ${viewLink}`;
    });

    blocks.push(sectionBlock(`*📅 THIS WEEK (${tasks.thisWeek.length})*\n${lines.join('\n')}`));
    blocks.push(dividerBlock());
  }

  // Empty state
  if (tasks.overdue.length === 0 && tasks.dueToday.length === 0 && tasks.thisWeek.length === 0) {
    blocks.push(sectionBlock('_No tasks this week. Enjoy the quiet!_'));
  }

  // Footer
  blocks.push(contextBlock('Reply with any questions or concerns.'));

  return blocks;
}

// ============================================================================
// Issue Call Digest
// ============================================================================

/**
 * Build blocks for issue call digest (channel)
 */
export function buildIssueCallDigestBlocks(
  issueCalls: IssueCallsByCategory
): any[] {
  const blocks: any[] = [];

  // Header with @closers mention
  blocks.push(headerBlock('📞 ISSUE CALL STATUS'));
  blocks.push(sectionBlock('<!subteam^S07QVQVMQMB>')); // @closers group

  // Overdue section
  if (issueCalls.overdue.length > 0) {
    const lines = issueCalls.overdue.map(ic => {
      const daysLate = getDaysLate(ic.dueDate);
      const assigneeText = ic.assigneeSlackId
        ? `<@${ic.assigneeSlackId}>`
        : ic.assignee ?? 'Unassigned';
      const viewLink = `<${getIssueCallViewLink(ic)}|↗>`;
      return `• ${truncate(ic.customerName, 25)} - ${truncate(ic.issue, 30)} — ${daysLate}d late · ${formatLastUpdate(ic.lastUpdate)} · ${assigneeText} ${viewLink}`;
    });
    blocks.push(sectionBlock(`*⚠️ OVERDUE (${issueCalls.overdue.length})*\n${lines.join('\n')}`));
    blocks.push(dividerBlock());
  }

  // Due today section - unclaimed need individual claim buttons
  if (issueCalls.dueToday.length > 0) {
    blocks.push(sectionBlock(`*🔴 DUE TODAY (${issueCalls.dueToday.length})*`));

    for (const ic of issueCalls.dueToday) {
      const viewLink = `<${getIssueCallViewLink(ic)}|↗>`;

      if (ic.isUnclaimed) {
        blocks.push(
          sectionBlock(`• ${truncate(ic.customerName, 25)} - ${truncate(ic.issue, 30)} · ${formatLastUpdate(ic.lastUpdate)} · ⚠️ *UNCLAIMED* ${viewLink}`)
        );
        blocks.push(buildClaimButton(ic.id));
      } else {
        const assigneeText = ic.assigneeSlackId
          ? `<@${ic.assigneeSlackId}>`
          : ic.assignee ?? 'Unassigned';
        blocks.push(
          sectionBlock(`• ${truncate(ic.customerName, 25)} - ${truncate(ic.issue, 30)} · ${formatLastUpdate(ic.lastUpdate)} · ${assigneeText} ${viewLink}`)
        );
      }
    }

    blocks.push(dividerBlock());
  }

  // This week section - group into one block
  if (issueCalls.thisWeek.length > 0) {
    const lines = issueCalls.thisWeek.map(ic => {
      const dayName = getDayName(ic.dueDate);
      const viewLink = `<${getIssueCallViewLink(ic)}|↗>`;
      return `• ${dayName}: ${truncate(ic.customerName, 20)} - ${truncate(ic.issue, 25)} · ${formatLastUpdate(ic.lastUpdate)} ${viewLink}`;
    });
    blocks.push(sectionBlock(`*📅 THIS WEEK (${issueCalls.thisWeek.length})*\n${lines.join('\n')}`));
    blocks.push(dividerBlock());
  }

  // Footer
  blocks.push(
    contextBlock('React 👀 on the thread or click [Claim] to take an issue.')
  );

  return blocks;
}

// ============================================================================
// Team Overview - Now Shows Actual Tasks
// ============================================================================

/**
 * Build blocks for team overview (channel)
 * Shows actual tasks for each team member, not just counts
 */
export function buildTeamOverviewBlocks(teamStatus: TeamStatus): any[] {
  const blocks: any[] = [];
  const today = new Date();

  // Header
  blocks.push(headerBlock(`📊 TEAM STATUS - ${formatDateEST(today)}`));

  // Helper: format a member's tasks as compact bullet lines
  function formatMemberTasks(member: TeamMemberTasks): string[] {
    const lines: string[] = [];
    for (const task of member.overdueTasks) {
      const viewLink = `<${getViewLink(task)}|↗>`;
      lines.push(`  ⚠️ ${truncate(task.name, 40)} — ${getDaysLate(task.dueDate)}d late · ${formatLastUpdate(task.lastUpdate)} ${viewLink}`);
    }
    for (const task of member.dueTodayTasks) {
      const viewLink = `<${getViewLink(task)}|↗>`;
      const confirmedTag = task.isConfirmed ? ' ✓' : '';
      lines.push(`  🔴 ${truncate(task.name, 40)} — today · ${formatLastUpdate(task.lastUpdate)}${confirmedTag} ${viewLink}`);
    }
    for (const task of member.thisWeekTasks) {
      const viewLink = `<${getViewLink(task)}|↗>`;
      lines.push(`  📅 ${truncate(task.name, 40)} — ${getDayName(task.dueDate)} · ${formatLastUpdate(task.lastUpdate)} ${viewLink}`);
    }
    return lines;
  }

  // Needs Attention section - one block per member (all tasks grouped)
  if (teamStatus.needsAttention.length > 0) {
    const memberBlocks = teamStatus.needsAttention.map(member => {
      const taskLines = formatMemberTasks(member);
      return `*${member.name}*\n${taskLines.join('\n')}`;
    });
    blocks.push(sectionBlock(`*🔴 NEEDS ATTENTION*\n${memberBlocks.join('\n')}`));
    blocks.push(dividerBlock());
  }

  // Heavy Load section - one block per member
  if (teamStatus.heavyLoad.length > 0) {
    const memberBlocks = teamStatus.heavyLoad.map(member => {
      const total = member.overdueTasks.length + member.dueTodayTasks.length + member.thisWeekTasks.length;
      const taskLines = formatMemberTasks(member);
      return `*${member.name}* (${total} tasks)\n${taskLines.join('\n')}`;
    });
    blocks.push(sectionBlock(`*🟡 HEAVY LOAD (5+ this week)*\n${memberBlocks.join('\n')}`));
    blocks.push(dividerBlock());
  }

  // On Track section - just names in one line
  if (teamStatus.onTrack.length > 0) {
    const names = teamStatus.onTrack.map(m => m.name).join(', ');
    blocks.push(sectionBlock(`*🟢 ON TRACK*\n${names}`));
    blocks.push(dividerBlock());
  }

  // Issue Calls section
  if (teamStatus.issueCalls.length > 0) {
    // Split unclaimed (need buttons) from claimed (can group)
    const unclaimed = teamStatus.issueCalls.filter(ic => ic.isUnclaimed);
    const claimed = teamStatus.issueCalls.filter(ic => !ic.isUnclaimed);

    if (claimed.length > 0) {
      const lines = claimed.map(ic => {
        const viewLink = `<${getIssueCallViewLink(ic)}|↗>`;
        const todayStr = getESTDateString();
        const icDateStr = getESTDateString(ic.dueDate);
        let statusEmoji = '📋';
        let dueText = '';
        if (icDateStr < todayStr) { statusEmoji = '⚠️'; dueText = `${getDaysLate(ic.dueDate)}d overdue`; }
        else if (icDateStr === todayStr) { statusEmoji = '🔴'; dueText = 'today'; }
        else { dueText = getDayName(ic.dueDate); }
        const assigneeText = ic.assigneeSlackId ? `<@${ic.assigneeSlackId}>` : ic.assignee ?? 'Unassigned';
        return `${statusEmoji} ${truncate(ic.customerName, 25)} - ${truncate(ic.issue, 30)} · ${dueText} · ${formatLastUpdate(ic.lastUpdate)} · ${assigneeText} ${viewLink}`;
      });
      blocks.push(sectionBlock(`*📞 ISSUE CALLS*\n${lines.join('\n')}`));
    } else {
      blocks.push(sectionBlock('*📞 ISSUE CALLS*'));
    }

    // Unclaimed need individual claim buttons
    for (const ic of unclaimed) {
      const viewLink = `<${getIssueCallViewLink(ic)}|↗>`;
      const todayStr = getESTDateString();
      const icDateStr = getESTDateString(ic.dueDate);
      let dueText = '';
      if (icDateStr < todayStr) { dueText = `${getDaysLate(ic.dueDate)}d overdue`; }
      else if (icDateStr === todayStr) { dueText = 'today'; }
      else { dueText = getDayName(ic.dueDate); }
      blocks.push(sectionBlock(`⚠️ ${truncate(ic.customerName, 25)} - ${truncate(ic.issue, 30)} · ${dueText} · *UNCLAIMED* ${viewLink}`));
      blocks.push(buildClaimButton(ic.id));
    }

    blocks.push(dividerBlock());
  } else {
    blocks.push(sectionBlock('*📞 ISSUE CALLS*\n_No open issue calls._'));
    blocks.push(dividerBlock());
  }

  // Footer with totals
  blocks.push(
    contextBlock(
      `Total: ${teamStatus.totals.total} tasks | Overdue: ${teamStatus.totals.overdue} | Due Today: ${teamStatus.totals.dueToday}`
    )
  );

  return blocks;
}

// ============================================================================
// Tomorrow Prep
// ============================================================================

/**
 * Build blocks for tomorrow prep digest
 */
export function buildTomorrowPrepBlocks(
  tasks: DigestTask[],
  unackedToday: DigestTask[],
  isFriday: boolean
): any[] {
  const blocks: any[] = [];
  const dayLabel = isFriday ? 'Monday' : 'tomorrow';

  // Header
  blocks.push(headerBlock(`Wrapping up! Here's ${dayLabel}:`));
  blocks.push(dividerBlock());

  // Tomorrow's tasks
  if (tasks.length > 0) {
    blocks.push(
      sectionBlock(`*📅 DUE ${dayLabel.toUpperCase()} (${tasks.length})*`)
    );

    for (const task of tasks) {
      const links = getTaskLinks(task);
      const lastUpdateText = formatLastUpdate(task.lastUpdate);
      blocks.push(
        sectionBlock(`• ${truncate(task.name, 50)} (last update ${lastUpdateText})\n  ${links}`)
      );
    }

    blocks.push(dividerBlock());
  }

  // Unacknowledged from today
  if (unackedToday.length > 0) {
    blocks.push(
      sectionBlock(`*👀 Still unacknowledged from today (${unackedToday.length}):*`)
    );

    for (const task of unackedToday) {
      const links = getTaskLinks(task);
      const lastUpdateText = formatLastUpdate(task.lastUpdate);
      blocks.push(
        sectionBlock(`• ${truncate(task.name, 50)} (last update ${lastUpdateText})\n  ${links}`)
      );
    }

    blocks.push(dividerBlock());
  }

  // Empty state
  if (tasks.length === 0 && unackedToday.length === 0) {
    blocks.push(
      sectionBlock(`_No tasks due ${dayLabel}. All caught up!_`)
    );
    blocks.push(dividerBlock());
  }

  // Footer
  const footerText = isFriday ? 'Enjoy your weekend!' : 'Have a good evening!';
  blocks.push(contextBlock(footerText));

  return blocks;
}

// ============================================================================
// Issue Call EOD
// ============================================================================

/**
 * Build blocks for issue call end of day summary
 */
export function buildIssueCallEODBlocks(
  completed: IssueCall[],
  carrying: IssueCall[],
  unclaimed: IssueCall[]
): any[] {
  const blocks: any[] = [];

  // Header
  blocks.push(headerBlock('📞 END OF DAY - Issue Calls'));
  blocks.push(dividerBlock());

  // Completed today
  if (completed.length > 0) {
    blocks.push(sectionBlock(`*✅ COMPLETED TODAY (${completed.length})*`));

    for (const ic of completed) {
      const assigneeText = ic.assigneeSlackId
        ? `<@${ic.assigneeSlackId}>`
        : ic.assignee ?? 'Unknown';
      const links = getIssueCallLinks(ic);
      blocks.push(
        sectionBlock(
          `• ${truncate(ic.customerName, 30)} - ${truncate(ic.issue, 40)} (by ${assigneeText})\n  ${links}`
        )
      );
    }

    blocks.push(dividerBlock());
  }

  // Carrying to tomorrow
  if (carrying.length > 0) {
    blocks.push(sectionBlock(`*📋 CARRYING TO TOMORROW (${carrying.length})*`));

    for (const ic of carrying) {
      const assigneeText = ic.assigneeSlackId
        ? `<@${ic.assigneeSlackId}>`
        : ic.assignee ?? 'Unassigned';
      const lastUpdateText = formatLastUpdate(ic.lastUpdate);
      const links = getIssueCallLinks(ic);
      blocks.push(
        sectionBlock(
          `• ${truncate(ic.customerName, 30)} - ${truncate(ic.issue, 35)} (${assigneeText}, last update ${lastUpdateText})\n  ${links}`
        )
      );
    }

    blocks.push(dividerBlock());
  }

  // Still unclaimed
  if (unclaimed.length > 0) {
    blocks.push(sectionBlock(`*⚠️ STILL UNCLAIMED (${unclaimed.length})*`));

    for (const ic of unclaimed) {
      const links = getIssueCallLinks(ic);
      const lastUpdateText = formatLastUpdate(ic.lastUpdate);
      blocks.push(
        sectionBlock(
          `• ${truncate(ic.customerName, 30)} - ${truncate(ic.issue, 35)} (last update ${lastUpdateText})\n  ${links}\n  _Needs morning attention!_`
        )
      );
    }

    blocks.push(dividerBlock());
  }

  // Empty state
  if (completed.length === 0 && carrying.length === 0 && unclaimed.length === 0) {
    blocks.push(sectionBlock('_No issue calls today._'));
    blocks.push(dividerBlock());
  }

  return blocks;
}

// ============================================================================
// Escalation Messages
// ============================================================================

/**
 * Build blocks for first escalation (12 PM - Garet + Eliana)
 */
export function buildFirstEscalationBlocks(
  userName: string,
  unconfirmedTasks: DigestTask[]
): any[] {
  const blocks: any[] = [];

  blocks.push(headerBlock('⚠️ Due-Today Alert'));
  blocks.push(dividerBlock());

  blocks.push(
    sectionBlock(
      `*${userName}* has ${unconfirmedTasks.length} unconfirmed task${unconfirmedTasks.length === 1 ? '' : 's'} due today:`
    )
  );

  for (const task of unconfirmedTasks) {
    const links = getTaskLinks(task);
    const lastUpdateText = formatLastUpdate(task.lastUpdate);
    blocks.push(
      sectionBlock(`• ${truncate(task.name, 50)} (last update ${lastUpdateText})\n  ${links}`)
    );
  }

  blocks.push(dividerBlock());
  blocks.push(contextBlock('No confirmation received by 12 PM deadline.'));

  return blocks;
}

/**
 * Build blocks for final escalation (1:30 PM - Edward)
 */
export function buildFinalEscalationBlocks(
  userName: string,
  unconfirmedTasks: DigestTask[]
): any[] {
  const blocks: any[] = [];

  blocks.push(headerBlock('🚨 Escalation Required'));
  blocks.push(dividerBlock());

  blocks.push(
    sectionBlock(
      `*${userName}* still has ${unconfirmedTasks.length} unconfirmed task${unconfirmedTasks.length === 1 ? '' : 's'}:`
    )
  );

  for (const task of unconfirmedTasks) {
    const links = getTaskLinks(task);
    const lastUpdateText = formatLastUpdate(task.lastUpdate);
    blocks.push(
      sectionBlock(`• ${truncate(task.name, 50)} (last update ${lastUpdateText})\n  ${links}`)
    );
  }

  blocks.push(dividerBlock());
  blocks.push(
    contextBlock('First escalation was sent at 12 PM to Garet + Eliana.\nNo response as of 1:30 PM.')
  );

  return blocks;
}

/**
 * Build blocks for issue call claim escalation
 */
export function buildIssueCallClaimEscalationBlocks(
  issueCall: IssueCall,
  hoursUnclaimed: number,
  isFirst: boolean
): any[] {
  const blocks: any[] = [];
  const headerText = isFirst
    ? '⚠️ Unclaimed Issue Call'
    : '🚨 Issue Call Needs Immediate Attention';

  blocks.push(headerBlock(headerText));
  blocks.push(dividerBlock());

  blocks.push(
    sectionBlock(`*${issueCall.customerName}* - ${issueCall.issue}`)
  );

  const timeText = hoursUnclaimed < 2
    ? `${Math.floor(hoursUnclaimed * 60)} minutes`
    : `${hoursUnclaimed}+ hours`;
  const lastUpdateText = formatLastUpdate(issueCall.lastUpdate);
  const links = getIssueCallLinks(issueCall);
  blocks.push(sectionBlock(`Created ${timeText} ago, still unclaimed. Last update: ${lastUpdateText}`));

  // Add Monday.com link
  const mondayUrl = getMondayUrl(issueCall.id);
  blocks.push(sectionBlock(`<${mondayUrl}|View in Monday>`));

  if (!isFirst) {
    blocks.push(dividerBlock());
    blocks.push(
      contextBlock('First escalation sent to Ruzzell + Dayna earlier.')
    );
  }

  return blocks;
}

/**
 * Build blocks for issue call completion escalation
 */
export function buildIssueCallCompletionEscalationBlocks(
  issueCall: IssueCall,
  hoursRemaining: number,
  isFirst: boolean
): any[] {
  const blocks: any[] = [];
  const headerText = isFirst
    ? '⚠️ Issue Call At Risk'
    : '🚨 Issue Call Critical';

  blocks.push(headerBlock(headerText));
  blocks.push(dividerBlock());

  blocks.push(
    sectionBlock(`*${issueCall.customerName}* - ${issueCall.issue}`)
  );

  const assigneeText = issueCall.assigneeSlackId
    ? `<@${issueCall.assigneeSlackId}>`
    : issueCall.assignee ?? 'Unknown';
  const lastUpdateText = formatLastUpdate(issueCall.lastUpdate);
  const links = getIssueCallLinks(issueCall);
  blocks.push(sectionBlock(`Assigned to: ${assigneeText} (last update ${lastUpdateText})`));

  blocks.push(
    sectionBlock(`Only *${hoursRemaining}* working hours until 4 PM deadline.`)
  );

  // Add Monday.com link
  const mondayUrl = getMondayUrl(issueCall.id);
  blocks.push(sectionBlock(`<${mondayUrl}|View in Monday>`));

  if (!isFirst) {
    blocks.push(dividerBlock());
    blocks.push(
      contextBlock('First escalation sent to Ruzzell + Dayna earlier.')
    );
  }

  return blocks;
}

// ============================================================================
// Task Thread Buttons
// ============================================================================

/**
 * Build button blocks to append to existing task threads
 * These are the standard workflow buttons for task management
 * @param taskId - Monday item ID
 * @param assigneeSlackIds - Optional array of all assignee Slack IDs for acknowledgment tracking
 */
export function buildTaskThreadButtons(taskId: string, assigneeSlackIds?: string[]): any[] {
  return [
    dividerBlock(),
    {
      type: 'actions',
      block_id: `task_${taskId}_actions`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '👀 Acknowledge', emoji: true },
          action_id: 'task_acknowledge',
          value: encodeAcknowledgeValue(taskId, assigneeSlackIds),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🟡 Working', emoji: true },
          action_id: 'task_working',
          value: taskId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Done', emoji: true },
          style: 'primary',
          action_id: 'task_complete',
          value: taskId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔴 Stuck', emoji: true },
          style: 'danger',
          action_id: 'task_stuck',
          value: taskId,
        },
      ],
    },
  ];
}

/**
 * Build button blocks for issue call threads
 */
export function buildIssueCallThreadButtons(issueCallId: string, isClaimed: boolean): any[] {
  const blocks: any[] = [dividerBlock()];

  if (!isClaimed) {
    blocks.push({
      type: 'actions',
      block_id: `issue_${issueCallId}_claim`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🙋 Claim This', emoji: true },
          style: 'primary',
          action_id: 'issue_call_claim',
          value: issueCallId,
        },
      ],
    });
  } else {
    blocks.push({
      type: 'actions',
      block_id: `issue_${issueCallId}_actions`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🟡 Working', emoji: true },
          action_id: 'task_working',
          value: issueCallId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Done', emoji: true },
          style: 'primary',
          action_id: 'task_complete',
          value: issueCallId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔴 Stuck', emoji: true },
          style: 'danger',
          action_id: 'task_stuck',
          value: issueCallId,
        },
      ],
    });
  }

  return blocks;
}
