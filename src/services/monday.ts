import { config, configCompat } from '../config/environment.js';
import { RETRY_DELAYS_MS, MAX_RETRY_ATTEMPTS } from '../config/constants.js';
import type { MondayItem, MondayUser, TaskDebugInfo } from '../types/index.js';
import { mondayCircuit } from './circuitBreaker.js';
import { addJob, registerProcessor } from './jobQueue.js';
import { monday as coreApiMonday } from './coreApi.js';

/**
 * Execute a GraphQL query against the Monday.com API via core-api
 * Wrapped in circuit breaker to prevent cascading failures (TD-05)
 */
async function executeQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  return mondayCircuit.execute(async () => {
    const result = await coreApiMonday.query(query, variables);
    return result as T;
  });
}

interface CreateItemInput {
  name: string;
  dueDate: string | null;  // Can be null if only urgency is set (ASAP case)
  ownerIds: number[];      // Primary owners (Monday Person column)
  supportIds?: string[];   // Support users (Monday Multiple Person column) - optional
  taskType: string;
  source: string;          // Source (Forwarding Tasks, Slack Tasks, etc.)
  team?: string;           // Sports team (optional)
  urgency?: 'High' | 'Medium' | 'Low';  // Priority/urgency level
  // NOTE: fromEmail/toEmail removed - narrative belongs in Updates, not columns
}

/**
 * Create a new item in Monday.com
 * LOCKED ARCHITECTURE: Columns = STATE + ROUTING only
 * All narrative/context goes to Updates via createUpdate()
 */
export async function createItem(input: CreateItemInput): Promise<MondayItem> {
  const { columns } = config.monday;

  // Build column values - STATE and ROUTING columns only
  const columnValues: Record<string, unknown> = {
    [columns.owner]: { personsAndTeams: input.ownerIds.map(id => ({ id, kind: 'person' })) },
    [columns.type]: { label: input.taskType },
    [columns.source]: { label: input.source },
  };

  // Set support users if provided (Multiple Person column)
  if (input.supportIds && input.supportIds.length > 0) {
    columnValues[columns.support] = {
      personsAndTeams: input.supportIds.map(id => ({ id: parseInt(id, 10), kind: 'person' })),
    };
  }

  // Only set due date if provided (ASAP tasks may have no date, just urgency)
  if (input.dueDate) {
    columnValues[columns.date] = { date: input.dueDate };
  }

  // Set urgency if provided (maps Claude priority to Monday status column)
  if (input.urgency) {
    columnValues[columns.urgency] = { label: input.urgency };
  }

  // Set team if provided (dropdown column - auto-create label if missing)
  // Guard against string "null" which Claude sometimes returns
  if (input.team && input.team !== 'null' && input.team.trim() !== '') {
    columnValues[columns.team] = { labels: [input.team] };
  }

  const query = `
    mutation CreateItem($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId
        item_name: $itemName
        column_values: $columnValues
        create_labels_if_missing: true
      ) {
        id
        name
      }
    }
  `;

  const result = await executeQuery<{ create_item: MondayItem }>(query, {
    boardId: configCompat.monday.boardId,
    itemName: input.name,
    columnValues: JSON.stringify(columnValues),
  });

  return result.create_item;
}

/**
 * Slack thread info stored in Monday
 * Format in column: "channelId:threadTs" (e.g., "C123ABC:1234567890.123456")
 * Legacy format (threadTs only) defaults to configCompat.slack.channelId
 */
export interface SlackThreadInfo {
  channelId: string;
  threadTs: string;
}

/**
 * Parse the slack thread column value into channel and thread info
 * Handles both new format (channelId:threadTs) and legacy format (threadTs only)
 */
export function parseSlackThreadValue(value: string | null): SlackThreadInfo | null {
  if (!value) return null;

  const parts = value.split(':');
  if (parts.length >= 2 && parts[0].startsWith('C')) {
    // New format: channelId:threadTs (channel IDs start with C)
    return {
      channelId: parts[0],
      threadTs: parts.slice(1).join(':'), // Handle case where threadTs contains colons
    };
  }

  // Legacy format: just threadTs, default to main channel
  return {
    channelId: configCompat.slack.channelId,
    threadTs: value,
  };
}

/**
 * Format channel and thread info for storage in Monday
 */
export function formatSlackThreadValue(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

/**
 * Update the Slack thread ID column on an item
 * Stores in format "channelId:threadTs" for proper channel routing
 */
export async function updateSlackThreadId(itemId: string, threadTs: string, channelId?: string): Promise<void> {
  const query = `
    mutation UpdateItem($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  // Store with channel ID if provided, otherwise use main channel
  const channel = channelId || configCompat.slack.channelId;
  const value = formatSlackThreadValue(channel, threadTs);

  await executeQuery(query, {
    boardId: configCompat.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.slackThreadId]: value,
    }),
  });
}

/**
 * Add a supporter to an item's support column
 * Appends to existing supporters (doesn't replace)
 */
export async function addSupporter(itemId: string, supporterMondayId: number): Promise<void> {
  // First, get current supporters
  const getQuery = `
    query GetItem($boardId: ID!, $itemId: ID!) {
      boards(ids: [$boardId]) {
        items_page(query_params: {ids: [$itemId]}) {
          items {
            column_values(ids: ["${config.monday.columns.support}"]) {
              id
              value
            }
          }
        }
      }
    }
  `;

  interface GetItemResponse {
    boards: Array<{
      items_page: {
        items: Array<{
          column_values: Array<{
            id: string;
            value: string;
          }>;
        }>;
      };
    }>;
  }

  const getResult = await executeQuery<GetItemResponse>(getQuery, {
    boardId: configCompat.monday.boardId,
    itemId,
  });

  const item = getResult.boards?.[0]?.items_page?.items?.[0];
  const currentValue = item?.column_values?.[0]?.value;

  // Parse existing supporters
  let existingSupporters: Array<{ id: number; kind: string }> = [];
  if (currentValue) {
    try {
      const parsed = JSON.parse(currentValue);
      existingSupporters = parsed?.personsAndTeams ?? [];
    } catch {
      // Ignore parse errors
    }
  }

  // Check if already a supporter
  if (existingSupporters.some(s => s.id === supporterMondayId)) {
    console.log(`User ${supporterMondayId} is already a supporter on item ${itemId}`);
    return;
  }

  // Add new supporter
  const newSupporters = [...existingSupporters, { id: supporterMondayId, kind: 'person' }];

  const updateQuery = `
    mutation UpdateItem($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await executeQuery(updateQuery, {
    boardId: configCompat.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.support]: { personsAndTeams: newSupporters },
    }),
  });

  console.log(`Added supporter ${supporterMondayId} to item ${itemId}`);
}

