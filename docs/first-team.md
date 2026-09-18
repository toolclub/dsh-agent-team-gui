# Run your first reusable Agent team

[简体中文](first-team.zh-CN.md) · [Back to the README](../README.md)

Import a planner, an implementation engineer, and an independent reviewer. Give them a small task
in an empty project, inspect their outputs, and keep the team for your next conversation.
This is a reproducible exercise, not a published live-model benchmark. The repository screenshots
use seeded UI example data; they are not evidence that this exercise completed.

## Install and open the team settings

You need a working DeepSeek Harness Web profile, pnpm, Node.js `>=22.19.0 <23` or `>=24.0.0`, and at
least one working provider/model route. DSH compatibility is declared as `>=0.1.5-rc.1 <0.1.6-0`;
the v1.1.1 release and current CI use DSH `0.1.5-rc.1`.

```sh
dsh plugin --profile web add -w https://github.com/toolclub/dsh-agent-team-gui/releases/download/v1.1.1/dsh-agent-team-gui-1.1.1.tgz
dsh --profile web
```

Restart an existing Web process and refresh its page. Open **Settings → Teams**. You should see
**Teams**, **Member library**, and **Recipes & data**. The release package includes the compiled
plugin, so this installation does not need the plugin's Git `prepare` build authorization.

Confirm that an ordinary Solo conversation can use your chosen model before adding the team.
All three members may use the same model; separate model accounts are optional. The conversation's
own model also needs to work because it plans and synthesizes the team run. Credentials stay in DSH.

## Import and map the recipe

1. Open the [full-stack delivery recipe](../examples/full-stack-delivery.recipe.json) and download
   the raw JSON, or copy its complete contents.
2. Open **Settings → Teams → Recipes & data → Team recipes**. Click **Choose recipe file** to
   preview the local file. Alternatively paste it into **Recipe JSON** and click **Preview**.
3. Map every `your-provider / your-model` placeholder to an available route. Choosing a provider
   selects its first model and automatically refreshes the preview. Resolved missing-route rows
   disappear; you can choose each member's exact model in **Member library** after importing.
4. Wait for **Recipe is valid**, keep **Import policy → Create a copy**, and click
   **Import reviewed recipe**. Review any conflicts before applying.
5. In **Member library**, confirm the model and tools for all three imported members, then save
   any edits. The implementation member needs project file and command tools; the reviewer needs
   code-reading and verification tools. Use tool names present in your DSH installation.

| Member | Responsibility in this exercise |
| --- | --- |
| Product planner | Acceptance criteria and edge cases, without implementing |
| Implementation engineer | Project files, behavior tests, and actual check output |
| Quality reviewer | Independent evidence-based review against the criteria |

Creating a copy preserves existing definitions. Merging by ID can change shared members and affect
other teams. Recipe import reads local JSON; it does not fetch recipe URLs or run a model.
The separate **Plan preview** action invokes the planner and consumes model Tokens.

## Set up the first run

Select the imported **Full-stack delivery** team. For this exercise, set **Activation → Run every time**
and **Member selection → All members**, keep **Fixed order** off, and choose **Response → Finish before synthesis**.
Save the team. The supplied recipe otherwise uses Smart/adaptive selection, which may skip a small
task or use fewer members.

The recipe sets concurrency to 2, a 10-minute member timeout, a 30,000-Token soft scheduling budget,
and a quality gate with at most one repair round. The soft budget does not cap already-running calls
at an exact total. The quality gate may call the reviewer after its ordinary member assignment.

Use an empty scratch project. On macOS/Linux, create one with:

```sh
TEAM_DEMO_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dsh-team-demo.XXXXXX")
printf '%s\n' "$TEAM_DEMO_DIR"
```

On Windows PowerShell:

```powershell
$teamDemoDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-team-demo-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $teamDemoDir
```

Open that directory as the DSH project and create a conversation. Check its working directory and
file/command permissions. Member policy cannot grant tools the parent conversation does not have.
In the composer team control, select the imported team and enable it for this conversation. Clear
any queued one-message Solo override so it does not take precedence over the saved team mode.

## Try a small development task

Paste this request into the conversation:

