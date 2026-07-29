# Conversation Turns execution plan

Status: complete — merged and released (Turn delivery fence `delivery-admission-v2` shipped in
daemon 0.13.0; see `CHANGELOG.md`). Moved to completed 2026-07-29.

## Goal

Preserve ordinary channel and DM collaboration while turning each sender's short message
burst into one durable unit of responsibility. Prove that the system answers relevant
work, does not duplicate execution, and does not create unbounded agent-to-agent loops.

## Steps

1. Persist sender/channel-scoped Turn admission and canonical trigger membership.
   Verification: integration tests prove same-sender merge, cross-sender isolation,
   explicit boundary sealing, and separate human/agent partitions.
2. Move responsibility selection and grant activation to stable Turn dispatch.
   Verification: collecting messages cannot be checked or answered; human ambient work
   has one owner, all explicit mentions get directed grants, DM replies remain authorized,
   and agent ambient messages do not wake peers.
3. Make dispatch and recovery durable.
   Verification: daemon ACK retry reuses one delivery id, daemon dedupe prevents a second
   runtime delivery, reconnect wakes only persisted owners/grantees, and blocked Turns
   reconcile after a later reply.
4. Bound agent causality.
   Verification: causal depth, total budget, and repeated agent-pair edges stop loops while
   explicit agent-authored work mentions remain actionable.
5. Synchronize the product/architecture/operations contract and release the daemon.
   Verification: schema docs, architecture, feature list, self-host variables, changelog,
   daemon package version, full tests, builds, and real browser/agent E2E agree.

## Decision log

- The burst key includes concrete channel and sender identity; a channel-wide debounce
  would let one human delay or absorb another human's request.
- Responsibility is reserved while collecting but becomes reply authority only when the
  Turn is dispatched. This prevents a partial sentence from being answered.
- Ambient human work has one server-selected owner; explicit mentions preserve the user's
  fan-out intent and give every named agent one directed work grant.
- DMs do not require an @ mention. Agent-authored ambient chatter remains visible but is
  non-wakeable; explicit agent mentions consume a bounded causal budget.
- Semantic relevance remains an agent decision. Deterministic external constraints cover
  admission, ownership, one-shot publication, recovery, idempotency, and loop ceilings.

## Progress log

- 2026-07-24: schema, Turn scheduler, dispatch policy, canonical reply grants, reconnect
  recovery, delivery ACK/dedupe, Activity FIFO, causal bounds, and regression tests added.
- 2026-07-24: full suite passed 399/399 (0 failed/cancelled/skipped/todo) with the
  isolated environment loaded. Root + web typecheck, web/docs production builds,
  daemon 0.12.0 bundle build, `db:push` (`No changes detected`), and `git diff --check`
  all passed.
- 2026-07-24: isolated browser E2E used a real Codex runtime. An unmentioned channel
  request and an unmentioned DM both published a granted reply. DB inspection tied each
  reply to one consumed primary grant. After a server/daemon restart, two distinct DM
  triggers each received exactly one reply; both agent-authored DM Turns ended
  `responsibility_state=completed` rather than the pre-fix `blocked` state.
- 2026-07-24: HTTP/WS integration evidence covers independent Alice/Bob windows,
  same-sender burst merge, stable cross-sender reads over a collecting cursor gap,
  multi-mention grants, reconnect ownership, deterministic ACK retry, and agent DM causal
  pair suppression. A live multi-agent agent-to-agent DM was not run; that edge is covered
  by the database-backed dispatch integration test.
- 2026-07-24: observed warnings are explicit: tests require `--test-force-exit` because
  the repository's integration runner leaves handles open; the real Codex runtime logged
  unrelated plugin-catalog authentication/manifest warnings; Claude live verification
  was unavailable because its session quota had reset later. The legacy unbound
  `seed-dev` bot also exposed the existing I92/I77 machine-binding residue during a
  simultaneous server/daemon restart and needed a stop/start token rotation before the
  second live DM run.
- 2026-07-24: independent review blocked merge on six P1 gaps: pre-grant visibility,
  causal ACK retry misclassification, pre-runtime ACK, unbounded trailing debounce,
  ineffective DM merging, and canonical observation hiding a 100-row page remainder.
  Regression tests now cover each case.
- 2026-07-24: second independent review found cold-start admission, stop/start/dequeue
  races, resource-queue cancellation, partial-recipient NACK visibility, unfenced lease
  recovery, early reply completion, and DM causal-root merging gaps. Runtime adapters now
  expose an exactly-once initial-admission result; every start path shares one cancellable
  fence; resource-queued delivery remains pending; Turn attempts fence every state change;
  directed fan-out is concurrent and partial retries remain active.
