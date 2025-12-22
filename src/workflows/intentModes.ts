/**
 * Intent-Driven Modes
 *
 * Detects task intent (Relocation, Exclusive Presale) and applies
 * specialized behavior after Monday item creation:
 * - Relocation: Creates 4 checklist subitems with assigned owners
 * - Exclusive Presale: Triggers /scan-like recipient extraction
 */

import * as monday from '../services/monday.js';
import { findUserByName } from '../services/userResolver.js';
import { getRelocationOwners } from '../services/slackConfig.js';
import type { WorkflowLogger } from './shared.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Relocation checklist items with their display names
 * These map to the Slack-driven config keys in slackConfig.ts
 */
export const RELOCATION_CHECKLIST = [
  { key: 'accounts_checked', label: 'Accounts Checked' },
  { key: 'board_setup', label: 'Board Setup' },
  { key: 'logins_confirmed', label: 'Logins Confirmed (10:00 AM ET day-of)' },
  { key: 'card_active', label: 'Card Active' },
] as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Result of Relocation checklist creation
 */
export interface RelocationChecklistResult {
  created: Array<{ id: string; name: string; owner: string | null; ownerResolved: boolean }>;
  skipped: boolean;
  skipReason?: string;
  warnings: string[];
}

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Detect if a task is a Relocation task
 */
export function isRelocationTask(taskType: string): boolean {
  return taskType.toLowerCase() === 'relocation';
}

/**
 * Detect if a task is an Exclusive Presale task
 * HARDENING: Narrowed matching to reduce false positives
 * - Matches: "presale", "pre-sale", "exclusive presale", "exclusive access"
 * - Does NOT match just "exclusive" alone (too broad)
 */
export function isExclusivePresaleTask(subject: string): boolean {
  const lowerSubject = subject.toLowerCase();
  // Match presale variants
  if (lowerSubject.includes('presale') || lowerSubject.includes('pre-sale')) {
    return true;
  }
  // Match "exclusive" only when followed by specific keywords
  if (lowerSubject.includes('exclusive presale') ||
      lowerSubject.includes('exclusive access') ||
      lowerSubject.includes('exclusive offer') ||
      lowerSubject.includes('exclusive sale')) {
    return true;
  }
  return false;
}

// ============================================================================
// Relocation Checklist Creation
// ============================================================================

/**
 * Create Relocation checklist subitems with owners from Slack config
 * Returns created subitems with their assigned owners
 *
 * PHASE 5: Creates 4 subitems for Relocation tasks:
 * - Accounts Checked → @owner from config
 * - Board Setup → @owner from config
 * - Logins Confirmed → @owner from config
 * - Card Active → @owner from config
 *
 * HARDENING:
 * - Idempotency: Checks for existing subitems before creating
 * - Owner validation: Resolves YAML owners to real users
 * - Visibility: Returns warnings for failed owner resolution
 *
 * Note: No per-subitem Slack notifications (per guardrails)
 * Owner is included in subitem name for visibility
 */
export async function createRelocationSubitems(
  parentItemId: string,
  log: WorkflowLogger
): Promise<RelocationChecklistResult> {
  log.log('Creating Relocation checklist subitems...');
  const warnings: string[] = [];

  // IDEMPOTENCY CHECK: Get existing subitems first
  const existingSubitems = await monday.getSubitems(parentItemId);
  log.log(`Found ${existingSubitems.length} existing subitems`);

  // Check if relocation checklist already exists (match by label prefix)
  const checklistLabels = RELOCATION_CHECKLIST.map(c => c.label.toLowerCase());
  const existingChecklistItems = existingSubitems.filter(sub =>
    checklistLabels.some(label => sub.name.toLowerCase().startsWith(label))
  );

  if (existingChecklistItems.length >= RELOCATION_CHECKLIST.length) {
    log.log('Relocation checklist already exists, skipping creation');
    return {
      created: [],
      skipped: true,
      skipReason: 'Relocation checklist already exists',
      warnings: [],
    };
  }

  if (existingChecklistItems.length > 0) {
    log.warn(`Found ${existingChecklistItems.length} partial checklist items, will create missing ones`);
  }

  // Get owners from Slack-driven config
  const owners = await getRelocationOwners();
  log.log('Relocation owners from config:', owners);

  const results: Array<{ id: string; name: string; owner: string | null; ownerResolved: boolean }> = [];

  for (const item of RELOCATION_CHECKLIST) {
    // Skip if this checklist item already exists
    const alreadyExists = existingChecklistItems.some(sub =>
      sub.name.toLowerCase().startsWith(item.label.toLowerCase())
    );
    if (alreadyExists) {
      log.log(`Skipping "${item.label}" - already exists`);
      continue;
    }

    const ownerFromConfig = owners[item.key as keyof typeof owners];
    let resolvedOwnerName: string | null = null;
    let ownerResolved = false;

    // OWNER VALIDATION: Try to resolve owner to a real user
    if (ownerFromConfig) {
      // Strip @ prefix if present (e.g., "@Assignee" → "Assignee")
      const ownerName = ownerFromConfig.replace(/^@/, '').trim();

      try {
        const user = await findUserByName(ownerName);
        if (user) {
          resolvedOwnerName = user.name;
          ownerResolved = true;
          log.log(`Resolved owner "${ownerFromConfig}" → ${user.name} (Monday ID: ${user.mondayId})`);
        } else {
          warnings.push(`Owner "${ownerFromConfig}" for "${item.label}" could not be resolved to a user`);
          log.warn(`Owner "${ownerFromConfig}" not found in user list`);
        }
      } catch (err) {
        warnings.push(`Failed to resolve owner "${ownerFromConfig}" for "${item.label}"`);
        log.error(`Error resolving owner "${ownerFromConfig}":`, err);
      }
    }

    // Format: "Accounts Checked (@Assignee)" or "Accounts Checked" if no owner
    const subitemName = resolvedOwnerName
      ? `${item.label} (@${resolvedOwnerName})`
      : item.label;

    try {
      const subitem = await monday.createSubitem(parentItemId, subitemName);
      results.push({
        id: subitem.id,
        name: subitem.name,
        owner: resolvedOwnerName,
        ownerResolved,
      });
      log.log(`Created Relocation subitem: ${subitemName}`);
    } catch (error) {
      log.error(`Failed to create Relocation subitem "${subitemName}":`, error);
      warnings.push(`Failed to create subitem "${item.label}"`);
    }
  }

  log.log(`Created ${results.length} Relocation subitems`);
  return {
    created: results,
    skipped: false,
    warnings,
  };
}

