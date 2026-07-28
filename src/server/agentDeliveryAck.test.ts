import test from "node:test";
import assert from "node:assert/strict";
import { acceptAgentDeliveryAck, expectAgentDeliveryAck, noteAgentDeliveryPending, rejectAgentDeliveryAck } from "./agentDeliveryAck.js";

test("delivery ACK resolves by the durable id", async () => {
  const waiter = expectAgentDeliveryAck("turn-1:agent-1", "agent-1", 10);
  assert.equal(acceptAgentDeliveryAck("turn-1:agent-1", "agent-1", 10), true);
  await waiter.promise;
});

test("ACK without a durable delivery id cannot settle admission", async () => {
  const waiter = expectAgentDeliveryAck("turn-2:agent-2", "agent-2", 20);
  assert.equal(acceptAgentDeliveryAck(undefined, "agent-2", 20), false);
  assert.equal(acceptAgentDeliveryAck("turn-2:agent-2", "agent-2", 20), true);
  await waiter.promise;
});

test("delivery NACK rejects immediately with the daemon admission error", async () => {
  const waiter = expectAgentDeliveryAck("turn-3:agent-3", "agent-3", 30);
  assert.equal(rejectAgentDeliveryAck("turn-3:agent-3", "agent-3", 30, "runtime rejected notice"), true);
  await assert.rejects(waiter.promise, /runtime rejected notice/);
});

test("NACK without a durable delivery id cannot settle admission", async () => {
  const waiter = expectAgentDeliveryAck("turn-4:agent-4", "agent-4", 40);
  assert.equal(rejectAgentDeliveryAck(undefined, "agent-4", 40, "legacy failure"), false);
  assert.equal(rejectAgentDeliveryAck("turn-4:agent-4", "agent-4", 40, "admission failure"), true);
  await assert.rejects(waiter.promise, /admission failure/);
});

test("concurrent waiters for one durable id share the original admission result", async () => {
  const first = expectAgentDeliveryAck("turn-5:agent-5", "agent-5", 50);
  const retry = expectAgentDeliveryAck("turn-5:agent-5", "agent-5", 51);
  assert.equal(retry.promise, first.promise);
  assert.equal(acceptAgentDeliveryAck("turn-5:agent-5", "agent-5", 51), true);
  await Promise.all([first.promise, retry.promise]);
});

test("cancelling one concurrent waiter does not cancel the shared admission", async () => {
  const first = expectAgentDeliveryAck("turn-6:agent-6", "agent-6", 60);
  const retry = expectAgentDeliveryAck("turn-6:agent-6", "agent-6", 61);
  first.cancel();
  assert.equal(acceptAgentDeliveryAck("turn-6:agent-6", "agent-6", 61), true);
  await retry.promise;
});

test("pending heartbeats keep a busy runtime admission waiter alive", async () => {
  const waiter = expectAgentDeliveryAck("turn-7:agent-7", "agent-7", 70);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(noteAgentDeliveryPending("turn-7:agent-7"), true);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(acceptAgentDeliveryAck("turn-7:agent-7", "agent-7", 70), true);
  await waiter.promise;
});

test("pending heartbeat without a durable id cannot extend another waiter", async () => {
  const waiter = expectAgentDeliveryAck("turn-8:agent-8", "agent-8", 80);
  assert.equal(noteAgentDeliveryPending(undefined), false);
  assert.equal(acceptAgentDeliveryAck("turn-8:agent-8", "agent-8", 80), true);
  await waiter.promise;
});
