# dsh-agent-team-gui

[English](README.md) | [简体中文](README-zh.md)

[![CI](https://github.com/toolclub/dsh-agent-team-gui/actions/workflows/ci.yml/badge.svg)](https://github.com/toolclub/dsh-agent-team-gui/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/toolclub/dsh-agent-team-gui?include_prereleases&style=flat-square)](https://github.com/toolclub/dsh-agent-team-gui/releases)
[![GitHub stars](https://img.shields.io/github/stars/toolclub/dsh-agent-team-gui?style=flat-square)](https://github.com/toolclub/dsh-agent-team-gui/stargazers)
[![MIT license](https://img.shields.io/github/license/toolclub/dsh-agent-team-gui?style=flat-square)](LICENSE)

**Persistent, reusable multi-model Agent teams for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
Give each member its own model, role, fallback route, token limit, and tool policy. Select a saved
team beside the normal composer; the lead model plans the work, runs a bounded dependency graph,
and synthesizes the result.

![Manage a persistent multi-model team in DeepSeek Harness Settings](assets/v0.5-teams-settings.png)

## Why this plugin

A team is a reusable product object, not a one-off dispatch form. Create it once in **Settings →
Teams**, then use it across projects and conversations.

| Capability | User outcome |
| --- | --- |
| One model and tool policy per member | Combine a planner, implementer, reviewer, or specialist without forcing one route on everyone |
| Dynamic workflow planning by default | The active conversation's model assigns focused work and dependencies from the current request |
| Team / Solo / Inherited modes | Choose a durable conversation override, a project default, or a one-message exception without ambiguous switches |
| Bounded DAG, retries, quality gate, background work | Long work is observable, cancellable, finite, and restart-safe |
| Official provider Token usage | See input, cache-read, cache-write, and output Tokens with full/partial/unavailable coverage—never invented prices |
| Versions, recipes, and definition backup | Reproduce a team, share it without credentials, preview impact, and remap model routes before applying |

## Install

Requirements: DeepSeek Harness `>=0.1.0-rc.5 <0.2.0`, the **Web** profile, Node.js
`>=22.19.0 <23` or `>=24.0.0` (Node.js 23 is not supported), pnpm, and at least one configured DSH
provider/model route.

```sh
dsh plugin --profile web add -w github:toolclub/dsh-agent-team-gui#v1.0.1
dsh --profile web
```

Git dependencies run this repository's `prepare` build. On pnpm 10 or later, the first command may
ask you to authorize that build. Add only this reviewed package to the Web profile file shown by
pnpm (normally `~/.dsh/profiles/web/pnpm-workspace.yaml`), then repeat the same pinned command:

```yaml
allowBuilds:
  dsh-agent-team-gui: true
```

Restart an already-running DSH Web process after installing or updating. Open **Settings → Teams**,
create or import members and a team, then open the control beside the conversation composer.

> [!TIP]
> If `dsh` is not on `PATH`, cloning Harness alone did not install a global command. From the
> Harness checkout use `pnpm dsh --version`, and replace `dsh ...` in this README with
> `pnpm --dir /absolute/path/to/deepseek-harness dsh ...`.

Verify the composed bundle without installing `rg`:

```sh
dsh --profile web --dump-config | grep -E "agent-team-gui|dsh-agent-team-gui"
```

Expected output contains both the `dsh-agent-team-gui` bundle layer and the `agent-team-gui` row.

> [!CAUTION]
> `allowBuilds` lets the selected Git dependency execute its build on your machine. Review and pin
> a tag or full commit SHA. A compiled release tarball does not need Git `prepare` permission.

## First team in five steps

1. In **Settings → Members**, create reusable members. Pick a configured provider/model, write a
   narrow role prompt, optionally add a fallback route, and grant only the tools that role needs.
2. In **Settings → Teams**, create a team and select those members. Leave **Fixed order** off for
   dynamic planning, or enable it for a repeatable serial pipeline.
3. Choose **Always**, **Smart**, or **Manual** activation; all members or an adaptive subset;
   foreground or background response; and optional resilience, budget, or review controls.
4. Beside the normal composer choose **Team**, **Solo**, or **Inherited**. You can also queue a
   different team or Solo for only the next eligible message, or set a project default.
5. Send the task normally. Open **Team runs** to inspect the plan, stages, members, review/repair
   rounds, outputs, errors, timings, retries, and official Token coverage.

![Choose Team, Solo, or Inherited beside the normal composer](assets/v0.5-composer-mode.png)

## How orchestration works

```mermaid
flowchart LR
    U["Normal user message"] --> M{"Conversation mode"}
    M -->|"Solo"| L["Lead Agent answers normally"]
    M -->|"Team / inherited default"| A{"Activation"}
    A -->|"Manual"| L
    A -->|"Smart may skip"| P["Bounded lead-model planner"]
    A -->|"Always"| P
    P --> D["Validated acyclic plan"]
    D --> W1["Ready member wave"]
    W1 --> W2["Dependent member wave"]
    W2 --> Q{"Optional quality gate"}
    Q -->|"Approved / disabled"| H["Bounded handoffs"]
    Q -->|"At most 2 repairs"| R["Named repair owner"]
    R --> Q
    H --> L
    D -. "live state + official Tokens" .-> C["Run Center and Insights"]
```

With no fixed order, the plugin uses the active conversation's provider/model route in a bounded,
tool-free planner child. It receives the member roles and returns structured assignments plus an
acyclic dependency graph. It does not turn one member into a replacement for the whole team. A
bad, cyclic, or unavailable plan falls back to deterministic role-scoped assignments.

Ready DAG nodes run up to `maxConcurrency`. Dependants receive only bounded structured handoffs;
full member output remains in durable run history. A fixed member order is an explicit serial
override and bypasses DAG planning.

### Activation and selection

- **Always** runs the selected team for every eligible top-level user message.
- **Smart** lets the bounded planner skip unsuitable/trivial work.
- **Manual** keeps ordinary sends Solo; queue the team for the next message or use the model tool.
- **All members** assigns each configured member exactly once.
- **Adaptive** lets Smart planning select the smallest useful non-empty subset.

### Conversation modes

- **Team** is an explicit durable team selection for this conversation.
- **Solo** is an explicit durable opt-out, even when the project has a default team.
- **Inherited** removes the conversation override and follows the project default when one exists.
- **Next message** is a separate crash-safe one-shot Team or Solo choice, consumed exactly once.

These states remain interactive after page refresh, cold Host startup, and live reconnect. An empty
or temporarily unavailable catalog never silently deletes a saved selection.

### Safety bounds

- Planner, member, reviewer, and repair prompts put the exclusive role and no-delegation contract
  before a bounded excerpt of user content.
- Delegated sessions cannot dispatch another team. Detected DSH subagent tools—including renamed
  registrations—are denied inside team children.
- One durable claim binds automatic and model-tool dispatch to the latest human message, so repeated
  tool calls cannot create hundreds of duplicate teams.
- Member timeout, concurrency, retry-once, soft team Token budget, and quality rounds are finite.
- A retry creates a linked immutable run and replays the original normalized assignments, order,
  and DAG; it does not silently ask the model to invent a different workflow.

## Run Center and Token usage

![Inspect the DAG, member state, review rounds, and Token buckets](assets/v0.5-run-center.png)

Every execution is written before planning starts. The Run Center exposes foreground/background
state, live phase, elapsed time, child IDs, complete outputs, bounded handoffs, stop, linked whole
or member retry, export, filters, and retention-safe clear.

If a DSH child settles with `stopReason: "error"` after delivering non-empty plain text, the member
counts as **Completed** instead of losing a valid long-form deliverable. The stop reason remains
recorded and Run Center shows a protocol-delivery warning. Empty output, rejected runs, cleanup
failures, timeouts, and other non-completed reasons such as `max-tokens` remain failures.

Each member handoff summary keeps up to 16,000 characters by default. A team may set
`handoffSummaryMaxChars` from 1,000 to 32,000. Complete raw output remains durable in Run Center;
dependency and lead prompts retain separate aggregate bounds so one long artifact cannot make model
context unbounded.

The plugin reuses DSH's official `tokenUsage` projection and keeps four buckets:

- uncached input;
- cache read;
- cache write;
- output.

Planner, member, review, and repair usage remain separately attributable. Coverage is explicitly
**full**, **partial**, or **unavailable** at run and retry-attempt level. Before a provider reports a
sample, the UI says **Metering…** instead of showing a false zero. Tokens are not money; the plugin
does not guess prices that Harness providers do not publish through a stable pricing contract.

![Compare durable usage and completion insights without fabricated prices](assets/v0.5-insights.png)

## Quality gate and background runs

An optional quality gate names one reviewer, one repair owner, explicit criteria, and `0..2` repair
rounds. A rejection can rerun only that repair owner, followed by the named reviewer. It cannot
create arbitrary agents or recurse.

Foreground runs finish before the lead Agent synthesizes bounded handoffs. Background runs return a
short acknowledgement and stay visible in the plugin Run Center; when the official DSH Jobs service
is present, the same run is also registered there with a shared cancel hook. Without that optional
service, the plugin falls back to process-local background execution; a Host restart then reconciles
unfinished durable state as **Interrupted** rather than pretending it completed.

## Versions, recipes, and definition backup

![Preview a recipe, conflicts, affected teams, and primary/fallback route remapping](assets/v0.5-recipes.png)

- Each saved team version includes immutable snapshots of all referenced member definitions.
- Restore is preview-first and warns when a shared member would change another team.
- Recipes contain one team and its members, never provider credentials. Import supports **Copy** or
  **Merge**, conflict preview, and separate primary/fallback route remapping.
- Definition backup exports agents and teams. Import is preview-first with **Merge** or **Replace**;
  replace reports deletions, dangling mode/default cleanup, and affected teams before confirmation.
- Multi-table writes are serialized and use compensating rollback on validation, cancellation, or
  storage failure. Readers see either the previous or committed definition graph, not a half-import.
- Remote recipe URLs are disabled in v0.5. Import a reviewed local JSON file; this intentionally
  avoids exposing an unprotected server-side fetch/SSRF surface.

Start with the credential-free
[full-stack delivery recipe](examples/full-stack-delivery.recipe.json), preview it, and remap its
`your-provider / your-model` placeholders to routes configured in your own DSH profile.

Definition exports include member system prompts and model route names. Run exports additionally
include the user task and member outputs. Review those files before sharing them.

## Settings reference

### Member

| Field | Meaning |
| --- | --- |
| Name and role prompt | Durable identity and exclusive instructions for this member |
| Primary provider/model | Existing DSH route; credentials stay in DSH |
| Fallback provider/model | Optional paired route for retry-once |
| `maxTokens` | Hard per-attempt output ceiling sent to the provider |
| Tool allow/deny | Least-privilege visibility for registered DSH tools; recursive team/subagent tools remain denied |

### Team

| Field | Meaning |
| --- | --- |
| Members and collaboration note | Reusable member definitions plus team-level coordination guidance |
| Fixed order | Complete serial permutation; leave off for dynamic assignments and DAG dependencies |
| Execution/context | Serial or bounded parallel; `spawn`, `fork`, or serial-only `chain` |
| Activation/selection | Always, Smart, or Manual; all members or adaptive subset |
| Response | Foreground synthesis or observable background run |
| Planner | Current/recent/full context and a bounded planner Token ceiling |
| Resilience | Continue, stop, or retry-once; member timeout and fallback route |
| Limits | Maximum concurrency and a soft provider-reported team Token budget |
| Handoff summary | Per-member summary ceiling in characters; blank uses 16,000, configurable from 1,000–32,000 |
| Quality | Named reviewer, repair owner, criteria, and at most two repair rounds |

![The primary path remains usable on a narrow viewport](assets/v0.5-narrow.png)

## Host configuration

The Web bundle inserts one unique Host row; it relies on the Web profile's existing storage,
Connection RPC, models, sessions, and browser module services.

```yaml
- id: agent-team-gui
  name: dsh-agent-team-gui
  config:
    defaultProvider: spawn
    defaultExecutionMode: serial
    defaultContextMode: spawn
    historyMaxRuns: 0
    historyMaxAgeDays: 0
    versionMaxPerSquad: 0
```

| Field | Default | Meaning |
| --- | --- | --- |
| `defaultProvider` | `spawn` | Registered DSH subagent provider |
| `defaultExecutionMode` | `serial` | Effective mode when a team omits it |
| `defaultContextMode` | `spawn` | Effective context when a team omits it |
| `historyMaxRuns` | `0` | Count retention; `0` disables automatic run deletion |
| `historyMaxAgeDays` | `0` | Age retention in days; `0` disables automatic run deletion |
| `versionMaxPerSquad` | `0` | Version retention per team; `0` disables automatic version deletion |

If you override the row in a profile patch, restate every needed field: DSH patch rows replace the
complete `config` object rather than deep-merging it. `chain` is valid only for serial execution.
Retention is deliberately opt-in: upgrading to v0.5 does not silently delete existing run history
or team versions. Set a positive limit only when automatic cleanup is the behavior you want.

## Other installation paths

### Exact commit

Resolve and review a full commit SHA, then use the same `allowBuilds` rule as the tagged Git install:

```sh
dsh plugin --profile web add -w github:toolclub/dsh-agent-team-gui#<full-commit-sha>
```

This is the most reproducible source install. The release CI performs the same fresh-profile check
against the exact pushed revision.

### Local checkout

From this repository:

```sh
pnpm install --frozen-lockfile
pnpm run preflight
dsh plugin --profile web add -w .
```

`preflight` type-checks Host, Client, and tests; runs Host/rendered Client suites; builds from a clean
output directory; audits the tarball and secrets; and boots an isolated temporary DSH Web profile.

### Compiled tarball

```sh
mkdir -p dist
pnpm pack --pack-destination dist
dsh plugin --profile web add -w ./dist/dsh-agent-team-gui-1.0.1.tgz
```

The package audit verifies runtime/declaration closure, examples, governance files, screenshots,
source maps, external dependency declarations, no absolute paths, no symlinks, and no known
credential patterns.

### Ask a terminal-capable Agent

You can send this single instruction inside DeepSeek Harness:

> Follow the installation and security notes in
> https://github.com/toolclub/dsh-agent-team-gui. Install the reviewed v1.0.1 tag into the Web
> profile, authorize only `dsh-agent-team-gui` if pnpm asks for `allowBuilds`, restart Web, verify the
> composed configuration, and report the exact installed revision.

## Model tool and public service

`dispatch_to_squad` remains available for explicit/manual model-driven use. It accepts a team ID or
unique case-insensitive name, a task, optional assignments/order, and execution/context overrides
where the saved team permits them. Its model-facing result is bounded; the complete canonical run is
durable and available through the Run Center/export.

The package also exports `AgentTeamService`, record/result types, Zod schemas, and the in-process
definition/dispatch/version/recipe/run APIs. Treat those APIs as developer-preview surfaces while
DSH itself is pre-stable.

## Security and privacy

- The dedicated RPC channel is registered loopback-only and validates every payload/result. This is
  not an authentication layer for exposing DSH Web to the public Internet.
- Provider credentials are never copied into plugin records, recipes, examples, logs, or exports.
- Durable local storage does contain team role prompts, selected route names, conversation/project
  identifiers, user tasks, run outputs, errors, and Token usage. Protect the DSH home directory.
- Use least-privilege member tools. A model may perform any action that its allowed DSH tools permit.
- URL recipe fetching is disabled. Installation scripts are the only extra machine-code authority;
  review and pin Git dependencies or use a compiled tarball.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md), not a public issue containing
  credentials or private prompts.

## Compatibility and limitations

- Web profile only; there is no headless Settings UI. The exported Host service can still be used by
  another in-process plugin that supplies the required services.
- Declared compatibility is DSH `>=0.1.0-rc.5 <0.2.0`; CI currently verifies rc.6. DSH and this
  plugin are both pre-stable, so pin versions.
- Old v0.4 durable definitions and v1 exports remain readable/importable. Editing them must satisfy
  the safer v0.5 new-write limits. A legacy run without a stored plan cannot be faithfully retried
  and is rejected with an explanation.
- Provider Token projections are optional. Partial/unavailable coverage is expected and explicit.
- A soft team Token budget prevents later scheduling; it cannot stop an already-running provider at
  the exact threshold. Per-member `maxTokens` is the hard provider bound.
- DSH currently offers no supported registration seam for custom durable `squad/*` Session event
  types. The plugin uses its durable run store, standard child sessions/tool events, Jobs, and logs.
- Model-tool trigger mode is best-effort because DSH exposes no `toolChoice` control. Guaranteed
  normal-send mode is Host-driven and durable-message-idempotent.

## Verification and project health

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run audit:pack
pnpm run smoke:install
pnpm run smoke:browser
```

CI runs Node 22.19 and Node 24, a fresh DSH rc.6 Web profile, browser keyboard/accessibility/reconnect
journeys, exact Git revision installation, and the community plugin doctor. The detailed product
contract and evidence matrix live in [docs/v0.5-product-spec.md](docs/v0.5-product-spec.md) and
[docs/v0.5-acceptance.md](docs/v0.5-acceptance.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and
[SECURITY.md](SECURITY.md). The concise Chinese tutorial
[从零开发一个 DeepSeek Harness 插件](docs/developing-a-deepseek-harness-plugin.zh-CN.md) explains
`apply`, Service plugins, profile/bundle wiring, local verification, and GitHub installation using
official Harness references.

Issues should include the exact DSH/plugin versions and a sanitized minimal reproduction. Pull
requests should add focused regression evidence and keep compatibility, bounded execution,
accessibility, privacy, and package closure in scope.

If this workflow helps, a [GitHub Star](https://github.com/toolclub/dsh-agent-team-gui) makes it
easier for other DSH users to discover. Real recipes, screenshots, and honest bug reports help even
more.

## Uninstall

```sh
dsh plugin --profile web remove dsh-agent-team-gui
```

Removing the package does not automatically delete durable plugin tables in the configured DSH
storage backend.

## License

Released under the [MIT License](LICENSE).
