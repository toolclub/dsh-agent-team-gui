import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AgentView, PlanView, SquadVersionView, SquadView, TeamSnapshot } from './contracts.ts'
import { AgentTeamController, errorText } from './controller.ts'
import {
  agentDraftOf, defaultAgent, EMPTY_SQUAD, normalizeOrder, squadDraftOf, structurallyEqual, toAgentRecord, toSquadRecord,
  validateAgent, validateSquad, type AgentDraft, type SquadDraft,
} from './forms.ts'
import { useI18n, type MessageKey, type Translate } from './i18n.ts'
import { formatTokens, planStages } from './view-models.ts'
import { RecipesWorkspace } from './RecipesWorkspace.tsx'
import { handleTabKey } from './tab-keyboard.ts'
import { SlotErrorBoundary } from './SlotErrorBoundary.tsx'

export interface TeamSettingsInjected {
  controller: AgentTeamController
}
export type TeamSettingsPageProps = PropsRuntime<'settings.section'> & InjectFace<TeamSettingsInjected>

type SettingsView = 'teams' | 'members' | 'recipes'

interface SquadRestorePreview {
  definitionRevision: number
  squadId: string
  version: number
  record: unknown
  memberSnapshots: unknown[]
  conflicts: Array<{ agentId: string; currentName: string; restoredName: string }>
  affectedSquads?: Array<{ squadId: string; squadName: string; agentIds: string[] }>
}

/** Three-view settings workspace with selected editors and guarded, sticky actions. */
export function TeamSettingsPage(props: TeamSettingsPageProps): ReactNode {
  return <SlotErrorBoundary controller={props.controller} testId="agent-team-settings"><TeamSettingsPageContent {...props} /></SlotErrorBoundary>
}

