import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'
import {
  CommandRunner,
  createHermeticEnvironment,
  REPOSITORY_ROOT,
  TemporaryWorkspace,
  envFlag,
  invariant,
  packPlugin,
  readJson,
  resolveRepositoryReleaseTarball,
} from './common.mjs'

const REQUIRED_FILES = [
  'package/package.json',
  'package/LICENSE',
  'package/README.md',
  'package/README-zh.md',
  'package/CHANGELOG.md',
  'package/CODE_OF_CONDUCT.md',
  'package/CONTRIBUTING.md',
  'package/SECURITY.md',
  'package/cordis.patch.yml',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/client.js.map',
  'package/lib/types/index.d.ts',
  'package/lib/types/index.d.ts.map',
  'package/lib/types/client/index.d.ts',
  'package/lib/types/client/index.d.ts.map',
  'package/examples/full-stack-delivery.recipe.json',
  'package/assets/v0.5-teams-settings.png',
  'package/assets/v0.5-composer-mode.png',
  'package/assets/v0.5-run-center.png',
  'package/assets/v0.5-insights.png',
  'package/assets/v0.5-recipes.png',
  'package/assets/v0.5-narrow.png',
]

const FORBIDDEN_PREFIXES = [
  'package/.git',
  'package/.github',
  'package/node_modules',
  'package/src',
  'package/tests',
  'package/scripts',
  'package/pnpm-lock.yaml',
  'package/restart-web.sh',
]

const ALLOWED_CLIENT_REQUIRES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
])

const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /(?:DEEPSEEK_API_KEY|OPENAI_API_KEY)\s*[:=]\s*['"]?[A-Za-z0-9_-]{12,}/,
  /https:\/\/[^\s/:]+:[^\s/@]+@[^\s/]+/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]

async function walk(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(root, path))
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'))
  }
  return files
}

async function auditExtractedEntryTypes(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    invariant(metadata.isDirectory() || metadata.isFile(), `tarball extracts a non-regular entry: ${path}`)
    if (metadata.isDirectory()) await auditExtractedEntryTypes(path)
    else invariant(metadata.nlink === 1, `tarball extracts a hard-linked file: ${path}`)
  }
}

