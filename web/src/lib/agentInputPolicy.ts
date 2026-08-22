export function filterAvailableAgentIds(
  selectedIds: Iterable<string>,
  availableIds: Iterable<string>,
): string[] {
  const available = new Set(availableIds);
  return [...selectedIds].filter((id) => available.has(id));
}
