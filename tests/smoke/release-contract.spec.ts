import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentTeamService } from '../../src/index.ts'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string
  description: string
  dsh: { bundle: { patch: string }; client: { inject: string[] } }
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
  devDependencies: Record<string, string>
  scripts: Record<string, string>
}

describe('release engineering contract', () => {
  it('declares a valid v0.5+ bundle and official locale dependency', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
    const [major, minor] = manifest.version.split('.').map(Number)
    expect(major! > 0 || minor! >= 5).toBe(true)
    expect(manifest.description).toContain('provider-reported token usage')
    expect(manifest.description).not.toContain('token cost')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-locale')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-client-locale']).toMatch(/<0\.2\.0/)
    expect(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-slots']).toMatch(/<0\.2\.0/)
    expect(manifest.peerDependencies['@deepseek-ai/dsh-jobs']).toMatch(/<0\.2\.0/)
    expect(manifest.peerDependenciesMeta['@deepseek-ai/dsh-jobs']?.optional).toBe(true)
    expect(manifest.devDependencies['dsh-plugin-doctor']).toBe('0.1.0')
    expect(AgentTeamService.inject).not.toContain('sessionProjections')
  })

  it('keeps every quality command backed by a checked-in script', () => {
    expect(manifest.scripts.prepare).toBe('pnpm run build')
    expect(manifest.scripts.build).toMatch(/^node scripts\/quality\/clean-build\.mjs && /)
    expect(manifest.scripts['check:whitespace']).toBe('node scripts/quality/git-whitespace.mjs')
    for (const script of ['audit:pack', 'smoke:install', 'smoke:browser', 'capture:readme', 'quality:doctor', 'preflight']) {
      const command = manifest.scripts[script]
      expect(command, `${script} is missing`).toMatch(/^node scripts\/quality\/[a-z-]+\.mjs$/)
      const file = command!.replace(/^node /, '')
      expect(existsSync(join(root, file)), `${file} is missing`).toBe(true)
    }
  })

  it('keeps unused production code as a permanent TypeScript gate', () => {
    for (const project of ['tsconfig.host.json', 'tsconfig.client.json']) {
      const config = JSON.parse(readFileSync(join(root, project), 'utf8')) as {
        compilerOptions?: { noUnusedLocals?: boolean; noUnusedParameters?: boolean }
      }
      expect(config.compilerOptions?.noUnusedLocals, `${project} must reject unused locals`).toBe(true)
      expect(config.compilerOptions?.noUnusedParameters, `${project} must reject unused parameters`).toBe(true)
    }
  })

  it('makes API v4 and the hermetic DSH boundary explicit', () => {
    const fixture = readFileSync(join(root, 'scripts/quality/dsh-fixture.mjs'), 'utf8')
    const common = readFileSync(join(root, 'scripts/quality/common.mjs'), 'utf8')
    expect(common).toContain('DEFAULT_API_VERSION = 4')
    expect(fixture).toContain('createHermeticEnvironment(workspace)')
    expect(common).toContain('DSH_HOME: dshHome')
    expect(common).toContain('HOME: userHome')
    expect(common).toContain('sanitizedEnvironment(source)')
    expect(common).toContain('const safe = {}')
    expect(common).toContain('NPM_CONFIG_USERCONFIG')
    expect(fixture).toContain("'--port', this.port ?? '0'")
    expect(fixture).toContain("'add', '-w', this.pluginSpec")
    expect(fixture).not.toContain("join(homedir(), '.dsh')")
    const browser = readFileSync(join(root, 'scripts/quality/browser-smoke.mjs'), 'utf8')
    const capture = readFileSync(join(root, 'scripts/quality/capture-readme.mjs'), 'utf8')
    const doctor = readFileSync(join(root, 'scripts/quality/doctor.mjs'), 'utf8')
    const preflight = readFileSync(join(root, 'scripts/quality/release-preflight.mjs'), 'utf8')
    expect(browser).toContain("from '@axe-core/playwright'")
    expect(browser).toContain('env: fixture.env')
    expect(capture).toContain('env: fixture.env')
    expect(browser).toContain('Configure later|稍后配置')
    expect(capture).toContain('Configure later|稍后配置')
    expect(browser).toContain("getAttribute('aria-controls')")
    expect(capture).toContain("getAttribute('aria-controls')")
    expect(browser).not.toContain("locator('#agent-team-mode-panel')")
    expect(capture).not.toContain("locator('#agent-team-mode-panel')")
    expect(browser).toContain('browser.newContext')
    expect(capture).toContain('browser.newContext')
    expect(capture).toContain("timezoneId: 'Asia/Shanghai'")
    expect(capture).toContain('page.mouse.move(viewport.width - 2, 2)')
    expect(browser).toContain('engageBrowserSession(sessionId)')
    expect(capture).toContain('engageBrowserSession(sessionId)')
    expect(capture).toContain('await rename(entry.staged, entry.target)')
    expect(capture).toContain('promoted.reverse()')
    expect(browser).toContain('intentionalRestart')
    expect(browser).toContain('const browserBaseUrl = await fixture.start()')
    expect(browser).toContain('baseUrl: browserBaseUrl')
    expect(browser).toContain('restartedBaseUrl === browserBaseUrl')
    expect(browser).toContain('restartInProgress || Date.now() <= restartGraceUntil')
    expect(browser).toContain('restartInProgress = true')
    expect(browser).toContain('ERR_INCOMPLETE_CHUNKED_ENCODING')
    expect(browser).toContain("'/agent-team-gui/mode/next-set'")
    expect(browser).toContain('consumeNextOverrideForEligibleMessage')
    expect(browser).toContain('createBrowserSession()')
    expect(capture).toContain('createBrowserSession()')
    expect(browser).toContain("'/agent-team-gui/project/default-set'")
    expect(browser).toContain("page.emulateMedia({ colorScheme")
    expect(browser).toContain('oversize-recipe.json')
    expect(browser).toContain('oversize-definitions.json')
    expect(browser).toContain('importRequests.length === 0')
    const installSmoke = readFileSync(join(root, 'scripts/quality/dsh-smoke.mjs'), 'utf8')
    expect(installSmoke).toContain('expectedRevision: examplePreview.definitionRevision')
    expect(installSmoke).toContain('seedRetentionHistory(seed)')
    expect(installSmoke).toContain('retentionHistory.ids.every((id, index) => retainedIds[index] === id)')
    expect(fixture).toContain('seedRetentionHistory(seed, count = 120')
    expect(fixture).toContain('Date.now() - 45 * 86_400_000')
    expect(fixture).toContain('Date.UTC(2026, 7, 17, 14, 2, 31)')
    expect(fixture).toContain('resolveRepositoryReleaseTarball(requestedTarball)')
    expect(fixture).toContain('setTimeout(() => { controller.abort() }, this.timeoutMs)')
    expect(doctor).toContain('createHermeticEnvironment(workspace)')
    expect(doctor).toContain("envFlag('RUN_SUPPLEMENTAL_DOCTOR')")
    expect(doctor).not.toContain("'dlx'")
    expect(doctor).not.toContain("'--allow-scripts'")
    for (const permission of ['credentials', 'shell', 'network', 'filesystem-write']) {
      expect(doctor).not.toContain(`'${permission}'`)
    }
    expect(preflight).toContain("if (envFlag('RUN_SUPPLEMENTAL_DOCTOR'))")
    expect(preflight).toContain("'RUN_SUPPLEMENTAL_DOCTOR', 'RUN_BROWSER_SMOKE'")
    expect(preflight).toContain("env[key] = '1'")
    expect(preflight).toContain('isAbsolute(process.env.DSH_BIN)')
    expect(preflight).toContain("['install', '--frozen-lockfile', '--ignore-scripts']")
    expect(preflight).not.toContain('SKIP_DOCTOR')
    const qualitySources = readFileSync(join(root, 'scripts/quality/common.mjs'), 'utf8')
      + browser + capture + doctor + preflight
      + readFileSync(join(root, 'scripts/quality/dsh-fixture.mjs'), 'utf8')
      + readFileSync(join(root, 'scripts/quality/dsh-smoke.mjs'), 'utf8')
      + readFileSync(join(root, 'scripts/quality/pack-audit.mjs'), 'utf8')
    expect(qualitySources).not.toMatch(/\bgit\s+remote\b|remote\.origin\.url|\.git\/config/)
    expect(browser).toContain("violation.impact === 'serious' || violation.impact === 'critical'")
    for (const workflow of ['ci.yml', 'release-preflight.yml']) {
      const source = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8')
      expect(source).toContain('persist-credentials: false')
      if (workflow === 'ci.yml') expect(source).toContain('pnpm install --frozen-lockfile --ignore-scripts')
      if (workflow === 'ci.yml' || workflow === 'release-preflight.yml') {
        expect(source).toContain('RUN_SUPPLEMENTAL_DOCTOR: 1')
      }
      const references = [...source.matchAll(/\buses:\s+\S+@([^\s#]+)/g)].map(match => match[1])
      expect(references.length).toBeGreaterThan(0)
      expect(references.every(reference => /^[0-9a-f]{40}$/.test(reference!))).toBe(true)
    }
    const ciWorkflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    const doctorJob = ciWorkflow.split('supplemental-doctor:')[1]
    expect(doctorJob).toContain('- run: pnpm run build')
    expect(doctorJob!.indexOf('- run: pnpm run build')).toBeLessThan(doctorJob!.indexOf('- run: pnpm run quality:doctor'))
    const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release-preflight.yml'), 'utf8')
    expect(releaseWorkflow).toContain("git rev-parse --verify 'HEAD^{commit}'")
    expect(releaseWorkflow).toContain('PLUGIN_SPEC: github:toolclub/dsh-agent-team-gui#${{ steps.release.outputs.commit }}')
    expect(releaseWorkflow.match(/PLUGIN_TARBALL=/g)).toHaveLength(2)
    expect(releaseWorkflow).not.toContain('steps.release.outputs.ref')
  })
})
