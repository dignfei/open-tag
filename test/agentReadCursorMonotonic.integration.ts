// Deterministic integration coverage for overlapping agent read paths: a request that
// read an older snapshot must not overwrite a newer channel-member cursor when its
// UPDATE resumes after the newer cursor commits.
//
// Requires dev PostgreSQL. Run:
//   JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx test/agentReadCursorMonotonic.integration.ts
import "../src/env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { db, schema, sql } from "../src/db/index.ts";
import { pub, redis, sub } from "../src/redis.ts";
import { hashToken } from "../src/server/auth.ts";
import { handleAgentApi } from "../src/server/routes-agent.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type Fixture = {
  ownerId: string;
  serverId: string;
  agentId: string;
  agentToken: string;
  channelId: string;
  channelName: string;
};

const databaseUrl = process.env.DATABASE_URL ?? "postgres://opentag:opentag@localhost:5433/opentag";
const blockerSql = postgres(databaseUrl, { max: 1 });

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitForBlockedCursorUpdate(blockerPid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sql<{ blocked: boolean }[]>`
      select exists (
        select 1
        from pg_stat_activity activity
        where activity.datname = current_database()
          and activity.wait_event_type = 'Lock'
          and ${blockerPid} = any(pg_blocking_pids(activity.pid))
          and activity.query ilike ${'%update "channel_members"%'}
      ) as blocked
    `;
    if (row?.blocked) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for the stale route UPDATE to block on channel_members");
}

function makeRequest(fixture: Fixture, method: string, path: string, body?: object): IncomingMessage {
  const raw = body ? JSON.stringify(body) : "";
  return Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url: path,
    headers: {
      authorization: `Bearer ${fixture.agentToken}`,
      "x-agent-id": fixture.agentId,
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
}

function makeResponse(): {
  res: ServerResponse;
  status: () => number;
  body: () => any;
} {
  let statusCode = 0;
  let raw = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    writeHead(code: number) { statusCode = code; this.statusCode = code; },
    end(data?: string | Buffer) {
      raw = data ? String(data) : "";
      emitter.emit("finish");
    },
  }) as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => raw ? JSON.parse(raw) : null,
  };
}

async function agentRequest(fixture: Fixture, method: string, path: string, body?: object) {
  const req = makeRequest(fixture, method, path, body);
  const response = makeResponse();
  const handled = await handleAgentApi(
    req,
    response.res,
    new URL(path, "http://localhost"),
    method,
  );
  assert.equal(handled, true);
  return { status: response.status(), body: response.body() };
}

const messageCheck = (fixture: Fixture) => agentRequest(fixture, "GET", "/agent-api/message/check");
const freshnessSend = (fixture: Fixture) => agentRequest(fixture, "POST", "/agent-api/message/send", {
  target: `#${fixture.channelName}`,
  content: "draft reply",
});

async function setup(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const agentToken = `sk_agent_cursor_${suffix}`;
  return db.transaction(async (tx) => {
    const [owner] = await tx.insert(schema.users).values({
      name: `cursor-owner-${suffix}`,
      displayName: "Cursor Owner",
      email: `cursor-owner-${suffix}@test.invalid`,
    }).returning();
    const [server] = await tx.insert(schema.servers).values({
      name: `Cursor ${suffix}`,
      slug: `cursor-${suffix}`,
      ownerId: owner!.id,
    }).returning();
    await tx.insert(schema.serverMembers).values({
      serverId: server!.id,
      userId: owner!.id,
      role: "owner",
    });
    const [agent] = await tx.insert(schema.agents).values({
      serverId: server!.id,
      name: `cursor-agent-${suffix}`,
      displayName: "Cursor Agent",
      agentTokenHash: hashToken(agentToken),
    }).returning();
    const channelName = `cursor-${suffix}`;
    const [channel] = await tx.insert(schema.channels).values({
      serverId: server!.id,
      name: channelName,
      type: "channel",
    }).returning();
    await tx.insert(schema.channelMembers).values([
      { channelId: channel!.id, memberType: "user", memberId: owner!.id },
      { channelId: channel!.id, memberType: "agent", memberId: agent!.id },
    ]);
    return {
      ownerId: owner!.id,
      serverId: server!.id,
      agentId: agent!.id,
      agentToken,
      channelId: channel!.id,
      channelName,
    };
  });
}

async function insertHumanMessage(fixture: Fixture, seq: number, content: string) {
  const [message] = await db.insert(schema.messages).values({
    seq,
    serverId: fixture.serverId,
    channelId: fixture.channelId,
    senderType: "user",
    senderId: fixture.ownerId,
    senderName: "cursor-owner",
    messageType: "text",
    content,
    searchText: content,
  }).returning();
  return message!;
}

