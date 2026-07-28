import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReplyIntent, validateDecisionInput } from "./replyCoordinationPolicy.js";

test("better_fit waits while the directed primary owner is active", () => {
  assert.deepEqual(evaluateReplyIntent({ reason: "better_fit", primaryState: "active", supplementalTaken: false }), {
    outcome: "pending",
  });
});

test("ambient first valid intent gets the primary slot", () => {
  assert.deepEqual(evaluateReplyIntent({ reason: "ownership", primaryState: "none", supplementalTaken: false }), {
    outcome: "grant",
    slot: "primary",
  });
});

test("evidence-bearing and unique-expertise reasons can get the supplemental slot", () => {
  for (const reason of ["correction", "blocker", "new_evidence", "unique_expertise"] as const) {
    assert.deepEqual(evaluateReplyIntent({ reason, primaryState: "active", supplementalTaken: false }), {
      outcome: "grant",
      slot: "supplemental",
    });
  }
  for (const reason of ["ownership", "handoff"] as const) {
    assert.deepEqual(evaluateReplyIntent({ reason, primaryState: "active", supplementalTaken: false }), {
      outcome: "deny",
      code: "PRIMARY_ALREADY_ASSIGNED",
    });
  }
});

test("a consumed primary cannot be replaced and a used supplemental cannot be duplicated", () => {
  assert.deepEqual(evaluateReplyIntent({ reason: "better_fit", primaryState: "consumed", supplementalTaken: false }), {
    outcome: "deny",
    code: "PRIMARY_ALREADY_PUBLISHED",
  });
  assert.deepEqual(evaluateReplyIntent({ reason: "correction", primaryState: "consumed", supplementalTaken: true }), {
    outcome: "deny",
    code: "SUPPLEMENTAL_ALREADY_ASSIGNED",
  });
});

test("structured decisions reject missing or incompatible fields", () => {
  assert.equal(validateDecisionInput({ decision: "no_action" }).ok, true);
  assert.deepEqual(validateDecisionInput({ decision: "request_reply" }), { ok: false, code: "REASON_REQUIRED" });
  assert.deepEqual(validateDecisionInput({ decision: "delegate", toAgentId: "" }), { ok: false, code: "DELEGATE_TARGET_REQUIRED" });
  assert.deepEqual(validateDecisionInput({ decision: "accept", reason: "better_fit" }), { ok: false, code: "UNEXPECTED_REASON" });
  assert.deepEqual(validateDecisionInput({ decision: "invented" }), { ok: false, code: "INVALID_DECISION" });
});