/**
 * Upload a file to an item's file column via core-api
 * Wrapped in circuit breaker to prevent cascading failures (TD-05)
 */
export async function uploadFileToItem(
  itemId: string,
  filename: string,
  fileData: Buffer
): Promise<void> {
  await mondayCircuit.execute(async () => {
    console.log('Uploading file to Monday item via core-api:', itemId, filename);
    const result = await coreApiMonday.uploadFileToItem({
      itemId,
      columnId: config.monday.fileColumnId,
      filename,
      fileData: fileData.toString('base64'),
    });
    console.log('Monday file uploaded successfully, file ID:', result.id);
  });
}

/**
 * Get a user by ID
 */
export async function getUser(userId: number): Promise<MondayUser | null> {
  const query = `
    query GetUser($ids: [ID!]) {
      users(ids: $ids) {
        id
        name
        email
      }
    }
  `;

  const result = await executeQuery<{ users: MondayUser[] }>(query, {
    ids: [userId],
  });

  return result.users[0] ?? null;
}

/**
 * Search for a user by email
 */
export async function findUserByEmail(email: string): Promise<MondayUser | null> {
  const query = `
    query FindUser($email: String!) {
      users(emails: [$email]) {
        id
        name
        email
      }
    }
  `;

  const result = await executeQuery<{ users: MondayUser[] }>(query, {
    email,
  });

  return result.users[0] ?? null;
}

/**
 * Generate the URL to view an item in Monday.com
 */
export function getItemUrl(itemId: string): string {
  return `${configCompat.monday.boardUrl}/pulses/${itemId}`;
}

/**
 * Fetch all users from Monday.com
 */
export async function getAllUsers(): Promise<MondayUser[]> {
  const query = `
    query GetAllUsers {
      users(limit: 100) {
        id
        name
        email
      }
    }
  `;

  const result = await executeQuery<{ users: MondayUser[] }>(query);
  return result.users;
}

/**
 * Find a Monday item by its Slack thread ID
 * Searches for both new format (channelId:threadTs) and legacy format (threadTs only)
 */
export async function findItemBySlackThread(slackThreadTs: string, channelId?: string): Promise<string | null> {
  const query = `
    query FindItemBySlackThread($boardId: ID!, $columnId: String!, $value: String!) {
      items_page_by_column_values(
        board_id: $boardId
        columns: [{ column_id: $columnId, column_values: [$value] }]
        limit: 1
      ) {
        items {
          id
        }
      }
    }
  `;

  try {
    // Try new format first if channel ID is provided
    if (channelId) {
      const newFormatValue = formatSlackThreadValue(channelId, slackThreadTs);
      const result = await executeQuery<{
        items_page_by_column_values: { items: Array<{ id: string }> };
      }>(query, {
        boardId: configCompat.monday.boardId,
        columnId: config.monday.columns.slackThreadId,
        value: newFormatValue,
      });

      if (result.items_page_by_column_values.items[0]?.id) {
        return result.items_page_by_column_values.items[0].id;
      }
    }

    // Try legacy format (just threadTs)
    const legacyResult = await executeQuery<{
      items_page_by_column_values: { items: Array<{ id: string }> };
    }>(query, {
      boardId: configCompat.monday.boardId,
      columnId: config.monday.columns.slackThreadId,
      value: slackThreadTs,
    });

    if (legacyResult.items_page_by_column_values.items[0]?.id) {
      return legacyResult.items_page_by_column_values.items[0].id;
    }

    // Also try with main channel format for backwards compatibility
    const mainChannelValue = formatSlackThreadValue(configCompat.slack.channelId, slackThreadTs);
    const mainChannelResult = await executeQuery<{
      items_page_by_column_values: { items: Array<{ id: string }> };
    }>(query, {
      boardId: configCompat.monday.boardId,
      columnId: config.monday.columns.slackThreadId,
      value: mainChannelValue,
    });

    return mainChannelResult.items_page_by_column_values.items[0]?.id ?? null;
  } catch (error) {
    console.error('Error finding item by Slack thread:', error);
    return null;
  }
}

/**
 * Get the Slack thread info from a Monday item
 * Returns parsed channel and thread info, or null if not found
 */