```text
Build a dependency-free to-do list in this empty scratch project.

Scope:
- Write only index.html, app.mjs, app.test.mjs, and README.md in this project.
- Do not install dependencies, call external services, commit, publish, or change another project.
- No persistence, authentication, or backend. Inline CSS in index.html is sufficient.

Acceptance criteria:
- Trim new task text and reject empty input, with clear input errors and an empty-list state.
- Support completing/uncompleting and deleting tasks. Remaining count equals incomplete tasks.
- Give the input an accessible name and use native buttons/checkboxes with keyboard operation.
- Keep state logic in app.mjs importable by Node without requiring a browser DOM.
- Use Node's test runner to verify add, blank-input rejection, completion toggle, deletion, and count.
- README.md explains how to serve the page locally, run tests, and check the UI manually.

The planner defines criteria and edge cases first. The implementation member writes the files and
runs checks. The reviewer independently checks the implementation and actual test output, naming
any required repairs. Run node --test. Report delivered files, checks actually run and their results,
unverified behavior, and remaining problems. Do not report unexecuted checks as passing.
```

The exact plan and number of stages depend on the model. The conversation's lead model plans and
synthesizes; the Product planner is a separate member responsible for acceptance criteria.

## Verify the result and inspect the run

Check all four files and the actual `node --test` output. Re-run the tests in the scratch directory.
Serve the page locally using the generated README; ES modules normally require HTTP rather than
opening `index.html` with `file://`. In the browser, add whitespace-padded text, reject blank text,
toggle completion twice, delete tasks, check the count and empty state, and try keyboard controls.
If the model has no browser tool, leave the browser checks explicitly marked for manual verification.

Open **Team runs** and expand the record to see the plan, dependency stages, member outputs, and
review/repair results. Use cancellation while a run is active, or linked whole/member retry after
investigating a failure. A completed run state does not replace file or behavior verification.

**Insights** aggregates provider-reported uncached input, cache reads, cache writes, and output
Tokens. It distinguishes planning, members, review, and repair. Partial or unavailable coverage
does not mean zero usage; the plugin does not infer a monetary price. The Run Center does not track
the lead model's final answer after team handoff.

## Installation troubleshooting

| Symptom | Next step |
| --- | --- |
| `dsh` is not found | Use the launcher for your working Harness. For npm, substitute `npx @deepseek-ai/dsh@0.1.5-rc.1` for `dsh`; from source, use `pnpm --dir /absolute/path/to/deepseek-harness dsh`. Use the same launcher for install and startup. |
| Marketplace Git install fails | Install the compiled Release URL above directly. If the failed Git dependency remains, remove it with `dsh plugin --profile web remove dsh-agent-team-gui`, then retry the release command. |
| Release download fails | Download the `.tgz` from [v1.1.1 Releases](https://github.com/toolclub/dsh-agent-team-gui/releases/tag/v1.1.1), then install its local absolute path. |
| Teams are missing or Host/client versions disagree | Confirm the Web profile, restart the DSH process, and refresh the browser. Record both plugin and DSH versions. |
| Recipe import stays disabled | Map all missing routes, wait for preview, and refresh the preview if another window changed the definitions. |
| Sending a message does not start the team | Check the selected team, conversation mode, one-message override, and the saved activation/member-selection settings. |
| Output contains code but no files or check results | Verify the project directory and parent/member tools. A prompt cannot supply missing file or command permissions. |
| A member times out or review fails | Read that member's output and error, fix the route/tools/task problem, then retry. |
| Tokens are partial or absent | Inspect provider coverage; missing samples are not filled with zero. |

To check activation, run `dsh --profile web --dump-config` and look for both the
`dsh-agent-team-gui` bundle and `agent-team-gui` row. This works without Unix text-filter commands.

For Git builds, follow the [source-install instructions](../README.md#git-source-installation), pin
the version, and authorize only the exact package key pnpm prints. Prefer the release package for
ordinary installation. Report unresolved problems with OS, Node, pnpm, DSH/plugin versions, the
exact command, and a sanitized error in an [issue](https://github.com/toolclub/dsh-agent-team-gui/issues/new/choose).

Reuse the saved team in another conversation when you are ready. If it helps,
[Star the repository](https://github.com/toolclub/dsh-agent-team-gui) and
[share your workflow](https://github.com/toolclub/dsh-agent-team-gui/discussions/1).
