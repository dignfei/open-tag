import test from "node:test";
import assert from "node:assert/strict";
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

  trailing.resolve({ channel: 4 });
  await Promise.all(requests);
  assert.deepEqual(commits, [{ channel: 1 }, { channel: 4 }]);
  assert.equal(loadCount, 2);
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