export async function getSlackThreadInfo(itemId: string): Promise<SlackThreadInfo | null> {
  const query = `
    query GetSlackThreadId($itemId: ID!) {
      items(ids: [$itemId]) {
        column_values(ids: ["${config.monday.columns.slackThreadId}"]) {
          text
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      items: Array<{ column_values: Array<{ text: string }> }>;
    }>(query, { itemId });

    const rawValue = result.items[0]?.column_values[0]?.text || null;
    return parseSlackThreadValue(rawValue);
  } catch (error) {
    console.error('Error getting Slack thread info:', error);
    return null;
  }
}

/**
 * Get the Slack thread ID from a Monday item (legacy - returns raw threadTs only)
 * @deprecated Use getSlackThreadInfo() instead for proper channel routing
 */
export async function getSlackThreadId(itemId: string): Promise<string | null> {
  const info = await getSlackThreadInfo(itemId);
  return info?.threadTs ?? null;
}

/**
 * Monday update (comment) with author info
 */
export interface MondayUpdate {
  id: string;
  body: string;
  textBody: string;
  createdAt: string;
  creatorId: number;
  creatorName: string | null;
}

/**
 * Get all updates (comments) from a Monday item
 * Returns updates in chronological order (oldest first)
 */
export async function getItemUpdates(itemId: string): Promise<MondayUpdate[]> {
  const query = `
    query GetItemUpdates($itemId: ID!) {
      items(ids: [$itemId]) {
        updates {
          id
          body
          text_body
          created_at
          creator_id
          creator {
            name
          }
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      items: Array<{
        updates: Array<{
          id: string;
          body: string;
          text_body: string;
          created_at: string;
          creator_id: number;
          creator: { name: string } | null;
        }>;
      }>;
    }>(query, { itemId });

    const updates = result.items[0]?.updates ?? [];

    // Map to our interface and reverse to get chronological order (oldest first)
    return updates
      .map(u => ({
        id: u.id,
        body: u.body,
        textBody: u.text_body,
        createdAt: u.created_at,
        creatorId: u.creator_id,
        creatorName: u.creator?.name ?? null,
      }))
      .reverse();
  } catch (error) {
    console.error('Error fetching item updates:', error);
    return [];
  }
}

/**
 * Create an update (comment) on a Monday item
 * @param itemId - The Monday item ID
 * @param body - The update body (HTML supported)
 * @param mentionUserIds - Optional array of Monday user IDs to mention
 */
export async function createUpdate(
  itemId: string,
  body: string,
  mentionUserIds?: number[]
): Promise<string> {
  // Build mentions_list if user IDs provided
  const mentionsList =
    mentionUserIds && mentionUserIds.length > 0
      ? mentionUserIds.map(id => ({ id, type: 'User' }))
      : undefined;

  const query = mentionsList
    ? `
    mutation CreateUpdate($itemId: ID!, $body: String!, $mentionsList: [MentionInput!]) {
      create_update(item_id: $itemId, body: $body, mentions_list: $mentionsList) {
        id
      }
    }
  `
    : `
    mutation CreateUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
  `;

  const variables: Record<string, unknown> = { itemId, body };
  if (mentionsList) {
    variables.mentionsList = mentionsList;
  }

  const result = await executeQuery<{ create_update: { id: string } }>(query, variables);

  return result.create_update.id;
}

/**
 * Add a file to an existing Monday update (comment) via core-api
 */
export async function addFileToUpdate(
  updateId: string,
  fileBuffer: Buffer,
  filename: string
): Promise<void> {
  console.log('Uploading file to Monday update via core-api:', updateId, filename);
  await coreApiMonday.uploadFileToUpdate({
    updateId,
    filename,
    fileData: fileBuffer.toString('base64'),
  });
  console.log(`Uploaded file ${filename} to Monday update ${updateId}`);
}

/**
 * Get file assets from a Monday update
 */
export interface MondayFileAsset {
  id: string;
  name: string;
  url: string;
  file_extension: string;
}

export async function getUpdateAssets(updateId: string): Promise<MondayFileAsset[]> {
  const query = `
    query GetUpdateAssets($updateId: [ID!]!) {
      updates(ids: $updateId) {
        assets {
          id
          name
          url
          file_extension
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      updates: Array<{ assets: MondayFileAsset[] }>;
    }>(query, { updateId: [updateId] });

    return result.updates[0]?.assets ?? [];
  } catch (error) {
    console.error('Error getting update assets:', error);
    return [];
  }
}

/**
 * Download a file from Monday.com
 * Note: Monday file URLs are typically public with auth embedded, so direct fetch works
 */
export async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Failed to download Monday file: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Update the workflow status column on a Monday item
 * (Acknowledged, Working on it, Complete, etc.)
 */
export async function updateWorkflowStatus(itemId: string, status: string): Promise<void> {
  const query = `
    mutation UpdateStatus($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await executeQuery(query, {
    boardId: configCompat.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.workflowStatus]: { label: status },
    }),
  });
}

/**
 * Update a task's due date
 */
export async function updateDueDate(itemId: string, date: string): Promise<void> {
  const query = `
    mutation UpdateDueDate($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await executeQuery(query, {
    boardId: configCompat.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.date]: { date },
    }),
  });
}

/**
 * Update the item name
 */
export async function updateItemName(itemId: string, newName: string): Promise<void> {
  const query = `
    mutation UpdateItemName($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await executeQuery(query, {
    boardId: configCompat.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      name: newName,
    }),
  });
}

/**
 * Update the team column on a Monday item
 */
export async function updateTeam(itemId: string, team: string): Promise<void> {
  const query = `
    mutation UpdateTeam($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await executeQuery(query, {
    boardId: configCompat.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.team]: { labels: [team] },
    }),
  });
}

/**
 * Update the task type column on a Monday item
 * (General, Opportunity, Decline, etc.)
 */
export async function updateType(itemId: string, taskType: string): Promise<void> {
  const query = `
    mutation UpdateType($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await executeQuery(query, {
    boardId: configCompat.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.type]: { label: taskType },
    }),
  });
}

/**
 * Create a subitem (subtask) on a parent item
 * Used for /scan feature to create recipient subtasks
 */
