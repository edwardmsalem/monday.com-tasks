/**
 * Block Kit Message Builders
 *
 * Builds Slack Block Kit messages for all digest types.
 * All blocks are typed as any[] for Slack API compatibility.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config } from '../config/environment.js';
import { formatDateEST, getDayName, getDaysLate, isToday, getESTDateString } from './workingHours.js';

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
}

export interface IssueCallsByCategory {
  overdue: IssueCall[];
  dueToday: IssueCall[];
  thisWeek: IssueCall[];
  unclaimed: IssueCall[];
}

export interface TeamMemberStatus {
  userId: string;
  name: string;
  overdueCount: number;
  dueTodayCount: number;
  unconfirmedCount: number;
  weekCount: number;
  oldestOverdueDays: number;
}

export interface TeamStatus {
  needsAttention: TeamMemberStatus[];
  heavyLoad: TeamMemberStatus[];
  onTrack: TeamMemberStatus[];
  issueCallSummary: {
    overdueCount: number;
    unclaimedCount: number;
    dueTodayCount: number;
  };
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
  return `${config.monday.boardUrl}/pulses/${itemId}`;
}

function getSlackThreadUrl(channelId: string, threadTs: string): string {
  return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${threadTs}`;
}

function getViewLink(task: DigestTask): string {
  if (task.slackThreadTs) {
    return getSlackThreadUrl(task.channelId, task.slackThreadTs);
  }
  return getMondayUrl(task.id);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
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
 * Build action buttons for overdue tasks
 * [Acknowledge] [Complete] [Stuck]
 */
