# Quality and release engineering

The v0.5 release gates exercise the same package users install. They do not copy an existing
profile and they never write to the operator's `~/.dsh` directory.

## Fast local checks

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check:whitespace
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run audit:pack
```

`audit:pack` creates a tarball below a guarded temporary directory, extracts it, verifies every
package export, checks the browser ModuleLoader dependency closure, rejects source/test/config
leaks, scans text artifacts for common credential forms, and enforces a size ceiling.

## Hermetic runtime checks

Install an official DSH CLI first, or point `DSH_BIN` at a built official checkout:

```sh
npm install --global @deepseek-ai/dsh@0.1.0-rc.6
API_VERSION=4 pnpm run smoke:install
pnpm exec playwright install chromium
API_VERSION=4 pnpm run smoke:browser
```

Generate the six README captures from the same isolated production UI (never from static HTML or
an image generator) with:

```sh
API_VERSION=4 pnpm run capture:readme
```

The capture fixture creates three valid reusable members through RPC, saves an advanced team,
reopens a schema-valid completed DAG run with provider-reported four-bucket usage and a review /
repair loop, then captures Composer, Settings, Recipes, Run Center, Insights, and the 390 px view.
It rejects browser console/page errors, serious or critical axe findings in every captured plugin
root, malformed/tiny PNGs, and horizontal overflow before reporting success. Set
`README_SCREENSHOT_DIR` only when a non-default output directory is required. Captures are staged
under a guarded temporary directory and promoted only after all six pass. Each destination file is
atomically replaced, and a synchronous promotion failure rolls back files already replaced. Because
no filesystem offers an atomic transaction across six ordinary files, an operating-system crash or
forced process termination during the brief promotion window must still be detected with Git diff
or the printed evidence hashes before release.

Each command creates its own `mkdtemp` workspace and sets an explicit `HOME`, `USERPROFILE`,
`DSH_HOME`, XDG/Corepack directories, npm config/cache, and Git config inside it. Ambient
environment state is rebuilt from a narrow allowlist (path, locale, terminal, timezone, and CI
presentation flags) before package lifecycle scripts, the community doctor, Chromium, or DSH start;
Git/package-manager controls, credential/config roots, proxies, and Node/shell/loader injection
variables are not forwarded. The install smoke performs:

1. production build and tarball creation;
2. installation into a brand-new Web profile;
3. composed-config verification;
4. Web boot on an operating-system-selected port;
5. HTML and RPC v4 checks;
6. persistent member/team creation;
7. immutable member-backed versions plus recipe export/preview;
8. graceful shutdown and restart;
9. verification that the saved records, explicit Solo, and separate one-shot Team override survived and an orphaned running
   record became interrupted;
10. run export, non-active cancel semantics, unmetered insights, filtered history clear, and transitions
    through explicit Team and inherited mode.

The browser layer repeats those cross-restart checks through the production ModuleLoader client,
queues both one-shot choices, then uses the isolated legal storage schema to model completion of one
eligible pre-step and prove its Team choice is not available to a second message after restart,
sets/clears a project default through Composer with cold reloads, then opens Settings, retries the
interrupted run, exercises Stop when the retry remains live (or proves it reached a valid terminal
state first), rejects oversized recipe and definition files before any RPC, and loads aggregate
insights. It checks keyboard, light/dark computed Harness tokens,
axe-core in both schemes, console/page errors, and narrow layout. Official live-locale propagation
and atomic first-run templates are deterministic rendered-integration tests; switching the outer
Harness locale and creating a template in the real shell remain explicit manual release checks.

On failure the temporary directory is intentionally preserved and its path is printed. On success
it is removed only after a real-path guard proves it is a tool-owned child of the operating-system
temporary directory. Set `KEEP_SMOKE_HOME=1` to preserve a successful run for inspection.

To verify the exact public revision instead of a local tarball:

```sh
PLUGIN_SPEC='github:toolclub/dsh-agent-team-gui#<full-40-character-commit>' \
  API_VERSION=4 pnpm run smoke:install
```

Tags and abbreviated SHAs are rejected because they are mutable or ambiguous at lifecycle-execution
time. Release automation may accept a tag as its checkout selector, but resolves the checked-out
`HEAD` to a full commit SHA before the Git-install gate. Git dependencies run their `prepare` build.
For this public repository only, the smoke script
initializes the temporary profile and adds pnpm's exact codeload URL key to that temporary
profile's `allowBuilds`; it never weakens a user's profile and rejects any other Git repository.

## Complete preflight

```sh
EXPECTED_VERSION=1.0.1 API_VERSION=4 pnpm run preflight
```

The preflight runs frozen installation, commit-range plus staged/unstaged whitespace validation,
every TypeScript face, Host and
rendered Client tests, production build, tarball audit, and isolated install/restart smoke. Add
`RUN_BROWSER_SMOKE=1` for the Playwright
journey. The browser gate uses axe-core to reject serious or critical violations inside the
composer, Settings, and Run Center roots, then verifies keyboard focus/open/close/save/expand flows.
Settings tabs are exercised with the ARIA tablist keys (ArrowLeft/ArrowRight/Home/End); Tab is
reserved for leaving the tablist instead of being treated as tab-to-tab navigation.
Set `RELEASE_REQUIRE_CLEAN=1` for a tag candidate. The community doctor is intentionally not part
of a local preflight by default: a temporary Home is not an operating-system sandbox and cannot
prevent a third-party process from reading repository metadata. Only a credential-free ephemeral
checkout, or a maintainer making that explicit trust decision, should add
`RUN_SUPPLEMENTAL_DOCTOR=1`.

The doctor is a community-maintained supplemental signal, not an official Harness API. Version
`0.1.0` is an exact development dependency whose registry integrity is frozen in `pnpm-lock.yaml`;
the wrapper invokes that installed file directly, never `pnpm dlx`. It runs static-only with
`--no-isolate`, never enables target lifecycle scripts, and acknowledges only the package's known
`prepare` declaration. It does not grant credential, shell, network, or filesystem-write findings.
Several v0.1 signatures intentionally over-report CSS, URLs, and quality scripts, so the local pack
and runtime gates remain authoritative and do not delegate installation safety to it.

## CI evidence

- `.github/workflows/ci.yml` runs Node 22.19 and Node 24 quality lanes, a fresh-profile browser
  lane, a pinned GitHub-SHA installation on every main push, and the supplemental doctor.
- `.github/workflows/release-preflight.yml` rejects a package/tag mismatch, resolves the checkout to
  a full commit SHA for the Git-install gate, then packs once and runs static audit, install/restart,
  and browser smoke against that exact tarball before publishing its SHA-256 file and evidence.
- All GitHub jobs use read-only repository permissions and temporary DSH homes. Every third-party
  Action is pinned to a verified full commit SHA, with the human-readable release in a comment;
  Dependabot proposes reviewed SHA/version refreshes instead of trusting a movable major tag.

See [browser-smoke.md](./browser-smoke.md) for the complete manual release journey that complements
the deterministic automated smoke.
