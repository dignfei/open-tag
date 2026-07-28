# Inline Agent Activity

## Goal

Replace the channel-wide Agent Live Trace sidebar with durable, per-message Activity disclosures in channels, DMs, and threads. A run that sends no public message must still leave a quiet handled/error receipt in the conversation, while the Agent Profile Activity tab remains the global diagnostic history.

## Product contract

- Agent runtime text, thinking, and tool calls are Activity, not public message content.
- A real agent message exists only after the agent uses the message API.
- Before that first message, the conversation renders one compact live run row. The persisted message inherits its client render key and replaces it in place; a run never creates a second continuation placeholder after publishing.
- Each real agent message owns the Activity accumulated since the run started or since the preceding message in the same run.
- Activity emitted after the final message is appended to that final message when the run completes.
- A completed run with no real message persists an `agent_activity_receipt` row. The UI renders it as `Handled` or `Failed`, without message actions or message-body copy.
- Activity receipts are human-facing observability records. Agent inbox/read APIs exclude them so receipts cannot wake agents or enter collaboration loops.
- Channel/thread users see only run Activity associated with that conversation. Agent Profile Activity remains the workspace-wide history for diagnostics.

## Data and event contract

1. The server creates a run boundary using the existing reply `streamId` and target `channelId` before daemon delivery.
2. The daemon attaches the active `streamId` and `channelId` to status and trajectory events.
3. `agent_activity_log` persists that context plus the eventual `messageId` segment owner.
4. `messages` persists the Activity snapshot, stream id, and completion state so a refresh restores the same disclosure without replaying the live event buffer.
5. Channel-scoped `agent:reply activity` events update the active placeholder. Workspace-scoped Activity events continue feeding Agent Profile, but no longer feed a global chat sidebar.
6. The first real message claims pending Activity for the run; later messages claim only entries emitted since the prior claim. Run completion appends the tail to the final message or creates a receipt when no message exists.

## Steps and verification

1. **Persist run/message correlation**
   - Added schema fields and shared run-activity helpers.
   - Verified against isolated Postgres: first-message, second-message, tail, and no-message segmentation all passed (11 checks).
2. **Carry run context through the daemon protocol**
   - Attached channel/stream/run context to status and trajectory events and removed trajectory-as-public-delta behavior.
   - Verified by typecheck, unit contracts, and real daemon runs.
3. **Render inline Activity and remove Live Trace**
   - Added the shared disclosure/receipt to channel and thread rows; removed the global trace buffer/sidebar; made the fourth grid column conditional on a real thread/profile panel.
   - Replaced the full pre-reply message card with a compact run row, preserved its render key when the real reply arrives, restored the agent presence indicator at the message's right edge, and widened the desktop message/composer rail. Channel and thread message Markdown now follows its responsive content column instead of retaining a document-style reading cap; Workspace document previews keep the narrower measure.
   - Verified by unit contracts and live desktop/mobile DOM measurements, including a real 14.8s agent run with one run-row-to-message transition and no continuation block.
4. **Documentation and migration sync**
   - Updated generated schema, architecture, feature status, README, daemon changelog, and daemon version.
   - Verified by the final doc-sync audit and diff hygiene checks.
5. **Real end-to-end validation**
   - Used an isolated server, Postgres, Redis, daemon, seeded Claude agent, and ego-browser.
   - Verified live channel Activity, persisted refresh, independent thread Activity, a no-message handled receipt, live-placeholder auto-expand followed by persisted-message/receipt auto-collapse, message-scoped header status, Profile Activity history, removal of the permanent Live Trace column, full-width message content at 1990px desktop, and a 390 x 844 mobile viewport with zero horizontal overflow.

## Decision log

- **2026-07-23:** Rejected a frontend-only correlation buffer because it loses message ownership on refresh and can mix cross-channel Activity.
- **2026-07-23:** Chose persisted message snapshots plus activity-log ownership instead of making the Agent Profile log the chat rendering source. The snapshot keeps message pagination bounded and preserves history even after the per-agent log retention cap prunes old rows.
- **2026-07-23:** Chose a dedicated message type for no-message receipts instead of technical explanatory copy. It participates in human conversation ordering/unread state but is filtered from agent-facing reads and has no message actions.
- **2026-07-23:** Kept Agent Profile Activity as the global cross-run diagnostic view. Inline Activity owns the local conversational context; the two surfaces are complementary rather than duplicate permanent panels.
- **2026-07-23:** Kept the live run and first public reply as one client-rendered object. A separate continuation row made one reply look like two messages and caused a second entrance animation; Activity now follows the persisted message instead.

## Progress log

- **2026-07-23:** Traced the existing reply-preview, trajectory, Activity log, channel/thread rendering, and right-panel layout; established the product and data contracts.
- **2026-07-23:** Implemented durable run/message correlation, contextual daemon events, no-message receipts, inline disclosure UI, and conditional chat layout.
- **2026-07-23:** Passed typecheck, the full unit suite, isolated-Postgres integration, production web build, and real ego-browser E2E across desktop/mobile channel, thread, no-message, refresh, and profile paths.
