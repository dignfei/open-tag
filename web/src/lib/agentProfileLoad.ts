export function isCurrentAgentProfileResponse(
  requestedId: string,
  requestVersion: number,
  currentId: string,
  currentVersion: number,
  response: unknown,
): response is { id: string } {
  return requestedId === currentId
    && requestVersion === currentVersion
    && !!response
    && typeof response === "object"
    && (response as { id?: unknown }).id === requestedId;
}