function auditClientClosure(source) {
  const requires = [...source.matchAll(/\brequire\((['"])(.*?)\1\)/g)].map(match => match[2])
  const unexpected = [...new Set(requires.filter(id => !ALLOWED_CLIENT_REQUIRES.has(id)))]
  invariant(unexpected.length === 0, `client bundle has unresolved ModuleLoader dependencies: ${unexpected.join(', ')}`)
  invariant(source.includes('window.__ModuleLoader__.load({'), 'client bundle does not register with window.__ModuleLoader__')
  invariant(source.includes('id: "dsh-agent-team-gui"'), 'client bundle registers the wrong ModuleLoader id')
  invariant(!/^\s*import\s/m.test(source), 'client bundle contains a top-level ESM import')
  invariant(/\bapiVersion:\s*4\b/.test(source), 'client bundle does not contain the RPC API v4 request contract')
  invariant(!/\bapiVersion:\s*3\b/.test(source), 'client bundle still contains the stale RPC API v3 contract')
}

function auditHostClosure(source, manifest) {
  invariant(!source.includes('node_modules/.pnpm/'), 'host bundle contains an inlined dependency filesystem path')
  invariant(!source.includes('class JobsService'), 'official @deepseek-ai/dsh-jobs implementation was bundled into the plugin')
  invariant(/\bapiVersion:\s*4\b/.test(source), 'host bundle does not expose RPC API v4')
  invariant(!/\bapiVersion:\s*3\b/.test(source), 'host bundle still contains stale RPC API v3 output')
  const imports = [
    ...source.matchAll(/\bfrom\s+(['"])([^'"]+)\1/g),
    ...source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g),
    ...source.matchAll(/^\s*import\s+(['"])([^'"]+)\1/gm),
  ].map(match => match[2])
  const unexpected = [...new Set(imports.filter(id => id !== 'zod' && !id.startsWith('node:') && !id.startsWith('@deepseek-ai/')))]
  invariant(unexpected.length === 0, `host bundle has unexpected external dependencies: ${unexpected.join(', ')}`)
  const declaredPackages = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  for (const specifier of new Set(imports.filter(id => !id.startsWith('node:')))) {
    const parts = specifier.split('/')
    const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    invariant(declaredPackages.has(packageName), `host bundle imports undeclared package ${packageName}`)
  }
}

async function auditDeclarationClosure(extractedRoot, files, manifest) {
  const declarations = files.filter(path => path.startsWith('package/lib/types/') && path.endsWith('.d.ts'))
  const declaredPackages = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  for (const file of declarations) {
    const source = await readFile(join(extractedRoot, file), 'utf8')
    const declarationMap = source.match(/^\/\/# sourceMappingURL=(.+)$/m)?.[1]
    if (declarationMap !== undefined) {
      const mapPath = posix.normalize(posix.join(posix.dirname(file), declarationMap))
      invariant(files.includes(mapPath), `${file} points to a missing declaration source map: ${declarationMap}`)
    }
    const specifiers = [
      ...source.matchAll(/\bfrom\s+(['"])([^'"]+)\1/g),
      ...source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g),
      ...source.matchAll(/^\s*import\s+(['"])([^'"]+)\1/gm),
    ].map(match => match[2])
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) {
        if (specifier.startsWith('node:')) continue
        const parts = specifier.split('/')
        const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
        invariant(declaredPackages.has(packageName), `${file} exposes undeclared package ${packageName}`)
        continue
      }
      const target = posix.normalize(posix.join(posix.dirname(file), specifier))
      invariant(target.startsWith('package/lib/types/'), `${file} declaration import escapes lib/types: ${specifier}`)
      const candidates = [
        target,
        target.replace(/\.(?:[cm]?js|tsx?)$/, '.d.ts'),
        `${target}.d.ts`,
        `${target}/index.d.ts`,
      ]
      invariant(candidates.some(candidate => files.includes(candidate)), `${file} points to a missing declaration: ${specifier}`)
    }
  }
}

async function auditSecrets(extractedRoot, files) {
  const textExtensions = new Set(['.js', '.json', '.md', '.yml', '.yaml', '.d.ts', '.map'])
  for (const file of files) {
    if (![...textExtensions].some(extension => file.endsWith(extension))) continue
    const body = await readFile(join(extractedRoot, file), 'utf8')
    for (const pattern of SECRET_PATTERNS) {
      invariant(!pattern.test(body), `possible credential leaked into tarball: ${file} (${pattern})`)
    }
  }
}

async function auditSourceMaps(extractedRoot, files) {
  for (const file of files.filter(path => path.endsWith('.map'))) {
    const map = await readJson(join(extractedRoot, file))
    invariant(map?.version === 3, `${file} is not a version 3 source map`)
    invariant(Array.isArray(map.sources), `${file} has no sources array`)
    invariant(map.sourceRoot === undefined || typeof map.sourceRoot === 'string', `${file} has an invalid sourceRoot`)
    const paths = [map.sourceRoot ?? '', ...map.sources]
    for (const source of paths) {
      invariant(typeof source === 'string', `${file} has a non-string source path`)
      invariant(!/^(?:[a-z]+:|\/|[A-Za-z]:[\\/])/i.test(source), `${file} leaks an absolute or URL source path: ${source}`)
    }
  }
}

function auditCredentialFields(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => { auditCredentialFields(item, `${path}[${index}]`) })
    return
  }
  if (value === null || typeof value !== 'object') return
  const forbidden = new Set([
    'key', 'token', 'apikey', 'accesskey', 'accesskeyid', 'secretaccesskey', 'accesstoken', 'refreshtoken',
    'password', 'passwd', 'secret', 'clientsecret', 'authorization', 'credential', 'credentials',
  ])
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
    invariant(!forbidden.has(normalized), `example JSON contains credential field ${path}.${key}`)
    auditCredentialFields(child, `${path}.${key}`)
  }
}

function localReadmeImages(markdown) {
  const definitions = new Map([...markdown.matchAll(/^\s*\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)]
    .map(match => [match[1].trim().toLowerCase(), match[2] ?? match[3]]))
  const referenceLinks = [...markdown.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)].map((match) => {
    const id = (match[2] || match[1]).trim().toLowerCase()
    const target = definitions.get(id)
    invariant(target !== undefined, `README image reference has no definition: ${id}`)
    return target
  })
  const links = [
    ...[...markdown.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+['"][^'"]*['"])?\)/g)].map(match => match[1] ?? match[2]),
    ...[...markdown.matchAll(/<img\b[^>]*\bsrc=['"]([^'"]+)['"]/gi)].map(match => match[1]),
    ...referenceLinks,
  ]
  return links.filter(link => !/^(?:[a-z]+:|#|\/\/)/i.test(link)).map((link) => {
    const decoded = decodeURIComponent(link.split(/[?#]/, 1)[0]).replace(/^\.\//, '')
    const normalized = posix.normalize(decoded)
    invariant(normalized !== '..' && !normalized.startsWith('../') && !normalized.startsWith('/'), `README image escapes the package: ${link}`)
    return normalized
  })
}

async function main() {
  const workspace = await TemporaryWorkspace.create('dsh-agent-team-gui-pack-')
  if (envFlag('KEEP_SMOKE_HOME')) workspace.preserve()
  process.stdout.write(`Pack audit workspace: ${workspace.root}${workspace.keep ? ' (preserved)' : ' (removed after success)'}\n`)
  try {
    const { env } = await createHermeticEnvironment(workspace)
    const runner = new CommandRunner({ env })
    const tarball = process.env.PACK_TARBALL
      ? await resolveRepositoryReleaseTarball(process.env.PACK_TARBALL)
      : await packPlugin(await workspace.directory('dist'), runner)
    const listing = (await runner.run('tar', ['-tzf', tarball], { capture: true })).stdout
      .split(/\r?\n/).filter(Boolean)
    invariant(listing.length > 0, 'release tarball is empty')
    invariant(listing.every(path => path === 'package' || path.startsWith('package/')), 'tarball has a path outside package/')
    invariant(listing.every(path => !path.split('/').includes('..')), 'tarball contains a traversal path')
    const verboseListing = (await runner.run('tar', ['-tvzf', tarball], { capture: true })).stdout.split(/\r?\n/).filter(Boolean)
    invariant(verboseListing.every(line => !/^[lh]/.test(line)), 'tarball contains a symbolic or hard link')
    for (const required of REQUIRED_FILES) invariant(listing.includes(required), `tarball is missing ${required}`)
    for (const forbidden of FORBIDDEN_PREFIXES) {
      invariant(!listing.some(path => path === forbidden || path.startsWith(`${forbidden}/`)), `tarball leaks ${forbidden}`)
    }

    const extracted = await workspace.directory('extract')
    await runner.run('tar', ['-xzf', tarball, '-C', extracted])
    await auditExtractedEntryTypes(extracted)
    const packageRoot = join(extracted, 'package')
    const packedManifest = await readJson(join(packageRoot, 'package.json'))
    const sourceManifest = await readJson(join(REPOSITORY_ROOT, 'package.json'))
    invariant(packedManifest.name === 'dsh-agent-team-gui', `unexpected package name ${packedManifest.name}`)
    invariant(packedManifest.version === sourceManifest.version, 'packed version does not match source package.json')
    if (process.env.EXPECTED_VERSION) {
      invariant(packedManifest.version === process.env.EXPECTED_VERSION, `expected version ${process.env.EXPECTED_VERSION}, got ${packedManifest.version}`)
    }
    invariant(packedManifest.dsh?.bundle?.patch === './cordis.patch.yml', 'manifest does not expose the DSH bundle patch')
    invariant(packedManifest.dsh?.client?.platform === 'web', 'manifest does not expose the Web client')
    for (const [subpath, target] of Object.entries(packedManifest.exports ?? {})) {
      const candidates = typeof target === 'string' ? [target] : Object.values(target)
      for (const candidate of candidates) {
        invariant(typeof candidate === 'string', `package export ${subpath} contains a non-string target`)
        const normalized = candidate.replace(/^\.\//, '')
        invariant((await walk(packageRoot)).includes(normalized), `package export ${subpath} points to missing ${candidate}`)
      }
    }

    const files = await walk(extracted)
    await auditSecrets(extracted, files)
    await auditSourceMaps(extracted, files)
    await auditDeclarationClosure(extracted, files, packedManifest)
    for (const file of files.filter(path => path.startsWith('package/examples/') && path.endsWith('.json'))) {
      auditCredentialFields(await readJson(join(extracted, file)), file)
    }
    for (const readme of ['README.md', 'README-zh.md']) {
      const markdown = await readFile(join(packageRoot, readme), 'utf8')
      for (const image of localReadmeImages(markdown)) {
        invariant(files.includes(`package/${image}`), `${readme} references an image missing from the tarball: ${image}`)
      }
    }
    auditClientClosure(await readFile(join(packageRoot, 'lib/client.js'), 'utf8'))
    auditHostClosure(await readFile(join(packageRoot, 'lib/index.js'), 'utf8'), packedManifest)
    const size = (await readFile(tarball)).byteLength
    invariant(size < 5_000_000, `release tarball is unexpectedly large (${size} bytes)`)
    process.stdout.write(`Pack audit passed: ${listing.length} entries, ${size} bytes, client closure is complete.\n`)
  } catch (error) {
    workspace.preserve()
    throw error
  } finally {
    await workspace.cleanup()
  }
}

await main()
