/**
 * SS Number Request (season-ticket SIM setup)
 *
 * Recreates the SS-number creation step that used to be done manually / via Bod.
 * Trigger: on the Leads board, the "Status" column (lead_status) changing to
 * "Request Setup". On that signal this:
 *   1. reads the lead's identity (name + address + ZIP) off the Leads row,
 *   2. asks farm-b to allocate a call-forward-safe SIM and run JUST the Unavo
 *      MDN swap for that identity (new on-demand endpoint, duplicate of the
 *      existing standalone swap; nothing existing on farm-b is changed),
 *   3. stamps the resulting SS number onto the lead and marks "Setup Complete".
 *
 * The Unavo swap is a real, irreversible carrier action and is serialized on
 * farm-b (single headed browser on the shared :99 display). So this is GATED:
 *   - SS_NUMBER_FLOW_ENABLED must be exactly "true" to fire a real swap.
 *   - Otherwise it runs in dry-run: it logs exactly what it would do and, if
 *     FARM_B_API_URL is set, asks farm-b for a dry-run allocation preview only.
 *
 * Deterministic webhook -> HTTP/GraphQL glue. No AI. All Monday calls go
 * through core-api per repo rule; farm-b is a direct HTTP call (it is not a
 * core-api-fronted service).
 */

import { monday as coreApiMonday } from './coreApi.js';

// Boards
const LEADS_BOARD_ID = '7511353720';

// Leads board columns
const LEAD_STATUS_COL = 'lead_status'; // "Status" - the trigger column
const LEAD_NAME_COL = 'name';
const LEAD_ADDRESS1_COL = 'address_1';
const LEAD_CITY_COL = 'text_mkq99yqj';
const LEAD_ZIP_COL = 'lead_zipcode';
const LEAD_STATE_ABBR_COL = 'text_mkn97bke'; // "State Abbreviation" (clean 2-letter)
const LEAD_STATE_DROPDOWN_COL = 'lead_state'; // fallback (mixed full names / abbrevs)
const LEAD_SS_MOBILE_COL = 'ss_mobile';

// Status labels on lead_status
const TRIGGER_LABEL = 'Request Setup';
const DONE_LABEL = 'Setup Complete';

// farm-b
const FARM_B_API_URL = process.env.FARM_B_API_URL ?? '';
const FARM_B_API_KEY = process.env.FARM_B_API_KEY ?? '';
const SS_SWAP_PATH = '/api/sim/ss-number-swap';

const ENABLED = process.env.SS_NUMBER_FLOW_ENABLED === 'true';

export const SS_NUMBER_TRIGGER = {
  boardId: Number(LEADS_BOARD_ID),
  columnId: LEAD_STATUS_COL,
};

interface StatusLabel {
  label?: { text?: string };
}
interface SsNumberEvent {
  pulseId?: number;
  columnId?: string;
  boardId?: number;
  value?: unknown;
  previousValue?: unknown;
}

interface Identity {
  first_name: string;
  last_name: string;
  address1: string;
  city: string;
  state: string;
  zip: string;
}

interface FarmBSwapResult {
  ok: boolean;
  result?: 'ok' | 'HALT';
  reason?: string;
  sim_item_id?: string;
  sim_iccid?: string;
  sim_phone?: string; // old number
  new_mdn?: string; // the SS number
  // dry-run shape:
  would_claim?: { sim_item_id?: string; sim_iccid?: string; bank_id?: string };
  eligible_count?: number;
}

function labelText(value: unknown): string {
  return (value as StatusLabel | undefined)?.label?.text?.trim() ?? '';
}

async function readColumns(itemId: string, columnIds: string[]): Promise<Record<string, string>> {
  const query = `
    query ReadColumns($ids: [ID!], $cols: [String!]) {
      items(ids: $ids) {
        name
        column_values(ids: $cols) { id text }
      }
    }
  `;
  const result = (await coreApiMonday.query(query, { ids: [itemId], cols: columnIds })) as {
    items?: Array<{ name?: string; column_values?: Array<{ id: string; text: string | null }> }>;
  };
  const item = result.items?.[0];
  const out: Record<string, string> = { name: (item?.name ?? '').trim() };
  for (const cv of item?.column_values ?? []) out[cv.id] = (cv.text ?? '').trim();
  return out;
}

