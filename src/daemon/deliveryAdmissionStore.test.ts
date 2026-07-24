import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeliveryAdmissionStore } from "./deliveryAdmissionStore.js";

test("successful delivery admission survives a daemon process replacement", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-delivery-store-"));
  try {
    const expiresAt = Date.now() + 60_000;
    await new DeliveryAdmissionStore(root).remember("turn-1:agent-1", expiresAt);
    const restarted = new DeliveryAdmissionStore(root);
    assert.equal(await restarted.has("turn-1:agent-1"), true);
    assert.equal(await restarted.has("turn-1:agent-2"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired delivery admission is not restored", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-delivery-store-"));
  try {
    await new DeliveryAdmissionStore(root).remember("turn-old:agent-1", Date.now() - 1);
    assert.equal(await new DeliveryAdmissionStore(root).has("turn-old:agent-1"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupted delivery ledger fails closed instead of forgetting admitted work", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-delivery-store-"));
  try {
    writeFileSync(path.join(root, ".delivery-admissions.json"), "not-json");
    await assert.rejects(new DeliveryAdmissionStore(root).has("turn-1:agent-1"), /JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping daemon stores merge admissions instead of last-writer-wins", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "open-tag-delivery-store-overlap-"));
  try {
    const first = new DeliveryAdmissionStore(dir);
    const second = new DeliveryAdmissionStore(dir);
    const expiresAt = Date.now() + 60_000;
    await Promise.all([
      first.remember("turn-first:agent", expiresAt),
      second.remember("turn-second:agent", expiresAt),
    ]);
    const fresh = new DeliveryAdmissionStore(dir);
    assert.equal(await fresh.has("turn-first:agent"), true);
    assert.equal(await fresh.has("turn-second:agent"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-loaded replacement daemon observes a later admission from the old process", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "open-tag-delivery-store-refresh-"));
  try {
    const oldProcess = new DeliveryAdmissionStore(dir);
    const replacement = new DeliveryAdmissionStore(dir);
    assert.equal(await replacement.has("turn-late:agent"), false, "replacement first loads the empty ledger");

    await oldProcess.remember("turn-late:agent", Date.now() + 60_000);
    assert.equal(await replacement.has("turn-late:agent"), true, "replacement must refresh after the old process persists admission");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
