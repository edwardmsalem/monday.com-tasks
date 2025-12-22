import { config } from '../config/environment.js';
import { MONDAY_API_TIMEOUT_MS, RETRY_DELAYS_MS, MAX_RETRY_ATTEMPTS } from '../config/constants.js';
import type { MondayItem, MondayUser, TaskDebugInfo } from '../types/index.js';
import FormData from 'form-data';
import { mondayCircuit } from './circuitBreaker.js';
import { addJob, registerProcessor } from './jobQueue.js';

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_FILE_URL = 'https://api.monday.com/v2/file';

interface MondayGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Execute a GraphQL query against the Monday.com API
 * Includes timeout to prevent hanging requests (QW-03)
 * Wrapped in circuit breaker to prevent cascading failures (TD-05)
 */
async function executeQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  return mondayCircuit.execute(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MONDAY_API_TIMEOUT_MS);

    try {
      const response = await fetch(MONDAY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': config.monday.apiToken,
          'API-Version': '2024-01',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
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
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Monday API timeout after ${MONDAY_API_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
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
 * Uses Monday's /v2/file endpoint with proper multipart format
 *
 * Key fixes:
 * - Uses form.getHeaders() to ensure correct Content-Type with boundary
 * - Consistent field naming: "file" instead of "image"
 * - Uses variables for itemId and columnId to avoid interpolation issues
 */
export async function uploadFileToItem(
  itemId: string,
  filename: string,
  fileData: Buffer
): Promise<void> {
  // Use variables for itemId and columnId to avoid GraphQL parsing issues
  const query = `mutation AddFileToColumn($itemId: ID!, $columnId: String!, $file: File!) {
    add_file_to_column(item_id: $itemId, column_id: $columnId, file: $file) {
      id
    }
  }`;

  const variables = {
    itemId,
    columnId: config.monday.fileColumnId,
  };

  const form = new FormData();
  form.append('query', query);
  form.append('variables', JSON.stringify(variables));
  // Map "file" field to variables.file (consistent naming)
  form.append('map', JSON.stringify({ file: 'variables.file' }));
  form.append('file', fileData, { filename, contentType: 'application/pdf' });

  // Merge FormData headers (includes correct Content-Type with boundary)
  // Wrapped in circuit breaker to prevent cascading failures (TD-05)
  await mondayCircuit.execute(async () => {
    const response = await fetch(MONDAY_FILE_URL, {
      method: 'POST',
      headers: {
        Authorization: config.monday.apiToken,
        ...form.getHeaders(),
      },
      body: form as unknown as BodyInit,
    });

    const responseText = await response.text();
    console.log('Monday file upload response:', response.status, responseText);

    if (!response.ok) {
      throw new Error(`Monday file upload error: ${response.status} - ${responseText}`);
    }

    // Check for GraphQL errors in successful response
    try {
      const result = JSON.parse(responseText);
      if (result.errors && result.errors.length > 0) {
        throw new Error(`Monday file upload GraphQL error: ${result.errors[0].message}`);
      }
      if (!result.data?.add_file_to_column?.id) {
        throw new Error('Monday file upload returned no file ID');
      }
      console.log('Monday file uploaded successfully, file ID:', result.data.add_file_to_column.id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('Monday file upload')) {
        throw e;
      }
      // If JSON parse fails but response was 200, that's unusual but not fatal
      console.warn('Could not parse Monday file upload response:', e);
    }
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
      boardId: config.monday.boardId,
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
    }>(query, { boardId: config.monday.boardId });

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
      boardId: config.monday.boardId,
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
      boardId: config.monday.boardId,
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
      const response = await fetch(item.pdfUrl);
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
    const slackThreadUrl = slackThreadId
      ? `https://slack.com/app_redirect?channel=${config.slack.channelId}&message_ts=${slackThreadId}`
      : null;

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
