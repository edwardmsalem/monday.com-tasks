/**
 * Presale Scanner Service
 *
 * Scans Gmail for exclusive presale emails from sports teams,
 * deduplicates them, and posts notifications to Slack with PDFs.
 *
 * Flow:
 * 1. Get sports team labels from Gmail (cached daily)
 * 2. Search Gmail for presale emails in the last hour
 * 3. Group by dedup key (sender domain + subject + date)
 * 4. Check if already posted
 * 5. For new presales, use AI to check exclusivity
 * 6. If exclusive, convert to PDF and post to Slack
 * 7. Auto-cleanup old entries
 */

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import { config } from '../config/environment.js';
import { gmailCircuit, slackCircuit } from './circuitBreaker.js';
import { getClient as getSlackClient } from './slack.js';
import {
  getCachedLabels,
  updateLabelCache,
  isPresaleSeen,
  markPresaleSeen,
  updateLastScan,
  cleanupOldEntries,
  isOpportunityDeclined,
} from './presaleState.js';
import { checkPresaleExclusivitySafe, type ExclusivityCheckResult } from './presaleAI.js';
import { convertHtmlToPdf } from './convertApi.js';

// ============================================================================
// Types
// ============================================================================

interface PresaleGroup {
  dedupKey: string;
  senderDomain: string;
  subject: string;
  date: string;  // YYYY-MM-DD
  team: string;
  sport: string;  // NBA, MLB, NFL, etc.
  labelName: string;
  emailCount: number;
  emails: GmailMessage[];
}

interface GmailMessage {
  id: string;
  subject: string;
  from: string;
  to: string | null;
  date: Date;
  bodyText: string;
  bodyHtml: string | null;
  labelIds: string[];
}

export interface ScanResult {
  scanned: number;
  newPresales: number;
  posted: string[];
  skipped: number;
  errors: string[];
}

// ============================================================================
// Sport Emoji Mapping
// ============================================================================

const SPORT_EMOJIS: Record<string, string> = {
  'NBA': '🏀',
  'MLB': '⚾',
  'NFL': '🏈',
  'NHL': '🏒',
  'MLS': '⚽',
  'NCAA': '🎓',
};

function getSportEmoji(sport: string): string {
  return SPORT_EMOJIS[sport.toUpperCase()] ?? '🎫';
}

// ============================================================================
// Gmail Client
// ============================================================================

let gmailClient: gmail_v1.Gmail | null = null;

async function getGmailClient(): Promise<gmail_v1.Gmail> {
  if (gmailClient) return gmailClient;

  const { clientId, clientSecret, refreshToken } = config.google;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Gmail OAuth not configured. Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN'
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'https://developers.google.com/oauthplayground'
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
  return gmailClient;
}

// ============================================================================
// Step 1: Get Sports Team Labels
// ============================================================================

/**
 * Get all sports team labels from Gmail
 * Filters for prefixes: NBA/, MLB/, NFL/, NHL/, MLS/, NCAA/
 * Caches the result for 24 hours
 */
async function getSportsTeamLabels(): Promise<string[]> {
  // Check cache first
  const cached = getCachedLabels();
  if (cached) {
    return cached;
  }

  console.log('[PresaleScanner] Fetching Gmail labels...');
  const gmail = await getGmailClient();

  const response = await gmailCircuit.execute(() =>
    gmail.users.labels.list({ userId: 'me' })
  );

  const labels = response.data.labels ?? [];
  const prefixes = config.presale.sportsLabelPrefixes;

  // Filter for sports team labels
  const sportsLabels = labels
    .filter(label => {
      const name = label.name ?? '';
      return prefixes.some(prefix => name.startsWith(prefix));
    })
    .map(label => label.name!)
    .sort();

  console.log(`[PresaleScanner] Found ${sportsLabels.length} sports team labels`);

  // Cache the result
  updateLabelCache(sportsLabels);

  return sportsLabels;
}

/**
 * Get label IDs for the given label names
 */
