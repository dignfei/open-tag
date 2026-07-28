import assert from "node:assert/strict";
import test from "node:test";
import { createWsFrameGate } from "./wsFrameGate.js";

test("buffers pre-auth frames and processes every frame in arrival order", async () => {
  const gate = createWsFrameGate<string>();
  const handled: string[] = [];

  gate.dispatch("ready");
  gate.dispatch("status");
  gate.open(async (frame) => {
    await Promise.resolve();
    handled.push(frame);
  });
  gate.dispatch("pong");

  await gate.drained();
  assert.deepEqual(handled, ["ready", "status", "pong"]);
});

test("cannot replace the frame handler after authentication", () => {
  const gate = createWsFrameGate<string>();
  gate.open(() => {});

  assert.throws(() => gate.open(() => {}), /already opened/);
});
