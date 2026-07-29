import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { hashToken, newKey } from "./auth.js";

const serverUrl = `http://localhost:${Number(process.env.PORT ?? 7777)}`;
const rawTokens = new Map<string, string>();

/** Build the daemon launch config without rotating a token held by an already-running agent. */
export async function agentConfig(agentId: string) {
  const agent = (await db.select().from(schema.agents).where(and(
    eq(schema.agents.id, agentId),
    isNull(schema.agents.deletedAt),
  )))[0];
  if (!agent) return null;

  let token = rawTokens.get(agent.id);
  if (!token && !(agent.status === "active" && agent.agentTokenHash)) {
    token = newKey("sk_agent_");
    rawTokens.set(agent.id, token);
    await db.update(schema.agents).set({ agentTokenHash: hashToken(token) }).where(eq(schema.agents.id, agent.id));
  }
  return {
    name: agent.name,
    displayName: agent.displayName,
    description: agent.description,
    model: agent.model,
    runtime: agent.runtime,
    projectPath: agent.projectPath,
    runtimeConfig: agent.runtimeConfig,
    sessionId: agent.sessionId ?? undefined,
    serverUrl,
    serverId: agent.serverId,
    agentId: agent.id,
    agentToken: token,
  };
}
