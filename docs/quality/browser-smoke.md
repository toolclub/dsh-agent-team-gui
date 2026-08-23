# Browser release journey

Run this checklist against the exact release commit after `pnpm run preflight` passes. Use a fresh
temporary `DSH_HOME`; never use a maintainer's normal profile as release evidence. Record the commit,
DSH version, browser version, viewport, locale, and result without credentials or private model names.
Remote Git evidence must use a full 40-character commit SHA; tags and abbreviated SHAs are not
accepted by the smoke harness.

The automated baseline is:

```sh
API_VERSION=4 SMOKE_SCREENSHOT_DIR=.artifacts/browser-smoke pnpm run smoke:browser
```

It proves the production client bundle loads through DSH, the RPC handshake is v3, a seeded team
appears, and both one-shot choices queue through Composer/RPC. While Web is stopped, the isolated
fixture models the legal durable result of one eligible pre-step; after restart the queued Team
choice is unavailable to a second message. A project default survives then clears across cold reloads. Controls
recover after restart, an interrupted run can be retried and stopped when still live, insights
aggregate durable history, oversized recipe/definition files produce visible errors without an
RPC, light/dark Harness tokens visibly differ, no browser runtime error is
emitted, and the primary page does not overflow at 390 px. It also exercises the primary flow with
Tab/Space/Escape and blocks serious or critical axe-core findings within the plugin's composer,
Settings, and Run Center roots (including Composer under both color schemes).
Within a tablist it uses ArrowLeft/ArrowRight/Home/End and expects roving `tabindex`; Tab must move
to the next control outside the tablist.
The following product journeys remain required before a tag:

Official locale-service propagation and atomic first-run template creation have rendered Client
integration tests. Their real Harness-shell switches remain in the manual list below; the automated
browser script does not claim to operate a shell API that Harness does not publicly expose.

## First use and Settings

1. Start with no teams. Verify the composer explains the empty state and opens Settings directly.
2. Create reusable members, then a team. Confirm inline validation, progressive advanced sections,
   sticky actions, selected-item persistence, and dirty navigation/close guards.
3. Save, close Settings, reload the page, and restart DSH. The team must be usable without re-saving.
4. Export a recipe, preview it without writing, exercise a naming conflict and model remap, import a
   copy, and compare the immutable member snapshot in team version preview/restore.

## Conversation activation

1. Exercise explicit Team, explicit Solo, inherited project default, and one-shot next-message
   states. Reload each durable state; consume a one-shot state exactly once.
2. In smart/adaptive mode, preview and send a trivial acknowledgement (skip) and a multi-role task
   (proper member subset). In always/all mode, verify legacy v0.4 behaviour remains deterministic.
3. Disconnect/reconnect the Host. Loading and failure UI must contain visible explanation and a
   retry action; no mystery disabled control or title-only punctuation is acceptable.

## Execution, recovery, and usage

1. Run a dependency graph containing a parallel stage and a dependant. Inspect bounded handoffs and
   stable topological order.
2. Trigger one rejected review and one repair. Confirm the configured maximum rounds is respected
   and no descendant can dispatch another team.
3. Compare foreground synthesis with background acknowledgement and Run Center ownership.
4. Cancel from both live dock and Run Center. Reload and verify API, run, and member cancellation
   states agree. Retry and verify a new run links to the original without mutating it.
5. Stop DSH during an active run. After restart it must be `interrupted`, not eternally running;
   retry must remain available.
6. Inspect run detail and insights. Uncached input, cache read, cache write, and output are separate;
   planner/member/review/repair attribution is visible; no token number is labelled as currency.
7. Exercise retention filters, export, selective clear, count/age cleanup, and soft-budget stopping.

## Accessibility and responsive UI

1. Switch the Harness locale live between English and Chinese while Settings and Run Center are open.
2. Complete the primary flow keyboard-only. Confirm focus-visible, logical order, restored focus after
   dialogs, and dynamic accessible names for every stateful icon control.
3. Repeat in light/dark themes and with reduced motion.
4. Repeat at 1440×900 and 390×844. No primary action may be clipped, require horizontal scrolling,
   or be hidden behind a fixed action bar.

Capture the six release screenshots named in `docs/v0.5-acceptance.md` from this exact build. Redact
workspace paths, credentials, private providers, user names, and unrelated conversation content.