async function cursor(fixture: Fixture): Promise<number> {
  const [member] = await db.select({ value: schema.channelMembers.lastReadSeq })
    .from(schema.channelMembers)
    .where(and(
      eq(schema.channelMembers.channelId, fixture.channelId),
      eq(schema.channelMembers.memberType, "agent"),
      eq(schema.channelMembers.memberId, fixture.agentId),
    ));
  return Number(member?.value ?? -1);
}

async function cleanup(fixture: Fixture): Promise<void> {
  await db.delete(schema.agentMessageObservations).where(eq(schema.agentMessageObservations.serverId, fixture.serverId));
  await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, fixture.serverId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, fixture.serverId));
  await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, fixture.channelId));
  await db.delete(schema.channels).where(eq(schema.channels.id, fixture.channelId));
  await db.delete(schema.agents).where(eq(schema.agents.id, fixture.agentId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, fixture.serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, fixture.serverId));
  await db.delete(schema.users).where(eq(schema.users.id, fixture.ownerId));
}

async function completeBehindNewerCursor(
  fixture: Fixture,
  startRequest: () => ReturnType<typeof agentRequest>,
  createNewerCursor: () => Promise<number>,
) {
  const blockerReady = deferred<number>();
  const advanceCursor = deferred<number>();
  const transaction = blockerSql.begin(async (tx) => {
    const [session] = await tx<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
    await tx`
      select 1
      from channel_members
      where channel_id = ${fixture.channelId}
        and member_type = 'agent'
        and member_id = ${fixture.agentId}
      for update
    `;
    blockerReady.resolve(session!.pid);
    const newerSeq = await advanceCursor.promise;
    await tx`
      update channel_members
      set last_read_seq = ${newerSeq}
      where channel_id = ${fixture.channelId}
        and member_type = 'agent'
        and member_id = ${fixture.agentId}
    `;
  }).catch((error) => {
    blockerReady.reject(error);
    throw error;
  });
  void transaction.catch(() => {});

  const blockerPid = await blockerReady.promise;
  const staleRequest = startRequest();
  try {
    await waitForBlockedCursorUpdate(blockerPid);
    const newerSeq = await createNewerCursor();
    advanceCursor.resolve(newerSeq);
    await transaction;
    return { response: await staleRequest, newerSeq };
  } catch (error) {
    advanceCursor.reject(error);
    await transaction.catch(() => {});
    await staleRequest.catch(() => {});
    throw error;
  }
}

async function main(): Promise<void> {
  let fixture: Fixture | undefined;
  try {
    fixture = await setup();
    const older = await insertHumanMessage(fixture, 1, "older inbox message");
    const inboxRace = await completeBehindNewerCursor(
      fixture,
      () => messageCheck(fixture!),
      async () => {
        const newer = await insertHumanMessage(fixture, 2, "newer inbox message");
        return newer.seq;
      },
    );
    assert.equal(inboxRace.response.status, 200, JSON.stringify(inboxRace.response.body));
    assert.deepEqual(inboxRace.response.body.messages.map((message: any) => message.id), [older.id], "the blocked request must have read only the older snapshot");
    assert.equal(await cursor(fixture), inboxRace.newerSeq, "the stale message/check completion must retain the newer cursor");

    console.log("\u2713 message/check retains a newer cursor after a stale request resumes");

    await db.delete(schema.agentMessageObservations).where(eq(schema.agentMessageObservations.serverId, fixture.serverId));
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, fixture.serverId));
    await db.delete(schema.messages).where(eq(schema.messages.serverId, fixture.serverId));
    await db.update(schema.channelMembers).set({ lastReadSeq: 0 }).where(and(
      eq(schema.channelMembers.channelId, fixture.channelId),
      eq(schema.channelMembers.memberType, "agent"),
      eq(schema.channelMembers.memberId, fixture.agentId),
    ));

    const freshnessOlder = await insertHumanMessage(fixture, 3, "older freshness message");
    const freshnessRace = await completeBehindNewerCursor(
      fixture,
      () => freshnessSend(fixture!),
      async () => {
        const newer = await insertHumanMessage(fixture, 4, "newer freshness message");
        return newer.seq;
      },
    );
    assert.equal(freshnessRace.response.status, 200, JSON.stringify(freshnessRace.response.body));
    assert.equal(freshnessRace.response.body.held, true, "the older snapshot must enter freshness hold");
    assert.equal(freshnessRace.response.body.newerCount, 1);
    assert.deepEqual(freshnessRace.response.body.messages.map((message: any) => message.id), [freshnessOlder.id], "the freshness response must contain only its older snapshot");
    assert.equal(await cursor(fixture), freshnessRace.newerSeq, "the stale freshness completion must retain the newer cursor");

    console.log("\u2713 freshness hold retains a newer cursor after a stale request resumes");
  } finally {
    if (fixture) await cleanup(fixture);
    redis.disconnect();
    pub.disconnect();
    sub.disconnect();
    await Promise.all([blockerSql.end(), sql.end()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