function buildOverdueTaskActions(taskId: string): any {
  return {
    type: 'actions',
    block_id: `task_${taskId}_overdue`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '👀 Acknowledge', emoji: true },
        action_id: 'task_acknowledge',
        value: taskId,
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
  const today = getESTDateString();

  // Header
  blocks.push(headerBlock(`Good morning ${firstName}! Here's your week:`));
  blocks.push(dividerBlock());

  // Overdue section
  if (tasks.overdue.length > 0) {
    blocks.push(sectionBlock(`*⚠️ OVERDUE (${tasks.overdue.length})*`));

    for (const task of tasks.overdue) {
      const daysLate = getDaysLate(task.dueDate);
      const viewLink = getViewLink(task);
      const dayText = daysLate === 1 ? 'day' : 'days';

      blocks.push(
        sectionBlock(
          `• ${truncate(task.name, 60)} (${daysLate} ${dayText} late) <${viewLink}|[View]>`
        )
      );
      blocks.push(buildOverdueTaskActions(task.id));
    }

    blocks.push(dividerBlock());
  }

  // Due today section
  if (tasks.dueToday.length > 0) {
    blocks.push(sectionBlock(`*🔴 DUE TODAY (${tasks.dueToday.length})*`));

    for (const task of tasks.dueToday) {
      const viewLink = getViewLink(task);
      const confirmedTag = task.isConfirmed ? ' ✓' : '';

      blocks.push(
        sectionBlock(`• ${truncate(task.name, 60)} <${viewLink}|[View]>${confirmedTag}`)
      );

      // Only show buttons if not already confirmed
      if (!task.isConfirmed) {
        blocks.push(buildDueTodayTaskActions(task.id));
      }
    }

    blocks.push(dividerBlock());
  }

  // This week section
  if (tasks.thisWeek.length > 0) {
    blocks.push(sectionBlock(`*📅 THIS WEEK (${tasks.thisWeek.length})*`));

    for (const task of tasks.thisWeek) {
      const viewLink = getViewLink(task);
      const dayName = getDayName(task.dueDate);

      blocks.push(
        sectionBlock(`• ${dayName}: ${truncate(task.name, 50)} <${viewLink}|[View]>`)
      );
    }

    blocks.push(dividerBlock());
  }

  // Empty state
  if (tasks.overdue.length === 0 && tasks.dueToday.length === 0 && tasks.thisWeek.length === 0) {
    blocks.push(sectionBlock('_No tasks this week. Enjoy the quiet!_'));
    blocks.push(dividerBlock());
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

  blocks.push(dividerBlock());

  // Overdue section
  if (issueCalls.overdue.length > 0) {
    blocks.push(sectionBlock(`*⚠️ OVERDUE (${issueCalls.overdue.length})*`));

    for (const ic of issueCalls.overdue) {
      const daysLate = getDaysLate(ic.dueDate);
      const dayText = daysLate === 1 ? 'day' : 'days';
      const assigneeText = ic.assigneeSlackId
        ? `<@${ic.assigneeSlackId}>`
        : ic.assignee ?? 'Unassigned';
      const viewLink = ic.slackThreadTs
        ? getSlackThreadUrl(ic.channelId, ic.slackThreadTs)
        : getMondayUrl(ic.id);

      blocks.push(
        sectionBlock(
          `• ${truncate(ic.customerName, 30)} - ${truncate(ic.issue, 40)} (${daysLate}${dayText} late) <${viewLink}|[View]>\n  Assigned: ${assigneeText}`
        )
      );
    }

    blocks.push(dividerBlock());
  }

  // Due today section
  if (issueCalls.dueToday.length > 0) {
    blocks.push(sectionBlock(`*🔴 DUE TODAY (${issueCalls.dueToday.length})*`));

    for (const ic of issueCalls.dueToday) {
      const viewLink = ic.slackThreadTs
        ? getSlackThreadUrl(ic.channelId, ic.slackThreadTs)
        : getMondayUrl(ic.id);

      if (ic.isUnclaimed) {
        blocks.push(
          sectionBlock(
            `• ${truncate(ic.customerName, 30)} - ${truncate(ic.issue, 40)} <${viewLink}|[View]>\n  ⚠️ *UNCLAIMED*`
          )
        );
        blocks.push(buildClaimButton(ic.id));
      } else {
        const assigneeText = ic.assigneeSlackId
          ? `<@${ic.assigneeSlackId}>`
          : ic.assignee ?? 'Unassigned';
        blocks.push(
          sectionBlock(
            `• ${truncate(ic.customerName, 30)} - ${truncate(ic.issue, 40)} <${viewLink}|[View]>\n  Assigned: ${assigneeText}`
          )
        );
      }
    }

    blocks.push(dividerBlock());
  }

  // This week section
  if (issueCalls.thisWeek.length > 0) {
    blocks.push(sectionBlock(`*📅 THIS WEEK (${issueCalls.thisWeek.length})*`));

    for (const ic of issueCalls.thisWeek) {
      const dayName = getDayName(ic.dueDate);
      const viewLink = ic.slackThreadTs
        ? getSlackThreadUrl(ic.channelId, ic.slackThreadTs)
        : getMondayUrl(ic.id);

      blocks.push(
        sectionBlock(
          `• ${dayName}: ${truncate(ic.customerName, 25)} - ${truncate(ic.issue, 35)} <${viewLink}|[View]>`
        )
      );
    }

    blocks.push(dividerBlock());
  }

  // Footer
  blocks.push(
    contextBlock('React 👀 on the thread or click [Claim] to take an issue.')
  );

  return blocks;
}

// ============================================================================
// Team Overview
// ============================================================================

/**
 * Build blocks for team overview (channel)
 */
export function buildTeamOverviewBlocks(teamStatus: TeamStatus): any[] {
  const blocks: any[] = [];
  const today = new Date();

  // Header
  blocks.push(headerBlock(`📊 TEAM STATUS - ${formatDateEST(today)}`));
  blocks.push(dividerBlock());

  // Needs Attention section
  if (teamStatus.needsAttention.length > 0) {
    blocks.push(sectionBlock('*🔴 NEEDS ATTENTION*'));

    for (const member of teamStatus.needsAttention) {
      let status = `• ${member.name}: `;
      const parts: string[] = [];

      if (member.overdueCount > 0) {
        const oldest =
          member.oldestOverdueDays > 0
            ? ` (${member.oldestOverdueDays} days)`
            : '';
        parts.push(`${member.overdueCount} overdue${oldest}`);
      }

      if (member.dueTodayCount > 0) {
        const unconf =
          member.unconfirmedCount > 0
            ? ` (${member.unconfirmedCount} unconfirmed)`
            : '';
        parts.push(`${member.dueTodayCount} due today${unconf}`);
      }

      status += parts.join(', ');
      blocks.push(sectionBlock(status));
    }

    blocks.push(dividerBlock());
  }

  // Heavy Load section
  if (teamStatus.heavyLoad.length > 0) {
    blocks.push(sectionBlock('*🟡 HEAVY LOAD (5+ this week)*'));

    for (const member of teamStatus.heavyLoad) {
      blocks.push(
        sectionBlock(`• ${member.name}: ${member.weekCount} tasks this week`)
      );
    }

    blocks.push(dividerBlock());
  }

  // On Track section
  if (teamStatus.onTrack.length > 0) {
    blocks.push(sectionBlock('*🟢 ON TRACK*'));

    const names = teamStatus.onTrack.map((m) => m.name).join(', ');
    blocks.push(sectionBlock(`• ${names}`));

    blocks.push(dividerBlock());
  }

  // Issue Calls section
  blocks.push(sectionBlock('*📞 ISSUE CALLS*'));
  blocks.push(
    sectionBlock(
      `• ${teamStatus.issueCallSummary.overdueCount} overdue\n` +
        `• ${teamStatus.issueCallSummary.unclaimedCount} unclaimed\n` +
        `• ${teamStatus.issueCallSummary.dueTodayCount} due today`
    )
  );

  blocks.push(dividerBlock());

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
      const viewLink = getViewLink(task);
      blocks.push(
        sectionBlock(`• ${truncate(task.name, 60)} <${viewLink}|[View]>`)
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
      const viewLink = getViewLink(task);
      blocks.push(
        sectionBlock(`• ${truncate(task.name, 60)} <${viewLink}|[View]>`)
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
      blocks.push(
        sectionBlock(
          `• ${truncate(ic.customerName, 30)} - ${truncate(ic.issue, 40)} (by ${assigneeText})`
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
      blocks.push(
        sectionBlock(
          `• ${truncate(ic.customerName, 30)} - ${truncate(ic.issue, 40)} (${assigneeText})`
        )
      );
    }

    blocks.push(dividerBlock());
  }

  // Still unclaimed
  if (unclaimed.length > 0) {
    blocks.push(sectionBlock(`*⚠️ STILL UNCLAIMED (${unclaimed.length})*`));

    for (const ic of unclaimed) {
      const viewLink = ic.slackThreadTs
        ? getSlackThreadUrl(ic.channelId, ic.slackThreadTs)
        : getMondayUrl(ic.id);
      blocks.push(
        sectionBlock(
          `• ${truncate(ic.customerName, 30)} - ${truncate(ic.issue, 40)} <${viewLink}|[View]>\n  _Needs morning attention!_`
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
    const viewLink = getViewLink(task);
    blocks.push(
      sectionBlock(`• ${truncate(task.name, 60)} <${viewLink}|[View]>`)
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
    const viewLink = getViewLink(task);
    blocks.push(
      sectionBlock(`• ${truncate(task.name, 60)} <${viewLink}|[View]>`)
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
  blocks.push(sectionBlock(`Created ${timeText} ago, still unclaimed.`));

  if (issueCall.slackThreadTs) {
    const viewLink = getSlackThreadUrl(issueCall.channelId, issueCall.slackThreadTs);
    blocks.push(sectionBlock(`<${viewLink}|View Thread>`));
  }

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
  blocks.push(sectionBlock(`Assigned to: ${assigneeText}`));

  blocks.push(
    sectionBlock(`Only *${hoursRemaining}* working hours until 4 PM deadline.`)
  );

  if (issueCall.slackThreadTs) {
    const viewLink = getSlackThreadUrl(issueCall.channelId, issueCall.slackThreadTs);
    blocks.push(sectionBlock(`<${viewLink}|View Thread>`));
  }

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
 */
export function buildTaskThreadButtons(taskId: string): any[] {
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
          value: taskId,
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
