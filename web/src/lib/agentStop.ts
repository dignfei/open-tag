export type AgentStopApi = (method: string, path: string) => Promise<unknown>;

const pendingStops = new Map<string, Promise<void>>();

export function requestAgentStop(api: AgentStopApi, agentId: string): Promise<void> {
  const pending = pendingStops.get(agentId);
  if (pending) return pending;

  const request = Promise.resolve()
    .then(() => api("POST", `/api/agents/${agentId}/stop`))
    .then((result) => {
      const response = result as { ok?: boolean; error?: unknown } | null;
      if (response?.ok === true) return;
      throw new Error(typeof response?.error === "string" ? response.error : "cannot stop");
    });
  pendingStops.set(agentId, request);
  const clear = () => { if (pendingStops.get(agentId) === request) pendingStops.delete(agentId); };
  request.then(clear, clear);
  return request;
}