- 2026-07-24: post-remediation root/web typecheck passed. The full unit, daemon, server
  integration, and real-API set previously passed 425/425 with 0 failed/cancelled/skipped/todo.
  A later monolithic run exposed shared-database test-server interference: one server startup
  can mark another test's newly connected machine offline. Focused database suites are therefore
  rerun sequentially until the harness isolation debt is fixed (I97).
- 2026-07-24: mixed-version review found that an old daemon could still ACK on websocket
  receipt and bypass runtime admission. The ready frame now advertises
  `delivery-admission-v1`; control delivery, agent inbox/decide/send, and reconnect catch-up
  all fail closed without it. Capability-paused Turns retain grants and resume after a capable
  bound reconnect or an exactly-one-daemon unbound takeover. Missing-id legacy ACK/NACK is
  rejected, and multi-mention capability preflight starts zero recipients until all are compatible.
- 2026-07-24: final blocker remediation adds per-recipient server admission timestamps, an atomic
  daemon delivery-id ledger that survives process replacement, zero/one/many unbound topology
  recovery, and request-correlated lifecycle ACK/NACK with serialized reset/restart. Focused evidence:
  delivery/lifecycle daemon tests 25/25, six original one-shot runtime tests 40/40, Turn integration
  16/16, Turn real API 1/1, and lifecycle real API 1/1. One-shot argv admission deliberately remains
  child-spawn acceptance; waiting for a model event would exceed the 2 s transport ACK window for
  normal slow models and create false duplicate retries.
- 2026-07-24: release-candidate verification is split around I97 instead of running shared-DB
  servers concurrently: 73 non-DB/non-MIME files passed 382/382; MIME guards passed 27/27 with
  the isolated `.env` loaded; reply coordination passed 14/14; Conversation Turns passed 17/17;
  lifecycle API passed 1/1. Aggregate: 449/449, 0 failed/cancelled/skipped/todo. Root/web
  typecheck, web/docs production builds, daemon bundle build, `db:push` (`No changes detected`),
  prompt provider-tool scan, and `git diff --check` also passed.
- 2026-07-24: final live failure reproduced a busy Codex recipient whose queued notice exceeded
  the short server ACK timeout, plus independent review found preflight visibility, lifecycle
  settlement, overlapping-ledger, and admitted-unbound topology gaps. Remediation adds non-terminal
  pending heartbeats, reserved-grant all-recipient preflight, per-session start/exit settlements,
  a locked refreshable ledger, and an admitted-recipient topology exception. Second independent
  blocker review closed all five P1s. Focused evidence: ACK/ledger/AgentManager 39/39, runtime
  adapters 24/24, Turn integration 16/16, Turn API 1/1, lifecycle API 1/1, and daemon/reconnect/
  activity 36/36; typecheck and diff check passed.
- 2026-07-24: isolated real Codex/browser E2E passed: one unmentioned channel request produced one
  reply, one unmentioned DM produced one reply, and a two-recipient mention produced one real chat
  reply per agent with no duplicate after 12 seconds. The directed Turn completed in one dispatch;
  both decision rows were `published/consumed` with non-null `delivery_admitted_at`. Screenshots are
  retained under `.shots/` (gitignored). The temporary helper was deleted and the seed bot restored
  to inactive after the run.
- 2026-07-27: consecutive-DM browser reproduction exposed a remaining ordering race: the daemon
  wrote a queued runtime notice before the server committed recipient admission, so a fast inbox
  check could finish as Handled with no reply. Capability `delivery-admission-v2` now uses an
  authenticated `ready -> admitted` commit barrier, strict per-agent FIFO, queue-head-only cold
  start, and terminal-online advancement. Addressed rows are admission-gated while ambient context
  remains readable. Focused evidence after remediation: AgentManager/ACK 38/38, Turn integration
  17/17, and real HTTP+WS Turn API 1/1; final browser evidence is recorded in the PR summary.
- 2026-07-27: final DM FIFO verification reproduced a second data-plane gap after transport ordering
  was fixed: freshness hold advanced `lastReadSeq` across an unadmitted second DM, so its later
  runtime check returned empty. Inbox/freshness now share one admission classifier but keep distinct
  read semantics: ambient collecting context can hold a stale draft without consuming formal inbox
  state, while direct queued work remains invisible and cursor-blocking. The final latest-daemon
  browser tag `admission-fifo-v7-1785122238641` produced INDIGO then SILVER in separate Activity
  runs; database rows were `published/consumed` with admissions at 03:17:19.676Z and
  03:17:42.130Z. The queued-state
  screenshot and final screenshot remain under `.shots/` (gitignored).
