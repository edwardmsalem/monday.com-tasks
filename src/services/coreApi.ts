/**
 * Core API Client
 * Centralized access to Slack, Claude, Monday, and Google APIs via core-api
 *
 * Use this client for new features or when gradually migrating existing code.
 * Provides same functionality as direct API calls but through the centralized hub.
 */

const CORE_API_URL = process.env.CORE_API_URL || 'http://core-api.railway.internal';
const CORE_API_KEY = process.env.CORE_API_KEY;

async function coreApiRequest<T = unknown>(
  endpoint: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const url = `${CORE_API_URL}${endpoint}`;

  const response = await fetch(url, {
    method: options.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': CORE_API_KEY || '',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Core API error (${response.status}): ${error}`);
  }

  return response.json() as Promise<T>;
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
};

// ============================================
// Monday
// ============================================

export interface MondayItem {
  id: string;
  name: string;
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

  async getBoardItems(boardId: string): Promise<MondayItem[]> {
    const result = await coreApiRequest<{ items: MondayItem[] }>(`/monday/boards/${boardId}/items`, {
      method: 'GET',
    });
    return result.items;
  },

  async searchItems(params: {
    boardId: string;
    columnId: string;
    value: string;
  }): Promise<MondayItem[]> {
    const result = await coreApiRequest<{ items: MondayItem[] }>(
      `/monday/boards/${params.boardId}/search`,
      {
        body: {
          columnId: params.columnId,
          value: params.value,
        },
      }
    );
    return result.items;
  },

  async getBoardColumns(boardId: string): Promise<unknown[]> {
    const result = await coreApiRequest<{ columns: unknown[] }>(
      `/monday/boards/${boardId}/columns`,
      { method: 'GET' }
    );
    return result.columns;
  },
};

// ============================================
// Google (Gmail, Docs, Sheets)
// ============================================

export const google = {
  gmail: {
    async listMessages(params?: {
      maxResults?: number;
      q?: string;
    }): Promise<{ messages: unknown[] }> {
      const searchParams = new URLSearchParams();
      if (params?.maxResults) searchParams.set('maxResults', String(params.maxResults));
      if (params?.q) searchParams.set('q', params.q);
      const query = searchParams.toString();
      return coreApiRequest(`/google/gmail/messages${query ? `?${query}` : ''}`, {
        method: 'GET',
      });
    },

    async getMessage(id: string): Promise<unknown> {
      return coreApiRequest(`/google/gmail/messages/${id}`, {
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
// Config (channel/board IDs)
// ============================================

export async function getConfig(): Promise<{
  slack: {
    channels: Record<string, string>;
    users: Record<string, string>;
  };
  monday: {
    boards: Record<string, string>;
  };
}> {
  return coreApiRequest('/config', { method: 'GET' });
}

export default { slack, claude, monday, google, sms, getConfig };
