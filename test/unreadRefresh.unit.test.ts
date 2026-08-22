import test from "node:test";
import assert from "node:assert/strict";
import { createUnreadRefresh } from "../web/src/unreadRefresh.ts";

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
