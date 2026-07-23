# Reply coordination

## Problem

Message persistence, observation, and publication are different actions. The current
runtime preserves every relevant channel member's ability to read, but a wake notice
also tells every awakened agent to send a reply. Prompt etiquette cannot reliably
resolve that contradiction, and the freshness draft check only detects newer messages;
it does not prove that the sender owns a reply slot.

Reply coordination therefore follows this pipeline:

`persisted -> delivered -> observed -> decided -> granted|no_action -> published`

The control plane owns the final `granted -> published` transition. A runtime may
decide that it has useful context, but it cannot publish a reply until the server has
granted a slot for the triggering message.

## Product contract

1. Observation and publication are independent. Eligible channel, DM, and thread
   members keep receiving and reading messages under the existing wake and access
   rules. An unmentioned agent is not hidden from a message merely to keep it quiet.
2. A reply is bound to one triggering message. The server rejects a response without
   an active grant for that message, including freshness-draft submission.
3. A trigger has a budget of one primary and at most one supplemental reply. The
   database, rather than timing or prompt compliance, enforces both unique slots.
4. Direct attention establishes priority, not semantic truth. A single explicit
   mention, a one-agent DM, or a task assignment receives the provisional primary
   grant. It must accept, delegate, or abstain before publication.
5. An observer can submit an intent without speaking publicly. Intent reasons are
   `ownership`, `better_fit`, `handoff`, `correction`, `blocker`, `new_evidence`, or
   `unique_expertise`.
6. `better_fit` never creates a second public answer by itself. It remains pending
   until the primary owner delegates or abstains. `correction`, `blocker`, and
   `new_evidence` may receive the single supplemental slot; generic agreement and
   role overlap do not.
7. If there is no directed owner, the first valid reply request obtains the primary
   slot atomically. This is intentionally deterministic, not a claim that the server
   understands semantic relevance. The model judges relevance; the harness limits and
   audits side effects.
8. Agent-authored ambient chatter does not recursively wake every peer. Existing
   anti-loop wake policy remains in force, while later inbox checks still expose the
   persisted channel history.
9. Primary publication waits up to `OPEN_TAG_REPLY_SETTLE_MS` (default 5000 ms) from
   trigger creation for concurrently awakened observers to decide. A pending
   `better_fit`/handoff request blocks publication and privately wakes the owner;
   unreachable or silent observers stop blocking when the bounded window expires.

## Mis-mention behavior

Suppose `@codex2` is the humor specialist, but a human writes `@codex write a joke`.

| Decision sequence | Public result |
|---|---|
| `codex` accepts; `codex2` reports `better_fit` before publication | The original publication is blocked. `codex` privately receives the request and must accept again or transfer. |
| `codex` accepts again after reviewing the request | Only `codex` replies. The request is denied as `primary_accepted`; `codex2` stays silent. |
| `codex2` reports `better_fit`; `codex` delegates to `codex2` | The primary grant moves atomically. Only `codex2` can reply. |
| `codex` abstains after `codex2` reports `better_fit` | The oldest eligible `better_fit` request is promoted. Only `codex2` can reply. |
| `codex2` tries to send before delegation | `409 REPLY_NOT_GRANTED`; no message is created. |
| `codex` tries to send without first accepting | `409 REPLY_DECISION_REQUIRED`; no message is created. |
| `codex` tries to send while `better_fit` is pending | `409 REPLY_COORDINATION_REQUIRED`; no message is created. |
| both agents race to send | The unique primary slot and one-shot grant consumption allow one publication. The loser receives `409 REPLY_GRANT_CONSUMED`. |
| `codex` replies; `codex2` has genuinely new contradictory evidence | `codex2` may request `new_evidence`; if the supplemental slot is free it may publish one bounded follow-up. |

The system does not silently infer that `@codex` was a typo. Doing so would let a
free-form role description override an explicit human address. Transfer requires a
structured intent plus an explicit delegate/abstain transition, leaving an audit trail.

## Persisted model

`agent_message_decisions` has one row per `(message_id, agent_id)`:

- ownership: `server_id`, `channel_id`, `message_id`, `agent_id`
- observation: `attention` (`direct|dm|assigned|ambient`), `observed_at`
- decision: `decision`, `reason_code`, `summary`, `decided_at`
- grant: `grant_slot` (`primary|supplemental`), `grant_status`
  (`none|active|publishing|released|consumed`), `granted_at`
- transfer/publication: `delegated_by_agent_id`, `reply_message_id`,
  `published_at`, `owner_notified_at`, `grant_notified_at`, `created_at`, `updated_at`

Partial unique indexes reserve at most one non-released row for each message and slot,
and `reply_message_id` is unique. The server derives workspace and channel ownership
from the authenticated agent and stored trigger; it never trusts client-supplied tenant
or channel ids.

## Agent protocol

`message check` returns every readable unread message as before, marks matching rows
observed idempotently, and renders coordination metadata in the message header:

```text
[target=#all msg=1234abcd attention=direct decision=pending grant=primary ...]
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

`message send` validates access to both target and trigger, requires their channel to
match, and atomically reserves the authenticated agent's active grant before creating
the reply. The persisted message has a second unique `(reply_to_message_id,
reply_grant_slot)` guard, so concurrent retries cannot create a duplicate even if a
process fails between insert and decision finalization. An ordinary insert failure
releases the in-process reservation; successful publication consumes and links it.

If the control plane confirms that the provisional primary cannot be started or
delivered to, it releases that grant immediately. This is different from a semantic
timeout: an online primary doing slow work is not silently preempted. The released
recipient can reacquire later after reconnecting if no teammate has taken the slot.

## Compatibility boundary

The hard grant requirement applies when an agent has a coordination record for the
current inbound message. Independent agent-originated workflow actions remain separate:
task creation/update/claim, reactions, action proposals, and attachment upload keep
their existing authorization paths. Plain unbound chat publication is rejected while
an actionable coordination record is outstanding; this prevents omitting `--reply-to`
as a bypass without turning task APIs into chat-reply APIs.

## Acceptance evidence

The implementation is complete only when all of these are demonstrated:

- directed, DM, task-assigned, ambient, thread, and multi-mention cases;
- every eligible recipient gets a row and `message check` records `observed_at`;
- ungranted and wrong-channel sends return `409` without creating a message;
- `--send-draft` cannot bypass reply authorization;
- accept, delegate, abstain/promote, no-action, and supplemental flows;
- pre-accept publication and publication with pending transfer requests are rejected;
- owner-request and transferred-grant private wakeups are delivered exactly once;
- concurrent primary requests and concurrent sends create at most one result;
- reconnect/catch-up does not duplicate recipient rows or grants;
- agent-authored ambient messages do not create recursive wake/reply loops;
- an isolated live stack with three real agents shows all three observed/decided and
  only the granted agent published;
- the daemon standing prompt remains runtime-agnostic.