async function getLabelIds(labelNames: string[]): Promise<Map<string, string>> {
  const gmail = await getGmailClient();

  const response = await gmailCircuit.execute(() =>
    gmail.users.labels.list({ userId: 'me' })
  );

  const labels = response.data.labels ?? [];
  const labelMap = new Map<string, string>();

  for (const label of labels) {
    if (label.id && label.name && labelNames.includes(label.name)) {
      labelMap.set(label.name, label.id);
    }
  }

  return labelMap;
}

// ============================================================================
// Step 2: Search Gmail
// ============================================================================

/**
 * Build Gmail search query for presale emails
 * - Last N minutes
 * - Has any sports team label
 * - Contains "presale" in subject or body
 */
function buildSearchQuery(labelIds: string[], lookbackMinutes: number): string {
  // Calculate the after timestamp
  const after = new Date(Date.now() - lookbackMinutes * 60 * 1000);
  const afterUnix = Math.floor(after.getTime() / 1000);

  // Build label query (any of these labels)
  // Gmail query uses: {label:A label:B} for OR
  const labelQuery = labelIds.length > 0
    ? `{${labelIds.map(id => `label:${id}`).join(' ')}}`
    : '';

  // Search for presale in subject or body
  const presaleQuery = '(subject:presale OR presale)';

  // Combine queries
  const query = `${labelQuery} ${presaleQuery} after:${afterUnix}`.trim();

  return query;
}

/**
 * Fetch a single Gmail message with full details
 */
async function fetchGmailMessage(gmail: gmail_v1.Gmail, messageId: string): Promise<GmailMessage | null> {
  try {
    const response = await gmailCircuit.execute(() =>
      gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      })
    );

    const msg = response.data;
    const headers = msg.payload?.headers ?? [];

    const getHeader = (name: string): string | null => {
      const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
      return header?.value ?? null;
    };

    const subject = getHeader('Subject') ?? '';
    const from = getHeader('From') ?? '';
    const to = getHeader('To');
    const dateStr = getHeader('Date');

    let date = new Date();
    if (dateStr) {
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        date = parsed;
      }
    }

    return {
      id: messageId,
      subject,
      from,
      to,
      date,
      bodyText: extractEmailBody(msg.payload),
      bodyHtml: extractEmailBodyHtml(msg.payload),
      labelIds: msg.labelIds ?? [],
    };
  } catch (error) {
    console.error(`[PresaleScanner] Failed to fetch message ${messageId}:`, error);
    return null;
  }
}

/**
 * Extract plain text body from Gmail message payload
 */
function extractEmailBody(payload: any): string {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractEmailBody(part);
      if (text) return text;
    }
  }

  return '';
}

/**
 * Extract HTML body from Gmail message payload
 */
function extractEmailBodyHtml(payload: any): string | null {
  if (!payload) return null;

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      const nested = extractEmailBodyHtml(part);
      if (nested) return nested;
    }
  }

  return null;
}

/**
 * Search Gmail for presale emails
 */
async function searchPresaleEmails(
  sportsLabels: string[],
  lookbackMinutes: number
): Promise<GmailMessage[]> {
  const gmail = await getGmailClient();

  // Get label IDs
  const labelIdMap = await getLabelIds(sportsLabels);
  const labelIds = Array.from(labelIdMap.values());

  if (labelIds.length === 0) {
    console.log('[PresaleScanner] No sports team labels found, skipping search');
    return [];
  }

  // Build and execute search
  const query = buildSearchQuery(sportsLabels, lookbackMinutes);
  console.log(`[PresaleScanner] Gmail search query: ${query}`);

  const searchResponse = await gmailCircuit.execute(() =>
    gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
    })
  );

  const messages = searchResponse.data.messages ?? [];
  console.log(`[PresaleScanner] Gmail returned ${messages.length} emails`);

  if (messages.length === 0) {
    return [];
  }

  // Fetch full message details
  const results: GmailMessage[] = [];
  for (const msg of messages) {
    if (msg.id) {
      const fullMsg = await fetchGmailMessage(gmail, msg.id);
      if (fullMsg) {
        results.push(fullMsg);
      }
    }
  }

  return results;
}

