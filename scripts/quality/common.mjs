import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DEFAULT_API_VERSION = 4

export function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

export function envFlag(name, fallback = false) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw new Error(`${name} must be one of 1, 0, true, or false; got ${JSON.stringify(value)}`)
}

export function positiveInteger(value, label, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  invariant(Number.isInteger(parsed) && parsed > 0, `${label} must be a positive integer; got ${JSON.stringify(value)}`)
  return parsed
}

export function parseAgentTeamGitSpec(spec) {
  const match = /^github:toolclub\/dsh-agent-team-gui#([0-9a-f]{40})$/.exec(spec)
  invariant(match?.[1], 'Git smoke accepts only an immutable full 40-character toolclub/dsh-agent-team-gui commit SHA')
  return match[1]
}

const RESTART_HOST_DESCRIBE_404 = 'Failed to load resource: the server responded with a status of 404 (Not Found)'

/** Match only the official Host probe that can race an intentional restart. */
export function isExpectedRestartHostDescribe404({ intentionalRestart, baseUrl, sourceUrl, message }) {
  if (!intentionalRestart || message !== RESTART_HOST_DESCRIBE_404) return false
  try {
    const base = new URL(baseUrl)
    const source = new URL(sourceUrl)
    const expected = `${base.origin}/api/host.describe`
    return (base.protocol === 'http:' || base.protocol === 'https:')
      && source.origin === base.origin
      && source.pathname === '/api/host.describe'
      && source.search === ''
      && source.hash === ''
      && source.username === ''
      && source.password === ''
      && source.href === expected
  } catch {
    return false
  }
}

/** Retain only ordinary presentation/process settings, never ambient credential or tool-control state. */
export function sanitizedEnvironment(source = process.env) {
  const safe = {}
  const ordinary = /^(?:PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|WINDIR|COMSPEC|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|CI)$/
  const sensitiveValue = /(?:\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{24,})\b|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|https?:\/\/[^\s/:]+:[^\s/@]+@|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/
  for (const [key, value] of Object.entries(source)) {
    if (ordinary.test(key) && typeof value === 'string' && !sensitiveValue.test(value)) safe[key] = value
  }
  return safe
}

/** Resolve only the versioned release tarball below this checkout's dist directory. */
export async function resolveRepositoryReleaseTarball(value) {
  invariant(typeof value === 'string' && value.trim() !== '', 'release tarball path must be non-empty')
  const manifest = await readJson(join(REPOSITORY_ROOT, 'package.json'))
  const dist = resolve(REPOSITORY_ROOT, 'dist')
  const candidate = resolve(REPOSITORY_ROOT, value)
  invariant(candidate.startsWith(`${dist}${sep}`), 'release tarball must be a direct file below the repository dist directory')
  invariant(basename(candidate) === `dsh-agent-team-gui-${manifest.version}.tgz`, 'release tarball filename does not match package version')
  const metadata = await lstat(candidate)
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), 'release tarball must be a regular file, not a link')
  const [realDist, realCandidate] = await Promise.all([realpath(dist), realpath(candidate)])
  invariant(realCandidate.startsWith(`${realDist}${sep}`), 'release tarball resolves outside the repository dist directory')
  return realCandidate
}

