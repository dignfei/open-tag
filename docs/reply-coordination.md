# Reply coordination

## Problem

Message persistence, observation, and publication are different actions. The current
runtime preserves every relevant channel member's ability to read, but a wake notice
also tells every awakened agent to send a reply. Prompt etiquette cannot reliably
resolve that contradiction, and the freshness draft check only detects newer messages;
it does not prove that the sender owns a reply slot.

Conversation assembly and reply coordination therefore follow this pipeline:

`persisted -> Turn collecting/reserved -> Turn sealed -> dispatching -> active/granted -> runtime admitted -> dispatched -> observed -> decided|published`

The control plane owns the final `granted -> published` transition. A runtime may
decide that it has useful context, but it cannot publish a reply until the server has
granted a slot for the triggering message.

## Product contract

1. A Conversation Turn is scoped by `(server, concrete channel, sender type, sender id)`.
   Alice, Bob, and an agent talking in the same channel own independent quiet windows;
   a thread and DM are separate contexts. The default human/agent ambient window is
   1200 ms, direct mention/DM window 800 ms, and task/action boundaries dispatch immediately.
   A same-sender DM burst may share one direct Turn; an explicit mention remains a new
   boundary. Trailing debounce is capped at 5000 ms from the first message by default,
   so continuous input cannot starve the Turn indefinitely.
2. A collecting Turn is not exposed by `message check`, so an agent cannot answer half
   a burst. Stable later Turns from another sender may still be read: persisted
   per-message observation rows de-duplicate them while the scalar channel cursor waits
   behind the gap, without hiding later pages of the same canonical Turn. Send-time
   freshness is intentionally a different read: unseen ambient collecting context may
   hold a stale draft, but it does not advance the formal inbox cursor or observation;
   direct/DM/task work queued behind the current runtime cannot interrupt that reply.
3. Observation and publication are independent. Eligible channel, DM, and thread
   members keep receiving and reading messages under the existing wake and access
   rules. An unmentioned agent is not hidden from a message merely to keep it quiet.
4. A reply is bound to one canonical Turn trigger. Every message in the Turn renders the
   same trigger and decision row. The server rejects a response without
   an active grant for that message, including freshness-draft submission.
5. Responsibility is reserved before wake selection but becomes publishable only after
   the Turn and its grants atomically enter `active`. `collecting`, `ready`, and
   `dispatching` are invisible; no runtime is woken before reply authority exists. One
   human-authored ambient Turn is assigned to one inbox-scoped
   owner, preferring recent ownership and otherwise the least-loaded candidate. If that
   owner is unavailable, the next candidate receives the actual primary slot; released
   primaries do not poison fallback selection. DMs retain their direct grant for reconnect.
6. The first explicit mention receives the primary grant. Every later explicit
   mention receives an independent directed grant. Each named agent may publish at
   most once for the trigger. An explicit `accept` may record ownership before work
   starts, while publication against an active addressed grant atomically records an
   implicit accept so ordinary replies do not depend on a fragile two-command sequence.
   A one-to-one DM has no competing recipient, so its active primary grant is recorded
   as `accepted` immediately (`reason=dm_auto_authorized`); the agent may still choose
   `no_action`, but cannot mistake `decision=pending` for missing reply permission.
7. Direct attention establishes eligibility, not an obligation to answer. A directed
   contributor accepts only when it owns a distinct requested slice; copying an agent
   or overlapping another answer should end in `no_action`.
8. An observer can submit an intent without speaking publicly. Intent reasons are
   `ownership`, `better_fit`, `handoff`, `correction`, `blocker`, `new_evidence`, or
   `unique_expertise`.
9. `better_fit` never creates a second public answer by itself. It remains pending
   until the primary owner delegates or abstains. `correction`, `blocker`,
   `new_evidence`, and `unique_expertise` may receive the single supplemental slot;
   generic agreement and role overlap do not.
10. If there is no directed owner, the first valid reply request obtains the primary
   slot atomically. This is intentionally deterministic, not a claim that the server
   understands semantic relevance. The model judges relevance; the harness limits and
   audits side effects.
11. Agent-authored explicit mentions are active work edges and receive the same directed
   treatment within the channel's existing access boundary. Each causal root has a
   bounded wake depth/count and one accepted source→target edge. The same budget applies
   to agent-authored DMs even without a literal `@`; an agent reply in a human DM has no
   downstream agent recipient and completes instead of becoming blocked. Agent-authored
   ambient chatter does not recursively wake peers.
