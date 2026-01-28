/**
 * Core API Client
 * Centralized access to Slack, Claude, Monday, and Google APIs via core-api
 *
 * Use this client for new features or when gradually migrating existing code.
 * Provides same functionality as direct API calls but through the centralized hub.
 */

const CORE_API_URL = process.env.CORE_API_URL || 'http://core-api.railway.internal';
const CORE_API_KEY = process.env.CORE_API_KEY;

// Default timeout: 60 seconds (Monday API can be slow)
const DEFAULT_TIMEOUT_MS = 60000;
// Max retries for transient errors
const MAX_RETRIES = 3;
// Retry delays: 2s, 4s, 8s
const RETRY_DELAYS = [2000, 4000, 8000];

/**
 * Check if an error is retryable (timeouts, network errors, 5xx)
 */
function isRetryableError(error: unknown, status?: number): boolean {
  if (status && status >= 500 && status < 600) {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('aborted') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused')
    );
  }
  return false;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function coreApiRequest<T = unknown>(
  endpoint: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    timeout?: number;
    retries?: number;
  } = {}
): Promise<T> {
  const url = `${CORE_API_URL}${endpoint}`;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.retries ?? MAX_RETRIES;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: options.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': CORE_API_KEY || '',
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Core API error (${response.status}): ${errorText}`);

        // Check if this is a retryable error (5xx or timeout in response)
        if (isRetryableError(error, response.status) && attempt < maxRetries) {
          const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
          console.warn(
            `[coreApi] Retryable error on ${endpoint} (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. Retrying in ${delay}ms...`
          );
          lastError = error;
          await sleep(delay);
          continue;
        }

        throw error;
      }

      return response.json() as Promise<T>;
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort (timeout)
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new Error(
          `Core API request to ${endpoint} timed out after ${timeout}ms`
        );
        if (attempt < maxRetries) {
          const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
          console.warn(
            `[coreApi] Timeout on ${endpoint} (attempt ${attempt + 1}/${maxRetries + 1}). Retrying in ${delay}ms...`
          );
          lastError = timeoutError;
          await sleep(delay);
          continue;
        }
        throw timeoutError;
      }

      // Check if other errors are retryable
      if (isRetryableError(error) && attempt < maxRetries) {
        const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.warn(
          `[coreApi] Retryable error on ${endpoint} (attempt ${attempt + 1}/${maxRetries + 1}): ${error instanceof Error ? error.message : error}. Retrying in ${delay}ms...`
        );
        lastError = error instanceof Error ? error : new Error(String(error));
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  // Should not reach here, but just in case
  throw lastError || new Error(`Core API request failed after ${maxRetries + 1} attempts`);
}

// ============================================
// Slack
// ============================================

export interface SlackPostMessageResult {
  ok: boolean;
  ts: string;
  channel: string;
}

export const slack = {
  async postMessage(params: {
    channel: string;
    text?: string;
    blocks?: unknown[];
    threadTs?: string;
    unfurlLinks?: boolean;
    unfurlMedia?: boolean;
  }): Promise<SlackPostMessageResult> {
    return coreApiRequest<SlackPostMessageResult>('/slack/post', {
      body: params as Record<string, unknown>,
    });
  },

  async updateMessage(params: {
    channel: string;
    ts: string;
    text?: string;
    blocks?: unknown[];
  }): Promise<SlackPostMessageResult> {
    return coreApiRequest<SlackPostMessageResult>('/slack/update', {
      body: params as Record<string, unknown>,
    });
  },

  async addReaction(params: { channel: string; ts: string; emoji: string }): Promise<{ ok: boolean }> {
    return coreApiRequest('/slack/react', {
      body: params,
    });
  },

  async removeReaction(params: { channel: string; ts: string; emoji: string }): Promise<{ ok: boolean }> {
    return coreApiRequest('/slack/react', {
      method: 'DELETE',
      body: params,
    });
  },

  async sendDm(params: { user: string; text: string; blocks?: unknown[] }): Promise<SlackPostMessageResult> {
    return coreApiRequest<SlackPostMessageResult>('/slack/dm', {
      body: params as Record<string, unknown>,
    });
  },

  async getThreadReplies(params: { channel: string; ts: string; limit?: number }): Promise<{
    ok: boolean;
    messages: unknown[];
  }> {
    const queryParams = params.limit ? `?limit=${params.limit}` : '';
    return coreApiRequest(`/slack/thread/${params.channel}/${params.ts}${queryParams}`, {
      method: 'GET',
    });
  },

  async lookupUserByEmail(email: string): Promise<{ ok: boolean; user: unknown }> {
    return coreApiRequest(`/slack/user/email/${encodeURIComponent(email)}`, {
      method: 'GET',
    });
  },

  async getChannels(): Promise<Record<string, string>> {
    return coreApiRequest('/slack/channels', { method: 'GET' });
  },

  async getUsers(): Promise<Record<string, string>> {
    return coreApiRequest('/slack/users', { method: 'GET' });
  },

  async uploadFile(params: {
    channel: string;
    threadTs?: string;
    filename: string;
    fileData: string; // base64
    title?: string;
  }): Promise<{ ok: boolean; files: unknown[] }> {
    return coreApiRequest('/slack/file-upload', {
      body: params as Record<string, unknown>,
    });
  },

  async listUsers(params?: { limit?: number; cursor?: string }): Promise<{
    ok: boolean;
    members: unknown[];
    response_metadata?: { next_cursor?: string };
  }> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.cursor) searchParams.set('cursor', params.cursor);
    const query = searchParams.toString();
    return coreApiRequest(`/slack/users/list${query ? `?${query}` : ''}`, {
      method: 'GET',
    });
  },

  async setReminder(params: {
    userId: string;
    text: string;
    time: string | number;
  }): Promise<{ ok: boolean; reminder: unknown }> {
    return coreApiRequest('/slack/reminders', {
      body: params as Record<string, unknown>,
    });
  },

  async getConversationHistory(params: {
    channel: string;
    limit?: number;
    oldest?: string;
    latest?: string;
    inclusive?: boolean;
  }): Promise<{
    ok: boolean;
    messages: unknown[];
    has_more?: boolean;
  }> {
    const searchParams = new URLSearchParams();
    searchParams.set('channel', params.channel);
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.oldest) searchParams.set('oldest', params.oldest);
    if (params.latest) searchParams.set('latest', params.latest);
    if (params.inclusive) searchParams.set('inclusive', 'true');
    return coreApiRequest(`/slack/conversations/history?${searchParams.toString()}`, {
      method: 'GET',
    });
  },
};

// ============================================
// Claude
// ============================================

export interface ClaudeAnalyzeResult {
  ok: boolean;
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export type ClaudeKeyType = 'default' | 'invoices';

export const claude = {
  async analyze(params: {
    content: string;
    prompt?: string;
    systemPrompt?: string;
    model?: string;
    maxTokens?: number;
    keyType?: ClaudeKeyType;
  }): Promise<ClaudeAnalyzeResult> {
    return coreApiRequest<ClaudeAnalyzeResult>('/claude/analyze', {
      body: params as Record<string, unknown>,
    });
  },

  async classify(params: {
    content: string;
    categories: string[];
    model?: string;
    keyType?: ClaudeKeyType;
  }): Promise<{
    ok: boolean;
    category: string;
    confidence: number;
    reasoning: string;
  }> {
    return coreApiRequest('/claude/classify', {
      body: params as Record<string, unknown>,
    });
  },

  async extract<T = unknown>(params: {
    content: string;
    schema: Record<string, unknown>;
    model?: string;
    keyType?: ClaudeKeyType;
  }): Promise<{
    ok: boolean;
    data: T;
  }> {
    return coreApiRequest('/claude/extract', {
      body: params as Record<string, unknown>,
    });
  },

  async toolUse<T = unknown>(params: {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    tools: Array<{
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }>;
    toolChoice?: { type: 'auto' | 'any' | 'tool'; name?: string };
    systemPrompt?: string;
    model?: string;
    maxTokens?: number;
    keyType?: ClaudeKeyType;
  }): Promise<{
    toolUse: { id: string; name: string; input: T } | null;
    text: string | null;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
    stopReason: string;
  }> {
    return coreApiRequest('/claude/tool-use', {
      body: params as Record<string, unknown>,
    });
  },
};

// ============================================
// Monday
// ============================================

export interface MondayItem {
  id: string;
  name: string;
}

export interface MondayUpdate {
  id: string;
  body: string;
  text_body?: string;
  created_at: string;
  creator?: { id: string; name: string };
  assets?: Array<{ id: string; name: string; url: string; file_extension: string; file_size: number }>;
}

export interface MondayUser {
  id: string;
  name: string;
  email: string;
  photo_thumb?: string;
  title?: string;
  enabled: boolean;
}

export const monday = {
  async createItem(params: {
    boardId: string;
    itemName: string;
    groupId?: string;
    columnValues?: Record<string, unknown>;
  }): Promise<MondayItem> {
    return coreApiRequest<MondayItem>('/monday/items', {
      body: params as Record<string, unknown>,
    });
  },

  async updateItem(params: {
    itemId: string;
    boardId: string;
    columnValues: Record<string, unknown>;
  }): Promise<MondayItem> {
    return coreApiRequest<MondayItem>(`/monday/items/${params.itemId}`, {
      method: 'PATCH',
      body: {
        boardId: params.boardId,
        columnValues: params.columnValues,
      },
    });
  },

  async getItem(itemId: string): Promise<MondayItem | null> {
    return coreApiRequest<MondayItem | null>(`/monday/items/${itemId}`, {
      method: 'GET',
    });
  },

  async getBoardItems(boardId: string, limit?: number): Promise<MondayItem[]> {
    const query = limit ? `?limit=${limit}` : '';
    return coreApiRequest<MondayItem[]>(`/monday/boards/${boardId}/items${query}`, {
      method: 'GET',
    });
  },

  async searchItems(params: {
    boardId: string;
    columnId: string;
    value: string;
  }): Promise<MondayItem[]> {
    return coreApiRequest<MondayItem[]>(
      `/monday/boards/${params.boardId}/search`,
      {
        body: {
          columnId: params.columnId,
          value: params.value,
        },
      }
    );
  },

  async getBoardColumns(boardId: string): Promise<unknown[]> {
    return coreApiRequest<unknown[]>(
      `/monday/boards/${boardId}/columns`,
      { method: 'GET' }
    );
  },

  async createUpdate(params: { itemId: string; body: string }): Promise<MondayUpdate> {
    return coreApiRequest<MondayUpdate>(`/monday/items/${params.itemId}/updates`, {
      body: { body: params.body },
    });
  },

  async getItemUpdates(itemId: string, limit?: number): Promise<MondayUpdate[]> {
    const query = limit ? `?limit=${limit}` : '';
    return coreApiRequest<MondayUpdate[]>(`/monday/items/${itemId}/updates${query}`, {
      method: 'GET',
    });
  },

  async uploadFileToItem(params: {
    itemId: string;
    columnId: string;
    filename: string;
    fileData: string; // base64
  }): Promise<{ id: string; name: string; url: string }> {
    return coreApiRequest(`/monday/items/${params.itemId}/files`, {
      body: {
        columnId: params.columnId,
        filename: params.filename,
        fileData: params.fileData,
      },
    });
  },

  async uploadFileToUpdate(params: {
    updateId: string;
    filename: string;
    fileData: string; // base64
  }): Promise<{ id: string; name: string; url: string }> {
    return coreApiRequest(`/monday/updates/${params.updateId}/files`, {
      body: {
        filename: params.filename,
        fileData: params.fileData,
      },
    });
  },

  async getAllUsers(): Promise<MondayUser[]> {
    // Users list can be slow to fetch - use longer timeout (90s)
    return coreApiRequest<MondayUser[]>('/monday/users', {
      method: 'GET',
      timeout: 90000,
    });
  },

  async findUserByEmail(email: string): Promise<MondayUser | null> {
    try {
      return await coreApiRequest<MondayUser>('/monday/users/find-by-email', {
        body: { email },
      });
    } catch (error) {
      // Return null if user not found
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  },

  async query(query: string, variables?: Record<string, unknown>): Promise<unknown> {
    // Monday queries can be slow for large datasets - use longer timeout (90s)
    return coreApiRequest('/monday/query', {
      body: { query, variables },
      timeout: 90000,
    });
  },
};

// ============================================
// Google (Gmail, Docs, Sheets)
// ============================================

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

export interface GmailMessageHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
  historyId?: string;
  internalDate?: string;
}

export const google = {
  gmail: {
    async listLabels(): Promise<GmailLabel[]> {
      return coreApiRequest<GmailLabel[]>('/google/gmail/labels', {
        method: 'GET',
      });
    },

    async listMessages(params?: {
      maxResults?: number;
      q?: string;
      labelIds?: string[];
    }): Promise<GmailMessage[]> {
      const searchParams = new URLSearchParams();
      if (params?.maxResults) searchParams.set('maxResults', String(params.maxResults));
      if (params?.q) searchParams.set('q', params.q);
      if (params?.labelIds && params.labelIds.length > 0) {
        searchParams.set('labelIds', params.labelIds.join(','));
      }
      const query = searchParams.toString();
      return coreApiRequest<GmailMessage[]>(`/google/gmail/messages${query ? `?${query}` : ''}`, {
        method: 'GET',
      });
    },

    async getMessage(id: string, format?: 'full' | 'metadata' | 'minimal'): Promise<GmailMessage> {
      const query = format ? `?format=${format}` : '';
      return coreApiRequest<GmailMessage>(`/google/gmail/messages/${id}${query}`, {
        method: 'GET',
      });
    },

    async sendEmail(params: {
      to: string;
      subject: string;
      body: string;
    }): Promise<{ ok: boolean; messageId: string }> {
      return coreApiRequest('/google/gmail/send', {
        body: params,
      });
    },

    async modifyLabels(params: {
      messageId: string;
      addLabels?: string[];
      removeLabels?: string[];
    }): Promise<{ ok: boolean }> {
      return coreApiRequest(`/google/gmail/messages/${params.messageId}`, {
        method: 'PATCH',
        body: {
          addLabelIds: params.addLabels,
          removeLabelIds: params.removeLabels,
        },
      });
    },
  },

  sheets: {
    async getValues(
      sheetId: string,
      range?: string
    ): Promise<{ values: unknown[][] }> {
      const query = range ? `?range=${encodeURIComponent(range)}` : '';
      return coreApiRequest(`/google/sheets/${sheetId}${query}`, {
        method: 'GET',
      });
    },

    async updateValues(
      sheetId: string,
      params: { range: string; values: unknown[][] }
    ): Promise<{ ok: boolean; updatedCells: number }> {
      return coreApiRequest(`/google/sheets/${sheetId}`, {
        method: 'PUT',
        body: params as Record<string, unknown>,
      });
    },

    async appendValues(
      sheetId: string,
      params: { range: string; values: unknown[][] }
    ): Promise<{ ok: boolean; updatedCells: number }> {
      return coreApiRequest(`/google/sheets/${sheetId}`, {
        body: params as Record<string, unknown>,
      });
    },

    async create(params: {
      title: string;
      sheetTitle?: string;
    }): Promise<{ spreadsheetId: string; spreadsheetUrl: string; title: string }> {
      return coreApiRequest('/google/sheets', {
        body: params,
      });
    },
  },

  docs: {
    async getDocument(docId: string): Promise<unknown> {
      return coreApiRequest(`/google/docs/${docId}`, {
        method: 'GET',
      });
    },

    async getDocumentText(docId: string): Promise<{ text: string }> {
      return coreApiRequest(`/google/docs/${docId}/text`, {
        method: 'GET',
      });
    },
  },

  drive: {
    async shareFile(
      fileId: string,
      params: {
        email?: string;
        role?: 'reader' | 'writer' | 'commenter';
        type?: 'user' | 'anyone';
      }
    ): Promise<{ ok: boolean; permissionId: string }> {
      return coreApiRequest('/google/drive/share', {
        body: {
          fileId,
          email: params.email,
          role: params.role || 'reader',
          type: params.type || 'user',
        },
      });
    },
  },
};

// ============================================
// ConvertAPI (PDF conversion)
// ============================================

export interface ConvertedFile {
  filename: string;
  data: string; // base64
  url: string;
}

export const convertApi = {
  async emlToPdf(params: { emlContent: string; filename: string }): Promise<ConvertedFile> {
    return coreApiRequest<ConvertedFile>('/convertapi/eml-to-pdf', {
      body: params,
    });
  },

  async htmlToPdf(params: { htmlContent: string; filename: string }): Promise<ConvertedFile> {
    return coreApiRequest<ConvertedFile>('/convertapi/html-to-pdf', {
      body: params,
    });
  },

  async textToPdf(params: {
    textContent: string;
    subject: string;
    from?: string;
    date?: string;
  }): Promise<ConvertedFile> {
    return coreApiRequest<ConvertedFile>('/convertapi/text-to-pdf', {
      body: params,
    });
  },

  async downloadPdf(url: string): Promise<Buffer> {
    const result = await coreApiRequest<{ data: string }>('/convertapi/download', {
      body: { url },
    });
    return Buffer.from(result.data, 'base64');
  },
};

// ============================================
// SMS (via sim-banks)
// ============================================

export const sms = {
  async send(params: {
    to: string;
    message: string;
    bankId?: string;
    slot?: string;
  }): Promise<{ ok: boolean; bankId: string; slot: string }> {
    return coreApiRequest('/sms/send', {
      body: params as Record<string, unknown>,
    });
  },

  async getStatus(bankId: string, slot: string): Promise<unknown> {
    return coreApiRequest(`/sms/status/${bankId}/${slot}`, {
      method: 'GET',
    });
  },

  async getBanks(): Promise<{ banks: unknown[] }> {
    return coreApiRequest('/sms/banks', {
      method: 'GET',
    });
  },

  async activate(phone: string): Promise<{
    ok: boolean;
    bankId: string;
    slot: string;
    phone: string;
  }> {
    return coreApiRequest('/sms/activate', {
      body: { phone },
    });
  },

  async find(phone: string): Promise<{
    ok: boolean;
    bankId: string;
    slot: string;
    status: unknown;
  }> {
    return coreApiRequest('/sms/find', {
      body: { phone },
    });
  },
};

// ============================================
// Config (channel/board IDs from core-api)
// ============================================

export interface CoreConfig {
  slack: {
    channels: Record<string, string>;
    users: Record<string, string>;
  };
  monday: {
    boards: Record<string, string>;
  };
  google: {
    sheets: Record<string, string>;
  };
  claude: {
    models: {
      default: string;
      fast: string;
      thinking: string;
      opus: string;
    };
  };
}

let cachedConfig: CoreConfig | null = null;

/**
 * Fetch config from core-api (channels, boards, sheets)
 * Results are cached after first fetch
 */
export async function getConfig(): Promise<CoreConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }
  cachedConfig = await coreApiRequest<CoreConfig>('/config', { method: 'GET' });
  return cachedConfig;
}

/**
 * Get cached config synchronously (must call initConfig first)
 * Throws if config not initialized
 */
export function getCachedConfig(): CoreConfig {
  if (!cachedConfig) {
    throw new Error('Config not initialized. Call initConfig() at startup.');
  }
  return cachedConfig;
}

/**
 * Initialize config at startup - call this before server starts
 */
export async function initConfig(): Promise<CoreConfig> {
  console.log('[coreApi] Fetching config from core-api...');
  const config = await getConfig();
  // Ensure claude.models exists (core-api may not have been updated yet)
  if (!config.claude?.models) {
    (config as any).claude = {
      models: {
        default: 'claude-sonnet-4-5-20250929',
        fast: 'claude-haiku-4-5-20250929',
        thinking: 'claude-sonnet-4-5-20250929',
        opus: 'claude-opus-4-5-20251101',
      },
    };
  }
  console.log('[coreApi] Config loaded:', {
    slackChannels: Object.keys(config.slack.channels).length,
    mondayBoards: Object.keys(config.monday.boards).length,
    googleSheets: Object.keys(config.google.sheets).length,
    claudeModel: config.claude.models.default,
  });
  return config;
}

export default { slack, claude, monday, google, sms, convertApi, getConfig, getCachedConfig, initConfig };
