import { spawn } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  CommandRunner,
  createHermeticEnvironment,
  DEFAULT_API_VERSION,
  REPOSITORY_ROOT,
  TemporaryWorkspace,
  envFlag,
  invariant,
  packPlugin,
  parseAgentTeamGitSpec,
  positiveInteger,
  readJson,
  resolveRepositoryReleaseTarball,
} from './common.mjs'

export class DshWebFixture {
  static async create() {
    const workspace = await TemporaryWorkspace.create('dsh-agent-team-gui-web-')
    if (envFlag('KEEP_SMOKE_HOME')) workspace.preserve()
    process.stdout.write(`Hermetic DSH workspace: ${workspace.root}${workspace.keep ? ' (preserved)' : ' (removed after success)'}\n`)
    const { env, dshHome: home } = await createHermeticEnvironment(workspace)
    const runtimeCwd = await workspace.directory('workspace')
    return new DshWebFixture({
      workspace,
      home,
      runtimeCwd,
      env,
      dshBin: process.env.DSH_BIN || 'dsh',
      expectedApiVersion: positiveInteger(process.env.API_VERSION, 'API_VERSION', DEFAULT_API_VERSION),
      timeoutMs: positiveInteger(process.env.SMOKE_TIMEOUT_MS, 'SMOKE_TIMEOUT_MS', 120_000),
    })
  }

  constructor({ workspace, home, runtimeCwd, env, dshBin, expectedApiVersion, timeoutMs }) {
    this.workspace = workspace
    this.home = home
    this.runtimeCwd = runtimeCwd
    this.env = env
    this.dshBin = dshBin
    this.expectedApiVersion = expectedApiVersion
    this.timeoutMs = timeoutMs
    this.runner = new CommandRunner({ cwd: runtimeCwd, env })
    this.buildRunner = new CommandRunner({ cwd: REPOSITORY_ROOT, env })
    this.child = undefined
    this.baseUrl = undefined
    this.cookie = undefined
    this.port = undefined
    this.output = ''
    this.rpcCounter = 0
    this.officialRpcCounter = 0
  }

  async install() {
    const packageDirectory = await this.workspace.directory('packages')
    const requestedSpec = process.env.PLUGIN_SPEC
    const requestedTarball = process.env.PLUGIN_TARBALL
    invariant(!(requestedSpec && requestedTarball), 'set only one of PLUGIN_SPEC or PLUGIN_TARBALL')
    if (requestedTarball) {
      this.pluginSpec = await resolveRepositoryReleaseTarball(requestedTarball)
    } else if (requestedSpec === undefined || requestedSpec === '') {
      this.pluginSpec = await packPlugin(packageDirectory, this.buildRunner)
    } else {
      // Never echo or forward an arbitrary URL: external smoke overrides are restricted
      // to this public repository at an immutable revision.
      parseAgentTeamGitSpec(requestedSpec)
      this.pluginSpec = requestedSpec
      await this.authorizeExactGitBuild(requestedSpec)
    }
    await this.runner.run(this.dshBin, ['plugin', '--profile', 'web', 'add', '-w', this.pluginSpec], {
      timeoutMs: this.timeoutMs * 2,
    })
    const manifestPath = join(this.home, 'profiles', 'web', 'package.json')
    const profile = await readJson(manifestPath)
    invariant(profile.dependencies?.['dsh-agent-team-gui'] !== undefined, 'fresh Web profile did not record the plugin dependency')
    invariant(profile.dsh?.profile?.bundles?.includes('dsh-agent-team-gui'), 'fresh Web profile did not activate the plugin bundle')
    const installedRoot = join(this.home, 'profiles', 'web', 'node_modules', 'dsh-agent-team-gui')
    for (const artifact of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts', 'lib/types/client/index.d.ts']) {
      await access(join(installedRoot, artifact)).catch(() => {
        throw new Error(`installed plugin is missing ${artifact}; Git prepare must build runtime and type artifacts`)
      })
    }
    const dump = await this.runner.run(this.dshBin, ['--profile', 'web', '--dump-config'], {
      capture: true,
      timeoutMs: this.timeoutMs,
    })
    invariant(dump.stdout.includes('agent-team-gui'), 'composed Web profile does not contain agent-team-gui')
  }