// ============================================================================
// Step 3: Group by Dedup Key
// ============================================================================

/**
 * Extract sender domain from email address
 * "John Doe <john@rangers.com>" -> "rangers.com"
 */
function extractSenderDomain(from: string): string {
  const emailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s<]+@[^\s>]+)/);
  if (emailMatch) {
    const email = emailMatch[1] || emailMatch[0];
    const domain = email.split('@')[1];
    return domain?.toLowerCase() ?? 'unknown';
  }
  return 'unknown';
}

/**
 * Normalize subject for dedup (remove RE:, FWD:, etc.)
 */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(fwd?|re|fw):\s*/gi, '')
    .replace(/^(fwd?|re|fw):\s*/gi, '')
    .trim()
    .toLowerCase();
}

/**
 * Extract team name and sport from label
 * "NBA/Lakers" -> { team: "Lakers", sport: "NBA" }
 */
function extractFromLabel(labelName: string): { team: string; sport: string } {
  const parts = labelName.split('/');
  if (parts.length >= 2) {
    return {
      sport: parts[0],
      team: parts[parts.length - 1],
    };
  }
  return {
    sport: '',
    team: labelName,
  };
}

/**
 * Find the sports team label for a message
 */
function findTeamLabel(message: GmailMessage, sportsLabels: string[], labelIdMap: Map<string, string>): string | null {
  // Reverse map: id -> name
  const idToName = new Map<string, string>();
  for (const [name, id] of labelIdMap.entries()) {
    idToName.set(id, name);
  }

  for (const labelId of message.labelIds) {
    const labelName = idToName.get(labelId);
    if (labelName && sportsLabels.includes(labelName)) {
      return labelName;
    }
  }

  return null;
}

/**
 * Group emails by dedup key
 * Key = sender domain + normalized subject + date (YYYY-MM-DD)
 */
async function groupByDedupKey(
  emails: GmailMessage[],
  sportsLabels: string[]
): Promise<PresaleGroup[]> {
  // Get label ID mapping
  const labelIdMap = await getLabelIds(sportsLabels);

  const groups = new Map<string, PresaleGroup>();

  for (const email of emails) {
    const senderDomain = extractSenderDomain(email.from);
    const normalizedSubject = normalizeSubject(email.subject);
    const dateStr = email.date.toISOString().split('T')[0]; // YYYY-MM-DD
    const labelName = findTeamLabel(email, sportsLabels, labelIdMap);

    // Skip if no sports team label found
    if (!labelName) {
      console.log(`[PresaleScanner] Skipping email without sports label: ${email.subject.substring(0, 50)}`);
      continue;
    }

    const { team, sport } = extractFromLabel(labelName);
    const dedupKey = `${senderDomain}:${normalizedSubject}:${dateStr}`;

    if (!groups.has(dedupKey)) {
      groups.set(dedupKey, {
        dedupKey,
        senderDomain,
        subject: email.subject, // Use original subject for display
        date: dateStr,
        team,
        sport,
        labelName,
        emailCount: 0,
        emails: [],
      });
    }

    const group = groups.get(dedupKey)!;
    group.emailCount++;
    group.emails.push(email);
  }

  console.log(`[PresaleScanner] Grouped into ${groups.size} unique presales`);
  return Array.from(groups.values());
}

// ============================================================================
// Step 6: Post to Slack
// ============================================================================

/**
 * Post presale notification to Slack with PDF attachment
 */