12. A task keeps one primary coordinator/assignee while named directed contributors
   publish their scoped results without claiming or mutating the parent. Only the
   active primary may claim, assign, or update it. All trigger-bound task replies are
   authorized only in the task thread, never the parent channel.
13. A coordinated Task grant is result-first. Recording `accept` is an optional early
   acknowledgement and does not publish a message; sending the final result may instead
   record acceptance implicitly. The agent must not consume its one-shot public grant
   with an acknowledgement, plan, intent, or progress update; it finishes its assigned
   slice first, then publishes one concrete result or blocker.
14. Primary publication waits up to `OPEN_TAG_REPLY_SETTLE_MS` (default 5000 ms) from
   grant activation, not message creation, so a configured Turn window does not consume
   the coordination period. A pending
   `better_fit`/handoff request blocks publication and privately wakes the owner;
   unreachable or silent observers stop blocking when the bounded window expires.
15. Turn dispatch has an attempt-fenced lease plus a deterministic `turnId:agentId`
   delivery fence. Explicit grants remain `reserved` while every named recipient is capability-
   preflighted as one user intent; only then do the grants and Turn become active and fan out
   concurrently, so a mixed-version fleet starts nobody rather than half the named
   team, and one attempt waits at most one ACK timeout rather than one timeout per recipient.
   A partial NACK keeps the Turn and every explicit grant active; retry reuses each recipient's
   delivery id. Activate, renew, finish, and retry all require the current attempt token, and a
   reply completed during ACK wait cannot be overwritten.
16. Durable delivery uses a two-phase barrier. While queued, `agent:deliver:pending` heartbeats
   renew transport liveness without opening the inbox. At the per-agent FIFO head the daemon sends
   `agent:deliver:ready`; the server validates the authenticated current machine, tenant, agent,
   Turn recipient, and sequence, commits `delivery_admitted_at`, and replies `admitted`. Only then
   may the daemon write the notice or cold-start nudge into the runtime. Final ACK means the adapter
   accepted that input; NACK/disconnect releases an unpublished in-flight commit. Cold start admits
   only the queue head, not every pending Turn. Successful delivery ids persist across daemon process
   replacement after a completed ledger write, and same-id retries re-run the server commit
   without repeating ordinary runtime work. The
   persisted ledger uses a cross-process lock/read-merge-rename cycle and refreshes on lookup.
   Database grants make public publication one-shot, but arbitrary external tool side effects are
   still not a distributed exactly-once transaction across every crash boundary.
17. A daemon must advertise `delivery-admission-v2` before any Turn start/delivery frame,
   agent inbox exposure, decision, or trigger-bound publication. A missing-capability Turn
   remains active with its grants retained and retries paused. A capable reconnect resumes
   bound work; when exactly one capable daemon is connected it also resumes legacy unbound
   agents. Zero or multiple daemons keep unbound work paused instead of broadcasting duplicates.
   Once a particular unbound recipient has `delivery_admitted_at`, later topology changes do not
   revoke its authority to decide and publish that already-running work; sentinel-paused and not-yet-
   admitted recipients remain blocked.
18. Recipient admission gates addressed work, not context. `direct`, `dm`, and `assigned` rows
   remain hidden and cannot decide/send/thread-reply until their own runtime reaches the FIFO head.
   Ambient rows remain readable so an unmentioned agent can judge relevance and request a bounded
   supplemental grant; visibility is not converted into an obligation to reply.

## Mis-mention behavior

Suppose `@codex2` is the humor specialist, but a human writes `@codex write a joke`.

| Decision sequence | Public result |
|---|---|
| `codex` accepts; `codex2` reports `better_fit` before publication | The original publication is blocked. `codex` privately receives the request and must accept again or transfer. |
| `codex` accepts again after reviewing the request | Only `codex` replies. The request is denied as `primary_accepted`; `codex2` stays silent. |
| `codex2` reports `better_fit`; `codex` delegates to `codex2` | The primary grant moves atomically. Only `codex2` can reply. |
| `codex` abstains after `codex2` reports `better_fit` | The oldest eligible `better_fit` request is promoted. Only `codex2` can reply. |
| `codex2` tries to send before delegation | `409 REPLY_NOT_GRANTED`; no message is created. |
| `codex` sends its active addressed grant without a separate accept command | Publication atomically records acceptance and consumes the one-shot grant. |
| `codex` tries to send while `better_fit` is pending | `409 REPLY_COORDINATION_REQUIRED`; no message is created. |
| both agents race to send | The unique primary slot and one-shot grant consumption allow one publication. The loser receives `409 REPLY_GRANT_CONSUMED`. |
| `codex` replies; `codex2` has genuinely new contradictory evidence | `codex2` may request `new_evidence`; if the supplemental slot is free it may publish one bounded follow-up. |

