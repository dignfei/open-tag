import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

test("deleteObject removes a saved local upload", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "open-tag-storage-delete-"));
  process.env.OPEN_TAG_HOME = home;
  process.env.OPEN_TAG_STORAGE = "local";
  try {
    const storage = await import(`../src/server/storage.ts?delete-test=${Date.now()}`);
    const saved = await storage.saveObject("blocked.txt", Readable.from([Buffer.from("blocked upload")]));
    assert.equal((await storage.readObject(saved.key)).toString(), "blocked upload");
    await storage.deleteObject(saved.key);
    await assert.rejects(storage.readObject(saved.key), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await storage.deleteObject(saved.key);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
