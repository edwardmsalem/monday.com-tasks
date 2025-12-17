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
  ownerId: number;
  taskType: string;
  fromEmail: string | null;
  toEmail: string | null;
  notes: string;
}

/**
 * Create a new item in Monday.com
 */
export async function createItem(input: CreateItemInput): Promise<MondayItem> {
  const { columns } = config.monday;

  // Build column values JSON
  const columnValues: Record<string, unknown> = {
    [columns.date]: { date: input.dueDate },
    [columns.owner]: { personsAndTeams: [{ id: input.ownerId, kind: 'person' }] },
    [columns.status]: { label: input.taskType },
    [columns.notes]: { text: input.notes },
  };

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