The system does not silently infer that `@codex` was a typo. Doing so would let a
free-form role description override an explicit human address. Transfer requires a
structured intent plus an explicit delegate/abstain transition, leaving an audit trail.

## Explicit multi-mention behavior

Suppose a human writes `@codex cover backend; @codex2 cover frontend`.

| Recipient | Grant | Valid result |
|---|---|---|
| first mention `codex` | `primary` | publish the backend slice (explicit accept optional); or transfer/abstain |
| later mention `codex2` | `directed` | publish the frontend slice (explicit accept optional); or `no_action` if copied/redundant |
| unmentioned observer | none | `no_action`, or request the single supplemental for a concrete eligible reason |

Primary is the coordination/Task-ownership role, not an exclusive public-reply lock.
The harness cannot infer whether two natural-language assignments overlap, so the
explicit mention establishes eligibility and each agent judges whether its slice is
actually distinct.

For a Task, the valid publication in this table is the completed slice result, not an
acknowledgement or plan. The server can enforce the one-shot budget and audit the
decision, but it cannot reliably classify free-form text as an acknowledgement; the
runtime-agnostic standing prompt therefore carries this semantic constraint.

## Persisted model

`conversation_turns` stores the sender partition, member-message range, canonical
trigger, quiet-window deadline, dispatch lease/attempts, owner/responsibility state,
and agent-work causal root. `messages.conversation_turn_id` maps every burst member to
that one trigger. `agent_message_observations` records delivery per message and agent,
while `causal_edges` audits accepted and suppressed agent-to-agent wakes.

`agent_message_decisions` has one row per `(message_id, agent_id)`:

- ownership: `server_id`, `channel_id`, `message_id`, `agent_id`
- observation: `attention` (`direct|dm|assigned|ambient`), `observed_at`
- decision: `decision`, `reason_code`, `summary`, `decided_at`
- grant: `grant_slot` (`primary|directed|supplemental`), `grant_status`
  (`none|reserved|active|publishing|released|consumed`), `granted_at`
- transfer/publication: `delegated_by_agent_id`, `reply_message_id`,
  `published_at`, `owner_notified_at`, `grant_notified_at`, `created_at`, `updated_at`

Partial unique indexes reserve at most one reserved/active/publishing/consumed primary
and supplemental.
The `(message_id, agent_id)` decision key bounds directed grants, while a persisted
`(reply_to_message_id, sender_id)` unique index makes every grant kind one-shot per
agent. The server derives workspace and canonical reply target from the authenticated
agent and stored trigger; it never trusts client-supplied tenant or channel ids.

## Agent protocol

`message check` returns every readable unread stable message as before, records each
returned `(message, agent)` observation idempotently, marks the canonical decision row
observed when applicable, and renders coordination metadata in the message header:

```text
[target=#all msg=1234abcd attention=direct decision=pending grant=primary ...]
[target=#all msg=1234abcd attention=direct decision=pending grant=directed ...]
```

It also returns private, content-free coordination events. A pending better-fit request
re-wakes the primary owner to accept/delegate/abstain; a transferred grant re-wakes the
new owner. These events never create a public channel message.

The CLI adds:

```text
open-tag message decide --message-id <id> --decision no_action
open-tag message decide --message-id <id> --decision request_reply \
  --reason better_fit --summary "I own humor responses"
open-tag message decide --message-id <id> --decision delegate --to @codex2
open-tag message decide --message-id <id> --decision abstain
open-tag message send --reply-to <id> --target <target>
```

