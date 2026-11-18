/**
 * Issue call owners
 *
 * One place that says who owns issue calls. Names come from the env var
 * ISSUE_CALL_OWNERS (comma separated), default Dayna. Each name is resolved
 * through the user directory (userResolver.findUserByName), so nobody's Slack
 * or Monday id is hardcoded here. A name that is no longer in the directory
 * (someone who left) is skipped with a log line.
 *
 * Used by /issuecall (Monday owners and the claim reminders), the daily issue
 * call report, the issue call escalations and the triage closer fallback.
 */

import type { UnifiedUser } from './userResolver.js';

export const DEFAULT_ISSUE_CALL_OWNERS = 'Dayna';

type FindUserByName = (name: string) => Promise<UnifiedUser | null>;

/** Owner names from ISSUE_CALL_OWNERS, default Dayna. */
export function issueCallOwnerNames(raw: string | undefined = process.env.ISSUE_CALL_OWNERS): string[] {
  const names = (raw || DEFAULT_ISSUE_CALL_OWNERS)
    .split(',').map(n => n.trim()).filter(Boolean);
  return names.length > 0 ? names : [DEFAULT_ISSUE_CALL_OWNERS];
}

/** Resolve the owner names to directory users, skipping anyone not found. */
export async function resolveIssueCallOwners(
  findUserByName: FindUserByName,
  names: string[] = issueCallOwnerNames()
): Promise<{ names: string[]; owners: UnifiedUser[] }> {
  const owners: UnifiedUser[] = [];
  for (const name of names) {
    const found = await findUserByName(name);
    if (found) owners.push(found);
    else console.warn(`[IssueCall] Owner "${name}" not found in the user directory, skipped`);
  }
  return { names, owners };
}

/**
 * Slack ids of the issue call owners. Falls back to `fallback` when no owner
 * resolves to a Slack account, so a directory outage does not drop the message.
 */
export async function issueCallOwnerSlackIds(
  findUserByName: FindUserByName,
  fallback: string[],
  names: string[] = issueCallOwnerNames()
): Promise<string[]> {
  try {
    const { owners } = await resolveIssueCallOwners(findUserByName, names);
    const ids = owners.map(o => o.slackId).filter((id): id is string => !!id);
    if (ids.length > 0) return [...new Set(ids)];
  } catch (error) {
    console.error('[IssueCall] Owner lookup failed, using fallback ids:', error);
  }
  return fallback;
}
