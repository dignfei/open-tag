import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createUnreadRefresh, parseUnreadValues } from "../web/src/unreadRefresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("overlapping badge refreshes run one trailing load", async () => {
  const first = deferred<unknown>();
  const trailing = deferred<unknown>();
  const loads = [first, trailing];
  const commits: unknown[] = [];
  let loadCount = 0;
  const refresh = createUnreadRefresh(
    () => loads[loadCount++]!.promise,
    (values) => commits.push(values),
  );

  const requests = [refresh.request()];
  await nextTurn();
  assert.equal(loadCount, 1);

  requests.push(refresh.request(), refresh.request(), refresh.request());
  first.resolve({ channel: 1 });
  await nextTurn();
  assert.equal(loadCount, 2);
  assert.deepEqual(commits, []);

  trailing.resolve({ channel: 4 });
  await Promise.all(requests);
  assert.deepEqual(commits, [{ channel: 4 }]);
  assert.equal(loadCount, 2);
});

test("a failed trailing load does not expose its superseded snapshot", async () => {
  const first = deferred<unknown>();
  const trailing = deferred<unknown>();
  const loads = [first, trailing];
  const commits: unknown[] = [];
  let loadCount = 0;
  const refresh = createUnreadRefresh(
    () => loads[loadCount++]!.promise,
    (values) => commits.push(values),
  );

  const requests = [refresh.request()];
  await nextTurn();
  requests.push(refresh.request());
  first.resolve({ stale: 8 });
  await nextTurn();
  trailing.reject(new Error("offline"));
  await Promise.all(requests);

  assert.deepEqual(commits, []);
});

test("badge snapshots keep only positive integer counts", () => {
  assert.deepEqual(parseUnreadValues({ active: 3, cleared: 0 }), { active: 3 });
});

test("malformed badge snapshots are rejected", () => {
  for (const value of [null, [], "invalid", { error: "failed" }, { channel: -1 }, { channel: 1.5 }, { channel: Number.NaN }]) {
    assert.equal(parseUnreadValues(value), null);
  }
});

test("a failed badge load preserves state and allows retry", async () => {
  const commits: unknown[] = [];
  let loadCount = 0;
  const refresh = createUnreadRefresh(
    async () => {
      loadCount += 1;
      if (loadCount === 1) throw new Error("offline");
      return { channel: 2 };
    },
    (values) => commits.push(values),
  );

  await refresh.request();
  assert.deepEqual(commits, []);

  await refresh.request();
  assert.deepEqual(commits, [{ channel: 2 }]);
});

test("disposed badge refreshes ignore late responses", async () => {
  const pending = deferred<unknown>();
  const commits: unknown[] = [];
  let loadCount = 0;
  const refresh = createUnreadRefresh(
    () => { loadCount += 1; return pending.promise; },
    (values) => commits.push(values),
  );

  const request = refresh.request();
  await nextTurn();
  refresh.dispose();
  pending.resolve({ previousWorkspace: 5 });
  await request;
  await refresh.request();

  assert.deepEqual(commits, []);
  assert.equal(loadCount, 1);
});

test("workspace activation owns its badge refresh lifecycle", () => {
  const src = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
  const reload = src.slice(src.indexOf("const reload = async"), src.indexOf("const onEvent"));
  assert.match(reload, /const unreadRefresh = unreadRefreshRef\.current;[\s\S]*await unreadRefresh\?\.request\(\);/);
  assert.doesNotMatch(reload, /api\("GET", "\/api\/channels\/unread"\)/);
  assert.match(src, /const unreadRefresh = createUnreadRefresh\([\s\S]*api\("GET", "\/api\/channels\/unread"\)[\s\S]*setUnread\(values\)/);
  assert.match(src, /unreadRefresh\.dispose\(\);[\s\S]*unreadRefreshRef\.current === unreadRefresh/);
});

test("read confirmation refreshes only its active workspace", () => {
  const src = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
  const markRead = src.slice(src.indexOf("const markRead"), src.indexOf("const uploadFiles"));
  const owner = markRead.indexOf("const unreadRefresh = unreadRefreshRef.current;");
  const request = markRead.indexOf('api("POST", `/api/channels/${id}/read`');
  assert.ok(owner >= 0 && request > owner);
  assert.match(markRead, /r\?\.ok !== true \|\| typeof r\?\.channelId !== "string"/);
  assert.match(markRead, /unreadRefreshRef\.current === unreadRefresh[\s\S]*unreadRefresh\.request\(\)/);
  assert.doesNotMatch(markRead, /r\.unread|setUnread/);
});

test("live unread events schedule server snapshots", () => {
  const src = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
  const syncStart = src.indexOf("const syncUnread = () => {");
  const syncUnread = src.slice(syncStart, src.indexOf("subscribedRef.current", syncStart));
  assert.match(syncUnread, /if \(unreadTimer\) return;/);
  assert.match(syncUnread, /unreadTimer = null;[\s\S]*unreadRefresh\.request\(\)/);
  assert.doesNotMatch(syncUnread, /clearTimeout/);

  const message = src.slice(src.indexOf('sock.on("message:new"'), src.indexOf('sock.on("agent:activity"'));
  assert.match(message, /if \(delta > 0\) syncUnread\(\);/);
  assert.doesNotMatch(message, /setUnread/);

  const threadStart = src.indexOf('sock.on("thread:updated"');
  const thread = src.slice(threadStart, src.indexOf("    })();", threadStart));
  assert.match(thread, /p\?\.parentChannelId && delta > 0\) syncUnread\(\)/);
  assert.doesNotMatch(thread, /setUnread/);
});

test("reconnect refreshes badges after message catch-up", () => {
  const src = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
  const reconnect = src.slice(src.indexOf('sock.on("connect"'), src.indexOf('sock.on("message:new"'));
  assert.match(reconnect, /api\("GET", `\/api\/messages\/sync\?since=\$\{lastSeq\}`\)/);
  assert.match(reconnect, /dispatch\(\{ type: "message", channelId: msg\.channelId, message: msg \}\);/);
  assert.match(reconnect, /syncUnread\(\);/);
  assert.doesNotMatch(reconnect, /setUnread/);
});

test("badge state changes only by reset or validated snapshot", () => {
  const src = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
  assert.equal(src.match(/setUnread\(/g)?.length, 2);
  assert.match(src, /setUnread\(\{\}\)/);
  assert.match(src, /\(values\) => setUnread\(values\)/);
});
