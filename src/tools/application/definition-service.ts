import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  agentRecordReadSchema,
  agentRecordSchema,
  agentTeamExportSchema,
  agentTeamRecipeSchema,
  squadRecordReadSchema,
  squadRecordSchema,
} from '../../spec.ts'
import {
  AgentId,
  DispatchId,
  SquadId,
  type AgentRecord,
  type AgentRouteRemap,
  type AgentTeamExportDocument,
  type AgentTeamImportMode,
  type AgentTeamImportPreview,
  type AgentTeamImportResult,
  type AgentTeamRecipeDocument,
  type ProjectSquadDefaultRecord,
  type RecipeImportResult,
  type RecipePreviewResult,
  type SessionNextSquadModeRecord,
  type SessionSquadModeRecord,
  type SessionSquadModeView,
  type SquadMessageClaimRecord,
  type SquadRecord,
  type SquadRunRecord,
  type SquadVersionRecord,
} from '../../types.ts'
import { copyRecipeIds, findMissingRecipeRoutes, findRecipeConflicts, prepareRecipe } from '../recipes.ts'
import { StorageUnitOfWork } from '../storage-transaction.ts'
import { AgentTeamError, type AgentTeamConfig } from '../domain/host.ts'
import { abortableStep, throwIfAborted, WriteCoordinator } from '../infrastructure/write-coordinator.ts'

interface PreparedDefinitionImport {
  readonly version: 1 | 2
  readonly agents: Array<{ readonly id: AgentId; readonly record: AgentRecord }>
  readonly squads: Array<{ readonly id: SquadId; readonly record: SquadRecord }>
}

export interface DefinitionSnapshot {
  readonly agents: ReadonlyMap<AgentId, AgentRecord>
  readonly squads: ReadonlyMap<SquadId, SquadRecord>
}

/**
 * Definition, versioning, portable-data, and mode use cases. This layer knows
 * durable tables but has no orchestration/runtime responsibility.
 */
export class DefinitionApplicationService extends Service {
  protected readonly definitionWrites = new WriteCoordinator()
  protected agentsTable?: KvTable<AgentId, AgentRecord>
  protected squadsTable?: KvTable<SquadId, SquadRecord>
  protected sessionModesTable?: KvTable<SessionId, SessionSquadModeRecord>
  protected nextModesTable?: KvTable<SessionId, SessionNextSquadModeRecord>
  protected messageClaimsTable?: KvTable<string, SquadMessageClaimRecord>
  protected runsTable?: KvTable<DispatchId, SquadRunRecord>
  protected squadVersionsTable?: KvTable<string, SquadVersionRecord>
  protected projectDefaultsTable?: KvTable<string, ProjectSquadDefaultRecord>
  /** Process-local fast path; durable receipts remain the authority. */
  private readonly lastGuaranteedMessage = new WeakMap<Agent, string>()

  constructor(ctx: Context, protected readonly config: AgentTeamConfig) {
    super(ctx, 'agentTeamGui')
  }

  /** Composition-root seam used once after the storage domain opens. */
  protected attachTables(tables: {
    agents: KvTable<AgentId, AgentRecord>
    squads: KvTable<SquadId, SquadRecord>
    sessionModes: KvTable<SessionId, SessionSquadModeRecord>
    nextModes: KvTable<SessionId, SessionNextSquadModeRecord>
    messageClaims: KvTable<string, SquadMessageClaimRecord>
    runs: KvTable<DispatchId, SquadRunRecord>
    squadVersions: KvTable<string, SquadVersionRecord>
    projectDefaults: KvTable<string, ProjectSquadDefaultRecord>
  }): void {
    this.agentsTable = tables.agents
    this.squadsTable = tables.squads
    this.sessionModesTable = tables.sessionModes
    this.nextModesTable = tables.nextModes
    this.messageClaimsTable = tables.messageClaims
    this.runsTable = tables.runs
    this.squadVersionsTable = tables.squadVersions
    this.projectDefaultsTable = tables.projectDefaults
  }

