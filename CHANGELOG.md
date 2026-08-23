# Changelog

## 1.0.1 — 2026-08-23

- Treat a DSH child that settles with `stopReason: "error"` but delivers non-empty plain text as a
  completed member contribution. The original stop reason stays durable and Run Center shows a
  protocol-delivery warning; rejected promises, cleanup failures, empty output, timeouts, and other
  stop reasons such as `max-tokens` remain failures.
- Raise the default per-member handoff summary ceiling from 4,000 to 16,000 characters so long-form
  Markdown deliverables are not silently cut at the old boundary.
- Add a durable, versioned, import/export-safe per-team `handoffSummaryMaxChars` setting with a
  1,000–32,000 character range, Host/RPC/client validation, Settings UI, and bilingual guidance.
  Complete raw output remains in Run Center, while dependency and lead prompts retain independent
  aggregate bounds.
- Move the mixed Host/client contract handshake to RPC v4 and align development plus CI smoke
  coverage with DSH `0.1.1-rc.2`, the reporter's reproduced environment.

## 1.0.0 — 2026-08-19

- **Structured retrospective synthesis**: the main Agent no longer produces a flat "synthesize
  these results" summary. After every squad run it now delivers a six-section retrospective:
  1. squad execution summary with per-member outcomes, 2. what went well, 3. what did not go well
  with root causes, 4. knowledge gap analysis classifying gaps as missing repository knowledge,
  missing user-supplied domain knowledge, scope/planning issues, or tool/execution limitations,
  5. concrete improvement recommendations for progressive disclosure or direct documentation, and
  6. a final verdict on squad effectiveness.
- Fix `.cursor/rules` and `.dsh/rules` backtick escaping in the progressive-disclosure guidance
  inside the retrospective prompt.

## 0.5.0 — 2026-08-17

- Add first-class **Team**, **Solo**, and **Inherited** conversation modes plus a durable one-shot
  override and project default. Cold boot, refresh, and live Host reconnect now rehydrate without
  requiring users to re-save a team or wait behind a permanently disabled control.
- Make the active conversation's model route the bounded workflow planner by default. It can skip
  unsuitable work, select an adaptive subset, produce role-specific assignments and an acyclic
  dependency graph, or fall back to a deterministic plan when structured planning fails.
- Add bounded parallel DAG execution, foreground/background runs, official Jobs integration,
  cancellation, crash reconciliation, linked whole/member retry, configurable retention, plan
  preview, and an optional reviewer/repair loop capped at two rounds.
- Keep automatic run/version retention opt-in (`0` by default), so upgrades never silently delete
  existing history; explicit positive limits still provide bounded cleanup.
- Prevent descendant explosions with lineage checks, fail-closed denial of every detected subagent
  tool name, bounded prompts/handoffs, a durable latest-user-message claim, and one normalized plan
  per run. Repeated model-tool calls for one user message cannot start duplicate teams.
- Stream the official provider token projection across planner, member, review, and repair phases;
  preserve uncached input/cache read/cache write/output buckets; keep retry totals monotonic; and
  label coverage as full, partial, or unavailable instead of treating missing samples as zero.
- Add reproducible team versions containing member snapshots, definition backup preview/apply,
  portable recipes with copy/merge and primary/fallback route remapping, impact warnings, and
  compensating rollback for aborted or failed multi-table writes.
- Rebuild the Web experience into focused Composer, Teams/Members/Recipes Settings, Run Center, and
  Insights surfaces with official live locale updates, keyboard/focus handling, inline validation,
  dirty-form guards, light/dark theme tokens, and narrow-screen layouts.
- Separate strict new-write schemas from permissive legacy readers so existing v0.4 records and v1
  exports—including previously valid large or empty records—still reopen and import safely.
- Add Host and rendered-client regression suites, an isolated fresh-profile install/restart smoke,
  browser accessibility/keyboard/reconnect checks, package-closure and secret audits, immutable
  GitHub Actions, release preflight, governance files, recipe examples, and a reproducible README
  capture pipeline. Final release evidence is recorded in `docs/v0.5-acceptance.md`.

## 0.4.1 — 2026-08-17

- Prevent recursive squad explosions by excluding delegated sessions from automatic mode, denying
  team/subagent tools inside members, and rejecting nested dispatches at the service boundary.
- Dispatch only the latest user message and deduplicate guaranteed dispatch by session/message trace.
- Stream official `tokenUsage` projection changes into active run/member rows, subtract fork seed
  usage, and show **Metering…** until a provider reports instead of displaying a false zero.
- Make the parent conversation's Main Agent the default dynamic workflow planner: it assigns every
  configured member exactly once according to role/model/tool capabilities, while fixed order remains
  an explicit override and planning failures fall back to differentiated role-scoped assignments.
- Rehydrate the persisted team catalog and per-conversation/project selection after every Web
  reconnect, with bounded cold-start retries so restarting DSH no longer requires re-saving a team.
- Keep an explicitly disabled Solo conversation immediately interactive after refresh, while
  unresolved inherited project defaults continue hydrating in the background.

## 0.4.0 — 2026-08-17

- Run the selected squad reliably from the host `agent/pre-step` path before the lead model answers.
- Add a conversation **Team runs** view and live run dock with durable progress, outputs, retry state,
  cancellation, timings, child IDs, and official provider-reported token usage buckets.
- Add optional planning leads, fixed/model-planned ordering, bounded parallelism, member timeouts,
  continue/stop/retry-once policies, fallback model routes, and soft token budgets.
- Add per-project team defaults with explicit per-conversation opt-out.
- Add quick-start templates, visual tool policies, team cloning, immutable revisions/restore, route
  diagnostics, and safer merge/replace import previews.
- Fix the composer switch being locked during Harness's normal `adjudicating` phase.
- Fix the Export action and add visible success/error feedback.
- Upgrade the browser/host RPC contract to revision 2 and add validated endpoints for runs,
  revisions, diagnostics, project defaults, import, and export.

## 0.1.0 — 2026-08-15

- Initial public preview with persistent agents/squads, Web Settings UI, per-conversation selection,
  serial/parallel dispatch, spawn/fork/chain context, import/export, and `dispatch_to_squad`.
