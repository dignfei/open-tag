# Directed reply coordination execution plan (completed)

Status: complete (2026-07-23).

## Goal

Preserve broad message observation while treating every explicit agent mention as an
independent, one-reply entitlement. Keep ambient replies bounded, route task results
to the task thread, and keep one accountable task assignee without blocking named
contributors.

## Behavioral contract

- The first explicit mention is the primary coordinator; later explicit mentions are
  directed contributors, not ambient observers.
- Every directed recipient decides independently: accept and publish once, or choose
  no action. A directed grant is permission, not an obligation to reply.
- Unmentioned observers remain readable and may obtain at most one supplemental grant
  for correction, blocker, new evidence, or unique expertise.
- A normal reply publishes in the trigger channel. A task reply publishes only in the
  task thread. A thread reply stays in that thread.
- A task retains one assignee. Its primary coordinator owns the claim while directed
  contributors submit scoped work without claiming, assigning, or updating the parent.
- Explicit mentions in agent-authored messages remain active work mentions; ambient
  agent-authored chatter remains non-wakeable.

## Steps

1. Refine persisted reply slots and uniqueness constraints.
   Verification: multiple directed grants coexist, primary/supplemental remain unique,
   and one agent cannot publish twice for one trigger.
2. Update decision and publication state transitions.
   Verification: directed accept/no-action, ambient unique-expertise, transfer,
   concurrency, and consumed-grant cases pass policy and PostgreSQL tests.
3. Derive the canonical reply target from the trigger and align task claim ownership.
   Verification: task replies succeed in the task thread, fail in the parent channel,
   and contributors cannot steal the primary coordinator's task claim.
4. Update the runtime-agnostic standing prompt and CLI-visible metadata.
   Verification: agents distinguish primary, directed contributor, and ambient roles;
   provider-specific tool-name scan remains empty.
5. Synchronize architecture, schema, feature, changelog, and reply-coordination docs.
   Verification: doc-sync Mode 1 has no unresolved owed docs or stale references.
6. Run unit, integration, build, and isolated three-agent browser E2E verification.
   Verification: separate-answer, task-thread, agent-mention, mistaken-mention, and
   ambient-supplemental scenarios match API, database, logs, and browser evidence.

## Progress log

- Added persisted `directed` grants, a per-trigger/per-agent publication guard, and an
  explicit idempotent index migration because Drizzle Kit did not detect predicate
  changes on existing partial indexes.
- Bound Task publication to the Task thread and reserved claim/assign/update for the
  active primary coordinator.
- Verified 394/394 repository tests, root/web typecheck, web/docs/daemon-package builds,
  provider-name prompt scan, migration idempotency, and live PostgreSQL index definitions.
- Isolated live stack: primary + directed Codex agents each published once in the Task
  thread, the parent received zero replies, and the ambient Claude agent chose no action.
  A Codex-authored mention then granted and woke the named Codex peer, which replied.
- The first live Task run exposed that both one-shot grants were consumed by plan-style
  acknowledgements. The follow-up reserves Task publications for completed results or
  concrete blockers and adds a prompt-contract regression test.
- Follow-up isolated live stack: the primary reply reported the observed channel count,
  agent count, and roster; the directed reply reported the observed Task number, status,
  assignee, and mention order. Neither used its grant for acknowledgement/plan/progress,
  both original grants reached `published/consumed`, the Task reached `in_review`, the
  parent channel received zero bound replies, and the ambient agent chose `no_action`.
- Residual I91 evidence remained visible: bare `@handle` values in a result were parsed as
  new work mentions. They produced no extra reply during the observation window, but one
  secondary `codex2` grant remained pending. This is intentionally not conflated with the
  result-first fix.
- Browser screenshot capture was skipped because the in-app browser webview could not
  attach after three fresh-tab attempts. The human UI was not changed; HTTP, DB, daemon,
  and server-log evidence covered the modified runtime path.

## Decision log

- Forward-fix the local reply-coordination merge instead of reverting to unrestricted
  multi-agent replies.
- Bound ambient self-selection, not explicit human or agent mentions.
- Keep one task assignee; independent lifecycle tracking still requires separate task
  cards rather than an implicit multi-assignee parent task.
- Keep literal/quoted `@handle` text as an active work mention for now. Live evidence
  reproduced the extra wake; I91 remains the explicit product boundary.
