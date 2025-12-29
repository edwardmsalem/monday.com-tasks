/**
 * Task Name Formatting Utilities
 *
 * Provides consistent task name formatting across all workflows.
 * When a team is detected, prefixes the name with [Team].
 */

/**
 * Format a task name with optional team prefix
 *
 * @param name - The base task name (subject, description, etc.)
 * @param team - Optional team name (if detected by AI)
 * @returns Formatted task name like "[Georgia Tech] Subject" or just "Subject" if no team
 */
export function formatTaskName(name: string, team?: string | null): string {
  if (team) {
    return `[${team}] ${name}`;
  }
  return name;
}