export async function createSubitem(parentItemId: string, name: string): Promise<{ id: string; name: string }> {
  const query = `
    mutation CreateSubitem($parentItemId: ID!, $itemName: String!) {
      create_subitem(
        parent_item_id: $parentItemId
        item_name: $itemName
      ) {
        id
        name
      }
    }
  `;

  const result = await executeQuery<{ create_subitem: { id: string; name: string } }>(query, {
    parentItemId,
    itemName: name,
  });

  return result.create_subitem;
}

/**
 * Create multiple subitems at once
 * Returns array of created subitem IDs
 */
export async function createSubitems(parentItemId: string, names: string[]): Promise<Array<{ id: string; name: string }>> {
  const results: Array<{ id: string; name: string }> = [];

  for (const name of names) {
    try {
      const subitem = await createSubitem(parentItemId, name);
      results.push(subitem);
      console.log(`Created subitem: ${name}`);
    } catch (error) {
      console.error(`Failed to create subitem "${name}":`, error);
    }
  }

  return results;
}

/**
 * Get existing subitems for a parent item
 * Used for idempotency checks before creating new subitems
 */
export async function getSubitems(parentItemId: string): Promise<Array<{ id: string; name: string }>> {
  const query = `
    query GetSubitems($itemId: ID!) {
      items(ids: [$itemId]) {
        subitems {
          id
          name
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      items: Array<{ subitems: Array<{ id: string; name: string }> }>;
    }>(query, { itemId: parentItemId });

    return result.items[0]?.subitems ?? [];
  } catch (error) {
    console.error('Error fetching subitems:', error);
    return [];
  }
}

/**
 * Get item details including name and workflow status
 */
export async function getItem(itemId: string): Promise<{
  id: string;
  name: string;
  workflowStatus: string | null;
  taskType: string | null;
} | null> {
  const query = `
    query GetItem($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        name
        column_values(ids: ["${config.monday.columns.workflowStatus}", "${config.monday.columns.type}"]) {
          id
          text
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      items: Array<{
        id: string;
        name: string;
        column_values: Array<{ id: string; text: string }>;
      }>;
    }>(query, { itemId });

    const item = result.items[0];
    if (!item) return null;

    const workflowStatusCol = item.column_values.find(c => c.id === config.monday.columns.workflowStatus);
    const typeCol = item.column_values.find(c => c.id === config.monday.columns.type);

    return {
      id: item.id,
      name: item.name,
      workflowStatus: workflowStatusCol?.text || null,
      taskType: typeCol?.text || null,
    };
  } catch (error) {
    console.error('Error getting item:', error);
    return null;
  }
}

/**
 * Get task name and all assignee Slack IDs for cross-notifications
 * Returns both owner and supporter Slack IDs
 */
