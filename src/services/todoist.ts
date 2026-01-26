/**
 * Todoist Integration Service
 *
 * Projection-only integration with Todoist.
 * Projects tasks from Monday to Todoist for personal task management.
 *
 * Features:
 * - One-way sync: Monday → Todoist (projection only, no sync back)
 * - Feature-flagged off by default (ENABLE_TODOIST_SYNC=false)
 * - Uses Todoist REST API v2
 *
 * Note: This is a "sink" - data flows in but not out.
 * Completion in Todoist does NOT update Monday.
 */

import { config, configCompat } from '../config/environment.js';

const TODOIST_API_URL = 'https://api.todoist.com/rest/v2';

interface TodoistTask {
  id: string;
  content: string;
  description: string;
  due: {
    date: string;
    datetime?: string;
    string?: string;
  } | null;
  priority: number; // 1 = normal, 4 = urgent
  project_id?: string;
  labels: string[];
}

interface CreateTaskInput {
  content: string;
  description?: string;
  dueDate?: string | null;  // YYYY-MM-DD format
  priority?: 'high' | 'medium' | 'low';
  labels?: string[];
  projectId?: string;
}

/**
 * Check if Todoist integration is enabled
 */
export function isEnabled(): boolean {
  return config.todoist.enabled && !!config.todoist.apiToken;
}

/**
 * Execute a Todoist API request
 */
async function todoistRequest<T>(
  endpoint: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: Record<string, unknown>
): Promise<T> {
  if (!config.todoist.apiToken) {
    throw new Error('Todoist API token not configured');
  }

  const response = await fetch(`${TODOIST_API_URL}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${config.todoist.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist API error: ${response.status} ${errorText}`);
  }

  // DELETE returns 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Map priority to Todoist priority level (1-4, 4 is highest)
 */
function mapPriority(priority: 'high' | 'medium' | 'low' | undefined): number {
  switch (priority) {
    case 'high': return 4;
    case 'medium': return 3;
    case 'low': return 2;
    default: return 1;
  }
}

/**
 * Create a task in Todoist
 * Returns the created task or null if Todoist is disabled
 */
export async function createTask(input: CreateTaskInput): Promise<TodoistTask | null> {
  if (!isEnabled()) {
    console.log('Todoist sync disabled - skipping task creation');
    return null;
  }

  try {
    const taskData: Record<string, unknown> = {
      content: input.content,
      priority: mapPriority(input.priority),
    };

    if (input.description) {
      taskData.description = input.description;
    }

    if (input.dueDate) {
      taskData.due_date = input.dueDate;
    }

    if (input.labels && input.labels.length > 0) {
      taskData.labels = input.labels;
    }

    if (input.projectId) {
      taskData.project_id = input.projectId;
    }

    const task = await todoistRequest<TodoistTask>('/tasks', 'POST', taskData);
    console.log('Todoist task created:', task.id, input.content.substring(0, 50));
    return task;
  } catch (error) {
    console.error('Failed to create Todoist task:', error);
    return null;
  }
}

/**
 * Project a Monday task to Todoist
 * Used after workflow creates a Monday item
 */
export async function projectFromMonday(params: {
  mondayItemId: string;
  taskName: string;
  taskType: string;
  owner: string;
  dueDate: string | null;
  priority: 'high' | 'medium' | 'low';
  notes: string;
}): Promise<TodoistTask | null> {
  if (!isEnabled()) {
    return null;
  }

  const { mondayItemId, taskName, taskType, owner, dueDate, priority, notes } = params;

  // Build task content with type prefix
  const content = `[${taskType}] ${taskName}`;

  // Build description with Monday link and notes
  const mondayUrl = `https://salemseats.monday.com/boards/${configCompat.monday.boardId}/pulses/${mondayItemId}`;
  const description = [
    `📋 **Monday:** ${mondayUrl}`,
    `👤 **Owner:** ${owner}`,
    notes ? `\n📝 ${notes}` : '',
  ].filter(Boolean).join('\n');

  // Add labels based on task type
  const labels = [taskType.toLowerCase().replace(/\s+/g, '-')];
  if (priority === 'high') {
    labels.push('urgent');
  }

  return createTask({
    content,
    description,
    dueDate,
    priority,
    labels,
  });
}

/**
 * Get all Todoist projects
 * Useful for finding project IDs for configuration
 */
export async function getProjects(): Promise<Array<{ id: string; name: string }>> {
  if (!isEnabled()) {
    return [];
  }

  try {
    return await todoistRequest<Array<{ id: string; name: string }>>('/projects');
  } catch (error) {
    console.error('Failed to get Todoist projects:', error);
    return [];
  }
}

/**
 * Close (complete) a Todoist task
 * Note: This is not currently used since we don't sync back from Todoist
 */
export async function closeTask(taskId: string): Promise<boolean> {
  if (!isEnabled()) {
    return false;
  }

  try {
    await todoistRequest(`/tasks/${taskId}/close`, 'POST');
    console.log('Todoist task closed:', taskId);
    return true;
  } catch (error) {
    console.error('Failed to close Todoist task:', error);
    return false;
  }
}
