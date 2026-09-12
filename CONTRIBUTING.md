# Contributing to dsh-agent-team-gui

Thank you for improving reusable multi-agent workflows for DeepSeek Harness. Small, focused changes
with reproducible evidence are the easiest to review and maintain.

## Before opening a change

1. Search existing issues and pull requests.
2. For a behavioural or RPC change, open an issue first and describe the user journey, compatibility
   impact, and failure behaviour.
3. Never include provider credentials, private prompts, conversation exports, or a real `~/.dsh`
   directory in an issue, fixture, screenshot, or commit.

## Local setup

The supported development baseline is Node.js `>=22.19.0 <23` or `>=24.0.0` (Node.js 23 is not
supported) and pnpm 9.15.4.

```sh
git clone https://github.com/toolclub/dsh-agent-team-gui.git
cd dsh-agent-team-gui
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
```

The repository can live beside a DeepSeek Harness checkout for source exploration, but its build and
Git-install lifecycle must never depend on that sibling directory.

## Architecture boundaries

- Pure policy modules own graph, handoff, recipe, retention, and usage calculations without React
  or browser globals.
- Application services separate definition/version/import/mode use cases from execution/run use
  cases. They own cancellation and storage consistency while adapting official Harness services.
- Infrastructure modules own FIFO read/write coordination, compensating storage units of work, and
  the narrow official Token projection adapter. RPC remains a strict transport boundary.
- Client controllers/stores own transport and observable state; React components render injected
  data/actions and do not reach into the Cordis context.

This is a pragmatic layered Cordis plugin, not a requirement to hide every official Harness call
behind a separate port. Preserve small public interfaces, coherent definition snapshots, bounded
external I/O, and testable pure policies rather than adding ceremonial abstractions.

Keep public RPC payloads Zod-validated, protected by the shared DSH browser authentication, backward compatible within the supported DSH
range, and represented in both Host and Client contract tests. Do not append new Harness session
event types or use private UI APIs as though they were supported extension points.

## Verification

Run the proportional checks while developing and the complete gate before requesting review:

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run audit:pack
pnpm run smoke:install
```

Changes to Settings, composer controls, Run Center, reconnect behaviour, or accessibility also need:

```sh
pnpm exec playwright install chromium
pnpm run smoke:browser
```

`smoke:install` and `smoke:browser` use isolated temporary homes. Never rewrite them to use a
developer's real `~/.dsh`.

## Pull requests

A pull request should:

- explain the user-visible outcome and non-obvious trade-offs;
- link an issue when behaviour or compatibility changes;
- add tests for success, failure, cancellation, restart, and migration paths where relevant;
- update both `README.md` and `README-zh.md` when public behaviour or commands change;
- include before/after captures for visual changes, using non-secret fixture data;
- keep generated bundles and release artifacts out of the diff unless the repository explicitly
  tracks them; and
- leave **Allow edits by maintainers** enabled when submitting from a fork.

Commit messages should be short, imperative, and scoped to one coherent change. By contributing,
you agree that your contribution is licensed under the repository's MIT License.
