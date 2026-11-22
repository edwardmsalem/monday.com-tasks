// Triage audit SEC-8: keep confirmed AI actions on the chat's own emails.

/** Ids a confirmed action targets that are not among the chat's selected
 *  emails. Empty when the chat had no selection (inbox-wide questions). */
export function actionTargetsOutsideSelection(toolInput: unknown, selected: string[] | undefined): string[] {
  if (!selected || selected.length === 0 || !toolInput || typeof toolInput !== 'object') return [];
  const input = toolInput as { messageIds?: unknown; messageId?: unknown };
  const targets: string[] = [];
  if (Array.isArray(input.messageIds)) targets.push(...input.messageIds.filter((x): x is string => typeof x === 'string'));
  if (typeof input.messageId === 'string') targets.push(input.messageId);
  const allowed = new Set(selected);
  return targets.filter((id) => !allowed.has(id));
}