export async function getTaskAssignees(itemId: string): Promise<{
  name: string;
  assigneeSlackIds: string[];
} | null> {
  const query = `
    query GetTaskAssignees($itemId: ID!) {
      items(ids: [$itemId]) {
        name
        column_values(ids: ["${config.monday.columns.owner}", "${config.monday.columns.support}"]) {
          id
          value
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      items: Array<{
        name: string;
        column_values: Array<{ id: string; value: string | null }>;
      }>;
    }>(query, { itemId });

    const item = result.items[0];
    if (!item) return null;

    const mondayIds: string[] = [];

    // Parse owner column
    const ownerCol = item.column_values.find(c => c.id === config.monday.columns.owner);
    if (ownerCol?.value) {
      try {
        const parsed = JSON.parse(ownerCol.value);
        const ownerIds = parsed?.personsAndTeams?.map((p: { id: number }) => String(p.id)) ?? [];
        mondayIds.push(...ownerIds);
      } catch {
        // Ignore parse errors
      }
    }

    // Parse support column
    const supportCol = item.column_values.find(c => c.id === config.monday.columns.support);
    if (supportCol?.value) {
      try {
        const parsed = JSON.parse(supportCol.value);
        const supportIds = parsed?.personsAndTeams?.map((p: { id: number }) => String(p.id)) ?? [];
        mondayIds.push(...supportIds);
      } catch {
        // Ignore parse errors
      }
    }

    // Convert Monday IDs to Slack IDs
    const slackModule = await import('./slack.js');
    const slackUsers = await slackModule.getAllUsers();
    const mondayUsers = await getAllUsers();

    const slackIds: string[] = [];
    for (const mondayId of mondayIds) {
      const mondayUser = mondayUsers.find(u => String(u.id) === mondayId);
      if (mondayUser?.email) {
        const slackUser = slackUsers.find(u => u.email?.toLowerCase() === mondayUser.email?.toLowerCase());
        if (slackUser) {
          slackIds.push(slackUser.id);
        }
      }
    }

    return {
      name: item.name,
      assigneeSlackIds: slackIds,
    };
  } catch (error) {
    console.error('Error getting task assignees:', error);
    return null;
  }
}

/**
 * Get full task details needed for supporter notification DM
 * Returns all info needed to build SupporterNotificationDetails
 */
export async function getTaskDetailsForSupporterNotification(itemId: string): Promise<{
  taskSubject: string;
  taskType: string;
  ownerName: string;
  dueDate: string;
  urgency: string;
  assigneeSlackIds: string[];
} | null> {
  const { columns } = config.monday;

  const query = `
    query GetTaskDetails($itemId: ID!) {
      items(ids: [$itemId]) {
        name
        column_values(ids: ["${columns.owner}", "${columns.support}", "${columns.type}", "${columns.urgency}", "${columns.date}"]) {
          id
          value
          text
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      items: Array<{
        name: string;
        column_values: Array<{ id: string; value: string | null; text: string | null }>;
      }>;
    }>(query, { itemId });

    const item = result.items[0];
    if (!item) return null;

    const getValue = (colId: string) => {
      const col = item.column_values.find(c => c.id === colId);
      return col?.text || '';
    };

    const getRawValue = (colId: string) => {
      const col = item.column_values.find(c => c.id === colId);
      return col?.value || null;
    };

    // Parse owner name from text field
    const ownerName = getValue(columns.owner) || 'Unknown';

    // Parse due date - format for display
    const dueDateRaw = getValue(columns.date);
    let dueDate = 'No due date';
    if (dueDateRaw) {
      try {
        const date = new Date(dueDateRaw);
        dueDate = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      } catch {
        dueDate = dueDateRaw;
      }
    }

    // Collect all assignee Monday IDs
    const mondayIds: string[] = [];

    // Parse owner column
    const ownerRaw = getRawValue(columns.owner);
    if (ownerRaw) {
      try {
        const parsed = JSON.parse(ownerRaw);
        const ownerIds = parsed?.personsAndTeams?.map((p: { id: number }) => String(p.id)) ?? [];
        mondayIds.push(...ownerIds);
      } catch {
        // Ignore parse errors
      }
    }

    // Parse support column
    const supportRaw = getRawValue(columns.support);
    if (supportRaw) {
      try {
        const parsed = JSON.parse(supportRaw);
        const supportIds = parsed?.personsAndTeams?.map((p: { id: number }) => String(p.id)) ?? [];
        mondayIds.push(...supportIds);
      } catch {
        // Ignore parse errors
      }
    }

    // Convert Monday IDs to Slack IDs
    const slackModule = await import('./slack.js');
    const slackUsers = await slackModule.getAllUsers();
    const mondayUsers = await getAllUsers();

    const slackIds: string[] = [];
    for (const mondayId of mondayIds) {
      const mondayUser = mondayUsers.find(u => String(u.id) === mondayId);
      if (mondayUser?.email) {
        const slackUser = slackUsers.find(u => u.email?.toLowerCase() === mondayUser.email?.toLowerCase());
        if (slackUser) {
          slackIds.push(slackUser.id);
        }
      }
    }

    return {
      taskSubject: item.name,
      taskType: getValue(columns.type) || 'General',
      ownerName,
      dueDate,
      urgency: getValue(columns.urgency) || 'Medium',
      assigneeSlackIds: slackIds,
    };
  } catch (error) {
    console.error('Error getting task details for supporter notification:', error);
    return null;
  }
}

/**
 * Check if an item has a Run ID (indicating automated creation)
 */
export async function hasRunId(itemId: string): Promise<boolean> {
  const result = await checkItemAutomation(itemId);
  return result.hasRunId;
}

/**
 * Known automated source values
 */
const AUTOMATED_SOURCES = ['Forwarding Tasks', 'Slack', 'Email Task'];

/**
 * Check item automation indicators (Run ID and Source)
 * Used to determine if an item was created via automation
 */
export async function checkItemAutomation(itemId: string): Promise<{
  hasRunId: boolean;
  source: string | null;
  isAutomated: boolean;
}> {
  const query = `
    query CheckAutomation($itemId: ID!) {
      items(ids: [$itemId]) {
        column_values(ids: ["${config.monday.columns.runId}", "${config.monday.columns.source}"]) {
          id
          text
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      items: Array<{
        column_values: Array<{ id: string; text: string }>;
      }>;
    }>(query, { itemId });

    const item = result.items[0];
    if (!item) {
      return { hasRunId: false, source: null, isAutomated: false };
    }

    const runIdCol = item.column_values.find(c => c.id === config.monday.columns.runId);
    const sourceCol = item.column_values.find(c => c.id === config.monday.columns.source);

    const hasRunId = !!(runIdCol?.text && runIdCol.text.length > 0);
    const source = sourceCol?.text || null;
    const isAutomated = hasRunId || (source !== null && AUTOMATED_SOURCES.includes(source));

    return { hasRunId, source, isAutomated };
  } catch (error) {
    console.error('Error checking item automation:', error);
    return { hasRunId: false, source: null, isAutomated: false };
  }
}

/**
 * Store the durable PDF URL on a Monday item for retry scenarios
 */
export async function storePdfUrl(itemId: string, pdfUrl: string): Promise<void> {
  const query = `
    mutation StorePdfUrl($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  try {
    await executeQuery(query, {
      boardId: configCompat.monday.boardId,
      itemId,
      columnValues: JSON.stringify({
        [config.monday.columns.pdfUrl]: pdfUrl,
      }),
    });
    console.log('PDF URL stored on Monday item:', itemId);
  } catch (error) {
    // Non-fatal - PDF URL storage is optional (column may not exist yet)
    console.warn('Could not store PDF URL on Monday item (column may not exist):', error);
  }
}

// Retry configuration imported from constants.ts

/**
 * Job payload for Monday file upload retries
 */
interface MondayFileUploadPayload {
  itemId: string;
  filename: string;
  fileDataBase64: string;  // Buffer serialized as base64
  slackThreadTs?: string;
}

/**
 * Register the Monday file upload job processor
 * Called during server startup
 */
export function registerMondayJobProcessors(): void {
  registerProcessor('monday_file_upload', async (payload) => {
    const data = payload as unknown as MondayFileUploadPayload;
    const fileData = Buffer.from(data.fileDataBase64, 'base64');

    console.log(`[MondayProcessor] Attempting file upload for item ${data.itemId}: ${data.filename}`);

    // Attempt the upload - let errors propagate for retry
    await uploadFileToItem(data.itemId, data.filename, fileData);

    console.log(`[MondayProcessor] File upload succeeded for item ${data.itemId}`);

    // On success, notify via Slack if thread info available
    if (data.slackThreadTs) {
      try {
        // Import dynamically to avoid circular dependency
        const { postToThread } = await import('./slack.js');
        await postToThread(
          data.slackThreadTs,
          '✅ PDF successfully uploaded to Monday (retry succeeded).'
        );
      } catch {
        // Ignore Slack notification failure
      }
    }
  });

  console.log('[Monday] Registered job processor for monday_file_upload');
}

/**
 * Upload file to Monday with retry logic
 * Returns success status and schedules background retries if initial upload fails
 * Uses durable job queue for retries (survives server restarts)
 */
export async function uploadFileToItemWithRetry(
  itemId: string,
  filename: string,
  fileData: Buffer,
  slackThreadTs?: string,
  postToSlack?: (message: string) => Promise<void>
): Promise<{ success: boolean; retryScheduled: boolean }> {
  // First attempt
  try {
    await uploadFileToItem(itemId, filename, fileData);
    return { success: true, retryScheduled: false };
  } catch (error) {
    console.error('Initial Monday file upload failed:', error);
  }

  // Schedule durable retries via job queue
  console.log('Scheduling Monday file upload retries via job queue...');

  // Post notification to Slack thread if available
  if (postToSlack) {
    try {
      await postToSlack('⚠️ PDF upload to Monday failed. Retrying automatically (1min, 5min, 15min, 1hr)...');
    } catch {
      // Ignore Slack notification failure
    }
  }

  // Add job to the durable queue
  const jobId = addJob(
    'monday_file_upload',
    {
      itemId,
      filename,
      fileDataBase64: fileData.toString('base64'),
      slackThreadTs,
    } as unknown as Record<string, unknown>,
    {
      maxAttempts: MAX_RETRY_ATTEMPTS,
      retryDelays: [...RETRY_DELAYS_MS],
    }
  );

  console.log(`Monday file upload job queued: ${jobId} for item ${itemId}`);

  return { success: false, retryScheduled: true };
}

/**
 * Handle permanent failure after all job queue retries exhausted
 * Called by the job queue when a job fails permanently
 */
export async function handleMondayUploadFailure(
  itemId: string,
  slackThreadTs?: string
): Promise<void> {
  console.error(`Monday file upload failed permanently for item ${itemId}`);

  // Set workflow status to indicate failure
  try {
    await updateWorkflowStatus(itemId, 'Attachment Failed');
  } catch {
    console.error('Could not update workflow status to Attachment Failed');
  }

  // Notify via Slack if thread info available
  if (slackThreadTs) {
    try {
      const { postToThread } = await import('./slack.js');
      await postToThread(
        slackThreadTs,
        '❌ PDF upload to Monday failed after all retries. Please upload manually.'
      );
    } catch {
      // Ignore
    }
  }
}

/**
 * Find all items with "Attachment Failed" status that have a stored PDF URL
 * Used by hourly sweep to retry uploads that failed after all in-memory retries
 */
export async function findItemsWithFailedAttachments(): Promise<Array<{
  id: string;
  name: string;
  pdfUrl: string;
  slackThreadId: string | null;
}>> {
  const query = `
    query FindFailedAttachments($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 50) {
          items {
            id
            name
            column_values {
              id
              text
            }
          }
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      boards: Array<{
        items_page: {
          items: Array<{
            id: string;
            name: string;
            column_values: Array<{ id: string; text: string }>;
          }>;
        };
      }>;
    }>(query, { boardId: configCompat.monday.boardId });

    const items = result.boards[0]?.items_page?.items ?? [];
    const failedItems: Array<{
      id: string;
      name: string;
      pdfUrl: string;
      slackThreadId: string | null;
    }> = [];

    for (const item of items) {
      const getValue = (colId: string) =>
        item.column_values.find(cv => cv.id === colId)?.text ?? '';

      const workflowStatus = getValue(config.monday.columns.workflowStatus);
      const pdfUrl = getValue(config.monday.columns.pdfUrl);
      const slackThreadId = getValue(config.monday.columns.slackThreadId) || null;

      // Only include items with "Attachment Failed" status AND a stored PDF URL
      if (workflowStatus === 'Attachment Failed' && pdfUrl) {
        failedItems.push({
          id: item.id,
          name: item.name,
          pdfUrl,
          slackThreadId,
        });
      }
    }

    return failedItems;
  } catch (error) {
    console.error('Error finding items with failed attachments:', error);
    return [];
  }
}

/**
 * Store the Run ID on a Monday item for debugging/tracing
 */
export async function storeRunId(itemId: string, runId: string): Promise<void> {
  const query = `
    mutation StoreRunId($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  try {
    await executeQuery(query, {
      boardId: configCompat.monday.boardId,
      itemId,
      columnValues: JSON.stringify({
        [config.monday.columns.runId]: runId,
      }),
    });
    console.log('Run ID stored on Monday item:', itemId, runId.substring(0, 8));
  } catch (error) {
    // Non-fatal - Run ID column may not exist yet
    console.warn('Could not store Run ID on Monday item (column may not exist):', error);
  }
}

/**
 * Update attachment state on a Monday item
 * States: Queued | Uploaded | Retrying | Failed | Skipped
 * Note: Errors go to Updates/Slack, not columns (keeping board lean)
 */
export async function updateAttachmentState(itemId: string, state: string): Promise<void> {
  const query = `
    mutation UpdateAttachmentState($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  try {
    await executeQuery(query, {
      boardId: configCompat.monday.boardId,
      itemId,
      columnValues: JSON.stringify({
        [config.monday.columns.attachmentState]: { label: state },
      }),
    });
    console.log('Attachment state updated on Monday item:', itemId, state);
  } catch (error) {
    // Non-fatal - attachment state column may not exist yet
    console.warn('Could not update attachment state on Monday item (column may not exist):', error);
  }
}

/**
 * Retry failed attachment uploads using stored PDF URLs
 * Called by hourly sweep - survives server restarts
 */
export async function retryFailedAttachments(
  postToSlack?: (threadTs: string, message: string) => Promise<void>
): Promise<{ attempted: number; succeeded: number }> {
  console.log('Checking for failed attachment uploads to retry...');

  const failedItems = await findItemsWithFailedAttachments();

  if (failedItems.length === 0) {
    console.log('No failed attachment uploads to retry');
    return { attempted: 0, succeeded: 0 };
  }

  console.log(`Found ${failedItems.length} items with failed attachments, retrying...`);

  let succeeded = 0;

  for (const item of failedItems) {
    try {
      console.log(`Retrying attachment upload for item ${item.id}: ${item.name}`);

      // Download PDF from stored URL
      const response = await fetch(item.pdfUrl, {
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        console.error(`Failed to download PDF for item ${item.id}: ${response.statusText}`);
        continue;
      }

      const pdfBuffer = Buffer.from(await response.arrayBuffer());
      const filename = `${item.name.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;

      // Upload to Monday
      await uploadFileToItem(item.id, filename, pdfBuffer);

      // Clear the "Attachment Failed" status
      await updateWorkflowStatus(item.id, '');

      // Clear the stored PDF URL (no longer needed)
      await storePdfUrl(item.id, '');

      // Notify via Slack if available
      if (postToSlack && item.slackThreadId) {
        try {
          await postToSlack(item.slackThreadId, '✅ PDF successfully uploaded to Monday (hourly retry succeeded).');
        } catch {
          // Ignore Slack errors
        }
      }

      console.log(`Successfully retried attachment for item ${item.id}`);
      succeeded++;
    } catch (error) {
      console.error(`Failed to retry attachment for item ${item.id}:`, error);
      // Leave status as "Attachment Failed" for next retry cycle
    }
  }

  console.log(`Attachment retry complete: ${succeeded}/${failedItems.length} succeeded`);
  return { attempted: failedItems.length, succeeded };
}

/**
 * Get task debug info for /taskdebug command
 * Returns state/routing columns for debugging
 * Note: Errors are in Updates/Slack, not columns (keeping board lean)
 */
export async function getTaskDebugInfo(itemId: string): Promise<TaskDebugInfo | null> {
  const { columns } = config.monday;

  const query = `
    query GetTaskDebugInfo($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        name
        column_values {
          id
          text
          value
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      items: Array<{
        id: string;
        name: string;
        column_values: Array<{ id: string; text: string; value: string }>;
      }>;
    }>(query, { itemId });

    const item = result.items[0];
    if (!item) return null;

    // Helper to get column value by ID
    const getValue = (colId: string): string | null => {
      const col = item.column_values.find(c => c.id === colId);
      return col?.text || null;
    };

    // Parse person column value to get owner name
    const getOwnerName = (): string | null => {
      const col = item.column_values.find(c => c.id === columns.owner);
      if (!col?.value) return null;
      try {
        // Monday person column format: { personsAndTeams: [{ id: number, kind: 'person' }] }
        // The text field usually contains the name
        return col.text || null;
      } catch {
        return col.text || null;
      }
    };

    // Build Slack thread URL if we have the thread ID
    const slackThreadId = getValue(columns.slackThreadId);
    let slackThreadUrl: string | null = null;
    if (slackThreadId) {
      // Parse channelId:threadTs format or just threadTs
      const [channelId, threadTs] = slackThreadId.includes(':')
        ? slackThreadId.split(':')
        : [configCompat.slack.channelId, slackThreadId];
      slackThreadUrl = `https://slack.com/archives/${channelId}/p${threadTs.replace('.', '')}`;
    }

    return {
      mondayItemId: item.id,
      mondayUrl: getItemUrl(item.id),
      slackThreadTs: slackThreadId,
      slackThreadUrl,
      taskType: getValue(columns.type),
      workflowStatus: getValue(columns.workflowStatus),
      urgency: getValue(columns.urgency),
      pdfUrl: getValue(columns.pdfUrl),
      attachmentState: getValue(columns.attachmentState),
      runId: getValue(columns.runId),
      dueDate: getValue(columns.date),
      owner: getOwnerName(),
    };
  } catch (error) {
    console.error('Error getting task debug info:', error);
    return null;
  }
}