function TeamSettingsPageContent({ controller, close, useSessions }: TeamSettingsPageProps): ReactNode {
  const { active, t } = useI18n(controller.i18n)
  const catalog = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [view, setView] = useState<SettingsView>('teams')
  const [squad, setSquad] = useState<SquadDraft>({ ...EMPTY_SQUAD })
  const [squadBaseline, setSquadBaseline] = useState<SquadDraft>({ ...EMPTY_SQUAD })
  const [agent, setAgent] = useState<AgentDraft>(() => defaultAgent(catalog.data))
  const [agentBaseline, setAgentBaseline] = useState<AgentDraft>(() => defaultAgent(catalog.data))
  const [initialized, setInitialized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [squadConflict, setSquadConflict] = useState(false)
  const [agentConflict, setAgentConflict] = useState(false)
  const currentSession = useSessions(state => state.current)
  const rootRef = useRef<HTMLDivElement>(null)
  const catalogRevisionRef = useRef<number | null>(null)

  const squadDirty = !structurallyEqual(squad, squadBaseline)
  const agentDirty = !structurallyEqual(agent, agentBaseline)
  const dirty = view === 'teams' ? squadDirty : view === 'members' ? agentDirty : false
  useDirtyGuard(rootRef, dirty, close, t)

  useEffect(() => { void controller.load().catch(() => undefined) }, [controller])
  useEffect(() => {
    if (catalog.status !== 'ready' || catalogRevisionRef.current === catalog.revision) return
    catalogRevisionRef.current = catalog.revision
    if (!initialized) {
      const firstSquad = catalog.data.squads[0]
      const firstAgent = catalog.data.agents[0]
      const squadDraft = firstSquad === undefined ? { ...EMPTY_SQUAD } : squadDraftOf(firstSquad)
      const agentDraft = firstAgent === undefined ? defaultAgent(catalog.data) : agentDraftOf(firstAgent)
      setSquad(squadDraft); setSquadBaseline(squadDraft)
      setAgent(agentDraft); setAgentBaseline(agentDraft)
      setInitialized(true)
      return
    }

    let externalChangePreserved = false
    if (squadDirty) { externalChangePreserved = true; setSquadConflict(true) }
    else {
      const nextRecord = catalog.data.squads.find(item => item.id === squad.id) ?? catalog.data.squads[0]
      const next = nextRecord === undefined ? { ...EMPTY_SQUAD } : squadDraftOf(nextRecord)
      setSquad(next); setSquadBaseline(next)
      setSquadConflict(false)
    }
    if (agentDirty) { externalChangePreserved = true; setAgentConflict(true) }
    else {
      const nextRecord = catalog.data.agents.find(item => item.id === agent.id) ?? catalog.data.agents[0]
      const next = nextRecord === undefined ? defaultAgent(catalog.data) : agentDraftOf(nextRecord)
      setAgent(next); setAgentBaseline(next)
      setAgentConflict(false)
    }
    if (externalChangePreserved) setNotice(t('externalChanges'))
  }, [agent.id, agentDirty, catalog.data, catalog.revision, catalog.status, initialized, squad.id, squadDirty, t])

  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { window.removeEventListener('beforeunload', beforeUnload) }
  }, [dirty])

  const confirmDiscard = (): boolean => !dirty || window.confirm(t('unsavedConfirm'))
  const changeView = (next: SettingsView): void => {
    if (next === view || !confirmDiscard()) return
    if (view === 'teams' && squadDirty) { setSquad(squadBaseline); setSquadConflict(false) }
    if (view === 'members' && agentDirty) { setAgent(agentBaseline); setAgentConflict(false) }
    setError(''); setNotice(''); setView(next)
  }
  const selectSquad = (item?: SquadView): void => {
    if (!confirmDiscard()) return
    const draft = item === undefined ? { ...EMPTY_SQUAD } : squadDraftOf(item)
    setSquad(draft); setSquadBaseline(draft); setSquadConflict(false); setError(''); setNotice('')
  }
  const selectAgent = (item?: AgentView): void => {
    if (!confirmDiscard()) return
    const draft = item === undefined ? defaultAgent(catalog.data) : agentDraftOf(item)
    setAgent(draft); setAgentBaseline(draft); setAgentConflict(false); setError(''); setNotice('')
  }
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(''); setNotice('')
    try { await action(); return true } catch (reason) { setError(errorText(reason)); return false } finally { setBusy(false) }
  }

  const deleteItem = async (kind: 'agent' | 'squad', id: string, name: string): Promise<void> => {
    if (kind === 'agent') {
      const affected = catalog.data.squads.filter(item => item.members.includes(id))
      const blocked = affected.filter(item => item.members.length <= 1 || item.qualityGate?.reviewerAgentId === id || item.qualityGate?.repairAgentId === id)
      if (blocked.length > 0) {
        setError(t('deleteMemberBlocked', { names: blocked.map(item => item.name).join(', ') }))
        return
      }
      const message = affected.length === 0
        ? `${t('remove')} “${name}”?`
        : t('deleteMemberAffected', { name, names: affected.map(item => item.name).join(', ') })
      if (!window.confirm(message)) return
    } else if (!window.confirm(t('deleteSquadAffected', { name }))) return
    const ok = await run(() => controller.mutate(`${kind}/delete`, { id }))
    if (!ok) return
    if (kind === 'squad') selectSquad(controller.getSnapshot().data.squads[0])
    else selectAgent(controller.getSnapshot().data.agents[0])
  }

  const cloneSquad = async (item: SquadView): Promise<void> => {
    if (!confirmDiscard()) return
    await run(async () => {
      const { id: _id, ...record } = item
      const created = await controller.call<{ id: string }>('squad/create', { record: { ...record, name: t('copyName', { name: item.name }) } })
      await controller.load(true)
      const stored = controller.getSnapshot().data.squads.find(value => value.id === created.id)
      if (stored !== undefined) {
        const next = squadDraftOf(stored)
        setSquad(next); setSquadBaseline(next); setError(''); setNotice('')
      }
    })
  }

  return <div ref={rootRef} className="atg-page" data-testid="agent-team-settings">
    <header className="atg-page-header"><div><h2>{t('teams')}</h2><p>{t('settingsIntro')}</p></div><button type="button" className="atg-button ghost" disabled={busy} onClick={() => { void controller.load(true).catch(reason => { setError(errorText(reason)) }) }}>↻ {t('refresh')}</button></header>
    <nav className="atg-tabs" role="tablist" aria-label={t('teams')} onKeyDown={handleTabKey}>
      <button type="button" id="agent-team-tab-teams" role="tab" tabIndex={view === 'teams' ? 0 : -1} aria-selected={view === 'teams'} aria-controls="agent-team-panel-teams" onClick={() => { changeView('teams') }}>{t('teams')} <span>{catalog.data.squads.length}</span></button>
      <button type="button" id="agent-team-tab-members" role="tab" tabIndex={view === 'members' ? 0 : -1} aria-selected={view === 'members'} aria-controls="agent-team-panel-members" onClick={() => { changeView('members') }}>{t('members')} <span>{catalog.data.agents.length}</span></button>
      <button type="button" id="agent-team-tab-recipes" role="tab" tabIndex={view === 'recipes' ? 0 : -1} aria-selected={view === 'recipes'} aria-controls="agent-team-panel-recipes" onClick={() => { changeView('recipes') }}>{t('recipes')}</button>
    </nav>
    {(error || catalog.error) && <div className="atg-recovery" role="alert"><strong>{t('connectionError')}</strong><span>{error || catalog.error}</span><button type="button" className="atg-button ghost" onClick={() => { void controller.load(true).catch(() => undefined) }}>{t('retry')}</button></div>}
    {notice !== '' && <div className="atg-success" role="status">{notice}</div>}
    {catalog.status === 'loading' && <div className="atg-loading">{t('loading')}</div>}
    {catalog.status === 'ready' && view === 'teams' && <div id="agent-team-panel-teams" role="tabpanel" aria-labelledby="agent-team-tab-teams"><TeamWorkspace
      controller={controller} data={catalog.data} draft={squad} baseline={squadBaseline} busy={busy} sessionId={currentSession} locale={active} t={t}
      setDraft={setSquad} setBaseline={setSquadBaseline} run={run} setNotice={setNotice} select={selectSquad}
      externalConflict={squadConflict} clearExternalConflict={() => { setSquadConflict(false) }} clone={cloneSquad} remove={(item) => { void deleteItem('squad', item.id, item.name) }}
    /></div>}
    {catalog.status === 'ready' && view === 'members' && <div id="agent-team-panel-members" role="tabpanel" aria-labelledby="agent-team-tab-members"><MemberWorkspace
      controller={controller} data={catalog.data} draft={agent} baseline={agentBaseline} busy={busy} locale={active} t={t}
      setDraft={setAgent} setBaseline={setAgentBaseline} run={run} setNotice={setNotice} select={selectAgent}
      externalConflict={agentConflict} clearExternalConflict={() => { setAgentConflict(false) }} remove={(item) => { void deleteItem('agent', item.id, item.name) }}
    /></div>}
    {catalog.status === 'ready' && view === 'recipes' && <div id="agent-team-panel-recipes" role="tabpanel" aria-labelledby="agent-team-tab-recipes"><RecipesWorkspace controller={controller} data={catalog.data} busy={busy} t={t} run={run} setNotice={setNotice} /></div>}
  </div>
}

interface WorkspaceCommon { controller: AgentTeamController; data: TeamSnapshot; busy: boolean; locale: string; t: Translate; run(action: () => Promise<void>): Promise<boolean>; setNotice(value: string): void }