async function postPresaleToSlack(
  group: PresaleGroup,
  exclusivity: ExclusivityCheckResult
): Promise<string> {
  const slack = getSlackClient();
  const channelId = config.presale.slackChannel;

  if (!channelId) {
    throw new Error('SLACK_PRESALE_CHANNEL not configured');
  }

  // Get HTML from the first email for PDF
  const firstEmail = group.emails[0];
  const htmlContent = firstEmail.bodyHtml;

  // Get sport emoji
  const sportEmoji = getSportEmoji(group.sport);

  // Build type-specific line
  let typeLine: string;
  if (exclusivity.presaleType === 'registration') {
    const dateInfo = exclusivity.presaleDate ? `🗓️ Presale starts ${exclusivity.presaleDate}` : '';
    typeLine = `📝 Registration${dateInfo ? ` • ${dateInfo}` : ''}`;
  } else if (exclusivity.presaleType === 'upcoming') {
    const dateInfo = exclusivity.presaleDate ? `🗓️ ${exclusivity.presaleDate}` : '';
    const codeInfo = exclusivity.presaleCode ? `🔑 Code: \`${exclusivity.presaleCode}\`` : '';
    const parts = [dateInfo, codeInfo].filter(Boolean).join(' • ');
    typeLine = `📅 Upcoming${parts ? ` • ${parts}` : ''}`;
  } else {
    const codeInfo = exclusivity.presaleCode ? `🔑 Code: \`${exclusivity.presaleCode}\`` : '';
    typeLine = `🎟️ Live Now${codeInfo ? ` • ${codeInfo}` : ''}`;
  }

  // Build the message blocks
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🎫 ${group.subject}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${sportEmoji} *${group.team}* • ${group.emailCount} account${group.emailCount > 1 ? 's' : ''}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: typeLine,
      },
    },
  ];

  // Add deadline if detected (and different from presale date)
  if (exclusivity.deadline && exclusivity.deadline !== exclusivity.presaleDate) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⏰ Ends: ${exclusivity.deadline}`,
      },
    });
  }

  // Add AI reasoning
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_${exclusivity.reason}_`,
      },
    ],
  });

  // Add action buttons (Interested / Not Interested)
  const interestedPayload = JSON.stringify({
    dedupKey: group.dedupKey,
    team: group.team,
    eventName: exclusivity.eventName ?? group.subject,
    subject: group.subject,
  });

  const declinePayload = JSON.stringify({
    domain: group.senderDomain,
    eventName: exclusivity.eventName ?? group.subject,
    team: group.team,
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '✅ Interested',
          emoji: true,
        },
        style: 'primary',
        action_id: 'presale_interested',
        value: interestedPayload,
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '❌ Not Interested',
          emoji: true,
        },
        action_id: 'presale_decline',
        value: declinePayload,
      },
    ],
  });

  // Post the initial message
  const messageResult = await slackCircuit.execute(() =>
    slack.chat.postMessage({
      channel: channelId,
      blocks,
      text: `🎫 ${group.team}: ${group.subject}`,
    })
  );

  const threadTs = (messageResult as any).ts;
  if (!threadTs) {
    throw new Error('Failed to get Slack message timestamp');
  }

  // Upload PDF if HTML is available
  if (htmlContent) {
    try {
      console.log('[PresaleScanner] Converting HTML to PDF...');
      const pdfResult = await convertHtmlToPdf(htmlContent, `presale-${group.team.toLowerCase()}`);

      await slackCircuit.execute(() =>
        slack.filesUploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          filename: `presale-${group.team.toLowerCase()}-${group.date}.pdf`,
          file: pdfResult.data,
          title: `${group.team} Presale Email`,
        })
      );

      console.log('[PresaleScanner] Uploaded PDF to Slack');
    } catch (error) {
      console.error('[PresaleScanner] Failed to upload PDF:', error);
      // Post error message in thread
      await slack.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `⚠️ Failed to generate PDF: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  return threadTs;
}

// ============================================================================
// Main Scan Function
// ============================================================================

/**
 * Run the presale scanner
 *
 * @param lookbackMinutes - How far back to search (default: from config)
 * @returns Scan result summary
 */
export async function scanPresales(
  lookbackMinutes?: number
): Promise<ScanResult> {
  console.log('[PresaleScanner] Starting scan...');

  const result: ScanResult = {
    scanned: 0,
    newPresales: 0,
    posted: [],
    skipped: 0,
    errors: [],
  };

  try {
    // Step 1: Get sports team labels
    const sportsLabels = await getSportsTeamLabels();
    console.log(`[PresaleScanner] Found ${sportsLabels.length} sports team labels`);

    if (sportsLabels.length === 0) {
      console.log('[PresaleScanner] No sports team labels found, nothing to scan');
      return result;
    }

    // Step 2: Search Gmail
    const actualLookback = lookbackMinutes ?? config.presale.lookbackMinutes;
    const emails = await searchPresaleEmails(sportsLabels, actualLookback);
    result.scanned = emails.length;
    console.log(`[PresaleScanner] Gmail returned ${emails.length} emails`);

    if (emails.length === 0) {
      console.log('[PresaleScanner] No presale emails found');
      updateLastScan();
      return result;
    }

    // Step 3: Group by dedup key
    const groups = await groupByDedupKey(emails, sportsLabels);
    console.log(`[PresaleScanner] Grouped into ${groups.length} unique presales`);

    // Step 4: Check already posted + Step 5-6: Check exclusivity and post
    let newCount = 0;
    let skippedCount = 0;

    for (const group of groups) {
      // Step 4: Check if already posted
      if (isPresaleSeen(group.dedupKey)) {
        console.log(`[PresaleScanner] Already seen: ${group.subject.substring(0, 50)}`);
        skippedCount++;
        continue;
      }

      newCount++;
      console.log(`[PresaleScanner] Checking: "${group.subject}" from ${group.senderDomain}`);

      // Step 5: AI exclusivity check
      const firstEmail = group.emails[0];
      const exclusivity = await checkPresaleExclusivitySafe(
        group.subject,
        firstEmail.bodyText
      );

      if (!exclusivity.isExclusive) {
        console.log(`[PresaleScanner] SKIPPED: "${group.subject}" - not exclusive (${exclusivity.reason})`);
        // Still mark as seen to avoid rechecking
        markPresaleSeen(group.dedupKey, '', group.emailCount, group.team, group.subject);
        skippedCount++;
        continue;
      }

      // Check if opportunity was previously declined
      if (exclusivity.eventName && isOpportunityDeclined(group.senderDomain, exclusivity.eventName)) {
        console.log(`[PresaleScanner] SKIPPED: "${group.subject}" - previously declined (${exclusivity.eventName})`);
        markPresaleSeen(group.dedupKey, '', group.emailCount, group.team, group.subject);
        skippedCount++;
        continue;
      }

      // Step 6: Post to Slack
      console.log(`[PresaleScanner] EXCLUSIVE (${exclusivity.presaleType}): "${group.subject}" - posting to Slack`);

      try {
        const slackTs = await postPresaleToSlack(group, exclusivity);
        markPresaleSeen(group.dedupKey, slackTs, group.emailCount, group.team, group.subject);
        result.posted.push(`${group.team}: ${group.subject}`);
        console.log(`[PresaleScanner] Posted to Slack: ${group.team} - ${group.subject}`);
      } catch (error) {
        const errorMsg = `Failed to post ${group.team}: ${error instanceof Error ? error.message : 'Unknown'}`;
        console.error(`[PresaleScanner] ${errorMsg}`);
        result.errors.push(errorMsg);
      }
    }

    result.newPresales = newCount;
    result.skipped = skippedCount;

    // Step 7: Auto-cleanup old entries
    cleanupOldEntries(7);

    // Update last scan timestamp
    updateLastScan();

    console.log(`[PresaleScanner] Scan complete: ${result.posted.length} posted, ${result.skipped} skipped`);
    return result;

  } catch (error) {
    const errorMsg = `Scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(`[PresaleScanner] ${errorMsg}`);
    result.errors.push(errorMsg);
    return result;
  }
}
