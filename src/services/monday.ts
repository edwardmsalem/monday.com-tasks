import { config } from '../config/environment.js';
import type { MondayItem, MondayUser } from '../types/index.js';
import FormData from 'form-data';

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_FILE_URL = 'https://api.monday.com/v2/file';

interface MondayGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Execute a GraphQL query against the Monday.com API
 */
async function executeQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': config.monday.apiToken,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Monday API error: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as MondayGraphQLResponse<T>;

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Monday GraphQL error: ${result.errors.map(e => e.message).join(', ')}`);
  }

  if (!result.data) {
    throw new Error('Monday API returned no data');
  }

  return result.data;
}

interface CreateItemInput {
  name: string;
  dueDate: string;
  ownerIds: number[];  // Support multiple owners
  taskType: string;
  source: string;      // Source (Forwarding Tasks, Slack Tasks, etc.)
  team?: string;       // Sports team (optional)
  fromEmail: string | null;
  toEmail: string | null;
  notes: string;
}

/**
 * Create a new item in Monday.com
 */
export async function createItem(input: CreateItemInput): Promise<MondayItem> {
  const { columns } = config.monday;

  // Build column values JSON - support multiple owners
  const columnValues: Record<string, unknown> = {
    [columns.date]: { date: input.dueDate },
    [columns.owner]: { personsAndTeams: input.ownerIds.map(id => ({ id, kind: 'person' })) },
    [columns.type]: { label: input.taskType },
    [columns.source]: { label: input.source },
    [columns.notes]: { text: input.notes },
  };

  // Set team if provided (dropdown column uses labels array)
  if (input.team) {
    columnValues[columns.team] = { labels: [input.team] };
  }

  if (input.fromEmail) {
    columnValues[columns.from] = { email: input.fromEmail, text: input.fromEmail };
  }

  if (input.toEmail) {
    columnValues[columns.to] = { email: input.toEmail, text: input.toEmail };
  }

  const query = `
    mutation CreateItem($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId
        item_name: $itemName
        column_values: $columnValues
      ) {
        id
        name
      }
    }
  `;

  const result = await executeQuery<{ create_item: MondayItem }>(query, {
    boardId: config.monday.boardId,
    itemName: input.name,
    columnValues: JSON.stringify(columnValues),
  });

  return result.create_item;
}

/**
 * Update the Slack thread ID column on an item
 */
export async function updateSlackThreadId(itemId: string, threadTs: string): Promise<void> {
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
    boardId: config.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.slackThreadId]: threadTs,
    }),
  });
}

/**
 * Upload a file to an item's file column
 */
export async function uploadFileToItem(
  itemId: string,
  filename: string,
  fileData: Buffer
): Promise<void> {
  const query = `
    mutation AddFile($itemId: ID!, $columnId: String!) {
      add_file_to_column(
        item_id: $itemId
        column_id: $columnId
        file: "file"
      ) {
        id
      }
    }
  `;

  // Monday.com file upload requires multipart form data
  const form = new FormData();
  form.append('query', query);
  form.append(
    'variables',
    JSON.stringify({
      itemId,
      columnId: config.monday.fileColumnId,
    })
  );
  form.append('file', fileData, { filename });

  const response = await fetch(MONDAY_FILE_URL, {
    method: 'POST',
    headers: {
      Authorization: config.monday.apiToken,
    },
    body: form as unknown as BodyInit,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Monday file upload error: ${response.status} - ${text}`);
  }
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
  return `${config.monday.boardUrl}/pulses/${itemId}`;
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
 */
export async function findItemBySlackThread(slackThreadTs: string): Promise<string | null> {
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
    const result = await executeQuery<{
      items_page_by_column_values: { items: Array<{ id: string }> };
    }>(query, {
      boardId: config.monday.boardId,
      columnId: config.monday.columns.slackThreadId,
      value: slackThreadTs,
    });

    return result.items_page_by_column_values.items[0]?.id ?? null;
  } catch (error) {
    console.error('Error finding item by Slack thread:', error);
    return null;
  }
}

/**
 * Get the Slack thread ID from a Monday item
 */
export async function getSlackThreadId(itemId: string): Promise<string | null> {
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

    return result.items[0]?.column_values[0]?.text || null;
  } catch (error) {
    console.error('Error getting Slack thread ID:', error);
    return null;
  }
}

/**
 * Create an update (comment) on a Monday item
 */
export async function createUpdate(itemId: string, body: string): Promise<string> {
  const query = `
    mutation CreateUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
  `;

  const result = await executeQuery<{ create_update: { id: string } }>(query, {
    itemId,
    body,
  });

  return result.create_update.id;
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
    boardId: config.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.workflowStatus]: { label: status },
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
    boardId: config.monday.boardId,
    itemId,
    columnValues: JSON.stringify({
      [config.monday.columns.type]: { label: taskType },
    }),
  });
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