function TeamWorkspace({ controller, data, draft, baseline, busy, sessionId, locale, t, setDraft, setBaseline, run, setNotice, select, clone, remove, externalConflict, clearExternalConflict }: WorkspaceCommon & {
  draft: SquadDraft; baseline: SquadDraft; sessionId: string | undefined; externalConflict: boolean; clearExternalConflict(): void; setDraft(value: SquadDraft | ((current: SquadDraft) => SquadDraft)): void; setBaseline(value: SquadDraft): void; select(item?: SquadView): void; clone(item: SquadView): Promise<void>; remove(item: SquadView): void
}): ReactNode {
  const validation = validateSquad(draft, data.agents, data.defaults)
  const dirty = !structurallyEqual(draft, baseline)
  const executionInheritLabel = draft.fixedOrder
    ? t('fixedOrderSerial')
    : t('inheritCurrent', { value: t(data.defaults.executionMode) })
  const contextInheritLabel = t('inheritCurrent', { value: t(data.defaults.contextMode) })
  const [previewTask, setPreviewTask] = useState('')
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [versions, setVersions] = useState<SquadVersionView[]>([])
  const [restorePreview, setRestorePreview] = useState<SquadRestorePreview | null>(null)
  const [selectedRestoreVersion, setSelectedRestoreVersion] = useState<number | null>(null)
  const [restoreError, setRestoreError] = useState('')

  useEffect(() => {
    setVersions([]); setRestorePreview(null); setSelectedRestoreVersion(null); setRestoreError(''); setPlan(null)
    if (draft.id === '') return
    void controller.call<SquadVersionView[]>('squad/versions', { id: draft.id }).then(setVersions, () => undefined)
  }, [controller, draft.id])

  const save = async (): Promise<void> => {
    if (!validation.valid) { focusFirstError(); return }
    if (externalConflict && !window.confirm(t('remoteOverwriteConfirm'))) return
    const name = draft.name.trim()
    await run(async () => {
      let id = draft.id
      if (id === '') {
        const result = await controller.call<{ id: string }>('squad/create', { record: toSquadRecord(draft) })
        id = result.id
      } else await controller.call('squad/update', { id, record: toSquadRecord(draft) })
      await controller.load(true)
      const stored = controller.getSnapshot().data.squads.find(item => item.id === id)
      if (stored !== undefined) { const next = squadDraftOf(stored); setDraft(next); setBaseline(next) }
      clearExternalConflict()
      setNotice(t('savedTeam', { name }))
    })
  }

  const preview = async (): Promise<void> => {
    if (dirty || draft.id === '' || previewTask.trim() === '' || sessionId === undefined) return
    await run(async () => { const response = await controller.runs.preview(sessionId, draft.id, previewTask.trim()); setPlan(response.plan ?? null) })
  }

  const chooseMember = (id: string, checked: boolean): void => {
    setDraft(current => checked ? { ...current, members: [...current.members, id], executionOrder: [...current.executionOrder, id] } : {
      ...current, members: current.members.filter(item => item !== id), executionOrder: current.executionOrder.filter(item => item !== id),
      leaderAgentId: current.leaderAgentId === id ? '' : current.leaderAgentId,
      reviewerAgentId: current.reviewerAgentId === id ? '' : current.reviewerAgentId,
      repairAgentId: current.repairAgentId === id ? '' : current.repairAgentId,
    })
  }

  const restore = async (version: number): Promise<void> => {
    if (draft.id === '') return
    setRestoreError('')
    await run(async () => {
      const response = await controller.call<unknown>('squad/restore-preview', { id: draft.id, version })
      if (!isSquadRestorePreview(response)) throw new Error(t('incompatibleHost'))
      setSelectedRestoreVersion(version)
      setRestorePreview(response)
    })
  }
  const applyRestore = async (): Promise<void> => {
    if (draft.id === '' || restorePreview === null || selectedRestoreVersion === null) return
    const version = selectedRestoreVersion
    const expectedRevision = restorePreview.definitionRevision
    await run(async () => {
      try {
        await controller.call('squad/restore', { id: draft.id, version, expectedRevision })
      } catch (reason) {
        if (isStaleRestorePreviewFailure(reason)) {
          setRestorePreview(null); setSelectedRestoreVersion(null); setRestoreError(t('staleRestorePreview'))
          return
        }
        throw reason
      }
      await controller.load(true)
      const item = controller.getSnapshot().data.squads.find(value => value.id === draft.id)
      if (item !== undefined) { const next = squadDraftOf(item); setDraft(next); setBaseline(next) }
      setRestorePreview(null); setSelectedRestoreVersion(null); setRestoreError('')
    })
  }

  const diagnose = async (): Promise<void> => {
    if (draft.id === '') return
    await run(async () => {
      const response = await controller.call<unknown>('squad/diagnose', { id: draft.id })
      if (!isDiagnosis(response)) throw new Error(t('incompatibleHost'))
      const details = response.checks.map(check => `${check.ok ? '✓' : '✕'} ${check.name}: ${check.message}`).join(' · ')
      if (response.ok) setNotice(details || t('diagnosticsPassed'))
      else { setNotice(''); throw new Error(`${t('diagnosticsFailed')} ${details}`.trim()) }
    })
  }

  const applyTemplate = async (kind: 'development' | 'review' | 'product'): Promise<void> => {
    const routes = data.models.flatMap(group => group.models.map(model => ({ provider: group.provider, model: model.id })))
    if (routes.length === 0) { setNotice(t('configureModels')); return }
    const template = kind === 'development' ? {
      name: t('development'),
      note: 'Plan, implement, and review the requested change with explicit acceptance criteria and regression checks.',
      roles: [
        ['Planner', 'Analyze the request, constraints, risks, and acceptance criteria. Produce an executable dependency-aware plan.'],
        ['Implementer', 'Implement the requested change completely, preserve existing behavior, and verify the result.'],
        ['Reviewer', 'Review correctness, security, UX, regressions, and missing tests. Return evidence-backed findings.'],
      ],
      executionMode: 'serial' as const,
    } : kind === 'review' ? {
      name: t('reviewTeam'),
      note: 'Run independent correctness, security, and test reviews, preserving disagreements for the lead Agent.',
      roles: [
        ['Correctness', 'Review behavior and logic for correctness. Report only evidence-backed findings.'],
        ['Security', 'Review trust boundaries, secrets, permissions, injection, and destructive behavior.'],
        ['Tests', 'Run or design focused tests and identify regression risk and missing coverage.'],
      ],
      executionMode: 'parallel' as const,
    } : {
      name: t('productTeam'),
      note: 'Balance user value, interaction quality, accessibility, and implementation feasibility.',
      roles: [
        ['Product', 'Clarify the user problem, success metrics, priorities, and edge cases.'],
        ['UX', 'Design a clear interaction flow, information architecture, states, and accessible microcopy.'],
        ['Engineer', 'Assess feasibility, architecture, risks, and a verified delivery plan.'],
      ],
      executionMode: 'parallel' as const,
    }
    await run(async () => {
      const ids = template.roles.map((_role, index) => `template-${kind}-member-${index + 1}`)
      const document = {
        format: 'agent-team-gui/recipe' as const,
        version: 1 as const,
        exportedAt: Date.now(),
        squad: {
          id: `template-${kind}-team`, name: template.name, members: ids, collabNote: template.note,
          executionMode: template.executionMode, contextMode: 'fork' as const, leaderAgentId: ids[0],
          triggerMode: 'guaranteed' as const, failurePolicy: 'continue' as const, maxConcurrency: 3,
          activationMode: 'smart' as const, memberSelectionMode: 'adaptive' as const,
          responseMode: 'foreground' as const, planningContext: 'current' as const, plannerMaxTokens: 2048,
        },
        agents: template.roles.map((role, index) => {
          const route = routes[index % routes.length]!
          return { id: ids[index]!, name: role[0]!, systemPrompt: role[1]!, provider: route.provider, model: route.model }
        }),
      }
      const preview = await controller.recipes.preview(document, {})
      if (!preview.valid) throw new Error(t('invalidRecipe'))
      const created = await controller.recipes.import(document, 'copy', {}, preview.definitionRevision) as { squadId: string }
      await controller.load(true)
      const stored = controller.getSnapshot().data.squads.find(item => item.id === created.squadId)
      if (stored !== undefined) { const next = squadDraftOf(stored); setDraft(next); setBaseline(next) }
      setNotice(t('templateCreated', { name: template.name }))
    })
  }

  return <div className="atg-workspace-shell">
    <aside className="atg-master" aria-label={t('teamList')}><button type="button" className="atg-button primary wide" onClick={() => { select() }}>＋ {t('newTeam')}</button><div className="atg-master-list">{data.squads.map(item => <article key={item.id} className={draft.id === item.id ? 'is-active' : ''}><button className="atg-master-main" type="button" onClick={() => { select(item) }}><strong>{item.name}</strong><small>{t('membersCount', { count: item.members.length })} · {item.executionOrder === undefined ? t('autoPlan') : t('fixedPlan')}</small></button><button type="button" className="atg-icon" aria-label={`${t('clone')}: ${item.name}`} onClick={() => { void clone(item) }}>⧉</button><button type="button" className="atg-icon danger" aria-label={`${t('remove')}: ${item.name}`} onClick={() => { remove(item) }}>×</button></article>)}</div>{data.squads.length === 0 && <div className="atg-empty compact"><strong>{t('noTeams')}</strong><span>{t('noTeamsHint')}</span></div>}</aside>
    <main className="atg-editor" aria-label={t('teamEditor')}>
      <div className="atg-editor-scroll" role="region" aria-label={t('teamEditor')} tabIndex={0}>
      {data.squads.length === 0 && <section className="atg-starter"><header><div><strong>{t('templates')}</strong><small>{t('templateHint')}</small></div></header><div><button type="button" onClick={() => { void applyTemplate('development') }}><span>⌘</span><strong>{t('development')}</strong></button><button type="button" onClick={() => { void applyTemplate('review') }}><span>◫</span><strong>{t('reviewTeam')}</strong></button><button type="button" onClick={() => { void applyTemplate('product') }}><span>◇</span><strong>{t('productTeam')}</strong></button></div></section>}
      <header className="atg-editor-head"><div><strong>{draft.id === '' ? t('newTeam') : draft.name}</strong><small>{t('membersCount', { count: draft.members.length })}</small></div>{dirty && <span className="atg-dirty">● {t('dirtyBadge')}</span>}</header>
      <section className="atg-form-section"><h3>{t('basic')}</h3><Field id="team-name" label={t('teamName')} value={draft.name} placeholder={t('teamNamePlaceholder')} maxLength={120} error={validation.errors.name === undefined ? undefined : t(validation.errors.name)} onChange={value => { setDraft(current => ({ ...current, name: value })) }} /><TextField id="team-note" label={t('collaborationNote')} value={draft.collabNote} placeholder={t('collaborationPlaceholder')} maxLength={20_000} error={validation.errors.collabNote === undefined ? undefined : t(validation.errors.collabNote)} onChange={value => { setDraft(current => ({ ...current, collabNote: value })) }} /><FieldError value={validation.errors.members} t={t} /><div className="atg-member-picker">{data.agents.map(item => <label key={item.id} className={draft.members.includes(item.id) ? 'is-selected' : ''}><input type="checkbox" checked={draft.members.includes(item.id)} onChange={event => { chooseMember(item.id, event.currentTarget.checked) }} /><span className="atg-avatar">{initials(item.name)}</span><span><strong>{item.name}</strong><small>{item.provider} / {item.model}</small></span></label>)}</div>{data.agents.length === 0 && <div className="atg-note">{t('noMembers')}</div>}</section>
      <details className="atg-disclosure" open><summary><span><strong>{t('orchestration')}</strong><small>{t('autoPlan')}</small></span><span aria-hidden="true">⌄</span></summary><div className="atg-disclosure-body"><div className="atg-three"><SelectField label={t('activationMode')} value={draft.activationMode} options={[['always', t('always')], ['smart', t('smart')], ['manual', t('manual')]]} onChange={value => { setDraft(current => ({ ...current, activationMode: value as SquadDraft['activationMode'] })) }} /><SelectField label={t('memberSelection')} value={draft.memberSelectionMode} options={[['all', t('allMembers')], ['adaptive', t('adaptive')]]} onChange={value => { setDraft(current => ({ ...current, memberSelectionMode: value as SquadDraft['memberSelectionMode'] })) }} /><SelectField label={t('responseMode')} value={draft.responseMode} options={[['foreground', t('foreground')], ['background', t('background')]]} onChange={value => { setDraft(current => ({ ...current, responseMode: value as SquadDraft['responseMode'] })) }} /></div><div className="atg-three"><SelectField label={t('executionMode')} value={draft.executionMode} options={[['inherit', executionInheritLabel], ['serial', t('serial')], ['parallel', t('parallel')]]} disabled={draft.fixedOrder} onChange={value => { setDraft(current => ({ ...current, executionMode: value as SquadDraft['executionMode'] })) }} /><SelectField label={t('contextMode')} value={draft.contextMode} options={[['inherit', contextInheritLabel], ['spawn', t('spawn')], ['fork', t('fork')], ['chain', t('chain')]]} error={validation.errors.contextMode === undefined ? undefined : t(validation.errors.contextMode)} onChange={value => { setDraft(current => ({ ...current, contextMode: value as SquadDraft['contextMode'] })) }} /><SelectField label={t('planningContext')} value={draft.planningContext} options={[['inherit', t('legacyPlanningFull')], ['current', t('current')], ['recent', t('recent')], ['full', t('full')]]} onChange={value => { setDraft(current => ({ ...current, planningContext: value as SquadDraft['planningContext'] })) }} /></div><div className="atg-two"><Field id="planner-limit" label={t('plannerMaxTokens')} value={draft.plannerMaxTokens} inputMode="numeric" error={validation.errors.plannerMaxTokens === undefined ? undefined : t(validation.errors.plannerMaxTokens)} onChange={value => { setDraft(current => ({ ...current, plannerMaxTokens: value })) }} /><SelectField label={t('teamLeader')} value={draft.leaderAgentId} options={[['', t('noLeader')], ...data.agents.filter(item => draft.members.includes(item.id)).map(item => [item.id, item.name] as [string, string])]} onChange={value => { setDraft(current => ({ ...current, leaderAgentId: value })) }} /></div><label className="atg-toggle-row"><input type="checkbox" checked={draft.fixedOrder} onChange={event => { setDraft(current => ({ ...current, fixedOrder: event.currentTarget.checked, executionMode: event.currentTarget.checked ? 'serial' : current.executionMode })) }} /><span><strong>{t('fixedOrder')}</strong><small>{t('fixedOrderHint')}</small></span></label>{draft.fixedOrder && <OrderEditor draft={draft} agents={data.agents} setDraft={setDraft} t={t} />}</div></details>
      <details className="atg-disclosure"><summary><span><strong>{t('resilience')}</strong><small>{t('advanced')}</small></span><span aria-hidden="true">⌄</span></summary><div className="atg-disclosure-body"><div className="atg-two"><SelectField label={t('failurePolicy')} value={draft.failurePolicy} options={[['continue', t('continue')], ['stop', t('stop')], ['retry-once', t('retryOnce')]]} warning={validation.warnings.failurePolicy === undefined ? undefined : t(validation.warnings.failurePolicy)} onChange={value => { setDraft(current => ({ ...current, failurePolicy: value as SquadDraft['failurePolicy'] })) }} /><Field id="team-concurrency" label={t('maxConcurrency')} value={draft.maxConcurrency} inputMode="numeric" error={validation.errors.maxConcurrency === undefined ? undefined : t(validation.errors.maxConcurrency)} onChange={value => { setDraft(current => ({ ...current, maxConcurrency: value })) }} /></div><div className="atg-two"><Field id="team-timeout" label={t('memberTimeout')} value={draft.memberTimeoutMs} inputMode="numeric" error={validation.errors.memberTimeoutMs === undefined ? undefined : t(validation.errors.memberTimeoutMs)} onChange={value => { setDraft(current => ({ ...current, memberTimeoutMs: value })) }} /><Field id="team-budget" label={t('tokenBudget')} value={draft.tokenBudget} inputMode="numeric" error={validation.errors.tokenBudget === undefined ? undefined : t(validation.errors.tokenBudget)} onChange={value => { setDraft(current => ({ ...current, tokenBudget: value })) }} /></div><label className="atg-toggle-row"><input type="checkbox" checked={draft.qualityEnabled} onChange={event => { setDraft(current => ({ ...current, qualityEnabled: event.currentTarget.checked })) }} /><span><strong>{t('enableQuality')}</strong><small>{t('qualityGateHint')}</small></span></label>{draft.qualityEnabled && <div className="atg-quality-fields"><div className="atg-three"><SelectField label={t('reviewer')} value={draft.reviewerAgentId} options={selectedOptions(data.agents, draft.members)} error={validation.errors.qualityMembers === undefined ? undefined : t(validation.errors.qualityMembers)} onChange={value => { setDraft(current => ({ ...current, reviewerAgentId: value })) }} /><SelectField label={t('repairOwner')} value={draft.repairAgentId} options={selectedOptions(data.agents, draft.members)} error={validation.errors.qualityDistinct === undefined ? undefined : t(validation.errors.qualityDistinct)} onChange={value => { setDraft(current => ({ ...current, repairAgentId: value })) }} /><SelectField label={t('maxRounds')} value={draft.qualityMaxRounds} options={[['0', '0'], ['1', '1'], ['2', '2']]} onChange={value => { setDraft(current => ({ ...current, qualityMaxRounds: value as '0' | '1' | '2' })) }} /></div><TextField id="quality-criteria" label={t('criteria')} value={draft.qualityCriteria} maxLength={20_000} error={validation.errors.qualityCriteria === undefined ? undefined : t(validation.errors.qualityCriteria)} onChange={value => { setDraft(current => ({ ...current, qualityCriteria: value })) }} /></div>}</div></details>
      <details className="atg-disclosure"><summary><span><strong>{t('previewPlan')}</strong><small>{t('previewOnly')}</small></span><span aria-hidden="true">⌄</span></summary><div className="atg-disclosure-body"><TextField id="preview-task" label={t('taskForPreview')} value={previewTask} placeholder={t('taskPlaceholder')} onChange={setPreviewTask} /><button type="button" className="atg-button ghost" disabled={busy || dirty || draft.id === '' || previewTask.trim() === '' || sessionId === undefined} onClick={() => { void preview() }}>{t('previewPlan')}</button>{dirty && <small className="atg-field-hint">{t('saveBeforePreview')}</small>}{sessionId === undefined && <small className="atg-field-hint">{t('openConversationPreview')}</small>}{plan !== null && <PlanPreview plan={plan} agents={data.agents} t={t} />}</div></details>
      {draft.id !== '' && <details className="atg-disclosure"><summary><span><strong>{t('versions')}</strong><small>{versions.length}</small></span><span aria-hidden="true">⌄</span></summary><div className="atg-disclosure-body"><button type="button" className="atg-button ghost" onClick={() => { void diagnose() }}>{t('diagnose')}</button><div className="atg-version-list">{versions.map(item => <div key={item.version}><span>v{item.version} · {new Date(item.createdAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')} · {item.memberSnapshots?.length ?? 0} {t('members')}</span><button type="button" className="atg-button ghost" onClick={() => { void restore(item.version) }}>{t('restorePreview')}</button></div>)}</div>{restoreError !== '' && <div className="atg-alert" role="alert">{restoreError}</div>}{restorePreview !== null && selectedRestoreVersion !== null && <div className="atg-restore-preview"><strong>v{selectedRestoreVersion} · {t('restoreMembers', { count: restorePreview.memberSnapshots.length })}</strong>{(restorePreview.affectedSquads ?? []).length > 0 && <div className="atg-warning" role="alert">{t('restoreAffectedTeams', { names: (restorePreview.affectedSquads ?? []).map(item => item.squadName).join(', ') })}</div>}<PreviewList title={t('conflicts')} values={restorePreview.conflicts ?? []} /><pre>{JSON.stringify({ record: restorePreview.record, memberSnapshots: restorePreview.memberSnapshots }, null, 2)}</pre><div className="atg-actions"><button type="button" className="atg-button ghost" onClick={() => { setRestorePreview(null); setSelectedRestoreVersion(null) }}>{t('cancel')}</button><button type="button" className="atg-button primary" onClick={() => { void applyRestore() }}>{t('confirmRestore')}</button></div></div>}</div></details>}
      <section className="atg-form-section"><h3>{t('handoffSummaryLimit')}</h3><Field id="team-handoff-summary-limit" label={t('handoffSummaryLimit')} value={draft.handoffSummaryMaxChars} inputMode="numeric" hint={t('handoffSummaryHint')} error={validation.errors.handoffSummaryMaxChars === undefined ? undefined : t(validation.errors.handoffSummaryMaxChars)} onChange={value => { setDraft(current => ({ ...current, handoffSummaryMaxChars: value })) }} /></section>
      <EditorActions dirty={dirty} busy={busy} valid={validation.valid} t={t} discard={() => { setDraft(baseline) }} save={save} />
      </div>
    </main>
  </div>
}

function MemberWorkspace({ controller, data, draft, baseline, busy, t, setDraft, setBaseline, run, setNotice, select, remove, externalConflict, clearExternalConflict }: WorkspaceCommon & {
  draft: AgentDraft; baseline: AgentDraft; externalConflict: boolean; clearExternalConflict(): void; setDraft(value: AgentDraft | ((current: AgentDraft) => AgentDraft)): void; setBaseline(value: AgentDraft): void; select(item?: AgentView): void; remove(item: AgentView): void
}): ReactNode {
  const validation = validateAgent(draft, data.tools)
  const dirty = !structurallyEqual(draft, baseline)
  const models = data.models.find(group => group.provider === draft.provider)?.models ?? []
  const fallbackModels = data.models.find(group => group.provider === draft.fallbackProvider)?.models ?? []
  const save = async (): Promise<void> => {
    if (!validation.valid) { focusFirstError(); return }
    if (externalConflict && !window.confirm(t('remoteOverwriteConfirm'))) return
    const name = draft.name.trim()
    await run(async () => {
      let id = draft.id
      if (id === '') { const created = await controller.call<{ id: string }>('agent/create', { record: toAgentRecord(draft) }); id = created.id }
      else await controller.call('agent/update', { id, record: toAgentRecord(draft) })
      await controller.load(true)
      const stored = controller.getSnapshot().data.agents.find(item => item.id === id)
      if (stored !== undefined) { const next = agentDraftOf(stored); setDraft(next); setBaseline(next) }
      clearExternalConflict()
      setNotice(t('savedMember', { name }))
    })
  }
  return <div className="atg-workspace-shell"><aside className="atg-master" aria-label={t('memberList')}><button type="button" className="atg-button primary wide" onClick={() => { select() }}>＋ {t('newMember')}</button><div className="atg-master-list">{data.agents.map(item => <article key={item.id} className={draft.id === item.id ? 'is-active' : ''}><button className="atg-master-main" type="button" onClick={() => { select(item) }}><strong>{item.name}</strong><small>{item.provider} / {item.model}</small></button><button type="button" className="atg-icon danger" aria-label={`${t('remove')}: ${item.name}`} onClick={() => { remove(item) }}>×</button></article>)}</div>{data.agents.length === 0 && <div className="atg-empty compact">{t('noMembers')}</div>}</aside><main className="atg-editor" aria-label={t('memberEditor')}><div className="atg-editor-scroll" role="region" aria-label={t('memberEditor')} tabIndex={0}><header className="atg-editor-head"><div><strong>{draft.id === '' ? t('newMember') : draft.name}</strong><small>{draft.provider} / {draft.model}</small></div>{dirty && <span className="atg-dirty">● {t('dirtyBadge')}</span>}</header><section className="atg-form-section"><h3>{t('basic')}</h3><Field id="member-name" label={t('memberName')} value={draft.name} maxLength={120} error={validation.errors.name === undefined ? undefined : t(validation.errors.name)} onChange={value => { setDraft(current => ({ ...current, name: value })) }} /><TextField id="member-prompt" label={t('rolePrompt')} value={draft.systemPrompt} maxLength={50_000} error={validation.errors.systemPrompt === undefined ? undefined : t(validation.errors.systemPrompt)} onChange={value => { setDraft(current => ({ ...current, systemPrompt: value })) }} /><div className="atg-two"><SelectField label={t('provider')} value={draft.provider} options={data.models.map(group => [group.provider, group.name])} error={validation.errors.provider === undefined ? undefined : t(validation.errors.provider)} onChange={value => { const nextModels = data.models.find(group => group.provider === value)?.models ?? []; setDraft(current => ({ ...current, provider: value, model: nextModels[0]?.id ?? '' })) }} /><SelectField label={t('model')} value={draft.model} options={models.map(model => [model.id, model.name])} error={validation.errors.model === undefined ? undefined : t(validation.errors.model)} onChange={value => { setDraft(current => ({ ...current, model: value })) }} /></div><Field id="member-max-tokens" label={t('maxTokens')} value={draft.maxTokens} inputMode="numeric" error={validation.errors.maxTokens === undefined ? undefined : t(validation.errors.maxTokens)} onChange={value => { setDraft(current => ({ ...current, maxTokens: value })) }} /></section><details className="atg-disclosure"><summary><span><strong>{t('resilience')}</strong><small>{t('fallbackRoute')}</small></span><span aria-hidden="true">⌄</span></summary><div className="atg-disclosure-body"><div className="atg-two"><SelectField label={t('provider')} value={draft.fallbackProvider} options={[['', '—'], ...data.models.map(group => [group.provider, group.name] as [string, string])]} error={validation.errors.fallback === undefined ? undefined : t(validation.errors.fallback)} onChange={value => { const next = data.models.find(group => group.provider === value)?.models ?? []; setDraft(current => ({ ...current, fallbackProvider: value, fallbackModel: value === '' ? '' : next[0]?.id ?? '' })) }} /><SelectField label={t('model')} value={draft.fallbackModel} options={[['', '—'], ...fallbackModels.map(model => [model.id, model.name] as [string, string])]} error={validation.errors.fallback === undefined ? undefined : t(validation.errors.fallback)} onChange={value => { setDraft(current => ({ ...current, fallbackModel: value })) }} /></div></div></details><details className="atg-disclosure"><summary><span><strong>{t('permissions')}</strong><small>{t('advanced')}</small></span><span aria-hidden="true">⌄</span></summary><div className="atg-disclosure-body"><FieldError value={validation.errors.tools} t={t} /><FieldWarning value={validation.warnings.tools} t={t} /><TextField id="allow-tools" label={t('allowTools')} value={draft.allow} maxLength={51_455} onChange={value => { setDraft(current => ({ ...current, allow: value })) }} /><TextField id="deny-tools" label={t('denyTools')} value={draft.deny} maxLength={51_455} onChange={value => { setDraft(current => ({ ...current, deny: value })) }} /><div className="atg-tool-grid">{data.tools.map(tool => <div className="atg-tool-row" key={tool.name}><span><strong>{tool.name}</strong><small>{tool.description}</small></span><button type="button" className={`atg-tool-state${csvIncludes(draft.allow, tool.name) ? ' allow' : ''}`} onClick={() => { setDraft(current => ({ ...current, allow: toggleCsv(current.allow, tool.name), deny: removeCsv(current.deny, tool.name) })) }}>{t('allowTools')}</button><button type="button" className={`atg-tool-state${csvIncludes(draft.deny, tool.name) ? ' deny' : ''}`} onClick={() => { setDraft(current => ({ ...current, deny: toggleCsv(current.deny, tool.name), allow: removeCsv(current.allow, tool.name) })) }}>{t('denyTools')}</button></div>)}</div></div></details><EditorActions dirty={dirty} busy={busy} valid={validation.valid} t={t} discard={() => { setDraft(baseline) }} save={save} /></div></main></div>
}

function EditorActions({ dirty, busy, valid, t, discard, save }: {
  dirty: boolean; busy: boolean; valid: boolean; t: Translate; discard(): void; save(): Promise<void>
}): ReactNode {
  return <footer className="atg-editor-actions" role="group" aria-label={t('editorActions')}><span>{dirty ? t('unsaved') : ''}</span><button type="button" className="atg-button ghost" disabled={!dirty || busy} onClick={discard}>{t('discard')}</button><button type="button" className="atg-button primary" disabled={!dirty || busy || !valid} onClick={() => { void save() }}>{busy ? t('saving') : t('save')}</button></footer>
}

function PlanPreview({ plan, agents, t }: { plan: PlanView; agents: AgentView[]; t: Translate }): ReactNode {
  const stages = planStages(plan)
  const route = [plan.plannerProvider, plan.plannerModel].filter(Boolean).join(' / ')
  return <div className="atg-plan-preview"><header><strong>{plan.summary}</strong><span>{t(plan.decision === 'skip' ? 'planDecisionSkip' : 'planDecisionRun')}</span></header><small>{t('plannerRoute')}: {route || plan.planner}</small>{plan.reason !== undefined && <p>{plan.reason}</p>}{stages.map(stage => <div key={stage.index}><strong>{t('stage', { n: stage.index + 1 })}</strong>{stage.agentIds.map(id => <span key={id}>{agents.find(item => item.id === id)?.name ?? id}: {plan.assignments.find(item => item.agentId === id)?.task}</span>)}</div>)}<section className="atg-preview-usage"><strong>{t('plannerUsage')}: {plan.usage?.providerReported === true ? `${formatTokens(plan.usage.totalTokens)} ${t('tokens')}` : t('usageUnavailable')}</strong>{plan.usage !== undefined && <div className="atg-token-grid"><PreviewToken label={t('uncachedInput')} value={plan.usage.uncachedInputTokens} /><PreviewToken label={t('cacheRead')} value={plan.usage.cacheReadTokens} /><PreviewToken label={t('cacheWrite')} value={plan.usage.cacheWriteTokens} /><PreviewToken label={t('output')} value={plan.usage.outputTokens} /></div>}</section></div>
}

function PreviewToken({ label, value }: { label: string; value: number }): ReactNode { return <div><strong>{formatTokens(value)}</strong><small>{label}</small></div> }

function OrderEditor({ draft, agents, setDraft, t }: { draft: SquadDraft; agents: AgentView[]; setDraft(value: SquadDraft | ((current: SquadDraft) => SquadDraft)): void; t: Translate }): ReactNode {
  const order = normalizeOrder(draft.members, draft.executionOrder)
  const move = (id: string, delta: -1 | 1): void => { const next = [...order]; const from = next.indexOf(id); const to = from + delta; if (from < 0 || to < 0 || to >= next.length) return; [next[from], next[to]] = [next[to]!, next[from]!]; setDraft(current => ({ ...current, executionOrder: next })) }
  return <ol className="atg-order-list" aria-label={t('executionOrder')}>{order.map((id, index) => {
    const name = agents.find(item => item.id === id)?.name ?? id
    return <li key={id}><span className="atg-order-number">{index + 1}</span><span><strong>{name}</strong></span><span><button type="button" className="atg-icon" disabled={index === 0} aria-label={t('moveUp', { name })} onClick={() => { move(id, -1) }}>↑</button><button type="button" className="atg-icon" disabled={index === order.length - 1} aria-label={t('moveDown', { name })} onClick={() => { move(id, 1) }}>↓</button></span></li>
  })}</ol>
}

function Field({ id, label, value, placeholder, inputMode, maxLength, hint, error, onChange }: { id: string; label: string; value: string; placeholder?: string | undefined; inputMode?: 'numeric' | undefined; maxLength?: number | undefined; hint?: string | undefined; error?: string | undefined; onChange(value: string): void }): ReactNode {
  const errorId = `${id}-error`
  const limitId = `${id}-limit`
  const hintId = `${id}-hint`
  const describedBy = [error === undefined ? undefined : errorId, maxLength === undefined ? undefined : limitId, hint === undefined ? undefined : hintId].filter(Boolean).join(' ') || undefined
  return <div className={`atg-field${error === undefined ? '' : ' has-error'}`}><label htmlFor={id}>{label}</label><input id={id} value={value} placeholder={placeholder} inputMode={inputMode} maxLength={maxLength} aria-invalid={error !== undefined} aria-describedby={describedBy} onChange={event => { onChange(event.currentTarget.value) }} />{maxLength !== undefined && <small id={limitId} className="atg-field-hint">{value.length}/{maxLength}</small>}{hint !== undefined && <small id={hintId} className="atg-field-hint">{hint}</small>}{error !== undefined && <small id={errorId} className="atg-field-error">{error}</small>}</div>
}
function TextField({ id, label, value, placeholder, maxLength, error, onChange }: { id: string; label: string; value: string; placeholder?: string | undefined; maxLength?: number | undefined; error?: string | undefined; onChange(value: string): void }): ReactNode {
  const errorId = `${id}-error`
  const limitId = `${id}-limit`
  const describedBy = [error === undefined ? undefined : errorId, maxLength === undefined ? undefined : limitId].filter(Boolean).join(' ') || undefined
  return <div className={`atg-field${error === undefined ? '' : ' has-error'}`}><label htmlFor={id}>{label}</label><textarea id={id} value={value} placeholder={placeholder} maxLength={maxLength} aria-invalid={error !== undefined} aria-describedby={describedBy} onChange={event => { onChange(event.currentTarget.value) }} />{maxLength !== undefined && <small id={limitId} className="atg-field-hint">{value.length}/{maxLength}</small>}{error !== undefined && <small id={errorId} className="atg-field-error">{error}</small>}</div>
}
function SelectField({ label, value, options, disabled, error, warning, onChange }: { label: string; value: string; options: Array<[string, string]>; disabled?: boolean | undefined; error?: string | undefined; warning?: string | undefined; onChange(value: string): void }): ReactNode {
  return <label className={`atg-field${error === undefined ? '' : ' has-error'}`}><span>{label}</span><select value={value} disabled={disabled} aria-invalid={error !== undefined} onChange={event => { onChange(event.currentTarget.value) }}>{options.map(option => <option key={option[0]} value={option[0]}>{option[1]}</option>)}</select>{error !== undefined && <small className="atg-field-error">{error}</small>}{warning !== undefined && <small className="atg-field-warning">{warning}</small>}</label>
}
function FieldError({ value, t }: { value?: MessageKey | undefined; t: Translate }): ReactNode { return value === undefined ? null : <small className="atg-field-error" role="alert">{t(value)}</small> }
function FieldWarning({ value, t }: { value?: MessageKey | undefined; t: Translate }): ReactNode { return value === undefined ? null : <small className="atg-field-warning" role="status">{t(value)}</small> }
function PreviewList({ title, values }: { title: string; values: unknown[] }): ReactNode { return values.length === 0 ? null : <div className="atg-preview-list"><strong>{title}</strong>{values.map((value, index) => <span key={index}>{typeof value === 'string' ? value : JSON.stringify(value)}</span>)}</div> }

function isSquadRestorePreview(value: unknown): value is SquadRestorePreview {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.definitionRevision === 'number' && Number.isSafeInteger(record.definitionRevision) && record.definitionRevision >= 0
    && typeof record.squadId === 'string' && typeof record.version === 'number' && Number.isSafeInteger(record.version) && record.version > 0
    && typeof record.record === 'object' && record.record !== null && !Array.isArray(record.record)
    && Array.isArray(record.memberSnapshots)
    && Array.isArray(record.conflicts) && record.conflicts.every(isRestoreConflict)
    && Array.isArray(record.affectedSquads) && record.affectedSquads.every(isRestoreAffectedSquad)
}

function isRestoreConflict(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.agentId === 'string' && typeof record.currentName === 'string' && typeof record.restoredName === 'string'
}

function isRestoreAffectedSquad(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.squadId === 'string' && typeof record.squadName === 'string'
    && Array.isArray(record.agentIds) && record.agentIds.every(agentId => typeof agentId === 'string')
}

function isStaleRestorePreviewFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return /stale restore preview/i.test(message)
}

function isDiagnosis(value: unknown): value is { ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.ok === 'boolean' && Array.isArray(record.checks) && record.checks.every(check => {
    if (typeof check !== 'object' || check === null || Array.isArray(check)) return false
    const item = check as Record<string, unknown>
    return typeof item.name === 'string' && typeof item.ok === 'boolean' && typeof item.message === 'string'
  })
}

function selectedOptions(agents: AgentView[], members: string[]): Array<[string, string]> { return [['', '—'], ...agents.filter(item => members.includes(item.id)).map(item => [item.id, item.name] as [string, string])] }
function initials(name: string): string { return name.trim().split(/\s+/).slice(0, 2).map(item => item[0]?.toUpperCase() ?? '').join('') || 'A' }
function csvIncludes(value: string, item: string): boolean { return value.split(',').map(part => part.trim()).includes(item) }
function toggleCsv(value: string, item: string): string { const items = value.split(',').map(part => part.trim()).filter(Boolean); return (items.includes(item) ? items.filter(value => value !== item) : [...items, item]).join(', ') }
function removeCsv(value: string, item: string): string { return value.split(',').map(part => part.trim()).filter(value => value !== '' && value !== item).join(', ') }
function focusFirstError(): void { requestAnimationFrame(() => { document.querySelector<HTMLElement>('.atg-editor [aria-invalid="true"]')?.focus() }) }

function useDirtyGuard(root: React.RefObject<HTMLDivElement>, dirty: boolean, close: (() => void) | undefined, t: Translate): void {
  const bypass = useRef(false)
  useEffect(() => {
    if (!dirty || close === undefined) return
    const guardClick = (event: MouseEvent): void => {
      if (bypass.current || !(event.target instanceof Node) || root.current?.contains(event.target) === true) return
      const dialog = root.current?.closest('[role="dialog"]')
      if (dialog === null || dialog === undefined) return
      if (window.confirm(t('unsavedConfirm'))) { bypass.current = true; return }
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
    }
    const guardEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || bypass.current) return
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
      if (window.confirm(t('unsavedConfirm'))) { bypass.current = true; close() }
    }
    document.addEventListener('click', guardClick, true)
    document.addEventListener('keydown', guardEscape, true)
    return () => { document.removeEventListener('click', guardClick, true); document.removeEventListener('keydown', guardEscape, true) }
  }, [close, dirty, root, t])
}
