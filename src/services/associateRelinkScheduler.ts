/**
 * Associate Relink Scheduler
 *
 * Guarantees the SIM<->person link on Master Numbers survives the lead->associate
 * changeover. The lead->associate transfer is a native Monday "move item to board"
 * recipe (not a Make scenario, not an API-visible automation), which cannot do the
 * cross-board phone match needed to link the SIM. So we do it here, continuously.
 *
 * Every tick this reuses the proven backfill engine: drive from the Associates
 * board (ss_mobile) -> match the Master Numbers row by phone (last 10) -> set the
 * Associate link + Active + Associate ID + SIM email. It is idempotent: rows
 * already linked correctly are skipped, so steady-state writes only the few
 * associates that newly arrived since the last tick.
 *
 * Self-healing by design: however the move happens (manual or recipe) and even
 * after downtime, the next sweep links anyone still unlinked. No second column,
 * no dependency on webhook delivery.
 *
 * Gated by RELINK_SWEEP_ENABLED (default on). Interval via RELINK_INTERVAL_MS
 * (default 15 min).
 */

import { computeBackfillPlan, executeBackfillWrites } from './backfillAssociates.js';

const ENABLED = (process.env.RELINK_SWEEP_ENABLED ?? 'true') === 'true';
const INTERVAL_MS = Number(process.env.RELINK_INTERVAL_MS ?? 15 * 60 * 1000);

let interval: NodeJS.Timeout | null = null;
let running = false; // re-entrancy guard (a sweep can outlast the interval)
let lastRun = '';
let lastResult = '';

async function sweep(): Promise<void> {
  if (running) {
    console.log('[Relink] previous sweep still running, skipping this tick');
    return;
  }
  running = true;
  try {
    const plan = await computeBackfillPlan();
    const ready = plan.matched.length;
    if (ready === 0) {
      lastResult = `nothing to link (alreadyCorrect=${plan.summary.alreadyCorrect ?? '?'})`;
      console.log(`[Relink] ${lastResult}`);
      return;
    }
    const res = await executeBackfillWrites(plan.matched);
    lastResult = `linked=${res.written} errors=${res.writeErrors} (of ${ready} ready)`;
    console.log(`[Relink] ${lastResult}`);
  } catch (e) {
    lastResult = `error: ${e instanceof Error ? e.message : 'unknown'}`;
    console.error(`[Relink] sweep failed: ${lastResult}`);
  } finally {
    running = false;
    lastRun = new Date().toISOString();
  }
}

export function startAssociateRelinkScheduler(): void {
  if (!ENABLED) {
    console.log('[Relink] disabled (RELINK_SWEEP_ENABLED!=true)');
    return;
  }
  if (interval) {
    console.log('[Relink] already started');
    return;
  }
  console.log(`[Relink] starting; interval=${Math.round(INTERVAL_MS / 60000)}min`);
  // first sweep shortly after boot
  setTimeout(() => { void sweep(); }, 20_000);
  interval = setInterval(() => { void sweep(); }, INTERVAL_MS);
}

export function getRelinkStatus(): { enabled: boolean; running: boolean; lastRun: string; lastResult: string } {
  return { enabled: ENABLED, running, lastRun, lastResult };
}
