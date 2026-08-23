import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InsightsBucket, InsightsView, QualityMemberView, QualityResultView, RunMemberStatus, RunView, TokenUsageView } from './contracts.ts'
import { EMPTY_USAGE } from './contracts.ts'
import { AgentTeamController, errorText } from './controller.ts'
import { useI18n, type Translate } from './i18n.ts'
import { RunPollStore } from './run-store.ts'
import {
  completionRate, describeBucket, downloadJson, formatDuration, formatTokens, isLive, planStages, statusKey,
  tokenSummary, usageShare, visibleRunFilter,
} from './view-models.ts'
import { handleTabKey } from './tab-keyboard.ts'
import { SlotErrorBoundary } from './SlotErrorBoundary.tsx'

export interface TeamRunInjected { controller: AgentTeamController }
export type TeamRunCenterProps = PropsRuntime<'conversation.view'> & InjectFace<TeamRunInjected>
export type TeamRunDockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<TeamRunInjected>

function useRunStore(controller: AgentTeamController, sessionId: string, limit: number): { store: RunPollStore; snapshot: ReturnType<RunPollStore['getSnapshot']> } {
  const store = useMemo(() => new RunPollStore(controller.runs, sessionId, limit), [controller, limit, sessionId])
  return { store, snapshot: useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) }
}

/** Run history, DAG stages, usage, retry, export, clearing, and aggregate insights. */
export function TeamRunCenter(props: TeamRunCenterProps): ReactNode {
  return <SlotErrorBoundary controller={props.controller} testId="agent-team-run-center"><TeamRunCenterContent {...props} /></SlotErrorBoundary>
}