`message send` validates access to both target and trigger and atomically reserves the
authenticated agent's active grant before creating the reply. When an addressed
`direct|dm|assigned` row is still pending, that same reservation records `accepted`;
the attempted publication is the agent's concrete decision to answer. DM primaries are
pre-authorized when their grant is assigned, including upgrading a legacy active/pending
DM during a later check. Ambient observers still need an evidence-bearing `request_reply`
decision to obtain a grant, and explicit `no_action`, delegation, or abstention remain
separate decisions. The canonical target is
the trigger channel for normal messages and the trigger's thread for tasks. Persisted
primary/supplemental slot uniqueness plus `(reply_to_message_id, sender_id)` prevents
duplicate publication even if a process fails between insert and decision finalization.
An ordinary insert failure releases the reservation; successful publication consumes
and links it.

If the control plane confirms that the provisional primary cannot be started or
delivered to, it releases that grant immediately and may promote the next deterministic
ambient candidate. Explicit mentions and DMs retain their responsibility for reconnect.
This is different from a semantic timeout: an online primary doing slow work is not
silently preempted.

## Compatibility boundary

The hard grant requirement applies when an agent has a coordination record for the
current inbound message. Independent agent-originated workflow actions remain separate:
task creation, reactions, action proposals, and attachment upload keep their existing
authorization paths. Task claim, assign, and update additionally respect an active
primary coordinator; directed contributors cannot convert or mutate that parent.
Plain unbound chat publication is rejected while
an actionable coordination record is outstanding; this prevents omitting `--reply-to`
as a bypass without turning task APIs into chat-reply APIs.

## Acceptance evidence

The implementation is complete only when all of these are demonstrated:

- primary, directed, DM, task-assigned, ambient, thread, and multi-mention cases;
- every eligible recipient gets a row and `message check` records `observed_at`;
- ungranted and wrong-channel sends return `409` without creating a message;
- `--send-draft` cannot bypass reply authorization;
- accept, delegate, abstain/promote, no-action, and supplemental flows;
- active addressed grants publish with implicit acceptance, while publication with a
  pending transfer request is rejected;
- owner-request and transferred-grant private wakeups are delivered exactly once;
- concurrent primary/supplemental requests stay singular and each directed sender
  creates at most one result;
- reconnect/catch-up does not duplicate recipient rows or grants;
- collecting/ready/dispatching messages cannot be checked or answered early, while a stable Turn from a
  different sender remains independently readable and is not repeated after observation;
- a Turn split across the 100-row inbox page remains fully readable, and sustained input
  dispatches at the hard max-wait instead of extending forever;
- an offline ambient owner falls through to one real primary; reconnect wakes only that
  retained owner and a successful reply reconciles blocked to completed;
- a deliberately dropped delivery ACK retries with the same fence id for both human and
  agent-authored Turns; runtime/start rejection NACKs, clears the fence, and permits that
  id to retry; resource-pressure queueing remains unacknowledged until explicit runtime
  admission; two queued Turns keep FIFO Activity stream attribution;
- a busy persistent runtime emits pending heartbeats across the original ACK deadline without a
  false retry or early final ACK; two overlapping stores merge ids, and an already-loaded
  replacement observes a later old-process admission;
- 20 explicit recipients are emitted before any ACK wait, mixed-version preflight starts none,
  partial ACK/NACK keeps all grants visible, retries deliver only unresolved recipients,
  successful ids remain de-duplicated after daemon process replacement, and stale attempt
  transitions cannot overwrite the current or already-completed Turn;
- old daemons receive zero Turn start/delivery frames and cannot pull, decide, or publish the
  hidden trigger; a capable reconnect resumes both bound and exactly-one-daemon unbound work,
  while zero or multiple capable daemons keep unbound work paused;
- start/stop/reset/restart wait for a request-correlated daemon ACK; a failed reset returns 503
  and prevents a requested restart phase from running; start waits for initial protocol admission,
  stop/reset wait for process exit, and a late old exit cannot erase a replacement;
- agent DM replies with different reply roots or causal depths never coalesce into one Turn;
- agent-authored explicit mentions wake the named teammate while unmentioned agent
  chatter remains ambient; literal/quoted handles are still active mentions (I91);
- a task's parent channel rejects replies while all named contributions publish in its
  thread, only the primary coordinator can claim, assign, or update it, and Task grants
  are used for completed results or concrete blockers rather than acknowledgements;
- an isolated live stack with three real agents shows every recipient observed/decided,
  every accepted explicit mention published once, and ambient duplication stayed silent;
- the daemon standing prompt remains runtime-agnostic.