  protected agents(): KvTable<AgentId, AgentRecord> {
    if (this.agentsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.agentsTable
  }

  protected squads(): KvTable<SquadId, SquadRecord> {
    if (this.squadsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.squadsTable
  }

  protected sessionModes(): KvTable<SessionId, SessionSquadModeRecord> {
    if (this.sessionModesTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.sessionModesTable
  }

  protected nextModes(): KvTable<SessionId, SessionNextSquadModeRecord> {
    if (this.nextModesTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.nextModesTable
  }

  protected messageClaims(): KvTable<string, SquadMessageClaimRecord> {
    if (this.messageClaimsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.messageClaimsTable
  }

  protected runs(): KvTable<DispatchId, SquadRunRecord> {
    if (this.runsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.runsTable
  }

  protected squadVersions(): KvTable<string, SquadVersionRecord> {
    if (this.squadVersionsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.squadVersionsTable
  }

  protected projectDefaults(): KvTable<string, ProjectSquadDefaultRecord> {
    if (this.projectDefaultsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.projectDefaultsTable
  }

  protected errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private assertPortableDocumentBounds(document: unknown, kind: 'definitions' | 'recipe'): void {
    const envelope = document !== null && typeof document === 'object' ? document as Record<string, unknown> : undefined
    const agents = Array.isArray(envelope?.['agents']) ? envelope['agents'] : undefined
    const squads = Array.isArray(envelope?.['squads']) ? envelope['squads'] : undefined
    const maxAgents = kind === 'definitions' ? 2_000 : 256
    const maxSquads = kind === 'definitions' ? 1_000 : 1
    const maxMembers = kind === 'definitions' ? 50_000 : 256
    if (agents !== undefined && agents.length > maxAgents) {
      throw new AgentTeamError(`${kind} document exceeds ${maxAgents} agents`, 'INVALID_IMPORT')
    }
    if (squads !== undefined && squads.length > maxSquads) {
      throw new AgentTeamError(`${kind} document exceeds ${maxSquads} squads`, 'INVALID_IMPORT')
    }
    const squadRows = kind === 'definitions' ? squads : envelope?.['squad'] === undefined ? undefined : [envelope['squad']]
    let totalMembers = 0
    for (const row of squadRows ?? []) {
      if (row !== null && typeof row === 'object' && Array.isArray((row as Record<string, unknown>)['members'])) {
        totalMembers += ((row as Record<string, unknown>)['members'] as unknown[]).length
        if (totalMembers > maxMembers) throw new AgentTeamError(`${kind} document exceeds ${maxMembers} total member references`, 'INVALID_IMPORT')
      }
    }
    let serialized: string | undefined
    try { serialized = JSON.stringify(document) }
    catch (error: unknown) { throw new AgentTeamError(`${kind} document is not JSON serializable: ${this.errorText(error)}`, 'INVALID_IMPORT') }
    const maxBytes = kind === 'definitions' ? 16 * 1_024 * 1_024 : 4 * 1_024 * 1_024
    // JSON.stringify(undefined) is intentionally left to the versioned Zod
    // parser so existing callers keep receiving the established shape error.
    if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      throw new AgentTeamError(`${kind} document exceeds ${maxBytes} UTF-8 bytes`, 'INVALID_IMPORT')
    }
  }

  /** Authoritative effective values for omitted/inherited definition fields. */
  definitionDefaults(): {
    readonly executionMode: 'serial' | 'parallel'
    readonly fixedOrderExecutionMode: 'serial'
    readonly contextMode: 'spawn' | 'fork' | 'chain'
    readonly planningContext: 'full'
    readonly plannerMaxTokens: 2_048
  } {
    return {
      executionMode: this.config.defaultExecutionMode,
      fixedOrderExecutionMode: 'serial',
      contextMode: this.config.defaultContextMode,
      planningContext: 'full',
      plannerMaxTokens: 2_048,
    }
  }

  /** One coherent clone of the definition graph, never a view into live tables. */
  async readDefinitionSnapshot(signal?: AbortSignal): Promise<DefinitionSnapshot> {
    return this.definitionWrites.read(() => ({
      agents: new Map([...this.agents().entries()].map(([id, record]) => [id, structuredClone(record)])),
      squads: new Map([...this.squads().entries()].map(([id, record]) => [id, structuredClone(record)])),
    }), signal)
  }

  /** RPC-facing barrier for a small synchronous read spanning definition tables. */
  readDefinitionState<T>(reader: () => T, signal?: AbortSignal): Promise<T> {
    return this.definitionWrites.read(reader, signal)
  }

  /** Freeze a squad and every referenced definition before a run starts. */
  protected async readSquadExecutionSnapshot(squadId: SquadId, signal?: AbortSignal): Promise<{
    readonly squad: SquadRecord | undefined
    readonly agents: ReadonlyMap<AgentId, AgentRecord>
  }> {
    return this.definitionWrites.read(() => {
      const current = this.squads().get(squadId)
      if (current === undefined) return { squad: undefined, agents: new Map<AgentId, AgentRecord>() }
      const squad = structuredClone(current)
      const agents = new Map<AgentId, AgentRecord>()
      for (const id of squad.members) {
        const record = this.agents().get(id)
        if (record !== undefined) agents.set(id, structuredClone(record))
      }
      return { squad, agents }
    }, signal)
  }

  protected async validateModelRoute(
    record: AgentRecord,
    signal?: AbortSignal,
    options: { readonly validateTools?: boolean } = {},
  ): Promise<void> {
    throwIfAborted(signal)
    if ((record.fallbackProvider === undefined) !== (record.fallbackModel === undefined)) {
      throw new Error('fallbackProvider and fallbackModel must be configured together')
    }
    try {
      await abortableStep(signal, () => this.ctx.llm.resolveModelInfo(record.provider, record.model, signal))
      if (record.fallbackProvider !== undefined && record.fallbackModel !== undefined) {
        await abortableStep(signal, () => this.ctx.llm.resolveModelInfo(record.fallbackProvider!, record.fallbackModel!, signal))
      }
    } catch (error: unknown) {
      throw new Error(`invalid model route ${record.provider}/${record.model}: ${this.errorText(error)}`, { cause: error })
    }
    throwIfAborted(signal)
    if (options.validateTools === false) return
    this.validateToolPolicy(record)
    throwIfAborted(signal)
  }

  private validateToolPolicy(_record: AgentRecord): void {
    // Tool registrations may live in an Agent preset scope and therefore are
    // not enumerable during Settings writes/imports. Structural validation is
    // handled by agentRecordSchema; effective `allow` names are checked against
    // the calling parent scope immediately before a dispatch starts.
  }

  async createAgent(record: AgentRecord, id: AgentId = AgentId(randomUUID()), signal?: AbortSignal): Promise<AgentId> {
    const parsed = agentRecordSchema.parse(record)
    const observed = await this.definitionWrites.readVersioned(() => this.agents().get(id), signal)
    if (observed.value !== undefined) throw new AgentTeamError(`agent "${id}" already exists`, 'AGENT_EXISTS')
    await this.validateModelRoute(parsed, signal)
    return this.definitionWrites.run(async () => {
      throwIfAborted(signal)
      if (this.agents().get(id) !== undefined) throw new AgentTeamError(`agent "${id}" already exists`, 'AGENT_EXISTS')
      // The definition graph may have changed while route validation was in
      // flight. The uniqueness/tool-policy checks above are repeated at the
      // exact commit boundary; route IO itself never owns the writer lock.
      if (this.definitionWrites.currentRevision !== observed.revision) throwIfAborted(signal)
      this.validateToolPolicy(parsed)
      const unit = new StorageUnitOfWork(); unit.capture(this.agents())
      return unit.run(async () => {
        await abortableStep(signal, () => this.agents().put(id, parsed))
        return id
      })
    }, signal)
  }

  async updateAgent(id: AgentId, record: AgentRecord, signal?: AbortSignal): Promise<void> {
    const parsed = agentRecordSchema.parse(record)
    const observed = await this.definitionWrites.readVersioned(() => this.agents().get(id), signal)
    if (observed.value === undefined) throw new AgentTeamError(`agent "${id}" does not exist`, 'AGENT_NOT_FOUND')
    await this.validateModelRoute(parsed, signal)
    return this.definitionWrites.run(async () => {
    if (this.agents().get(id) === undefined) throw new AgentTeamError(`agent "${id}" does not exist`, 'AGENT_NOT_FOUND')
    if (this.definitionWrites.currentRevision !== observed.revision) throwIfAborted(signal)
    this.validateToolPolicy(parsed)
    const unit = new StorageUnitOfWork()
    unit.capture(this.agents())
    unit.capture(this.squadVersions())
    await unit.run(async () => {
      await abortableStep(signal, () => this.agents().put(id, parsed))
      for (const [squadId, squad] of this.squads().entries()) {
        if (squad.members.includes(id)) await this.recordSquadVersion(squadId, squad, signal)
      }
    })
    }, signal)
  }

  async deleteAgent(id: AgentId, signal?: AbortSignal): Promise<boolean> {
    return this.definitionWrites.run(async () => {
    throwIfAborted(signal)
    if (this.agents().get(id) === undefined) return false
    const affected = [...this.squads().entries()].filter(([, squad]) => squad.members.includes(id))
    for (const [, squad] of affected) {
      if (squad.members.length === 1) throw new AgentTeamError(`cannot delete the last member of squad "${squad.name}"`, 'INVALID_MEMBERS')
      if (squad.qualityGate?.reviewerAgentId === id || squad.qualityGate?.repairAgentId === id) {
        throw new AgentTeamError(`agent "${id}" owns the quality gate for squad "${squad.name}"`, 'INVALID_MEMBERS')
      }
    }
    const unit = new StorageUnitOfWork()
    unit.capture(this.agents())
    unit.capture(this.squads())
    unit.capture(this.squadVersions())
    return unit.run(async () => {
      for (const [squadId] of affected) {
        const updated = await abortableStep(signal, () => this.squads().update(squadId, (squad) => {
          const { leaderAgentId, ...withoutLeader } = squad
          return {
            ...(leaderAgentId === id ? withoutLeader : squad),
            members: squad.members.filter(memberId => memberId !== id),
            ...(squad.executionOrder === undefined ? {} : { executionOrder: squad.executionOrder.filter(memberId => memberId !== id) }),
          }
        }))
        await this.recordSquadVersion(squadId, updated, signal)
      }
      return abortableStep(signal, () => this.agents().delete(id))
    })
    }, signal)
  }

  getAgent(id: AgentId): AgentRecord | undefined { return this.agents().get(id) }
  listAgents(): [AgentId, AgentRecord][] { return [...this.agents().entries()] }

  protected validateSquadRecord(
    record: SquadRecord,
    knownAgents?: ReadonlySet<string>,
    options: { readonly allowLegacyEmpty?: boolean } = {},
  ): void {
    if (record.members.length === 0 && options.allowLegacyEmpty !== true) {
      throw new AgentTeamError('a squad must contain at least one member', 'INVALID_MEMBERS')
    }
    const unique = new Set(record.members)
    if (unique.size !== record.members.length) throw new AgentTeamError('squad members must be unique', 'INVALID_MEMBERS')
    const missing = record.members.filter(id => knownAgents === undefined ? this.agents().get(id) === undefined : !knownAgents.has(id))
    if (missing.length > 0) throw new AgentTeamError(`unknown squad members: ${missing.join(', ')}`, 'INVALID_MEMBERS')
    if (record.executionOrder !== undefined) {
      const orderSet = new Set(record.executionOrder)
      const permutation = record.executionOrder.length === record.members.length
        && orderSet.size === record.executionOrder.length && record.members.every(id => orderSet.has(id))
      if (!permutation) throw new AgentTeamError('executionOrder must contain every squad member exactly once', 'INVALID_MEMBERS')
      if (record.executionMode === 'parallel') throw new AgentTeamError('executionOrder requires serial execution', 'INVALID_DISPATCH')
    }
    if (record.executionMode === 'parallel' && record.contextMode === 'chain') {
      throw new AgentTeamError('contextMode "chain" requires serial execution', 'INVALID_DISPATCH')
    }
    if (record.leaderAgentId !== undefined && !record.members.includes(record.leaderAgentId)) {
      throw new AgentTeamError('leaderAgentId must be one of the squad members', 'INVALID_MEMBERS')
    }
    if (record.qualityGate !== undefined) {
      if (record.qualityGate.reviewerAgentId === record.qualityGate.repairAgentId) {
        throw new AgentTeamError('quality reviewer and repair owner must be different members', 'INVALID_MEMBERS')
      }
      if (!record.members.includes(record.qualityGate.reviewerAgentId)) throw new AgentTeamError('quality reviewer must be one of the squad members', 'INVALID_MEMBERS')
      if (!record.members.includes(record.qualityGate.repairAgentId)) throw new AgentTeamError('quality repair owner must be one of the squad members', 'INVALID_MEMBERS')
    }
    if (record.executionOrder !== undefined && record.memberSelectionMode === 'adaptive') {
      throw new AgentTeamError('adaptive member selection cannot be combined with a fixed executionOrder', 'INVALID_DISPATCH')
    }
  }

  protected async recordSquadVersion(squadId: SquadId, record: SquadRecord, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const version = (this.listSquadVersions(squadId)[0]?.version ?? 0) + 1
    const memberSnapshots = record.members.map((id) => {
      const member = this.agents().get(id)
      if (member === undefined) throw new AgentTeamError(`squad references missing agent "${id}"`, 'AGENT_NOT_FOUND')
      return { id, record: structuredClone(member) }
    })
    await abortableStep(signal, () => this.squadVersions().put(`${squadId}:${String(version).padStart(8, '0')}`, {
      squadId, version, createdAt: Date.now(), record: structuredClone(record), memberSnapshots,
    }))
    const versionLimit = this.config.versionMaxPerSquad ?? 0
    const excess = versionLimit === 0 ? [] : this.listSquadVersions(squadId).slice(versionLimit)
    for (const old of excess) {
      await abortableStep(signal, () => this.squadVersions().delete(`${squadId}:${String(old.version).padStart(8, '0')}`))
    }
  }

  async createSquad(record: SquadRecord, id: SquadId = SquadId(randomUUID()), signal?: AbortSignal): Promise<SquadId> {
    return this.definitionWrites.run(async () => {
    const parsed = squadRecordSchema.parse(record)
    if (this.squads().get(id) !== undefined) throw new AgentTeamError(`squad "${id}" already exists`, 'SQUAD_EXISTS')
    this.validateSquadRecord(parsed)
    const unit = new StorageUnitOfWork()
    unit.capture(this.squads())
    unit.capture(this.squadVersions())
    await unit.run(async () => {
      await abortableStep(signal, () => this.squads().put(id, parsed))
      await this.recordSquadVersion(id, parsed, signal)
    })
    return id
    }, signal)
  }

  async updateSquad(id: SquadId, record: SquadRecord, signal?: AbortSignal): Promise<void> {
    return this.definitionWrites.run(async () => {
    if (this.squads().get(id) === undefined) throw new AgentTeamError(`squad "${id}" does not exist`, 'SQUAD_NOT_FOUND')
    const parsed = squadRecordSchema.parse(record)
    this.validateSquadRecord(parsed)
    const unit = new StorageUnitOfWork()
    unit.capture(this.squads())
    unit.capture(this.squadVersions())
    await unit.run(async () => {
      await abortableStep(signal, () => this.squads().put(id, parsed))
      await this.recordSquadVersion(id, parsed, signal)
    })
    }, signal)
  }

  async deleteSquad(id: SquadId, signal?: AbortSignal): Promise<boolean> {
    return this.definitionWrites.run(async () => {
    throwIfAborted(signal)
    if (this.squads().get(id) === undefined) return false
    const unit = new StorageUnitOfWork()
    unit.capture(this.squads()); unit.capture(this.sessionModes()); unit.capture(this.nextModes())
    unit.capture(this.projectDefaults()); unit.capture(this.squadVersions())
    return unit.run(async () => {
      for (const [sessionId, mode] of this.sessionModes().entries()) if (mode.squadId === id) await abortableStep(signal, () => this.sessionModes().delete(sessionId))
      for (const [sessionId, mode] of this.nextModes().entries()) if (mode.squadId === id) await abortableStep(signal, () => this.nextModes().delete(sessionId))
      for (const [projectKey, record] of this.projectDefaults().entries()) if (record.squadId === id) await abortableStep(signal, () => this.projectDefaults().delete(projectKey))
      for (const [key, version] of this.squadVersions().entries()) if (version.squadId === id) await abortableStep(signal, () => this.squadVersions().delete(key))
      return abortableStep(signal, () => this.squads().delete(id))
    })
    }, signal)
  }

  getSquad(id: SquadId): SquadRecord | undefined { return this.squads().get(id) }
  listSquads(): [SquadId, SquadRecord][] { return [...this.squads().entries()] }

  async diagnoseSquad(id: SquadId, signal?: AbortSignal): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }> }> {
    const snapshot = await this.readSquadExecutionSnapshot(id, signal)
    const squad = snapshot.squad
    if (squad === undefined) throw new AgentTeamError(`squad "${id}" does not exist`, 'SQUAD_NOT_FOUND')
    const checks: Array<{ name: string; ok: boolean; message: string }> = []
    const add = (name: string, ok: boolean, message: string): void => { checks.push({ name, ok, message }) }
    try {
      this.validateSquadRecord(squad, new Set(snapshot.agents.keys()))
      add('definition', true, `${squad.members.length} members; ${squad.executionMode ?? this.config.defaultExecutionMode}/${squad.contextMode ?? this.config.defaultContextMode}`)
    } catch (error: unknown) { add('definition', false, this.errorText(error)) }
    for (const memberId of squad.members) {
      const member = snapshot.agents.get(memberId)
      if (member === undefined) { add(String(memberId), false, 'missing agent definition'); continue }
      try {
        await this.validateModelRoute(member, signal)
        add(member.name, true, `${member.provider}/${member.model}${member.fallbackProvider === undefined ? '' : ` → ${member.fallbackProvider}/${member.fallbackModel}`}`)
      } catch (error: unknown) { add(member.name, false, this.errorText(error)) }
    }
    return { ok: checks.every(check => check.ok), checks }
  }

  listSquadVersions(squadId: SquadId): SquadVersionRecord[] {
    return [...this.squadVersions().entries()].map(([, record]) => record)
      .filter(version => version.squadId === squadId).sort((left, right) => right.version - left.version)
  }

  async restoreSquadVersion(squadId: SquadId, version: number, signal?: AbortSignal, expectedRevision?: number): Promise<void> {
    const observed = await this.definitionWrites.readVersioned(() => {
      const found = this.listSquadVersions(squadId).find(item => item.version === version)
      return found === undefined ? undefined : structuredClone(found)
    }, signal)
    const candidate = observed.value
    if (candidate === undefined) throw new AgentTeamError(`squad version ${version} does not exist`, 'SQUAD_NOT_FOUND')
    if (expectedRevision !== undefined && observed.revision !== expectedRevision) {
      throw new AgentTeamError('stale restore preview: definitions changed; preview this version again before restoring', 'INVALID_IMPORT')
    }
    if (candidate.memberSnapshots !== undefined) {
      await Promise.all(candidate.memberSnapshots.map(item => this.validateModelRoute(item.record, signal, { validateTools: false })))
      this.validateSquadRecord(candidate.record, new Set(candidate.memberSnapshots.map(item => item.id)), { allowLegacyEmpty: true })
    }
    return this.definitionWrites.run(async () => {
    throwIfAborted(signal)
    const found = this.listSquadVersions(squadId).find(item => item.version === version)
    if (found === undefined) throw new AgentTeamError(`squad version ${version} does not exist`, 'SQUAD_NOT_FOUND')
    if (this.definitionWrites.currentRevision !== observed.revision
      && (expectedRevision !== undefined || JSON.stringify(found) !== JSON.stringify(candidate))) {
      throw new AgentTeamError(`squad version ${version} changed while its routes were being validated; preview and retry`, 'INVALID_IMPORT')
    }
    const unit = new StorageUnitOfWork()
    unit.capture(this.agents()); unit.capture(this.squads()); unit.capture(this.squadVersions())
    await unit.run(async () => {
      const changedAgentIds = new Set<AgentId>()
      if (found.memberSnapshots !== undefined) {
        for (const item of found.memberSnapshots) {
          const current = this.agents().get(item.id)
          if (current === undefined || JSON.stringify(current) !== JSON.stringify(item.record)) changedAgentIds.add(item.id)
          await abortableStep(signal, () => this.agents().put(item.id, item.record))
        }
      }
      const parsed = squadRecordReadSchema.parse(found.record)
      this.validateSquadRecord(parsed, undefined, { allowLegacyEmpty: true })
      await abortableStep(signal, () => this.squads().put(squadId, parsed))
      await this.recordSquadVersion(squadId, parsed, signal)
      for (const [affectedId, affected] of this.squads().entries()) {
        if (affectedId !== squadId && affected.members.some(id => changedAgentIds.has(id))) {
          await this.recordSquadVersion(affectedId, affected, signal)
        }
      }
    })
    }, signal)
  }

  async previewSquadRestore(squadId: SquadId, version: number, signal?: AbortSignal): Promise<{
    definitionRevision: number
    squadId: SquadId
    version: number
    record: SquadRecord
    memberSnapshots: NonNullable<SquadVersionRecord['memberSnapshots']>
    conflicts: Array<{ agentId: AgentId; currentName: string; restoredName: string }>
    affectedSquads: Array<{ squadId: SquadId; squadName: string; agentIds: AgentId[] }>
  }> {
    const captured = await this.definitionWrites.readVersioned(() => this.previewSquadRestoreUnlocked(squadId, version), signal)
    return { definitionRevision: captured.revision, ...captured.value }
  }

  private previewSquadRestoreUnlocked(squadId: SquadId, version: number): {
    squadId: SquadId
    version: number
    record: SquadRecord
    memberSnapshots: NonNullable<SquadVersionRecord['memberSnapshots']>
    conflicts: Array<{ agentId: AgentId; currentName: string; restoredName: string }>
    affectedSquads: Array<{ squadId: SquadId; squadName: string; agentIds: AgentId[] }>
  } {
    const found = this.listSquadVersions(squadId).find(item => item.version === version)
    if (found === undefined) throw new AgentTeamError(`squad version ${version} does not exist`, 'SQUAD_NOT_FOUND')
    const memberSnapshots = found.memberSnapshots ?? found.record.members.flatMap((id) => {
      const record = this.agents().get(id); return record === undefined ? [] : [{ id, record }]
    })
    const conflicts = memberSnapshots.flatMap((item) => {
      const current = this.agents().get(item.id)
      return current === undefined || JSON.stringify(current) === JSON.stringify(item.record)
        ? [] : [{ agentId: item.id, currentName: current.name, restoredName: item.record.name }]
    })
    const changed = new Set(conflicts.map(item => item.agentId))
    const affectedSquads = this.listSquads().flatMap(([id, squad]) => {
      if (id === squadId) return []
      const agentIds = squad.members.filter(agentId => changed.has(agentId))
      return agentIds.length === 0 ? [] : [{ squadId: id, squadName: squad.name, agentIds }]
    })
    return { squadId, version, record: found.record, memberSnapshots, conflicts, affectedSquads }
  }

  getSessionSquadMode(sessionId: SessionId): SessionSquadModeView | undefined {
    const mode = this.sessionModes().get(sessionId)
    if (mode === undefined || mode.disabled === true || mode.squadId === undefined) return undefined
    const squad = this.squads().get(mode.squadId)
    return squad === undefined ? undefined : { sessionId, squadId: mode.squadId, squadName: squad.name }
  }

  getSessionSquadOverride(sessionId: SessionId): 'enabled' | 'disabled' | 'inherit' {
    const mode = this.sessionModes().get(sessionId)
    if (mode === undefined) return 'inherit'
    return mode.disabled === true || mode.squadId === undefined ? 'disabled' : 'enabled'
  }

  async setSessionSquadMode(sessionId: SessionId, squadId?: SquadId, signal?: AbortSignal): Promise<SessionSquadModeView | undefined> {
    return this.definitionWrites.run(async () => {
      const squad = squadId === undefined ? undefined : this.squads().get(squadId)
      if (squadId !== undefined && squad === undefined) throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
      const unit = new StorageUnitOfWork(); unit.capture(this.sessionModes())
      return unit.run(async () => {
        if (squadId === undefined) {
          await abortableStep(signal, () => this.sessionModes().put(sessionId, { disabled: true }))
          return undefined
        }
        await abortableStep(signal, () => this.sessionModes().put(sessionId, { squadId }))
        return { sessionId, squadId, squadName: squad!.name }
      })
    }, signal)
  }

  async inheritSessionSquadMode(sessionId: SessionId, signal?: AbortSignal): Promise<SessionSquadModeView | undefined> {
    return this.definitionWrites.run(async () => {
      const unit = new StorageUnitOfWork(); unit.capture(this.sessionModes())
      return unit.run(async () => {
        await abortableStep(signal, () => this.sessionModes().delete(sessionId))
        const session = this.ctx.sessions.get(sessionId)
        return session === undefined ? undefined : this.getEffectiveSessionSquadModeForSession(session, sessionId)
      })
    }, signal)
  }

  getNextSessionSquadMode(sessionId: SessionId): SessionNextSquadModeRecord | undefined {
    const record = this.nextModes().get(sessionId)
    return record?.claimedMessageId === undefined ? record : undefined
  }

  async setNextSessionSquadMode(sessionId: SessionId, state: 'inherit' | 'solo' | 'team', squadId?: SquadId, signal?: AbortSignal): Promise<SessionNextSquadModeRecord | undefined> {
    return this.definitionWrites.run(async () => {
      if (state === 'team' && (squadId === undefined || this.squads().get(squadId) === undefined)) {
        throw new AgentTeamError(`squad "${squadId ?? ''}" does not exist`, 'SQUAD_NOT_FOUND')
      }
      const unit = new StorageUnitOfWork(); unit.capture(this.nextModes())
      return unit.run(async () => {
        if (state === 'inherit') { await abortableStep(signal, () => this.nextModes().delete(sessionId)); return undefined }
        if (state === 'solo') {
          const record: SessionNextSquadModeRecord = { state: 'solo' }
          await abortableStep(signal, () => this.nextModes().put(sessionId, record))
          return record
        }
        const record: SessionNextSquadModeRecord = { state: 'team', squadId: squadId! }
        await abortableStep(signal, () => this.nextModes().put(sessionId, record))
        return record
      })
    }, signal)
  }

  /** Bind a one-shot to exactly one message before any other durable write. */
  protected async claimNextSessionSquadMode(sessionId: SessionId, messageId: string): Promise<SessionNextSquadModeRecord | undefined> {
    return this.definitionWrites.run(async () => {
    const record = this.nextModes().get(sessionId)
    if (record === undefined) return undefined
    if (record.claimedMessageId !== undefined && record.claimedMessageId !== messageId) return undefined
    if (record.claimedMessageId === messageId) return record
    let claimed = false
    const updated = await this.nextModes().update(sessionId, (current) => {
      if (current.claimedMessageId !== undefined && current.claimedMessageId !== messageId) return current
      claimed = true
      return current.claimedMessageId === messageId
        ? current
        : { ...current, claimedMessageId: messageId, claimedAt: Date.now() }
    })
    return claimed ? updated : undefined
    })
  }

  protected async clearClaimedNextSessionSquadMode(sessionId: SessionId, messageId: string): Promise<void> {
    return this.definitionWrites.run(async () => {
    if (this.nextModes().get(sessionId)?.claimedMessageId === messageId) await this.nextModes().delete(sessionId)
    })
  }

  projectKeyFor(agent: Agent): string | undefined { return this.projectKeyForSession(agent.session) }
  projectKeyForSession(session: Agent['session']): string | undefined { return session.header.cwd }

  getEffectiveSessionSquadModeForSession(session: Agent['session'], sessionId: SessionId = session.id): SessionSquadModeView | undefined {
    if (this.isDelegatedSession(session)) return undefined
    const explicit = this.sessionModes().get(sessionId)
    if (explicit !== undefined) return this.getSessionSquadMode(sessionId)
    const projectKey = this.projectKeyForSession(session)
    if (projectKey === undefined) return undefined
    const project = this.projectDefaults().get(projectKey)
    if (project === undefined || !project.enabled) return undefined
    const squad = this.squads().get(project.squadId)
    return squad === undefined ? undefined : { sessionId, squadId: project.squadId, squadName: squad.name }
  }

  getEffectiveSessionSquadMode(agent: Agent): SessionSquadModeView | undefined { return this.getEffectiveSessionSquadModeForSession(agent.session, agent.id) }
  protected isDelegatedAgent(agent: Agent): boolean { return agent.options?.agentTeamGuiChild === true || this.isDelegatedSession(agent.session) }
  protected isDelegatedSession(session: Agent['session']): boolean {
    const header = session.header
    return header.origin === 'subagent' || header.parentSession !== undefined || (header.delegationDepth ?? 0) > 0
  }

  protected async claimGuaranteedMessage(agent: Agent, messageId: string, kind: 'solo' | 'team'): Promise<boolean> {
    return this.definitionWrites.run(async () => {
    const key = `${agent.id}:${messageId}`
    const alreadyDurable = this.messageClaims().get(key) !== undefined
      || [...this.runs().entries()].some(([, run]) => run.sessionId === agent.id && run.sourceMessageId === messageId)
    if (this.lastGuaranteedMessage.get(agent) === messageId || alreadyDurable) return false
    await this.messageClaims().put(key, { sessionId: agent.id, messageId, kind, createdAt: Date.now() })
    this.lastGuaranteedMessage.set(agent, messageId)
    return true
    })
  }

  /** Bound durable idempotency receipts independently from run history. */
  protected async pruneMessageClaims(now = Date.now()): Promise<number> {
    const claims = [...this.messageClaims().entries()].sort((left, right) => right[1].createdAt - left[1].createdAt)
    const cutoff = now - 90 * 86_400_000
    let pruned = 0
    for (const [index, [key, claim]] of claims.entries()) {
      if (claim.createdAt >= cutoff && index < 2_000) continue
      if (await this.messageClaims().delete(key)) pruned += 1
    }
    // A claimed one-shot was already bound to an old in-flight message. On a
    // cold start it is at-most-once and must never be advertised or leak into
    // a later message.
    for (const [sessionId, next] of [...this.nextModes().entries()]) {
      if (next.claimedMessageId !== undefined && await this.nextModes().delete(sessionId)) pruned += 1
    }
    return pruned
  }

  getProjectDefault(projectKey: string): ProjectSquadDefaultRecord | undefined { return this.projectDefaults().get(projectKey) }
  async setProjectDefault(projectKey: string, squadId?: SquadId, signal?: AbortSignal): Promise<ProjectSquadDefaultRecord | undefined> {
    return this.definitionWrites.run(async () => {
      if (projectKey.trim() === '') throw new AgentTeamError('project key must not be empty', 'INVALID_DISPATCH')
      if (squadId !== undefined && this.squads().get(squadId) === undefined) throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
      const unit = new StorageUnitOfWork(); unit.capture(this.projectDefaults())
      return unit.run(async () => {
        if (squadId === undefined) { await abortableStep(signal, () => this.projectDefaults().delete(projectKey)); return undefined }
        const record: ProjectSquadDefaultRecord = { projectKey, squadId, enabled: true }
        await abortableStep(signal, () => this.projectDefaults().put(projectKey, record))
        return record
      })
    }, signal)
  }

  squadModeGuidance(agent: Agent | undefined): string {
    if (agent === undefined || this.isDelegatedAgent(agent)) return ''
    const mode = this.getEffectiveSessionSquadMode(agent)
    if (mode === undefined) return ''
    const squad = this.squads().get(mode.squadId)
    if (squad === undefined) return ''
    const order = squad.executionOrder === undefined
      ? 'No fixed member order is configured. If delegation is useful, omit assignments and memberOrder to let the planner select members and build a dependency graph. Explicit assignments bypass that planner and must cover every member with distinct role-specific work.'
      : `Use this fixed serial member order: ${squad.executionOrder.join(' -> ')}. Omit memberOrder entirely when calling dispatch_to_squad; it cannot override this fixed order.`
    const executionMode = squad.executionMode ?? (squad.executionOrder === undefined ? this.config.defaultExecutionMode : 'serial')
    const contextMode = squad.contextMode ?? this.config.defaultContextMode
    const guaranteed = (squad.triggerMode ?? 'guaranteed') === 'guaranteed'
    const manual = squad.activationMode === 'manual'
    const capabilities = squad.members.map(id => {
      const record = this.agents().get(id)
      if (record === undefined) return `- ${id}: unavailable`
      return `- ${id}: role=${record.systemPrompt.slice(0, 600)}; allowed tools=${record.toolScope?.allow?.slice(0, 10).join(', ') ?? 'parent tools subject to restrictions'}; denied tools=${record.toolScope?.deny?.slice(0, 10).join(', ') ?? 'none configured'}`
    }).join('\n').slice(0, 16_000)
    return [
      '<agent_team_squad_mode>',
      `Squad mode is enabled for this conversation. Active squad id: ${mode.squadId}.`,
      `Squad name: ${squad.name}. Members (id, name, model): ${squad.members.map((id) => {
        const record = this.agents().get(id)
        return record === undefined ? `${id} (missing)` : `${id} (${record.name}, ${record.provider}/${record.model})`
      }).join(', ') || '(none)'}.`,
      ...(squad.collabNote === undefined || squad.collabNote.length === 0 ? [] : [`Collaboration note: ${squad.collabNote}`]),
      order,
      `Default executionMode: ${executionMode}. Default contextMode: ${contextMode}.`,
      `Member capabilities (bounded reference for choosing useful delegation):\n${capabilities}`,
      'An explicit per-message Solo or host-dispatch notice takes precedence over these conversation defaults. Never redispatch a message already handled by the host.',
      'A settled failed/partial run may expose continuation.allowed=true. Then review the failure diagnosis and existing artifacts and call continue_squad_run with its sourceRunId/expectedRevision plus revised remaining assignments and a progressReview. This is a bounded continuation of the same goal, not another dispatch_to_squad. Never bypass cancellation, exhausted quota, or continuation limits. Do not change the original acceptance criteria or silently take over worker implementation.',
      ...(manual ? [
        'This team is Manual-only. Ordinary messages do not start a squad. Answer directly or ask for missing information; do not call dispatch_to_squad. The user can explicitly choose Force Team next or use a manual Run Center action.',
      ] : guaranteed ? [
        'The host runs this squad before your request and injects one dsh-agent-team-gui notice containing the plan and member results.',
        'Do not call dispatch_to_squad again when that notice is present. Produce a structured retrospective: (1) squad execution summary — what each member did and the outcome, (2) what went well, (3) what did not go well and why, (4) knowledge gap analysis — classify whether underperformance was due to missing repository knowledge, missing user-supplied domain knowledge, scope/planning issues, or tool/execution limitations, (5) concrete improvement recommendations with specific files/presets/settings for progressive disclosure or documentation, and (6) a final verdict on squad effectiveness.',
      ] : [
        'This team is AVAILABLE ON DEMAND, not mandatory. Decide within your normal reasoning whether delegation adds value. Do not start a planner or workers just to decide whether this team is needed.',
        'Answer simple arithmetic such as 1+1, short explanations, and straightforward local work directly when you can do so effectively. Ask the user when necessary information is missing. Do not invent extra tasks to keep members busy.',
        'Use dispatch_to_squad only when distinct member expertise, parallel independent deliverables, or a useful independent review justify its additional latency and Token cost, or the user explicitly requests team execution.',
        `When you choose to delegate, pass squadId exactly as "${mode.squadId}". Preserve the user goal and define concrete boundaries.`,
        'Model-initiated dispatch waits for its result; the background setting applies only to host-triggered dispatch. After a direct answer, do not fabricate a team run or give an unnecessary squad retrospective.',
        'After actual delegation, synthesize the member results and report failures honestly. At most one initial dispatch is admitted per user message. Use the bounded continuation path only when its result says it is allowed; changing wording does not reset admission.',
      ]),
      '</agent_team_squad_mode>',
    ].join('\n')
  }

  async exportDefinitions(): Promise<AgentTeamExportDocument> {
    const snapshot = await this.readDefinitionSnapshot()
    const common = {
      format: 'agent-team-gui/definitions' as const,
      exportedAt: Date.now(),
      agents: [...snapshot.agents].map(([id, record]) => ({ id, ...record })),
      squads: [...snapshot.squads].map(([id, record]) => ({ id, ...record })),
    }
    this.assertPortableDocumentBounds(common, 'definitions')
    const current = { ...common, version: 2 as const }
    // A legacy record may exceed v2 write limits. Export it as v1 rather than
    // producing an invalid backup or making the upgraded installation unusable.
    if (agentTeamExportSchema.safeParse(current).success) return current
    return agentTeamExportSchema.parse({ ...common, version: 1 })
  }

  /** Parse and validate the complete closed definition graph before any write. */
  private async prepareDefinitionsImport(
    document: unknown,
    mode: AgentTeamImportMode,
    existingAgentIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<PreparedDefinitionImport> {
    throwIfAborted(signal)
    this.assertPortableDocumentBounds(document, 'definitions')
    const parsed = agentTeamExportSchema.parse(document)
    const agentSchema = parsed.version === 1 ? agentRecordReadSchema : agentRecordSchema
    const squadSchema = parsed.version === 1 ? squadRecordReadSchema : squadRecordSchema
    const seenAgents = new Set<string>()
    const agents = parsed.agents.map((item) => {
      if (seenAgents.has(item.id)) throw new AgentTeamError(`duplicate agent "${item.id}" in import document`, 'INVALID_IMPORT')
      seenAgents.add(item.id)
      const { id, ...fields } = item
      return { id: AgentId(id), record: agentSchema.parse(fields) }
    })
    for (const item of agents) {
      try {
        await this.validateModelRoute(item.record, signal, { validateTools: parsed.version !== 1 })
      } catch (error: unknown) {
        if (signal?.aborted === true) throwIfAborted(signal)
        throw new AgentTeamError(
          `invalid import agent "${item.id}" route ${item.record.provider}/${item.record.model}: ${this.errorText(error)}`,
          'INVALID_IMPORT',
        )
      }
    }
    throwIfAborted(signal)
    const knownAgents = new Set<string>(mode === 'replace'
      ? agents.map(item => item.id)
      : [...existingAgentIds, ...agents.map(item => item.id)])
    const seenSquads = new Set<string>()
    const squads = parsed.squads.map((item) => {
      if (seenSquads.has(item.id)) throw new AgentTeamError(`duplicate squad "${item.id}" in import document`, 'INVALID_IMPORT')
      seenSquads.add(item.id)
      const { id, ...fields } = item
      const record = squadSchema.parse(fields)
      try { this.validateSquadRecord(record, knownAgents, { allowLegacyEmpty: parsed.version === 1 }) }
      catch (error: unknown) { throw new AgentTeamError(`invalid import squad "${id}": ${this.errorText(error)}`, 'INVALID_IMPORT') }
      return { id: SquadId(id), record }
    })
    throwIfAborted(signal)
    return { version: parsed.version, agents, squads }
  }

  private changedAgentIds(
    incoming: readonly { readonly id: AgentId; readonly record: AgentRecord }[],
    existing: ReadonlyMap<AgentId, AgentRecord> = new Map(this.listAgents()),
  ): Set<AgentId> {
    return new Set(incoming.flatMap((item) => {
      const current = existing.get(item.id)
      return current !== undefined && JSON.stringify(current) !== JSON.stringify(item.record) ? [item.id] : []
    }))
  }

  private affectedSquadsFor(
    changed: ReadonlySet<AgentId>,
    excluded: ReadonlySet<SquadId> = new Set(),
    existing: ReadonlyMap<SquadId, SquadRecord> = new Map(this.listSquads()),
  ): Array<{ squadId: SquadId; squadName: string; agentIds: AgentId[] }> {
    return [...existing].flatMap(([id, squad]) => {
      if (excluded.has(id)) return []
      const agentIds = squad.members.filter(agentId => changed.has(agentId))
      return agentIds.length === 0 ? [] : [{ squadId: id, squadName: squad.name, agentIds }]
    })
  }

  private revalidatePreparedImport(prepared: PreparedDefinitionImport, mode: AgentTeamImportMode): void {
    const knownAgents = new Set<string>(mode === 'replace'
      ? prepared.agents.map(item => item.id)
      : [...this.listAgents().map(([id]) => id), ...prepared.agents.map(item => item.id)])
    if (prepared.version !== 1) for (const item of prepared.agents) this.validateToolPolicy(item.record)
    for (const item of prepared.squads) {
      try { this.validateSquadRecord(item.record, knownAgents, { allowLegacyEmpty: prepared.version === 1 }) }
      catch (error: unknown) { throw new AgentTeamError(`invalid import squad "${item.id}": ${this.errorText(error)}`, 'INVALID_IMPORT') }
    }
  }

  /** Complete read-only impact report for the explicit import confirmation UI. */
  async previewDefinitionsImport(document: unknown, mode: AgentTeamImportMode = 'merge', signal?: AbortSignal): Promise<AgentTeamImportPreview> {
    if (mode !== 'merge' && mode !== 'replace') throw new AgentTeamError(`unknown import mode "${String(mode)}"`, 'INVALID_IMPORT')
    const captured = await this.definitionWrites.readVersioned(() => ({
      agents: new Map(this.listAgents()),
      squads: new Map(this.listSquads()),
      sessionModes: [...this.sessionModes().entries()],
      nextModes: [...this.nextModes().entries()],
      projectDefaults: [...this.projectDefaults().entries()],
      squadVersions: [...this.squadVersions().entries()],
    }), signal)
    const prepared = await this.prepareDefinitionsImport(document, mode, new Set(captured.value.agents.keys()), signal)
    const incomingAgents = new Set(prepared.agents.map(item => item.id))
    const incomingSquads = new Set(prepared.squads.map(item => item.id))
    const conflicts = {
      agentIds: prepared.agents.filter(item => captured.value.agents.has(item.id)).map(item => item.id),
      squadIds: prepared.squads.filter(item => captured.value.squads.has(item.id)).map(item => item.id),
    }
    const changedAgents = this.changedAgentIds(prepared.agents, captured.value.agents)
    const removedSquads = new Set(mode === 'replace'
      ? [...captured.value.squads.keys()].filter(id => !incomingSquads.has(id))
      : [])
    return {
      valid: true,
      definitionRevision: captured.revision,
      mode,
      incoming: { agents: prepared.agents.length, squads: prepared.squads.length },
      conflicts,
      affectedSquads: this.affectedSquadsFor(changedAgents, new Set(), captured.value.squads),
      deletions: {
        agents: mode === 'replace' ? [...captured.value.agents.keys()].filter(id => !incomingAgents.has(id)).length : 0,
        squads: removedSquads.size,
        sessionModes: captured.value.sessionModes.filter(([, value]) => value.squadId !== undefined && removedSquads.has(value.squadId)).length,
        nextModes: captured.value.nextModes.filter(([, value]) => value.squadId !== undefined && removedSquads.has(value.squadId)).length,
        projectDefaults: captured.value.projectDefaults.filter(([, value]) => removedSquads.has(value.squadId)).length,
        squadVersions: captured.value.squadVersions.filter(([, value]) => removedSquads.has(value.squadId)).length,
      },
    }
  }

  async importDefinitions(
    document: unknown,
    mode: AgentTeamImportMode = 'merge',
    signal?: AbortSignal,
    expectedRevision?: number,
  ): Promise<AgentTeamImportResult> {
    if (mode !== 'merge' && mode !== 'replace') throw new AgentTeamError(`unknown import mode "${String(mode)}"`, 'INVALID_IMPORT')
    const observed = await this.definitionWrites.readVersioned(() => new Set(this.listAgents().map(([id]) => id)), signal)
    if (expectedRevision !== undefined && observed.revision !== expectedRevision) {
      throw new AgentTeamError('stale import preview: definitions changed; preview the backup again before applying', 'INVALID_IMPORT')
    }
    const prepared = await this.prepareDefinitionsImport(document, mode, observed.value, signal)
    return this.definitionWrites.run(async () => {
    if (this.definitionWrites.currentRevision !== observed.revision) {
      throw new AgentTeamError('stale import preview: definitions changed during validation; preview the backup again', 'INVALID_IMPORT')
    }
    this.revalidatePreparedImport(prepared, mode)
    const agentsToWrite = prepared.agents
    const squadsToWrite = prepared.squads
    const changedAgents = this.changedAgentIds(agentsToWrite)
    const importedSquadIds = new Set(squadsToWrite.map(item => item.id))
    const unit = new StorageUnitOfWork()
    unit.capture(this.agents()); unit.capture(this.squads()); unit.capture(this.sessionModes()); unit.capture(this.nextModes())
    unit.capture(this.projectDefaults()); unit.capture(this.squadVersions())
    await unit.run(async () => {
      if (mode === 'replace') {
        for (const [id] of this.listAgents()) await abortableStep(signal, () => this.agents().delete(id))
        for (const [id] of this.listSquads()) await abortableStep(signal, () => this.squads().delete(id))
        const imported = new Set(squadsToWrite.map(item => item.id))
        for (const [id, value] of this.sessionModes().entries()) if (value.squadId !== undefined && !imported.has(value.squadId)) await abortableStep(signal, () => this.sessionModes().delete(id))
        for (const [id, value] of this.nextModes().entries()) if (value.squadId !== undefined && !imported.has(value.squadId)) await abortableStep(signal, () => this.nextModes().delete(id))
        for (const [id, value] of this.projectDefaults().entries()) if (!imported.has(value.squadId)) await abortableStep(signal, () => this.projectDefaults().delete(id))
        for (const [id, value] of this.squadVersions().entries()) if (!imported.has(value.squadId)) await abortableStep(signal, () => this.squadVersions().delete(id))
      }
      for (const item of agentsToWrite) await abortableStep(signal, () => this.agents().put(item.id, item.record))
      for (const item of squadsToWrite) {
        await abortableStep(signal, () => this.squads().put(item.id, item.record))
        await this.recordSquadVersion(item.id, item.record, signal)
      }
      for (const affected of this.affectedSquadsFor(changedAgents, importedSquadIds)) {
        const squad = this.squads().get(affected.squadId)
        if (squad !== undefined) await this.recordSquadVersion(affected.squadId, squad, signal)
      }
    })
    return { agents: agentsToWrite.length, squads: squadsToWrite.length }
    }, signal)
  }

  async exportRecipe(squadId: SquadId, signal?: AbortSignal): Promise<AgentTeamRecipeDocument> {
    const recipe = await this.definitionWrites.read(() => this.exportRecipeUnlocked(squadId), signal)
    try {
      this.assertPortableDocumentBounds(recipe, 'recipe')
      return agentTeamRecipeSchema.parse(recipe)
    } catch (error: unknown) {
      throw new AgentTeamError(
        `this legacy squad exceeds the portable recipe compatibility envelope; use the full Definitions backup instead: ${this.errorText(error)}`,
        'INVALID_IMPORT',
      )
    }
  }

  private exportRecipeUnlocked(squadId: SquadId): AgentTeamRecipeDocument {
    const squad = this.squads().get(squadId)
    if (squad === undefined) throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    const agents = squad.members.map((id) => {
      const record = this.agents().get(id)
      if (record === undefined) throw new AgentTeamError(`squad references missing agent "${id}"`, 'AGENT_NOT_FOUND')
      return { id, ...structuredClone(record) }
    })
    return { format: 'agent-team-gui/recipe', version: 1, exportedAt: Date.now(), squad: { id: squadId, ...structuredClone(squad) }, agents }
  }

  async previewRecipe(document: unknown, routeRemap: Readonly<Record<string, AgentRouteRemap>> = {}, signal?: AbortSignal): Promise<RecipePreviewResult> {
    const recipe = this.parseRecipeDocument(document, routeRemap)
    const captured = await this.definitionWrites.readVersioned(() => ({
      agents: new Map([...this.agents().entries()].map(([id, record]) => [id, structuredClone(record)])),
      squads: new Map([...this.squads().entries()].map(([id, record]) => [id, structuredClone(record)])),
    }), signal)
    return this.previewRecipeAgainstSnapshot(recipe, captured.value, signal, captured.revision)
  }

  private parseRecipeDocument(document: unknown, routeRemap: Readonly<Record<string, AgentRouteRemap>> = {}): AgentTeamRecipeDocument {
    this.assertPortableDocumentBounds(document, 'recipe')
    let recipe: AgentTeamRecipeDocument
    try {
      recipe = prepareRecipe(document, routeRemap)
      const agents = new Map(recipe.agents.map((item) => { const { id, ...record } = item; return [id, record] as const }))
      const { id: _id, ...record } = recipe.squad
      this.validateSquadRecord(record, new Set(agents.keys()), { allowLegacyEmpty: true })
    } catch (error: unknown) { throw new AgentTeamError(`invalid recipe: ${this.errorText(error)}`, 'INVALID_IMPORT') }
    return recipe
  }

  private async previewRecipeAgainstSnapshot(
    recipe: AgentTeamRecipeDocument,
    definitions: DefinitionSnapshot,
    signal?: AbortSignal,
    definitionRevision = this.definitionWrites.currentRevision,
  ): Promise<RecipePreviewResult> {
    throwIfAborted(signal)
    const conflicts = findRecipeConflicts(recipe, {
      agents: definitions.agents,
      squads: new Map([...definitions.squads].map(([id, record]) => [id, { name: record.name }])),
    })
    const missingRoutes = await findMissingRecipeRoutes(
      recipe,
      (provider, model) => abortableStep(signal, () => this.ctx.llm.resolveModelInfo(provider, model, signal)),
      signal,
    )
    throwIfAborted(signal)
    const changedAgents = this.changedAgentIds(recipe.agents.map((item) => {
      const { id, ...record } = item
      return { id: AgentId(id), record }
    }), definitions.agents)
    return {
      valid: missingRoutes.length === 0,
      definitionRevision,
      squad: recipe.squad,
      agents: recipe.agents,
      conflicts,
      missingRoutes,
      affectedSquads: this.affectedSquadsFor(changedAgents, new Set([SquadId(recipe.squad.id)]), definitions.squads),
    }
  }

  async importRecipe(
    document: unknown,
    policy: 'merge' | 'copy',
    routeRemap: Readonly<Record<string, AgentRouteRemap>> = {},
    signal?: AbortSignal,
    expectedRevision?: number,
  ): Promise<RecipeImportResult> {
    if (policy !== 'merge' && policy !== 'copy') throw new AgentTeamError(`unknown recipe import policy "${String(policy)}"`, 'INVALID_IMPORT')
    const prepared = this.parseRecipeDocument(document, routeRemap)
    const recipe = policy === 'copy' ? copyRecipeIds(prepared, randomUUID) : prepared
    const observed = await this.definitionWrites.readVersioned(() => ({
      agents: new Map(this.listAgents()), squads: new Map(this.listSquads()),
    }), signal)
    if (expectedRevision !== undefined && observed.revision !== expectedRevision) {
      throw new AgentTeamError('stale recipe preview: definitions changed; preview the recipe again before applying', 'INVALID_IMPORT')
    }
    const preview = await this.previewRecipeAgainstSnapshot(recipe, observed.value, signal, observed.revision)
    if (!preview.valid) throw new AgentTeamError(`recipe has unavailable model routes: ${preview.missingRoutes.map(item => `${item.provider}/${item.model}`).join(', ')}`, 'INVALID_IMPORT')
    return this.definitionWrites.run(async () => {
    if (this.definitionWrites.currentRevision !== observed.revision) {
      throw new AgentTeamError('stale recipe preview: definitions changed during validation; preview the recipe again', 'INVALID_IMPORT')
    }
    const incomingIds = new Set(recipe.agents.map(item => String(item.id)))
    const { id: _validatedId, ...validatedSquad } = recipe.squad
    this.validateSquadRecord(validatedSquad, incomingIds, { allowLegacyEmpty: true })
    const squadId = SquadId(recipe.squad.id)
    const createdAgents = recipe.agents.filter(item => this.agents().get(AgentId(item.id)) === undefined).length
    const changedAgents = this.changedAgentIds(recipe.agents.map((item) => {
      const { id, ...record } = item
      return { id: AgentId(id), record }
    }))
    const unit = new StorageUnitOfWork()
    unit.capture(this.agents()); unit.capture(this.squads()); unit.capture(this.squadVersions())
    await unit.run(async () => {
      for (const item of recipe.agents) {
        const { id, ...record } = item
        const strict = agentRecordSchema.safeParse(record)
        const parsed = strict.success ? strict.data : agentRecordReadSchema.parse(record)
        if (strict.success) this.validateToolPolicy(parsed)
        await abortableStep(signal, () => this.agents().put(AgentId(id), parsed))
      }
      const { id: _id, ...squad } = recipe.squad
      const strict = squadRecordSchema.safeParse(squad)
      const parsed = strict.success ? strict.data : squadRecordReadSchema.parse(squad)
      await abortableStep(signal, () => this.squads().put(squadId, parsed))
      await this.recordSquadVersion(squadId, parsed, signal)
      for (const affected of this.affectedSquadsFor(changedAgents, new Set([squadId]))) {
        const squad = this.squads().get(affected.squadId)
        if (squad !== undefined) await this.recordSquadVersion(affected.squadId, squad, signal)
      }
    })
    return { squadId, agents: recipe.agents.length, createdAgents, updatedAgents: recipe.agents.length - createdAgents }
    }, signal)
  }

  resolveSquadId(reference: string): SquadId {
    const trimmed = reference.trim()
    const direct = SquadId(trimmed)
    if (this.squads().get(direct) !== undefined) return direct
    const matches = this.listSquads().filter(([, squad]) => squad.name.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase())
    if (matches.length === 1) return matches[0]![0]
    if (matches.length > 1) throw new AgentTeamError(`squad name "${trimmed}" is ambiguous; use its durable id`, 'INVALID_DISPATCH')
    throw new AgentTeamError(`squad "${trimmed}" does not exist`, 'SQUAD_NOT_FOUND')
  }

  async addMemberToSquad(squadId: SquadId, agentId: AgentId, signal?: AbortSignal): Promise<SquadRecord> {
    return this.definitionWrites.run(async () => {
    if (this.agents().get(agentId) === undefined) throw new AgentTeamError(`agent "${agentId}" does not exist`, 'AGENT_NOT_FOUND')
    if (this.squads().get(squadId) === undefined) throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    const unit = new StorageUnitOfWork(); unit.capture(this.squads()); unit.capture(this.squadVersions())
    return unit.run(async () => {
      const updated = await abortableStep(signal, () => this.squads().update(squadId, squad => {
        if (squad.members.includes(agentId)) throw new AgentTeamError(`agent "${agentId}" is already in squad "${squadId}"`, 'INVALID_MEMBERS')
        const next = { ...squad, members: [...squad.members, agentId],
          ...(squad.executionOrder === undefined ? {} : { executionOrder: [...squad.executionOrder, agentId] }) }
        const parsed = squadRecordSchema.parse(next)
        this.validateSquadRecord(parsed)
        return parsed
      }))
      await this.recordSquadVersion(squadId, updated, signal)
      return updated
    })
    }, signal)
  }

  async removeMemberFromSquad(squadId: SquadId, agentId: AgentId, signal?: AbortSignal): Promise<SquadRecord> {
    return this.definitionWrites.run(async () => {
    const existing = this.squads().get(squadId)
    if (existing === undefined) throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    if (existing.members.includes(agentId) && existing.members.length === 1) throw new AgentTeamError('a squad must retain at least one member', 'INVALID_MEMBERS')
    if (existing.qualityGate?.reviewerAgentId === agentId || existing.qualityGate?.repairAgentId === agentId) {
      throw new AgentTeamError('remove or reassign the quality gate before removing this member', 'INVALID_MEMBERS')
    }
    const unit = new StorageUnitOfWork(); unit.capture(this.squads()); unit.capture(this.squadVersions())
    return unit.run(async () => {
      const updated = await abortableStep(signal, () => this.squads().update(squadId, squad => {
        const { leaderAgentId, ...withoutLeader } = squad
        const next = { ...(leaderAgentId === agentId ? withoutLeader : squad),
          members: squad.members.filter(id => id !== agentId),
          ...(squad.executionOrder === undefined ? {} : { executionOrder: squad.executionOrder.filter(id => id !== agentId) }) }
        const parsed = squadRecordSchema.parse(next)
        this.validateSquadRecord(parsed)
        return parsed
      }))
      await this.recordSquadVersion(squadId, updated, signal)
      return updated
    })
    }, signal)
  }
}
