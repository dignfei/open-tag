export const REPLY_DECISIONS = ["no_action", "request_reply", "accept", "delegate", "abstain"] as const;
export const REPLY_REASONS = ["ownership", "better_fit", "handoff", "correction", "blocker", "new_evidence", "unique_expertise"] as const;
export const SUPPLEMENTAL_REASONS = new Set<ReplyReason>(["correction", "blocker", "new_evidence", "unique_expertise"]);

export type ReplyDecision = typeof REPLY_DECISIONS[number];
export type ReplyReason = typeof REPLY_REASONS[number];
export type ReplySlot = "primary" | "directed" | "supplemental";
export type PrimaryState = "none" | "active" | "consumed";

export type IntentOutcome =
  | { outcome: "grant"; slot: ReplySlot }
  | { outcome: "pending" }
  | { outcome: "deny"; code: "PRIMARY_ALREADY_ASSIGNED" | "PRIMARY_ALREADY_PUBLISHED" | "SUPPLEMENTAL_ALREADY_ASSIGNED" };

export function evaluateReplyIntent(o: { reason: ReplyReason; primaryState: PrimaryState; supplementalTaken: boolean }): IntentOutcome {
  if (SUPPLEMENTAL_REASONS.has(o.reason)) {
    if (o.supplementalTaken) return { outcome: "deny", code: "SUPPLEMENTAL_ALREADY_ASSIGNED" };
    if (o.primaryState !== "none") return { outcome: "grant", slot: "supplemental" };
  }
  if (o.primaryState === "none") return { outcome: "grant", slot: "primary" };
  if (o.primaryState === "consumed") return { outcome: "deny", code: "PRIMARY_ALREADY_PUBLISHED" };
  if (o.reason === "better_fit") return { outcome: "pending" };
  return { outcome: "deny", code: "PRIMARY_ALREADY_ASSIGNED" };
}

type DecisionInput = { decision?: unknown; reason?: unknown; toAgentId?: unknown };
type Validation = { ok: true; decision: ReplyDecision; reason?: ReplyReason } | { ok: false; code: string };

export function validateDecisionInput(input: DecisionInput): Validation {
  if (!REPLY_DECISIONS.includes(input.decision as ReplyDecision)) return { ok: false, code: "INVALID_DECISION" };
  const decision = input.decision as ReplyDecision;
  if (decision === "request_reply") {
    if (!input.reason) return { ok: false, code: "REASON_REQUIRED" };
    if (!REPLY_REASONS.includes(input.reason as ReplyReason)) return { ok: false, code: "INVALID_REASON" };
    return { ok: true, decision, reason: input.reason as ReplyReason };
  }
  if (input.reason) return { ok: false, code: "UNEXPECTED_REASON" };
  if (decision === "delegate" && (typeof input.toAgentId !== "string" || !input.toAgentId.trim())) {
    return { ok: false, code: "DELEGATE_TARGET_REQUIRED" };
  }
  return { ok: true, decision };
}