function TeamRunCenterContent({ controller, sessionId }: TeamRunCenterProps): ReactNode {
  const { active, t } = useI18n(controller.i18n)
  const { store, snapshot } = useRunStore(controller, sessionId, 50)
  const [view, setView] = useState<'runs' | 'insights'>('runs')
  const [filter, setFilter] = useState<'all' | 'live' | 'attention' | 'done'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [insights, setInsights] = useState<InsightsView | null>(null)
  const [insightsError, setInsightsError] = useState('')
  const [range, setRange] = useState<'7d' | '30d' | 'all'>('30d')

  useEffect(() => {
    if (view !== 'insights') return
    let active = true
    const since = range === 'all' ? undefined : Date.now() - (range === '7d' ? 7 : 30) * 86_400_000
    void controller.runs.insights(sessionId, since).then(value => { if (active) { setInsights(value); setInsightsError('') } }, reason => { if (active) setInsightsError(errorText(reason)) })
    return () => { active = false }
  }, [controller, range, sessionId, snapshot.revision, view])

  useEffect(() => {
    if (expanded === null || snapshot.status !== 'ready' || snapshot.runs.some(run => run.id === expanded)) return
    setExpanded(null)
    store.watchDetail(null)
    setActionError(t('runGone'))
  }, [expanded, snapshot.runs, snapshot.status, store, t])

  const act = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key); setActionError('')
    try { await action(); store.refresh() } catch (reason) { setActionError(errorText(reason)) } finally { setBusy(null) }
  }

  const retryRun = (id: string, agentId?: string): void => { void act(`retry:${id}:${agentId ?? ''}`, () => controller.runs.retry(id, agentId)) }
  const cancelRun = (id: string): void => { void act(`cancel:${id}`, () => controller.runs.cancel(id)) }
  const exportRun = (id: string): void => { void act(`export:${id}`, async () => downloadJson(await controller.runs.export(id), `agent-team-run-${id}.json`)) }
  const clear = (): void => {
    if (!window.confirm(t('clearConfirm'))) return
    void act('clear', () => controller.runs.clear(sessionId))
  }

  const toggleRun = (run: RunView): void => {
    if (expanded === run.id) { setExpanded(null); store.watchDetail(null); return }
    setExpanded(run.id)
    store.watchDetail(run.id)
    void controller.runs.get(run.id).then(({ run: detail }) => {
      if (detail === null) {
        setExpanded(null); store.watchDetail(null); setActionError(t('runGone')); store.refresh(); return
      }
      store.replaceRun(detail)
    }, reason => { setActionError(errorText(reason)) })
  }

  const filtered = snapshot.runs.filter(run => visibleRunFilter(run, filter))
  return <div className="atg-run-center" data-testid="agent-team-run-center">
    <header className="atg-run-header"><div><h2>{t('runs')}</h2><p>{t('runIntro')}</p></div><div className="atg-toolbar"><button className="atg-button ghost" type="button" onClick={() => { store.refresh() }}>↻ {t('refresh')}</button><button className="atg-button ghost" type="button" disabled={busy !== null} onClick={clear}>{t('clearHistory')}</button></div></header>
    <nav className="atg-tabs" role="tablist" aria-label={t('runs')} onKeyDown={handleTabKey}><button type="button" id="agent-team-runs-tab" role="tab" tabIndex={view === 'runs' ? 0 : -1} aria-selected={view === 'runs'} aria-controls="agent-team-runs-panel" onClick={() => { setView('runs') }}>{t('runs')}</button><button type="button" id="agent-team-insights-tab" role="tab" tabIndex={view === 'insights' ? 0 : -1} aria-selected={view === 'insights'} aria-controls="agent-team-insights-panel" onClick={() => { setView('insights') }}>{t('insights')}</button></nav>
    {(snapshot.error !== '' || actionError !== '') && <div className="atg-recovery" role="alert"><strong>{t('connectionError')}</strong><span>{snapshot.error || actionError}</span><button type="button" className="atg-button ghost" onClick={() => { store.refresh() }}>{t('retry')}</button></div>}
    {view === 'insights' ? <div id="agent-team-insights-panel" role="tabpanel" aria-labelledby="agent-team-insights-tab"><InsightsPanel insights={insights} error={insightsError} runs={snapshot.runs} range={range} setRange={setRange} t={t} /></div> : <div id="agent-team-runs-panel" role="tabpanel" aria-labelledby="agent-team-runs-tab">
      <div className="atg-run-filters" role="group" aria-label={t('filterAll')}>
        {(['all', 'live', 'attention', 'done'] as const).map(value => <button type="button" key={value} className={filter === value ? 'is-active' : ''} aria-pressed={filter === value} onClick={() => { setFilter(value) }}>{t(value === 'all' ? 'filterAll' : value === 'live' ? 'filterLive' : value === 'attention' ? 'filterFailed' : 'filterDone')}</button>)}
      </div>
      {snapshot.status === 'loading' && <div className="atg-loading">{t('loading')}</div>}
      {snapshot.runs.length === 0 && snapshot.status !== 'loading' && <Empty title={t('noRuns')} />}
      <div className="atg-run-list">{filtered.map(run => <RunCard key={run.id} run={run} open={expanded === run.id} busy={busy} locale={active} t={t} onToggle={() => { toggleRun(run) }} onCancel={cancelRun} onRetry={retryRun} onExport={exportRun} />)}</div>
    </div>}
  </div>
}