async function setColumnValues(boardId: string, itemId: string, values: Record<string, unknown>): Promise<void> {
  const query = `
    mutation SetColumns($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }
  `;
  await coreApiMonday.query(query, { boardId, itemId, columnValues: JSON.stringify(values) });
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

async function callFarmBSwap(identity: Identity, dryRun: boolean): Promise<FarmBSwapResult> {
  if (!FARM_B_API_URL) {
    return { ok: false, reason: 'FARM_B_API_URL not configured' };
  }
  const url = `${FARM_B_API_URL.replace(/\/$/, '')}${SS_SWAP_PATH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(FARM_B_API_KEY ? { Authorization: `Bearer ${FARM_B_API_KEY}` } : {}),
    },
    body: JSON.stringify({ ...identity, dry_run: dryRun }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: `farm-b ${res.status}: ${body.slice(0, 200)}` };
  }
  return (await res.json()) as FarmBSwapResult;
}

/**
 * Handle a Leads "Status" change. Fires only when it becomes "Request Setup".
 */
export async function handleSsNumberRequest(event: SsNumberEvent): Promise<void> {
  const leadId = event.pulseId ? String(event.pulseId) : null;
  if (!leadId) {
    console.log('[SsNumber] No pulseId on event, skipping');
    return;
  }

  const newStatus = labelText(event.value);
  const oldStatus = labelText(event.previousValue);
  if (newStatus !== TRIGGER_LABEL || oldStatus === TRIGGER_LABEL) {
    console.log(`[SsNumber] item ${leadId}: status "${oldStatus}" -> "${newStatus}", not a fresh Request Setup, skipping`);
    return;
  }

  const cols = await readColumns(leadId, [
    LEAD_NAME_COL,
    LEAD_ADDRESS1_COL,
    LEAD_CITY_COL,
    LEAD_ZIP_COL,
    LEAD_STATE_ABBR_COL,
    LEAD_STATE_DROPDOWN_COL,
    LEAD_SS_MOBILE_COL,
  ]);

  const { first, last } = splitName(cols.name ?? '');
  const state = (cols[LEAD_STATE_ABBR_COL] || cols[LEAD_STATE_DROPDOWN_COL] || '').trim();
  const identity: Identity = {
    first_name: first,
    last_name: last,
    address1: cols[LEAD_ADDRESS1_COL] ?? '',
    city: cols[LEAD_CITY_COL] ?? '',
    state,
    zip: cols[LEAD_ZIP_COL] ?? '',
  };

  // Validate we have what the swap needs (ZIP drives the new area code).
  const missing = Object.entries({
    first_name: identity.first_name,
    address1: identity.address1,
    city: identity.city,
    state: identity.state,
    zip: identity.zip,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.warn(`[SsNumber] item ${leadId}: missing identity fields [${missing.join(', ')}] — cannot request SS number`);
    return;
  }

  if (!ENABLED) {
    const preview = FARM_B_API_URL ? await callFarmBSwap(identity, true) : { ok: false, reason: 'no FARM_B_API_URL' };
    console.log(
      `[SsNumber] DRY-RUN (SS_NUMBER_FLOW_ENABLED!=true) item ${leadId} ${identity.first_name} ${identity.last_name} ` +
        `${identity.city}, ${identity.state} ${identity.zip} -> would allocate+swap. farm-b preview: ${JSON.stringify(preview)}`
    );
    return;
  }

  console.log(`[SsNumber] item ${leadId}: requesting SS number for ${identity.first_name} ${identity.last_name} (${identity.zip})`);
  const result = await callFarmBSwap(identity, false);

  if (!result.ok || result.result === 'HALT' || !result.new_mdn) {
    console.error(`[SsNumber] item ${leadId}: swap failed: ${result.reason ?? 'unknown'} (${JSON.stringify(result)})`);
    return;
  }

  // Stamp the SS number onto the lead. (farm-b writeback already put the MDN on
  // Master Numbers by ICCID; the SIM<->person link is finalized later when the
  // lead becomes an associate and is linked on Master Numbers.)
  const digits = result.new_mdn.replace(/\D/g, '');
  await setColumnValues(LEADS_BOARD_ID, leadId, {
    [LEAD_SS_MOBILE_COL]: { phone: digits, countryShortName: 'US' },
    [LEAD_STATUS_COL]: { label: DONE_LABEL },
  });
  console.log(`[SsNumber] item ${leadId}: SS number ${digits} (SIM ${result.sim_iccid}) -> stamped + marked "${DONE_LABEL}"`);
}
