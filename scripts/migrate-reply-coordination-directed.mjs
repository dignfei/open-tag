#!/usr/bin/env node
// Drizzle Kit does not detect changes to PostgreSQL partial-index predicates. Rebuild
// the reply-coordination indexes explicitly before db:push so existing installations
// get the same constraints as fresh databases. This migration is idempotent and does
// not modify message or decision rows.
import postgres from "postgres";

try {
  process.loadEnvFile?.(process.env.ENV_FILE ?? ".env");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const url = process.env.DATABASE_URL ?? "postgres://opentag:opentag@localhost:5433/opentag";
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main() {
  const [tables] = await sql`
    SELECT
      to_regclass('public.messages') AS messages,
      to_regclass('public.agent_message_decisions') AS decisions
  `;
  if (!tables?.messages || !tables?.decisions) {
    console.log("[reply-coordination-indexes] tables absent; drizzle-kit will create fresh indexes");
    return;
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_reply_slot_budget_uniq
        ON messages (reply_to_message_id, reply_grant_slot)
        WHERE reply_to_message_id IS NOT NULL
          AND reply_grant_slot IN ('primary', 'supplemental')
    `);
    await tx.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_reply_agent_grant_uniq
        ON messages (reply_to_message_id, sender_id)
        WHERE reply_to_message_id IS NOT NULL
          AND reply_grant_slot IS NOT NULL
          AND sender_id IS NOT NULL
    `);
    const [slotIndex] = await tx`
      SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'agent_message_decisions_slot_budget_uniq'
    `;
    if (!String(slotIndex?.predicate ?? "").includes("reserved")) {
      await tx.unsafe("DROP INDEX IF EXISTS agent_message_decisions_slot_budget_uniq");
      await tx.unsafe(`
        CREATE UNIQUE INDEX agent_message_decisions_slot_budget_uniq
          ON agent_message_decisions (message_id, grant_slot)
          WHERE grant_slot IN ('primary', 'supplemental')
            AND grant_status IN ('reserved', 'active', 'publishing', 'consumed')
      `);
    }

    await tx.unsafe("DROP INDEX IF EXISTS messages_reply_slot_uniq");
    await tx.unsafe("DROP INDEX IF EXISTS messages_reply_agent_uniq");
    await tx.unsafe("DROP INDEX IF EXISTS agent_message_decisions_slot_uniq");
  });
  console.log("[reply-coordination-indexes] indexes current");
}

main().catch((error) => {
  console.error("[reply-coordination-indexes] failed", error);
  process.exitCode = 1;
}).finally(() => sql.end());