  async authorizeExactGitBuild(spec) {
    const revision = parseAgentTeamGitSpec(spec)
    await this.runner.run(this.dshBin, ['--profile', 'web', '--dump-config'], {
      capture: true,
      timeoutMs: this.timeoutMs,
    })
    const workspacePath = join(this.home, 'profiles', 'web', 'pnpm-workspace.yaml')
    const existing = await readFile(workspacePath, 'utf8')
    invariant(!existing.includes('\nallowBuilds:'), 'fresh smoke profile unexpectedly contains allowBuilds')
    const key = `dsh-agent-team-gui@https://codeload.github.com/toolclub/dsh-agent-team-gui/tar.gz/${revision}`
    await writeFile(workspacePath, `${existing.trimEnd()}\n\nallowBuilds:\n  ${JSON.stringify(key)}: true\n`, 'utf8')
  }

  async start() {
    invariant(this.child === undefined, 'DSH Web fixture is already running')
    this.output = ''
    this.cookie = undefined
    const child = spawn(this.dshBin, ['--profile', 'web', '--port', this.port ?? '0', '--no-open'], {
      cwd: this.runtimeCwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    this.child = child
    const onData = chunk => {
      const text = chunk.toString()
      this.output += text
      if (envFlag('SMOKE_VERBOSE')) process.stdout.write(text.replace(/([?&]token=)[^\s)]+/g, '$1<redacted>'))
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const baseUrl = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`dsh Web did not become ready in ${this.timeoutMs} ms\n${this.output}`))
      }, this.timeoutMs)
      const inspect = () => {
        const match = /dsh web: (http:\/\/[^\s]+)/.exec(this.output)
        if (match?.[1]) {
          clearTimeout(timer)
          resolveReady(match[1])
        }
      }
      child.stdout.on('data', inspect)
      child.stderr.on('data', inspect)
      child.once('error', error => {
        clearTimeout(timer)
        reject(new Error(`could not start ${this.dshBin}: ${error.message}`))
      })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`dsh Web exited before readiness with code ${code}\n${this.output}`))
      })
    })
    this.port = new URL(baseUrl).port
    const launch = new URL(baseUrl)
    let rootUrl = baseUrl
    if (launch.searchParams.has('token')) {
      const exchange = await this.boundedFetch('Web authentication', baseUrl, { redirect: 'manual' })
      invariant(exchange.response.status >= 300 && exchange.response.status < 400, `Web authentication returned HTTP ${exchange.response.status}`)
      const cookie = exchange.response.headers.get('set-cookie')?.split(';', 1)[0]
      invariant(cookie !== undefined && cookie.includes('='), 'Web authentication returned no session cookie')
      this.cookie = cookie
      rootUrl = new URL(exchange.response.headers.get('location') ?? '/', baseUrl).href
    }
    this.launchUrl = baseUrl
    this.baseUrl = launch.origin
    const { response, body: html } = await this.boundedFetch('Web root', rootUrl)
    invariant(response.ok, `Web root returned HTTP ${response.status}`)
    invariant(/<html/i.test(html), 'Web root did not return an HTML document')
    return this.baseUrl
  }

  async boundedFetch(label, input, init = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
    try {
      const headers = new Headers(init.headers)
      if (this.cookie !== undefined && !headers.has('cookie')) headers.set('cookie', this.cookie)
      const response = await fetch(input, { ...init, headers, signal: controller.signal })
      const body = await response.text()
      return { response, body }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${label} timed out after ${this.timeoutMs} ms`, { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async rpc(endpoint, payload = {}) {
    invariant(this.baseUrl !== undefined, 'DSH Web fixture is not running')
    const rpcId = `agent-team-smoke-${Date.now()}-${this.rpcCounter++}`
    const { response, body: text } = await this.boundedFetch(endpoint, new URL('/api/agentTeamGui', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'agentTeamGui', payload: { endpoint, payload } }),
    })
    if (!response.ok) {
      throw new Error(`${endpoint} returned HTTP ${response.status}: ${text}`)
    }
    const body = JSON.parse(text)
    invariant(body?.type === 'server-response', `${endpoint} returned an invalid RPC envelope`)
    invariant(body.rpcId === rpcId, `${endpoint} returned a mismatched rpcId`)
    if (!body.result?.ok) {
      throw new Error(`${endpoint} failed: ${body.result?.error?.code ?? 'unknown'}: ${body.result?.error?.message ?? 'no message'}`)
    }
    return body.result.value
  }

  async officialRpc(method, payload = {}) {
    invariant(this.baseUrl !== undefined, 'DSH Web fixture is not running')
    const rpcId = `dsh-smoke-${Date.now()}-${this.officialRpcCounter++}`
    const endpoint = method.replace('.', '/')
    const { response, body: text } = await this.boundedFetch(method, new URL(`/api/${endpoint}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: { request: payload } } }),
    })
    if (!response.ok) {
      throw new Error(`${method} returned HTTP ${response.status}: ${text}`)
    }
    const body = JSON.parse(text)
    invariant(body?.type === 'server-response', `${method} returned an invalid official RPC envelope`)
    invariant(body.rpcId === rpcId, `${method} returned a mismatched official rpcId`)
    if (!body.result?.ok) {
      throw new Error(`${method} failed: ${body.result?.error?.code ?? 'unknown'}: ${body.result?.error?.message ?? 'no message'}`)
    }
    return body.result.value
  }

  /** Materialize a blank Workspace Session so conversation-owned plugin slots exist. */
  async createBrowserSession() {
    const adopted = await this.officialRpc('workspace.create', { path: this.runtimeCwd })
    const workspaceId = adopted?.workspace?.workspaceId
    invariant(typeof workspaceId === 'string' && workspaceId !== '', 'workspace.create returned no workspace id')
    const created = await this.officialRpc('session.create', { workspaceId })
    invariant(typeof created?.sessionId === 'string' && created.sessionId !== '', 'session.create returned no session id')
    return created.sessionId
  }

  /**
   * Engage a blank official Session without credentials so its conversation-view
   * tabs become available. The missing-key RC fixture admits the durable user
   * message, then the immediate cancel prevents a provider turn from lingering.
   */
  async engageBrowserSession(sessionId) {
    const prompted = await this.officialRpc('session.prompt', {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Hermetic UI verification: open the isolated session views.' }],
      clientTimeZone: 'UTC',
    })
    invariant(prompted?.accepted === true, 'official session.prompt did not engage the isolated browser session')
    const cancelled = await this.officialRpc('session.cancel', { sessionId })
    invariant(cancelled?.accepted === true, 'official session.cancel did not settle the isolated browser session')
  }

  async assertSnapshot() {
    const snapshot = await this.rpc('snapshot')
    invariant(snapshot.apiVersion === this.expectedApiVersion, `expected RPC API v${this.expectedApiVersion}, got v${snapshot.apiVersion}`)
    invariant(Array.isArray(snapshot.agents) && Array.isArray(snapshot.squads), 'snapshot has no agent/squad catalog')
    return snapshot
  }

  async firstModelRoute() {
    const snapshot = await this.assertSnapshot()
    const modelGroup = snapshot.models.find(group => Array.isArray(group.models) && group.models.length > 0)
    const model = modelGroup?.models[0]
    invariant(
      typeof modelGroup?.provider === 'string' && typeof model?.id === 'string',
      'fresh Web profile exposes no provider/model route; install an official DSH profile with at least one catalog route before running smoke',
    )
    return { provider: modelGroup.provider, model: model.id }
  }

  async seedDefinitions(marker = `smoke-${Date.now()}`) {
    const route = await this.firstModelRoute()
    const createdAgent = await this.rpc('agent/create', {
      record: {
        name: `${marker}-member`,
        systemPrompt: 'Return a concise, structured handoff. Never delegate.',
        provider: route.provider,
        model: route.model,
      },
    })
    invariant(typeof createdAgent.id === 'string', 'agent/create returned no id')
    const createdSquad = await this.rpc('squad/create', {
      record: {
        name: `${marker}-team`,
        members: [createdAgent.id],
        collabNote: 'Hermetic release smoke definition.',
      },
    })
    invariant(typeof createdSquad.id === 'string', 'squad/create returned no id')
    return { marker, agentId: createdAgent.id, squadId: createdSquad.id, ...route }
  }

  async seedReadmeDefinitions() {
    const route = await this.firstModelRoute()
    const definitions = [
      {
        key: 'planner', name: 'Product planner', maxTokens: 4_096,
        systemPrompt: 'Translate the request into acceptance criteria, dependencies, edge cases, and a bounded handoff. Do not implement it.',
      },
      {
        key: 'engineer', name: 'Implementation engineer', maxTokens: 8_192,
        systemPrompt: 'Implement the assigned scope, add focused tests, and report changed files, verification evidence, and residual risk.',
      },
      {
        key: 'reviewer', name: 'Quality reviewer', maxTokens: 4_096,
        systemPrompt: 'Review correctness, regressions, security, accessibility, UX, and verification evidence. Approve only with concrete support.',
      },
    ]
    const agents = {}
    for (const definition of definitions) {
      const created = await this.rpc('agent/create', {
        record: {
          name: definition.name,
          systemPrompt: definition.systemPrompt,
          provider: route.provider,
          model: route.model,
          fallbackProvider: route.provider,
          fallbackModel: route.model,
          maxTokens: definition.maxTokens,
          toolScope: { deny: ['dispatch_to_squad'] },
        },
      })
      invariant(typeof created.id === 'string', `could not create README ${definition.key} member`)
      agents[definition.key] = { id: created.id, name: definition.name }
    }
    const members = [agents.planner.id, agents.engineer.id, agents.reviewer.id]
    const createdSquad = await this.rpc('squad/create', {
      record: {
        name: 'Full-stack delivery',
        members,
        collabNote: 'Plan the request, implement only the agreed scope, then review the evidence. Surface unresolved risk to the lead Agent.',
        executionMode: 'parallel',
        contextMode: 'fork',
        leaderAgentId: agents.planner.id,
        triggerMode: 'guaranteed',
        failurePolicy: 'retry-once',
        maxConcurrency: 2,
        memberTimeoutMs: 600_000,
        tokenBudget: 30_000,
        activationMode: 'smart',
        memberSelectionMode: 'adaptive',
        responseMode: 'foreground',
        planningContext: 'current',
        plannerMaxTokens: 2_048,
        qualityGate: {
          reviewerAgentId: agents.reviewer.id,
          repairAgentId: agents.engineer.id,
          maxRounds: 1,
          criteria: 'Acceptance criteria pass, regressions are tested, UX states are explicit, and verification evidence is complete.',
        },
      },
    })
    invariant(typeof createdSquad.id === 'string', 'could not create README team')
    return { squadId: createdSquad.id, squadName: 'Full-stack delivery', agents, members, ...route }
  }

  async assertDefinitions(seed) {
    const snapshot = await this.assertSnapshot()
    invariant(snapshot.agents.some(agent => agent.id === seed.agentId && agent.name === `${seed.marker}-member`), 'persisted smoke member is missing')
    invariant(snapshot.squads.some(squad => squad.id === seed.squadId && squad.name === `${seed.marker}-team`), 'persisted smoke team is missing')
    return snapshot
  }

  async seedOrphanedRun(seed, sessionId = 'agent-team-smoke-session') {
    invariant(this.child === undefined, 'orphan fixture must be written only while DSH Web is stopped')
    const storagePath = join(this.home, 'storages', 'agent_team_gui.json')
    const storage = JSON.parse(await readFile(storagePath, 'utf8'))
    invariant(storage?.tables?.runs !== null && typeof storage?.tables?.runs === 'object', 'run storage table is unavailable')
    const id = randomUUID()
    const startedAt = Date.now() - 5_000
    storage.tables.runs[id] = {
      id,
      sessionId,
      squadId: seed.squadId,
      squadName: `${seed.marker}-team`,
      task: 'Simulated process interruption for release verification.',
      executionMode: 'serial',
      contextMode: 'spawn',
      status: 'running',
      phase: 'members',
      responseMode: 'foreground',
      startedAt,
      // Retries must replay the immutable work division that was visible at
      // the time of the source run; a plan-less legacy row is intentionally
      // non-retryable in v0.5.
      plan: {
        decision: 'run',
        reason: 'Persisted interruption recovery fixture.',
        summary: 'Resume the single assigned verification task after interruption.',
        memberOrder: [seed.agentId],
        assignments: [{
          agentId: seed.agentId,
          task: 'Verify the isolated interrupted-run recovery path.',
          dependsOn: [],
        }],
        planner: 'deterministic-fallback',
      },
      members: [{
        agentId: seed.agentId,
        agentName: `${seed.marker}-member`,
        provider: seed.provider,
        model: seed.model,
        status: 'running',
        attempts: 1,
        startedAt,
        output: [],
      }],
      usage: {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        providerReported: false,
      },
    }
    await writeFile(storagePath, `${JSON.stringify(storage, null, 2)}\n`, 'utf8')
    return id
  }

  /** Seed old settled history above the former implicit 100/30-day defaults. */
  async seedRetentionHistory(seed, count = 120, sessionId = 'agent-team-retention-smoke-session') {
    invariant(this.child === undefined, 'retention fixture must be written only while DSH Web is stopped')
    invariant(Number.isInteger(count) && count > 100 && count <= 200, 'retention fixture count must be between 101 and 200')
    const storagePath = join(this.home, 'storages', 'agent_team_gui.json')
    const storage = JSON.parse(await readFile(storagePath, 'utf8'))
    invariant(storage?.tables?.runs !== null && typeof storage?.tables?.runs === 'object', 'run storage table is unavailable')
    const ids = []
    const fortyFiveDaysAgo = Date.now() - 45 * 86_400_000
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID()
      const startedAt = fortyFiveDaysAgo - index * 1_000
      const endedAt = startedAt + 100
      const usage = {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        providerReported: false,
      }
      ids.push(id)
      storage.tables.runs[id] = {
        id,
        sessionId,
        squadId: seed.squadId,
        squadName: `${seed.marker}-team`,
        task: `Persisted pre-upgrade history row ${index + 1}.`,
        executionMode: 'serial',
        contextMode: 'spawn',
        status: 'completed',
        phase: 'settled',
        responseMode: 'foreground',
        startedAt,
        endedAt,
        members: [{
          agentId: seed.agentId,
          agentName: `${seed.marker}-member`,
          provider: seed.provider,
          model: seed.model,
          status: 'completed',
          attempts: 1,
          startedAt,
          endedAt,
          output: [],
          usage,
        }],
        usage,
      }
    }
    await writeFile(storagePath, `${JSON.stringify(storage, null, 2)}\n`, 'utf8')
    return { ids, sessionId }
  }

  /** Simulate the durable end of one eligible agent/pre-step while Web is stopped. */
  async consumeNextOverrideForEligibleMessage(sessionId, messageId) {
    invariant(this.child === undefined, 'one-shot claim fixture must be written only while DSH Web is stopped')
    const storagePath = join(this.home, 'storages', 'agent_team_gui.json')
    const storage = JSON.parse(await readFile(storagePath, 'utf8'))
    const nextModes = storage?.tables?.next_modes
    const claims = storage?.tables?.message_claims
    invariant(nextModes !== null && typeof nextModes === 'object', 'next-mode storage table is unavailable')
    invariant(claims !== null && typeof claims === 'object', 'message-claim storage table is unavailable')
    const next = nextModes[sessionId]
    if (next === undefined) return undefined
    const key = `${sessionId}:${messageId}`
    invariant(claims[key] === undefined, `eligible message ${messageId} was already claimed`)
    claims[key] = {
      sessionId,
      messageId,
      kind: next.state === 'team' ? 'team' : 'solo',
      createdAt: Date.now(),
    }
    delete nextModes[sessionId]
    await writeFile(storagePath, `${JSON.stringify(storage, null, 2)}\n`, 'utf8')
    return structuredClone(next)
  }

  async seedReadmeCompletedRun(seed, sessionId) {
    invariant(this.child === undefined, 'README run fixture must be written only while DSH Web is stopped')
    const storagePath = join(this.home, 'storages', 'agent_team_gui.json')
    const storage = JSON.parse(await readFile(storagePath, 'utf8'))
    invariant(storage?.tables?.runs !== null && typeof storage?.tables?.runs === 'object', 'run storage table is unavailable')
    const id = randomUUID()
    // Keep release documentation captures byte-reproducible across reruns.
    const startedAt = Date.UTC(2026, 7, 17, 14, 2, 31)
    const endedAt = startedAt + 84_000
    const usage = (uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) => ({
      uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
      totalTokens: uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      providerReported: true,
    })
    const plannerUsage = usage(480, 220, 320, 80)
    const plannerMemberUsage = usage(400, 240, 220, 40)
    const engineerUsage = usage(1_200, 900, 900, 200)
    const reviewerMemberUsage = usage(450, 300, 250, 50)
    const firstReviewUsage = usage(300, 260, 200, 40)
    const repairUsage = usage(600, 500, 400, 100)
    const finalReviewUsage = usage(280, 250, 180, 40)
    const totalUsage = usage(3_710, 2_670, 2_470, 550)
    const content = text => [{ type: 'text', text }]
    const result = (agent, output, resultUsage, offset, handoff) => ({
      agentId: agent.id,
      agentName: agent.name,
      status: 'completed',
      runId: `readme-${agent.id}-${offset}`,
      childId: `readme-child-${offset}`,
      stopReason: 'completed',
      output: content(output),
      attempts: 1,
      startedAt: startedAt + offset,
      endedAt: startedAt + offset + 12_000,
      usage: resultUsage,
      handoff,
    })
    const plannerHandoff = {
      summary: 'Defined three acceptance criteria and the dependency boundary.',
      deliverables: ['Acceptance checklist', 'Dependency map'], risks: ['Keep migration backwards compatible'], changedFiles: [],
    }
    const engineerHandoff = {
      summary: 'Implemented the scoped workflow and added regression coverage.',
      deliverables: ['Feature implementation', 'Regression tests'], risks: [], changedFiles: ['src/workflow.ts', 'tests/workflow.spec.ts'],
    }
    const reviewerHandoff = {
      summary: 'Verified the repaired workflow against the acceptance checklist.',
      deliverables: ['Review findings', 'Verification evidence'], risks: [], changedFiles: [],
    }
    const plannerResult = result(seed.agents.planner, 'Acceptance criteria and a bounded delivery plan are ready.', plannerMemberUsage, 8_000, plannerHandoff)
    const engineerResult = result(seed.agents.engineer, 'Implementation and focused regression tests completed.', engineerUsage, 25_000, engineerHandoff)
    const reviewerResult = result(seed.agents.reviewer, 'Independent review completed with one repaired issue.', reviewerMemberUsage, 48_000, reviewerHandoff)
    const firstReview = result(seed.agents.reviewer, 'One narrow-layout issue needs repair before approval.', firstReviewUsage, 58_000, reviewerHandoff)
    const repair = result(seed.agents.engineer, 'Adjusted the responsive grid and added the missing narrow test.', repairUsage, 66_000, engineerHandoff)
    const finalReview = result(seed.agents.reviewer, 'All acceptance criteria now have passing evidence.', finalReviewUsage, 76_000, reviewerHandoff)
    storage.tables.runs[id] = {
      id,
      sessionId,
      sourceMessageId: 'readme-demo-message',
      projectKey: '/demo/full-stack-delivery',
      squadId: seed.squadId,
      squadName: seed.squadName,
      task: 'Deliver a responsive project dashboard with explicit loading, empty, error, and success states.',
      executionMode: 'parallel',
      contextMode: 'fork',
      responseMode: 'foreground',
      status: 'completed',
      phase: 'settled',
      startedAt,
      endedAt,
      plan: {
        decision: 'run',
        reason: 'The request needs product definition, implementation, and independent review.',
        summary: 'Plan acceptance criteria, implement the bounded change, then review and repair before lead synthesis.',
        memberOrder: seed.members,
        assignments: [
          { agentId: seed.agents.planner.id, task: 'Define acceptance criteria and dependencies.', dependsOn: [] },
          { agentId: seed.agents.engineer.id, task: 'Implement the agreed scope and regression tests.', dependsOn: [seed.agents.planner.id] },
          { agentId: seed.agents.reviewer.id, task: 'Review implementation and evidence independently.', dependsOn: [seed.agents.engineer.id] },
        ],
        planner: 'main-agent',
        plannerProvider: seed.provider,
        plannerModel: seed.model,
        leaderAgentId: seed.agents.planner.id,
        usage: plannerUsage,
      },
      members: [
        { ...plannerResult, provider: seed.provider, model: seed.model },
        { ...engineerResult, provider: seed.provider, model: seed.model },
        { ...reviewerResult, provider: seed.provider, model: seed.model },
      ],
      usage: totalUsage,
      quality: {
        approved: true,
        rounds: [
          { round: 1, approved: false, feedback: 'Repair the narrow-layout overflow and add evidence.', reviewer: firstReview, repair },
          { round: 2, approved: true, feedback: 'Responsive repair and regression evidence verified.', reviewer: finalReview },
        ],
      },
    }
    await writeFile(storagePath, `${JSON.stringify(storage, null, 2)}\n`, 'utf8')
    return id
  }

  async stop() {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    this.baseUrl = undefined
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise((resolveStop, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`dsh Web did not stop gracefully\n${this.output}`))
      }, 15_000)
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        if (code === 0 || signal === 'SIGTERM') resolveStop()
        else reject(new Error(`dsh Web stopped with code ${code}, signal ${signal}\n${this.output}`))
      })
    })
  }

  async close({ failed = false } = {}) {
    try {
      await this.stop()
    } finally {
      if (failed) this.workspace.preserve()
      await this.workspace.cleanup()
    }
  }
}