/**
 * Backfill item: data needed to create a Slack thread for an existing Monday item
 */
export interface BackfillItem {
  id: string;
  name: string;
  owner: string | null;
  taskType: string | null;
  team: string | null;
  workflowStatus: string | null;
  dueDate: string | null;
  slackThreadId: string | null;
}

/**
 * Fetch all items from the board that have status "Complete" and have a Slack Thread ID
 * Used for cleanup of accidentally backfilled completed items
 */
export async function getCompletedItemsWithSlackThread(): Promise<BackfillItem[]> {
  const { columns } = config.monday;

  const query = `
    query GetAllItems($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values {
              id
              text
            }
          }
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      boards: Array<{
        items_page: {
          items: Array<{
            id: string;
            name: string;
            column_values: Array<{ id: string; text: string }>;
          }>;
        };
      }>;
    }>(query, { boardId: configCompat.monday.boardId });

    const items = result.boards[0]?.items_page?.items ?? [];
    const completedItems: BackfillItem[] = [];

    for (const item of items) {
      const getValue = (colId: string): string | null => {
        const col = item.column_values.find(c => c.id === colId);
        return col?.text || null;
      };

      const slackThreadId = getValue(columns.slackThreadId);
      const workflowStatus = getValue(columns.workflowStatus);

      // Only include items WITH a Slack thread ID AND status is Complete/Done
      const isComplete = workflowStatus?.toLowerCase() === 'complete' ||
                         workflowStatus?.toLowerCase() === 'done';

      if (slackThreadId && slackThreadId.trim() !== '' && isComplete) {
        completedItems.push({
          id: item.id,
          name: item.name,
          owner: getValue(columns.owner),
          taskType: getValue(columns.type),
          team: getValue(columns.team),
          workflowStatus,
          dueDate: getValue(columns.date),
          slackThreadId,
        });
      }
    }

    return completedItems;
  } catch (error) {
    console.error('Error fetching completed items with Slack thread:', error);
    return [];
  }
}

/**
 * Clear the Slack thread ID from a Monday item
 */
export async function clearSlackThreadId(itemId: string): Promise<void> {
  const query = `
    mutation UpdateItem($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await executeQuery(query, {
    boardId: configCompat.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.slackThreadId]: '',
    }),
  });
}