function RunCard({ run, open, busy, locale, t, onToggle, onCancel, onRetry, onExport }: { run: RunView; open: boolean; busy: string | null; locale: string; t: Translate; onToggle(): void; onCancel(id: string): void; onRetry(id: string, agentId?: string): void; onExport(id: string): void }): ReactNode {
  const completed = run.members.filter(member => member.status === 'completed').length
  const stages = planStages(run.plan)
  const plannerUsage = run.plan?.usage ?? run.liveUsage?.planner
  const reviewUsage = run.quality === undefined ? run.liveUsage?.review : undefined
  const repairUsage = run.quality === undefined ? run.liveUsage?.repair : undefined
  const displayUsage = usageWithLive(run)
  const coverage = runUsageCoverage(run)
  return <article className={`atg-run-card status-${run.status}`} data-run-id={run.id}>
    <button type="button" className="atg-run-summary" aria-expanded={open} onClick={onToggle}>
      <span className={`atg-status-dot status-${run.status}`} /><span className="atg-run-title"><strong>{run.squadName}</strong><small>{truncate(run.task, 90)}</small></span><span className="atg-run-metric"><strong>{completed}/{run.members.length}</strong><small>{t('members')}</small></span><span className="atg-run-metric"><strong>{displayUsage.providerReported ? formatTokens(displayUsage.totalTokens) : (isLive(run.status) ? t('metering') : '—')}</strong><small>{t('tokens')}{coverage.partial > 0 ? ` · ${t('partialMetering')}` : ''}</small></span><span className="atg-run-time">{formatDuration(run.startedAt, run.endedAt)}</span><span className={`atg-status-label status-${run.status}`}>{t(statusKey(run.status))}</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
    </button>
    {open && <div className="atg-run-detail">
      {run.error !== undefined && run.error !== '' && <div className="atg-alert" role="alert">{run.error}</div>}
      <div className="atg-run-meta"><span>{run.executionMode === 'parallel' ? t('parallel') : t('serial')}</span><span>{run.contextMode === 'spawn' ? t('spawn') : run.contextMode === 'fork' ? t('fork') : t('chain')}</span>{run.phase !== undefined && <span>{runPhaseLabel(run.phase, t)}</span>}<span>{new Date(run.startedAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')}</span>{run.retryOf !== undefined && <span>{t('retryOf', { id: run.retryOf })}</span>}</div>
      {run.plan !== undefined && <section className={`atg-plan${run.plan.warning === undefined ? '' : ' has-warning'}`}><header><strong>{t('plan')}</strong><span>{t(run.plan.decision === 'skip' ? 'planDecisionSkip' : 'planDecisionRun')}</span></header><p>{run.plan.summary}</p>{run.plan.reason !== undefined && <small>{run.plan.reason}</small>}{run.plan.warning !== undefined && <div className="atg-warning">{run.plan.warning}</div>}</section>}
      {stages.length > 0 && <section className="atg-stages" aria-label={t('dependencyStages')}><h3>{t('dependencyStages')}</h3><div className="atg-stage-scroll" role="region" tabIndex={0} aria-label={t('dependencyStagesScroll', { count: stages.length })}>{stages.map(stage => <div className="atg-stage" key={stage.index}><span>{t('stage', { n: stage.index + 1 })}</span><div>{stage.agentIds.map(id => { const member = run.members.find(item => item.agentId === id); const assignment = run.plan?.assignments.find(item => item.agentId === id); return <article key={id}><span className={`atg-status-dot status-${member?.status ?? 'pending'}`} /><strong>{member?.agentName ?? id}</strong><small>{assignment?.task ?? ''}</small></article> })}</div></div>)}</div></section>}
      {run.qualityProgress !== undefined && <QualityProgress run={run} t={t} />}
      <UsagePanel usage={displayUsage} members={run.members} live={isLive(run.status)} coverage={coverage} {...(plannerUsage === undefined ? {} : { plannerUsage })} {...(reviewUsage === undefined ? {} : { reviewUsage })} {...(repairUsage === undefined ? {} : { repairUsage })} {...(run.quality === undefined ? {} : { quality: run.quality })} t={t} />
      {run.members.some(member => member.status === 'completed' && member.stopReason === 'error') && <div className="atg-warning" role="status">{t('protocolDeliveryWarning')}</div>}
      <section className="atg-run-members" aria-label={t('members')}>{run.members.map(member => <details key={`${member.agentId}:${member.phase ?? 'member'}`} className={`atg-run-member status-${member.status}`}><summary><span className={`atg-status-dot status-${member.status}`} /><span><strong>{member.agentName}</strong><small>{member.provider} / {member.model}{member.phase !== undefined ? ` · ${t(member.phase === 'quality' ? 'phaseQuality' : member.phase === 'repair' ? 'phaseRepair' : 'phaseMember')}` : ''}</small></span><span>{memberStatusLabel(member.status, t)}</span><span>{member.usage === undefined ? (member.status === 'running' ? t('metering') : '—') : `${formatTokens(member.usage.totalTokens)} ${t('tokens')}`}</span><span>{[member.attempts > 1 ? `×${member.attempts}` : '', member.usageSamples === undefined ? '' : t('sampleCoverage', member.usageSamples)].filter(Boolean).join(' · ')}</span></summary><div className="atg-member-output">{member.error !== undefined && <div className="atg-alert">{member.error}</div>}<pre>{member.output.map(block => block.text ?? '').filter(Boolean).join('\n') || '—'}</pre><div className="atg-member-actions"><button type="button" className="atg-button ghost" disabled={busy !== null || isLive(run.status)} onClick={() => { onRetry(run.id, member.agentId) }}>{t('retryMember')}</button></div></div></details>)}</section>
      {run.quality !== undefined && <QualityTimeline quality={run.quality} t={t} />}
      <div className="atg-synthesis"><span aria-hidden="true">◆</span><div><strong>{t('handoffToLead')}</strong><small>{isLive(run.status) || run.phase === 'synthesis' ? t('handoffWaiting') : run.status === 'completed' || run.status === 'partial' ? t('handoffReady') : t(statusKey(run.status))}</small></div></div>
      <div className="atg-actions">{isLive(run.status) && <button type="button" className="atg-button danger" disabled={busy !== null} onClick={() => { onCancel(run.id) }}>{t('stopRun')}</button>}<button type="button" className="atg-button ghost" disabled={busy !== null || isLive(run.status)} onClick={() => { onRetry(run.id) }}>{t('retryRun')}</button><button type="button" className="atg-button ghost" disabled={busy !== null} onClick={() => { onExport(run.id) }}>{t('exportRun')}</button></div>
    </div>}
  </article>
}

function QualityProgress({ run, t }: { run: RunView; t: Translate }): ReactNode {
  const progress = run.qualityProgress
  if (progress === undefined) return null
  const activeId = progress.state === 'reviewing' ? progress.reviewerAgentId : progress.repairAgentId
  const activeName = run.members.find(member => member.agentId === activeId)?.agentName ?? activeId
  return <section className="atg-quality-progress" role="status" aria-live="polite"><span className="atg-live-pulse" /><div><strong>{t(progress.state === 'reviewing' ? 'phaseQualityReview' : 'phaseQualityRepair')}</strong><small>{t('qualityRoundProgress', { round: progress.round, max: progress.totalReviews })} · {activeName}</small></div></section>
}

function UsagePanel({ usage, plannerUsage, memberUsage, reviewUsage, repairUsage, members = [], quality, live = false, coverage, t }: { usage: TokenUsageView; plannerUsage?: TokenUsageView; memberUsage?: TokenUsageView; reviewUsage?: TokenUsageView; repairUsage?: TokenUsageView; members?: RunView['members']; quality?: QualityResultView; live?: boolean; coverage?: MeteringCoverage; t: Translate }): ReactNode {
  const derivedMemberUsage = memberUsage ?? reportedAggregate(members.map(member => member.usage))
  const derivedReviewUsage = reviewUsage ?? reportedAggregate(quality?.rounds.map(round => round.reviewer.usage) ?? [])
  const derivedRepairUsage = repairUsage ?? reportedAggregate(quality?.rounds.map(round => round.repair?.usage) ?? [])
  const totalKnown = usage.providerReported
  const partial = coverage !== undefined && (coverage.partial > 0 || (coverage.metered > 0 && coverage.metered < coverage.total))
  const pending = live ? t('metering') : '—'
  const hasAttribution = members.length > 0 || quality !== undefined || plannerUsage !== undefined || memberUsage !== undefined || reviewUsage !== undefined || repairUsage !== undefined
  return <section className="atg-usage" aria-label={t('tokenUsage')}><header><div><strong>{t('tokenUsage')}</strong><small>{totalKnown ? `${tokenSummary(usage, t)}${partial ? ` · ${t('partialMetering')}` : ''}` : (live ? t('metering') : t('usageUnavailable'))}</small></div><strong>{totalKnown ? formatTokens(usage.totalTokens) : pending}</strong></header><div className="atg-token-grid"><TokenCell label={t('uncachedInput')} value={totalKnown ? usage.uncachedInputTokens : pending} /><TokenCell label={t('cacheRead')} value={totalKnown ? usage.cacheReadTokens : pending} /><TokenCell label={t('cacheWrite')} value={totalKnown ? usage.cacheWriteTokens : pending} /><TokenCell label={t('output')} value={totalKnown ? usage.outputTokens : pending} /></div>{hasAttribution && <div className="atg-usage-attribution"><TokenCell label={t('plannerUsage')} value={usageValue(plannerUsage, pending)} /><TokenCell label={t('memberUsage')} value={usageValue(derivedMemberUsage, pending)} /><TokenCell label={t('qualityUsage')} value={usageValue(derivedReviewUsage, pending)} /><TokenCell label={t('repairUsage')} value={usageValue(derivedRepairUsage, pending)} /></div>}<p>{t('tokenDisclaimer')}</p></section>
}

function QualityTimeline({ quality, t }: { quality: QualityResultView; t: Translate }): ReactNode {
  return <section className={`atg-quality-timeline${quality.approved ? ' is-approved' : ' is-rejected'}`} aria-label={t('qualityLoop')}><header><strong>{t('qualityLoop')}</strong><span>{quality.approved ? t('statusCompleted') : t('statusFailed')}</span></header>{quality.rounds.map(round => <article key={round.round}><div className="atg-quality-round"><span>{t('stage', { n: round.round })}</span><strong>{round.approved ? t('statusCompleted') : t('statusFailed')}</strong></div><p>{round.feedback}</p><QualityResult result={round.reviewer} label={t('phaseQuality')} t={t} />{round.repair !== undefined && <QualityResult result={round.repair} label={t('phaseRepair')} t={t} />}</article>)}</section>
}

function QualityResult({ result, label, t }: { result: QualityMemberView; label: string; t: Translate }): ReactNode {
  return <details className="atg-quality-result"><summary><span className={`atg-status-dot status-${result.status}`} /><strong>{label}: {result.agentName}</strong><span>{result.usage === undefined ? '—' : `${formatTokens(result.usage.totalTokens)} ${t('tokens')}`}</span></summary><div>{result.error !== undefined && <div className="atg-alert">{result.error}</div>}<pre>{result.output.map(block => block.text ?? '').filter(Boolean).join('\n') || '—'}</pre></div></details>
}

function InsightsPanel({ insights, error, runs, range, setRange, t }: { insights: InsightsView | null; error: string; runs: RunView[]; range: '7d' | '30d' | 'all'; setRange(value: '7d' | '30d' | 'all'): void; t: Translate }): ReactNode {
  if (error !== '') return <div className="atg-alert" role="alert">{error}</div>
  const fallbackTotals = runs.reduce<TokenUsageView>((sum, run) => ({
    uncachedInputTokens: sum.uncachedInputTokens + run.usage.uncachedInputTokens,
    outputTokens: sum.outputTokens + run.usage.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + run.usage.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + run.usage.cacheWriteTokens,
    totalTokens: sum.totalTokens + run.usage.totalTokens,
    providerReported: false,
  }), { ...EMPTY_USAGE })
  const fallbackUsage = { ...fallbackTotals, providerReported: runs.some(run => run.usage.providerReported) }
  const usage = insights?.usage ?? fallbackUsage
  const count = insights?.runCount ?? runs.length
  const fallbackCoverage = runs.map(run => run.meteringCoverage ?? (run.usage.providerReported ? 'full' : 'none'))
  const fullyMetered = insights?.fullyMeteredRuns ?? fallbackCoverage.filter(value => value === 'full').length
  const partiallyMetered = insights?.partiallyMeteredRuns ?? fallbackCoverage.filter(value => value === 'partial').length
  const metered = insights?.meteredRuns ?? fullyMetered + partiallyMetered
  const unmetered = insights?.unmeteredRuns ?? Math.max(0, count - metered)
  const statuses = insights?.statuses
  const settledEligible = new Set(['completed', 'partial', 'failed', 'interrupted'])
  const eligible = statuses === undefined ? undefined : Object.entries(statuses).filter(([status]) => settledEligible.has(status)).reduce((sum, [, value]) => sum + (value ?? 0), 0)
  const rate = eligible === undefined ? completionRate(runs) : eligible === 0 ? null : (statuses?.completed ?? 0) / eligible
  return <div className="atg-insights" data-testid="agent-team-insights">
    <div className="atg-range" role="group" aria-label={t('insights')}>{(['7d', '30d', 'all'] as const).map(value => <button type="button" key={value} className={range === value ? 'is-active' : ''} aria-pressed={range === value} onClick={() => { setRange(value) }}>{t(value === '7d' ? 'last7Days' : value === '30d' ? 'last30Days' : 'allTime')}</button>)}</div>
    <div className="atg-insight-kpis"><div><strong>{count}</strong><small>{t('runCount')}</small></div><div><strong>{rate === null ? '—' : `${Math.round(rate * 100)}%`}</strong><small>{t('successRate')}</small></div><div><strong>{usage.providerReported ? `${Math.round(usageShare(usage) * 100)}%` : '—'}</strong><small>{t('cacheRate')}</small></div><div><strong>{usage.providerReported ? formatTokens(usage.totalTokens) : '—'}</strong><small>{t('totalUsage')}</small></div></div>
    <UsagePanel usage={usage} coverage={{ metered, total: metered + unmetered, full: fullyMetered, partial: partiallyMetered }} {...(insights === null ? {} : { plannerUsage: insights.plannerUsage, memberUsage: insights.memberUsage, reviewUsage: insights.reviewUsage, repairUsage: insights.repairUsage })} t={t} />
    <p className="atg-metering-coverage">{t('meteringCoverage', { metered, total: metered + unmetered })} {t('meteringCoverageDetailed', { full: fullyMetered, partial: partiallyMetered, none: unmetered })}</p>
    <div className="atg-insight-groups"><InsightGroup title={t('byTeam')} rows={insights?.bySquad ?? []} t={t} /><InsightGroup title={t('members')} rows={insights?.byAgent ?? []} t={t} /><InsightGroup title={t('byModel')} rows={insights?.byModel ?? []} t={t} /><InsightGroup title={t('byProject')} rows={insights?.byProject ?? []} t={t} /></div>
  </div>
}

function InsightGroup({ title, rows, t }: { title: string; rows: InsightsBucket[]; t: Translate }): ReactNode {
  return <section><h3>{title}</h3>{rows.length === 0 ? <span>—</span> : rows.slice(0, 8).map((row, index) => {
    const metered = row.meteredSamples ?? 0
    const total = metered + (row.unmeteredSamples ?? 0)
    const measured = row.usage?.providerReported === true || metered > 0
    return <div key={`${describeBucket(row)}:${index}`}><strong>{describeBucket(row)}</strong><span>{row.runCount ?? 0}</span><small>{measured ? formatTokens(row.usage?.totalTokens ?? 0) : '—'}{total > 0 ? ` · ${t('sampleCoverage', { metered, total })}` : ''}</small></div>
  })}</section>
}

function TokenCell({ label, value }: { label: string; value: number | string }): ReactNode { return <div><strong>{typeof value === 'number' ? formatTokens(value) : value}</strong><small>{label}</small></div> }
function usageValue(usage: TokenUsageView | undefined, pending: string): number | string {
  if (usage === undefined) return pending
  if (usage.providerReported) return usage.totalTokens
  return usage.totalTokens > 0 ? `${formatTokens(usage.totalTokens)}+` : pending
}
interface MeteringCoverage { metered: number; total: number; full: number; partial: number }
function runUsageCoverage(run: RunView): MeteringCoverage {
  if (run.meteringCoverage === 'full') return { metered: 1, total: 1, full: 1, partial: 0 }
  if (run.meteringCoverage === 'partial') return { metered: 1, total: 1, full: 0, partial: 1 }
  if (run.meteringCoverage === 'none') return { metered: 0, total: 1, full: 0, partial: 0 }
  const samples: Array<TokenUsageView | undefined> = []
  if (run.plan !== undefined) samples.push(run.plan.usage ?? run.liveUsage?.planner)
  samples.push(...run.members.map(member => member.usage))
  for (const round of run.quality?.rounds ?? []) {
    samples.push(round.reviewer.usage)
    if (round.repair !== undefined) samples.push(round.repair.usage)
  }
  if (run.quality === undefined && run.liveUsage?.review !== undefined) samples.push(run.liveUsage.review)
  if (run.quality === undefined && run.liveUsage?.repair !== undefined) samples.push(run.liveUsage.repair)
  if (samples.length === 0) return { metered: run.usage.providerReported ? 1 : 0, total: 1, full: run.usage.providerReported ? 1 : 0, partial: 0 }
  const metered = samples.filter(sample => sample?.providerReported === true).length
  return { metered, total: samples.length, full: metered === samples.length ? 1 : 0, partial: metered > 0 && metered < samples.length ? 1 : 0 }
}
function reportedAggregate(values: Array<TokenUsageView | undefined>): TokenUsageView | undefined {
  const reported = values.filter((value): value is TokenUsageView => value?.providerReported === true)
  if (reported.length === 0) return undefined
  return reported.reduce<TokenUsageView>((sum, value) => ({
    uncachedInputTokens: sum.uncachedInputTokens + value.uncachedInputTokens,
    outputTokens: sum.outputTokens + value.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + value.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + value.cacheWriteTokens,
    totalTokens: sum.totalTokens + value.totalTokens,
    providerReported: true,
  }), { ...EMPTY_USAGE, providerReported: true })
}
function usageWithLive(run: RunView): TokenUsageView {
  const values = [run.usage, run.liveUsage?.planner, run.liveUsage?.review, run.liveUsage?.repair].filter((value): value is TokenUsageView => value !== undefined)
  return values.reduce<TokenUsageView>((sum, value) => ({
    uncachedInputTokens: sum.uncachedInputTokens + value.uncachedInputTokens,
    outputTokens: sum.outputTokens + value.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + value.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + value.cacheWriteTokens,
    totalTokens: sum.totalTokens + value.totalTokens,
    providerReported: sum.providerReported || value.providerReported,
  }), { ...EMPTY_USAGE })
}
function Empty({ title }: { title: string }): ReactNode { return <div className="atg-empty"><span aria-hidden="true">◇</span><strong>{title}</strong></div> }
function truncate(value: string, length: number): string { return value.length <= length ? value : `${value.slice(0, length - 1)}…` }
function memberStatusLabel(status: RunMemberStatus, t: Translate): string {
  if (status === 'pending') return t('statusPending')
  if (status === 'timed-out') return t('statusTimedOut')
  return t(statusKey(status === 'interrupted' ? 'interrupted' : status as Exclude<RunMemberStatus, 'pending' | 'timed-out'>))
}

function runPhaseLabel(phase: NonNullable<RunView['phase']>, t: Translate): string {
  const keys = {
    queued: 'phaseQueued', planning: 'phasePlanning', members: 'phaseMembers',
    'quality-review': 'phaseQualityReview', 'quality-repair': 'phaseQualityRepair',
    synthesis: 'phaseSynthesis', settled: 'phaseSettled',
  } as const
  return t(keys[phase])
}

/** Compact live progress control with keyboard-accessible inline actions. */
export function TeamRunDock(props: TeamRunDockProps): ReactNode {
  return <SlotErrorBoundary controller={props.controller} testId="agent-team-run-dock"><TeamRunDockContent {...props} /></SlotErrorBoundary>
}

function TeamRunDockContent({ controller, sessionId }: TeamRunDockProps): ReactNode {
  const { t } = useI18n(controller.i18n)
  const { store, snapshot } = useRunStore(controller, sessionId, 3)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const live = snapshot.runs.find(run => isLive(run.status))
  if (live === undefined) return null
  const done = live.members.filter(member => member.status === 'completed' || member.status === 'failed' || member.status === 'cancelled' || member.status === 'interrupted' || member.status === 'timed-out').length
  const displayUsage = usageWithLive(live)
  const coverage = runUsageCoverage(live)
  const stop = async (): Promise<void> => {
    try { await controller.runs.cancel(live.id); store.refresh() } catch (reason) { setError(errorText(reason)) }
  }
  return <div className="atg-run-dock-wrap"><button type="button" className="atg-run-dock" aria-expanded={open} onClick={() => { setOpen(value => !value) }}><span className="atg-live-pulse" /><strong>{live.squadName}</strong><span>{live.status === 'planning' ? t('statusPlanning') : `${done}/${live.members.length} ${t('members')}`}</span><span>{displayUsage.providerReported ? `${formatTokens(displayUsage.totalTokens)} ${t('tokens')}${coverage.partial > 0 ? ` · ${t('partialMetering')}` : ''}` : t('metering')}</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span></button>{open && <div className="atg-dock-panel" role="status"><span>{truncate(live.task, 120)}</span>{error !== '' && <small role="alert">{error}</small>}<div><button type="button" className="atg-button ghost" onClick={openRunCenter}>{t('viewRun')}</button><button type="button" className="atg-button danger" onClick={() => { void stop() }}>{t('stopRun')}</button></div></div>}</div>
}

/** DSH has no public imperative conversation-view selection service yet; use the host's semantic tab. */
export function openRunCenter(): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => ['小队运行', 'Team runs'].includes(item.textContent?.trim() ?? ''))
  button?.click()
}