// ============================================================================
// Intent Mode Application
// ============================================================================

/**
 * Apply intent-driven mode behavior based on task type and subject
 *
 * Called after Monday item creation to add specialized behavior:
 * - Relocation: Creates 4 checklist subitems with assigned owners
 * - Exclusive Presale: May trigger /scan-like behavior (recipient extraction)
 *
 * HARDENING:
 * - Posts Monday Updates for warnings and failures
 * - Never fails the workflow, only logs and reports issues
 *
 * Returns summary of actions taken for logging/updates
 */
export async function applyIntentDrivenMode(
  mondayItemId: string,
  taskType: string,
  subject: string,
  log: WorkflowLogger
): Promise<{
  mode: 'relocation' | 'presale' | 'none';
  actions: string[];
  warnings: string[];
}> {
  const actions: string[] = [];
  const warnings: string[] = [];

  // Check for Relocation intent
  if (isRelocationTask(taskType)) {
    log.log('Intent-driven mode: RELOCATION detected');

    const result = await createRelocationSubitems(mondayItemId, log);

    // Handle skipped (idempotency)
    if (result.skipped) {
      actions.push(result.skipReason || 'Relocation checklist already exists, skipped creating duplicates');
      // Post Monday Update about skipped duplicates
      await monday.createUpdate(mondayItemId, '📋 Relocation checklist already exists, skipped creating duplicates.');
      return { mode: 'relocation', actions, warnings: [] };
    }

    // Handle created subitems
    if (result.created.length > 0) {
      const ownersSummary = result.created
        .filter(s => s.owner)
        .map(s => `${s.name.split(' (')[0]}: @${s.owner}`)
        .join(', ');

      actions.push(`Created ${result.created.length} Relocation checklist items`);
      if (ownersSummary) {
        actions.push(`Assigned: ${ownersSummary}`);
      }

      // Post timing requirement for Logins Confirmed step
      const hasLoginsStep = result.created.some(s => s.name.toLowerCase().includes('logins confirmed'));
      if (hasLoginsStep) {
        await monday.createUpdate(mondayItemId,
          `⏰ *Logins Confirmed Timing*\n\n` +
          `The "Logins Confirmed" step should be completed by *10:00 AM ET on day-of* to ensure accounts are ready before the event.`
        );
        actions.push('Posted Logins Confirmed timing requirement (10:00 AM ET day-of)');
      }

      // Collect unresolved owner warnings
      const unresolvedOwners = result.created.filter(s => !s.ownerResolved && s.owner === null);
      if (unresolvedOwners.length > 0) {
        warnings.push(`${unresolvedOwners.length} checklist items created without owners (could not resolve from config)`);
      }
    }

    // Handle warnings from creation process
    if (result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }

    // VISIBILITY: Post Monday Update if there were warnings or no subitems created
    if (result.created.length === 0 && !result.skipped) {
      const reason = result.warnings.length > 0
        ? result.warnings.join('; ')
        : 'Unknown error';
      await monday.createUpdate(mondayItemId,
        `⚠️ Relocation mode triggered but checklist creation failed (reason: ${reason})`
      );
      warnings.push('Relocation checklist creation failed');
    } else if (result.warnings.length > 0) {
      // Post warnings as Monday Update
      await monday.createUpdate(mondayItemId,
        `⚠️ Relocation checklist created with warnings:\n${result.warnings.map(w => `• ${w}`).join('\n')}`
      );
    }

    return { mode: 'relocation', actions, warnings };
  }

  // Check for Exclusive Presale intent (narrowed matching)
  if (isExclusivePresaleTask(subject)) {
    log.log('Intent-driven mode: EXCLUSIVE PRESALE detected');
    // Presale mode uses the existing /scan mechanism
    // The /scan detection happens separately in executeWorkflow
    actions.push('Presale detected - use /scan for recipient extraction');
    return { mode: 'presale', actions, warnings };
  }

  return { mode: 'none', actions, warnings };
}