/**
 * Extended backfill item with owner person IDs for Slack @mention lookup
 */
export interface BackfillItemWithOwner extends BackfillItem {
  ownerPersonIds: number[];
}

/**
 * Fetch all items from the board that need Slack thread backfill.
 * Excludes completed/done items.
 *
 * @param mode - 'missing' (default): items without thread ID
 *               'today': items with thread ID created today (for re-backfill after cleanup)
 *               'all': all non-done items regardless of thread ID
 */
export async function getItemsForBackfill(mode: 'missing' | 'today' | 'all' = 'missing'): Promise<BackfillItemWithOwner[]> {
  const { columns } = config.monday;

  const query = `
    query GetAllItems($boardId: ID!) {
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
    const result = await executeQuery<{
      boards: Array<{
        items_page: {
          items: Array<{
            id: string;
            name: string;
            column_values: Array<{ id: string; text: string; value: string }>;
          }>;
        };
      }>;
    }>(query, { boardId: configCompat.monday.boardId });

    const items = result.boards[0]?.items_page?.items ?? [];
    const backfillItems: BackfillItemWithOwner[] = [];

    for (const item of items) {
      const getValue = (colId: string): string | null => {
        const col = item.column_values.find(c => c.id === colId);
        return col?.text || null;
      };

      const getRawValue = (colId: string): string | null => {
        const col = item.column_values.find(c => c.id === colId);
        return col?.value || null;
      };

      const slackThreadId = getValue(columns.slackThreadId);
      const workflowStatus = getValue(columns.workflowStatus);

      // Check if status is complete/done
      const isComplete = workflowStatus?.toLowerCase() === 'complete' ||
                         workflowStatus?.toLowerCase() === 'done';

      // Skip completed items
      if (isComplete) continue;

      // Filter based on mode
      const hasThread = slackThreadId && slackThreadId.trim() !== '';

      if (mode === 'missing') {
        // Only items without a Slack thread ID
        if (hasThread) continue;
      } else if (mode === 'today') {
        // Only items WITH a thread ID that was created today
        if (!hasThread) continue;

        // Parse the thread timestamp to check if it's from today
        // Slack thread_ts format: "1234567890.123456" (seconds since epoch)
        // Extract just the threadTs part if it's in channelId:threadTs format
        const threadInfo = parseSlackThreadValue(slackThreadId);
        if (threadInfo) {
          const threadDate = new Date(parseFloat(threadInfo.threadTs) * 1000);
          const today = new Date();
          const isToday = threadDate.toDateString() === today.toDateString();
          if (!isToday) continue;
        }
      }
      // mode === 'all': include all non-done items

      // Parse owner person IDs from the raw column value
      let ownerPersonIds: number[] = [];
      const ownerRaw = getRawValue(columns.owner);
      if (ownerRaw) {
        try {
          const parsed = JSON.parse(ownerRaw);
          ownerPersonIds = parsed?.personsAndTeams?.map((p: { id: number }) => p.id) ?? [];
        } catch {
          // Ignore parse errors
        }
      }

      backfillItems.push({
        id: item.id,
        name: item.name,
        owner: getValue(columns.owner),
        taskType: getValue(columns.type),
        team: getValue(columns.team),
        workflowStatus,
        dueDate: getValue(columns.date),
        slackThreadId,
        ownerPersonIds,
      });
    }

    return backfillItems;
  } catch (error) {
    console.error('Error fetching items for backfill:', error);
    return [];
  }
}

/**
 * Get all Issue Call items from the board
 * Used for renaming legacy items with verbose naming
 */
export async function getIssueCallItems(): Promise<Array<{
  id: string;
  name: string;
  team: string | null;
}>> {
  const { columns } = config.monday;

  const query = `
    query GetAllItems($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values {
              id
              text
            }
          }
        }
      }
    }
  `;

  try {
    const result = await executeQuery<{
      boards: Array<{
        items_page: {
          items: Array<{
            id: string;
            name: string;
            column_values: Array<{ id: string; text: string }>;
          }>;
        };
      }>;
    }>(query, { boardId: configCompat.monday.boardId });

    const items = result.boards[0]?.items_page?.items ?? [];
    const issueCallItems: Array<{ id: string; name: string; team: string | null }> = [];

    for (const item of items) {
      const getValue = (colId: string): string | null => {
        const col = item.column_values.find(c => c.id === colId);
        return col?.text || null;
      };

      const taskType = getValue(columns.type);

      // Only include Issue Call items
      if (taskType === 'Issue Call') {
        issueCallItems.push({
          id: item.id,
          name: item.name,
          team: getValue(columns.team),
        });
      }
    }

    return issueCallItems;
  } catch (error) {
    console.error('Error fetching issue call items:', error);
    return [];
  }
}
