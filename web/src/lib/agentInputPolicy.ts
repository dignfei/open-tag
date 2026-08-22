export const MAX_AGENT_INPUT_SOURCES = 100;

export function filterAvailableAgentIds(
  selectedIds: Iterable<string>,
  availableIds: Iterable<string>,
): string[] {
  const available = new Set(availableIds);
  return [...selectedIds].filter((id) => available.has(id));
}

export function toggleAgentInputSource(selectedIds: Iterable<string>, id: string): Set<string> {
  const next = new Set(selectedIds);
  if (next.delete(id)) return next;
  if (next.size < MAX_AGENT_INPUT_SOURCES) next.add(id);
  return next;
}
