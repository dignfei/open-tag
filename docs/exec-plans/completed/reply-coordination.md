# Reply coordination execution plan

Status: completed 2026-07-23.

## Goal

Keep relevant agents informed while making public replies a server-enforced,
auditable, single-owner action. Prove the original multi-reply failure and the corrected
mention, mis-mention, ambient, thread, task, concurrency, and reconnect behavior.

## Steps

1. Capture the current wake/check/send chain and write the protocol contract.
   Verification: `docs/reply-coordination.md` contains explicit before/after outcomes,
   invariants, API shape, and acceptance cases.
2. Add the persistence and decision state machine in a server module.
   Verification: schema constraints reject duplicate primary/supplemental grants and
   unit tests cover every transition and invalid reason.
3. Bind observation and publication to the state machine.
   Verification: integration tests show `message check` marks observation, send requires
   a matching active grant, transactionally consumes it, and draft submission cannot
   bypass it.
4. Update the agent CLI and runtime-agnostic daemon prompt.
   Verification: CLI exercises decide/delegate/send flows; provider-specific prompt
   terms remain absent.
5. Exercise failure, race, and recovery paths.
   Verification: concurrent requests/sends, wrong tenant/channel, missing/invalid ids,
   duplicate checks, reconnect catch-up, multi-mention, DM, task assignment, thread
   follow/unfollow, and agent-authored loop suppression all pass.
6. Run a three-agent isolated live stack and inspect API, database, logs, and browser.
   Verification: all eligible agents have observation/decision evidence, exactly the
   granted agent publishes, and the channel UI shows one reply.
7. Synchronize architecture, schema, feature, release, and operational documentation.
   Verification: `/doc-sync`, root/web typechecks, build, applicable tests, real curl,
   and browser verification pass; skipped/warnings/unverified paths are reported.

## Progress log

- 2026-07-23: Production evidence and source trace established that ambient recipients
  were awakened, all ran `message check`, and prompt instructions compelled replies;
  freshness hold did not represent reply ownership.
- 2026-07-23: Isolated worktree `reply-coordination` created from `origin/main`.
- 2026-07-23: Protocol, mis-mention semantics, persistence model, and acceptance matrix
  documented before implementation.
- 2026-07-23: Observe/decide/grant/send protocol implemented across schema, server,
  CLI, daemon prompt, and Hermes fallback. Policy, PostgreSQL race, core task/thread/DM,
  and real HTTP three-agent tests pass; confirmed delivery failure releases provisional
  ownership without using a semantic timeout.
- 2026-07-23: Live three-Codex E2E reproduced the exact typo-mention case. All three
  agents checked and decided; `codex-worker` chose `no_action`, `codex` released the
  provisional primary, `codex2` was privately promoted and published the only linked
  reply. A nested `@codex` inside the joke was observed and classified `no_action`, with
  no follow-up message. Browser, server logs, and decision/reply rows agreed.
- 2026-07-23: Final verification completed: 112/112 repository tests passed with no
  failures/skips/cancellations, root+web typecheck passed, daemon package/web/docs builds
  passed, relative documentation links resolved, and the runtime-agnostic prompt scan
  found no provider-specific tool names. The full-suite command requires Node's
  `--test-force-exit` because the pre-existing agent-manager test leaves handles open.

## Decision log

- Preserve observation for eligible agents; constrain publication instead of hiding
  messages from unmentioned agents.
- Treat explicit mention as provisional priority, not an irrevocable exclusive lock.
- Require structured transfer for suspected mention mistakes; do not let role text
  silently override the human's address.
- Keep semantic relevance in the agent decision and deterministic concurrency/budget
  enforcement in the control plane; do not add a second judge model in this slice.
- Keep freshness hold as a secondary stale-context defense, never as authorization.
- Bound the concurrent intent-settlement wait to five seconds by default; silent peers
  must not deadlock a reply, but an intent that arrives before publication must block
  the provisional owner until accept/transfer is explicit.