/** A credential-free process environment whose user/config/cache roots are tool-owned. */
export async function createHermeticEnvironment(workspace, source = process.env) {
  const ordinaryEnvironment = sanitizedEnvironment(source)
  const userHome = await workspace.directory('user-home')
  const dshHome = await workspace.directory('dsh-home')
  const npmUserConfig = workspace.path('npmrc')
  const gitGlobalConfig = workspace.path('gitconfig')
  await writeFile(npmUserConfig, '', 'utf8')
  await writeFile(gitGlobalConfig, '', 'utf8')
  const npmCache = await workspace.directory('npm-cache')
  const packageManagerHome = await workspace.directory('package-manager-home')
  const childTemp = await workspace.directory('child-temp')
  const env = {
    ...ordinaryEnvironment,
    CI: '1',
    HOME: userHome,
    USERPROFILE: userHome,
    DSH_HOME: dshHome,
    XDG_CACHE_HOME: await workspace.directory('xdg-cache'),
    XDG_CONFIG_HOME: await workspace.directory('xdg-config'),
    XDG_DATA_HOME: await workspace.directory('xdg-data'),
    COREPACK_HOME: await workspace.directory('corepack-cache'),
    PNPM_HOME: packageManagerHome,
    npm_config_prefix: packageManagerHome,
    NPM_CONFIG_PREFIX: packageManagerHome,
    YARN_CACHE_FOLDER: await workspace.directory('yarn-cache'),
    TMPDIR: childTemp,
    TMP: childTemp,
    TEMP: childTemp,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_userconfig: npmUserConfig,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    GIT_CONFIG_GLOBAL: gitGlobalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_UPDATE_NOTIFIER: '1',
  }
  return { env, userHome, dshHome }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export class CommandRunner {
  constructor({ cwd = REPOSITORY_ROOT, env = sanitizedEnvironment() } = {}) {
    this.cwd = cwd
    this.env = env
  }

  async run(command, args, { capture = false, timeoutMs = 300_000 } = {}) {
    const printable = [command, ...args].map(argument => /\s/.test(argument) ? JSON.stringify(argument) : argument).join(' ')
    process.stdout.write(`$ ${printable}\n`)
    return new Promise((resolveRun, reject) => {
      const child = spawn(command, args, {
        cwd: this.cwd,
        env: this.env,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        shell: false,
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let forceTimer
      child.stdout?.on('data', chunk => { stdout += chunk.toString() })
      child.stderr?.on('data', chunk => { stderr += chunk.toString() })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        forceTimer = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
      }, timeoutMs)
      child.once('error', (error) => {
        clearTimeout(timer)
        clearTimeout(forceTimer)
        reject(new Error(`could not start ${printable}: ${error.message}`))
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        clearTimeout(forceTimer)
        if (timedOut) {
          reject(new Error(`${printable} timed out after ${timeoutMs} ms (exit ${code ?? signal})\n${stdout}${stderr}`))
          return
        }
        if (code === 0) {
          resolveRun({ stdout, stderr })
          return
        }
        reject(new Error(
          `${printable} exited with ${code === null ? `signal ${signal}` : `code ${code}`}\n${stdout}${stderr}`,
        ))
      })
    })
  }
}

export class TemporaryWorkspace {
  static async create(prefix = 'dsh-agent-team-gui-') {
    const root = await mkdtemp(join(tmpdir(), prefix))
    return new TemporaryWorkspace(root)
  }

  constructor(root) {
    this.root = root
    this.keep = false
  }

  path(...segments) {
    return join(this.root, ...segments)
  }

  async directory(...segments) {
    const path = this.path(...segments)
    await mkdir(path, { recursive: true })
    return path
  }

  preserve() {
    this.keep = true
  }

  async cleanup() {
    if (this.keep) {
      process.stdout.write(`Preserved diagnostic workspace: ${this.root}\n`)
      return
    }
    const temp = await realpath(tmpdir())
    const root = await realpath(this.root)
    invariant(root.startsWith(`${temp}${sep}`), `refusing to remove non-temporary path ${root}`)
    invariant(root !== temp && root.split(sep).at(-1)?.startsWith('dsh-agent-team-gui-'), `refusing unsafe cleanup target ${root}`)
    await rm(root, { recursive: true, force: true })
  }
}

export async function packPlugin(destination, runner = new CommandRunner()) {
  await mkdir(destination, { recursive: true })
  const before = new Set((await readdir(destination)).filter(name => name.endsWith('.tgz')))
  await runner.run('pnpm', ['pack', '--pack-destination', destination], { timeoutMs: 300_000 })
  const created = (await readdir(destination))
    .filter(name => name.endsWith('.tgz') && !before.has(name))
    .map(name => join(destination, name))
  invariant(created.length === 1, `pnpm pack must create exactly one tarball; found ${created.length}`)
  return created[0]
}
