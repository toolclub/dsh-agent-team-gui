import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CommandRunner,
  TemporaryWorkspace,
  createHermeticEnvironment,
  isExpectedRestartHostDescribe404,
  parseAgentTeamGitSpec,
  positiveInteger,
  resolveRepositoryReleaseTarball,
  sanitizedEnvironment,
} from '../../scripts/quality/common.mjs'
import { DshWebFixture } from '../../scripts/quality/dsh-fixture.mjs'

describe('quality script safety helpers', () => {
  it('removes ambient credentials while retaining ordinary process settings', () => {
    expect(sanitizedEnvironment({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      GH_TOKEN: 'do-not-forward',
      OPENAI_API_KEY: 'do-not-forward',
      AWS_REGION: 'do-not-forward',
      SSH_AUTH_SOCK: '/private/socket',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_VALUE_0: 'credential.helper=malicious',
      OPAQUE_GITHUB_VALUE: 'fixture-value-not-a-token',
      HTTPS_PROXY: 'https://proxy.example.test',
      NODE_OPTIONS: '--require=/private/inject.cjs',
      NETRC: '/private/netrc',
      GH_CONFIG_DIR: '/private/gh',
      GIT_DIR: '/private/repository',
      GIT_WORK_TREE: '/private/worktree',
      NPM_CONFIG_GLOBALCONFIG: '/private/npmrc',
      npm_config_script_shell: '/private/untrusted-shell',
      XDG_STATE_HOME: '/private/state',
    })).toEqual({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' })
  })

  it('accepts only positive integer configuration', () => {
    expect(positiveInteger(undefined, 'LIMIT', 7)).toBe(7)
    expect(positiveInteger('12', 'LIMIT', 7)).toBe(12)
    expect(() => positiveInteger('0', 'LIMIT', 7)).toThrow(/positive integer/)
    expect(() => positiveInteger('1.5', 'LIMIT', 7)).toThrow(/positive integer/)
  })

  it('accepts exact public revisions and rejects mutable or foreign Git specs', () => {
    const revision = '0123456789abcdef0123456789abcdef01234567'
    expect(parseAgentTeamGitSpec(`github:toolclub/dsh-agent-team-gui#${revision}`)).toBe(revision)
    expect(() => parseAgentTeamGitSpec('github:toolclub/dsh-agent-team-gui#0123456789abcdef')).toThrow(/40-character/)
    expect(() => parseAgentTeamGitSpec('github:toolclub/dsh-agent-team-gui#v0.5.0-rc.1')).toThrow(/40-character/)
    expect(() => parseAgentTeamGitSpec('github:toolclub/dsh-agent-team-gui#main')).toThrow(/40-character/)
    expect(() => parseAgentTeamGitSpec(`github:someone-else/dsh-agent-team-gui#${revision}`)).toThrow(/40-character/)
  })

  it('ignores only the exact same-origin Host describe 404 during an intentional restart', () => {
    const exact = {
      intentionalRestart: true,
      baseUrl: 'http://127.0.0.1:48123',
      sourceUrl: 'http://127.0.0.1:48123/api/host.describe',
      message: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
    }
    expect(isExpectedRestartHostDescribe404(exact)).toBe(true)
    expect(isExpectedRestartHostDescribe404({ ...exact, intentionalRestart: false })).toBe(false)
    expect(isExpectedRestartHostDescribe404({ ...exact, sourceUrl: 'http://127.0.0.1:48124/api/host.describe' })).toBe(false)
    expect(isExpectedRestartHostDescribe404({ ...exact, sourceUrl: 'https://127.0.0.1:48123/api/host.describe' })).toBe(false)
    expect(isExpectedRestartHostDescribe404({ ...exact, sourceUrl: 'http://example.test/api/host.describe' })).toBe(false)
    expect(isExpectedRestartHostDescribe404({ ...exact, sourceUrl: 'http://127.0.0.1:48123/api/host.describe?retry=1' })).toBe(false)
    expect(isExpectedRestartHostDescribe404({ ...exact, sourceUrl: 'http://127.0.0.1:48123/api/host.describe#retry' })).toBe(false)
    expect(isExpectedRestartHostDescribe404({ ...exact, sourceUrl: 'http://127.0.0.1:48123/api/host.describe/extra' })).toBe(false)
    expect(isExpectedRestartHostDescribe404({ ...exact, sourceUrl: 'not a URL' })).toBe(false)
    expect(isExpectedRestartHostDescribe404({ ...exact, message: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)' })).toBe(false)
    expect(isExpectedRestartHostDescribe404({ ...exact, message: `${exact.message} extra` })).toBe(false)
  })

  it('rejects release-artifact overrides outside the repository dist directory', async () => {
    await expect(resolveRepositoryReleaseTarball('/tmp/untrusted-release.tgz')).rejects.toThrow(/repository dist directory/)
  })

  it('cleans only tool-owned temporary workspaces', async () => {
    const workspace = await TemporaryWorkspace.create()
    const root = workspace.root
    expect(existsSync(root)).toBe(true)
    await workspace.cleanup()
    expect(existsSync(root)).toBe(false)
    await expect(new TemporaryWorkspace('/tmp').cleanup()).rejects.toThrow(/refusing/)
  })

  it('isolates every user/config/cache root and removes credentials', async () => {
    const workspace = await TemporaryWorkspace.create()
    try {
      const { env, userHome, dshHome } = await createHermeticEnvironment(workspace, {
        PATH: process.env.PATH,
        GH_TOKEN: 'must-not-cross-the-boundary',
      })
      expect(env.GH_TOKEN).toBeUndefined()
      expect(env.CI).toBe('1')
      expect(env.HOME).toBe(userHome)
      expect(env.USERPROFILE).toBe(userHome)
      expect(env.DSH_HOME).toBe(dshHome)
      for (const key of [
        'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'COREPACK_HOME', 'PNPM_HOME',
        'npm_config_cache', 'npm_config_prefix', 'YARN_CACHE_FOLDER', 'TMPDIR', 'TMP', 'TEMP',
      ]) {
        expect(env[key]?.startsWith(`${workspace.root}/`)).toBe(true)
      }
      expect(env.NPM_CONFIG_USERCONFIG).toBe(workspace.path('npmrc'))
      expect(env.GIT_CONFIG_GLOBAL).toBe(workspace.path('gitconfig'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('spawns commands without a shell', async () => {
    const runner = new CommandRunner()
    const marker = '$(must-not-execute)'
    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', marker], { capture: true })
    expect(result.stdout).toBe(marker)
  })

  it('waits for a timed-out child to terminate before rejecting', async () => {
    const runner = new CommandRunner()
    await expect(runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      capture: true,
      timeoutMs: 25,
    })).rejects.toThrow(/timed out after 25 ms/)
  })

  it('parses a successful RPC body exactly once and reads error text only on failure', async () => {
    const fixture = Object.create(DshWebFixture.prototype) as DshWebFixture
    fixture.baseUrl = 'http://fixture.test'
    fixture.rpcCounter = 0
    fixture.timeoutMs = 1_000
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'agent-team-smoke-1-0',
        result: { ok: true, value: { apiVersion: 4 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
      const now = Date.now
      Date.now = () => 1
      try {
        await expect(fixture.rpc('snapshot')).resolves.toEqual({ apiVersion: 4 })
      } finally {
        Date.now = now
      }

      globalThis.fetch = async () => new Response('not available', { status: 503 })
      await expect(fixture.rpc('snapshot')).rejects.toThrow('snapshot returned HTTP 503: not available')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('bounds Host HTTP response and body reads', async () => {
    const fixture = Object.create(DshWebFixture.prototype) as DshWebFixture
    fixture.baseUrl = 'http://fixture.test'
    fixture.rpcCounter = 0
    fixture.timeoutMs = 10
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async (_input, init) => await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted by fixture')) }, { once: true })
      })
      await expect(fixture.rpc('snapshot')).rejects.toThrow('snapshot timed out after 10 ms')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
