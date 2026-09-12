import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ModeResponse, NextOverride, RunView } from './contracts.ts'
import { AgentTeamController, errorText, isAuthoritativeModeResponse } from './controller.ts'
import { useI18n } from './i18n.ts'
import { formatDuration, formatTokens, statusKey } from './view-models.ts'
import { SlotErrorBoundary } from './SlotErrorBoundary.tsx'

export interface TeamComposerInjected {
  controller: AgentTeamController
}
export type TeamComposerControlProps = PropsRuntime<'conversation.input.right'> & InjectFace<TeamComposerInjected>

interface ModeState {
  initialized: boolean
  busy: boolean
  selected: string
  override: 'enabled' | 'disabled' | 'inherit'
  effective: ModeResponse['mode']
  next: NextOverride
  projectKey: string | null
  projectDefault: string | null
  error: string
}

const INITIAL_MODE: ModeState = {
  initialized: false, busy: false, selected: '', override: 'inherit', effective: null, next: null,
  projectKey: null, projectDefault: null, error: '',
}

interface ModePanelPlacement {
  side: 'above' | 'below'
  maxHeight: number
}

const PANEL_VIEWPORT_MARGIN = 12
const PANEL_TRIGGER_GAP = 6

/** Accessible, native-style mode entry. The panel exposes every durable and one-shot state. */
export function TeamComposerControl(props: TeamComposerControlProps): ReactNode {
  return <SlotErrorBoundary controller={props.controller} testId="agent-team-composer"><TeamComposerControlContent {...props} /></SlotErrorBoundary>
}

function TeamComposerControlContent({ controller, sessionId, useInput }: TeamComposerControlProps): ReactNode {
  const { t } = useI18n(controller.i18n)
  const catalog = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [state, setState] = useState<ModeState>(INITIAL_MODE)
  const [open, setOpen] = useState(false)
  const [panelPlacement, setPanelPlacement] = useState<ModePanelPlacement>({ side: 'above', maxHeight: 320 })
  const [lastRun, setLastRun] = useState<RunView | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const requestRef = useRef(0)
  const panelId = useId()

  useEffect(() => { void controller.load().catch(() => undefined) }, [controller])

  useEffect(() => {
    if (catalog.status !== 'ready') {
      setState(current => ({ ...current, initialized: false, busy: false }))
      return
    }
    const request = ++requestRef.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const retryDelays = [100, 300, 1_000, 2_000, 5_000, 10_000, 30_000] as const
    setState(current => ({ ...current, busy: true, error: '' }))
    const read = (attempt: number): void => {
      void controller.modes.get(sessionId).then(response => {
        if (request !== requestRef.current) return
        const authoritative = isAuthoritativeModeResponse(response)
        setState(current => ({
          ...current,
          initialized: true,
          busy: false,
          ...(authoritative ? {
            override: response.sessionOverride ?? (response.mode === null ? 'disabled' : 'enabled'),
            effective: response.mode,
            selected: response.mode?.squadId
              ?? response.projectDefault?.squadId
              ?? (typeof response.nextOverride === 'object' && response.nextOverride !== null ? response.nextOverride.squadId : undefined)
              ?? current.selected,
          } : {}),
          next: response.nextOverride ?? null,
          projectKey: response.projectKey ?? null,
          projectDefault: response.projectDefault?.squadId ?? null,
          error: '',
        }))
        if (!authoritative) timer = setTimeout(() => { read(Math.min(attempt + 1, retryDelays.length - 1)) }, retryDelays[Math.min(attempt, retryDelays.length - 1)])
      }, reason => {
        if (request !== requestRef.current) return
        setState(current => ({ ...current, initialized: true, busy: false, error: errorText(reason) }))
        timer = setTimeout(() => { read(Math.min(attempt + 1, retryDelays.length - 1)) }, retryDelays[Math.min(attempt, retryDelays.length - 1)])
      })
    }
    read(0)
    return () => { requestRef.current += 1; if (timer !== undefined) clearTimeout(timer) }
  }, [catalog.revision, catalog.status, controller, sessionId, t])

  useEffect(() => {
    if (catalog.status !== 'ready') return
    if (catalog.data.squads.length === 0) {
      setState(current => current.selected === '' && current.effective !== null
        ? { ...current, selected: current.effective.squadId }
        : current)
      return
    }
    const first = catalog.data.squads[0]?.id ?? ''
    setState(current => {
      if (current.selected !== '' && catalog.data.squads.some(item => item.id === current.selected)) return current
      return { ...current, selected: first }
    })
  }, [catalog.data.squads, catalog.status])

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => { panelRef.current?.focus() })
    let active = true
    void controller.runs.list(sessionId, 1, false).then(response => {
      if (active) setLastRun(response.runs[0] ?? null)
    }, () => undefined)
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() } }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { active = false; document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [controller, open, sessionId])

  useLayoutEffect(() => {
    if (!open) return
    const updatePlacement = (): void => {
      const trigger = triggerRef.current
      if (trigger === null) return
      const rect = trigger.getBoundingClientRect()
      const viewport = window.visualViewport
      const viewportTop = viewport?.offsetTop ?? 0
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
      const above = Math.max(0, rect.top - viewportTop - PANEL_VIEWPORT_MARGIN - PANEL_TRIGGER_GAP)
      const below = Math.max(0, viewportBottom - rect.bottom - PANEL_VIEWPORT_MARGIN - PANEL_TRIGGER_GAP)
      const side = above >= below ? 'above' : 'below'
      const maxHeight = Math.floor(side === 'above' ? above : below)
      setPanelPlacement(current => current.side === side && current.maxHeight === maxHeight ? current : { side, maxHeight })
    }
    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    window.visualViewport?.addEventListener('resize', updatePlacement)
    window.visualViewport?.addEventListener('scroll', updatePlacement)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
      window.visualViewport?.removeEventListener('resize', updatePlacement)
      window.visualViewport?.removeEventListener('scroll', updatePlacement)
    }
  }, [open])

  const selectedTeam = useMemo(() => catalog.data.squads.find(item => item.id === state.selected), [catalog.data.squads, state.selected])
  const effectiveTeam = useMemo(() => catalog.data.squads.find(item => item.id === state.effective?.squadId), [catalog.data.squads, state.effective?.squadId])
  const hasSquads = catalog.data.squads.length > 0
  const inputPhase = useInput((input: InputState) => input.phase)
  const locked = state.busy || inputPhase === 'submitting'
  const effectiveActivation = effectiveTeam?.activationMode ?? 'always'
  const modeGroupName = `agent-team-conversation-mode:${sessionId}`

  const runModeAction = async (action: () => Promise<ModeResponse>): Promise<void> => {
    const request = ++requestRef.current
    setState(current => ({ ...current, busy: true, error: '' }))
    try {
      const response = await action()
      if (request !== requestRef.current) return
      setState(current => ({
        ...current,
        busy: false,
        initialized: true,
        override: response.sessionOverride,
        effective: response.mode,
        selected: response.mode?.squadId ?? current.selected,
        next: response.nextOverride,
        projectKey: response.projectKey,
        projectDefault: response.projectDefault?.squadId ?? null,
      }))
    } catch (reason) {
      if (request === requestRef.current) setState(current => ({ ...current, busy: false, error: errorText(reason) }))
    }
  }

  const setDurable = (choice: 'enabled' | 'disabled' | 'inherit'): void => {
    if (choice === 'inherit') void runModeAction(() => controller.modes.inherit(sessionId))
    else void runModeAction(() => controller.modes.set(sessionId, choice, choice === 'enabled' ? state.selected : undefined))
  }

  const setNext = (choice: 'inherit' | 'solo' | 'team'): void => {
    void runModeAction(() => controller.modes.setNext(sessionId, choice, choice === 'team' ? state.selected : undefined))
  }

  const setNextTeam = (squadId: string): void => {
    void runModeAction(() => controller.modes.setNext(sessionId, 'team', squadId))
  }

  const toggleProject = async (): Promise<void> => {
    if (state.projectKey === null || state.selected === '') return
    const request = ++requestRef.current
    setState(current => ({ ...current, busy: true, error: '' }))
    try {
      const response = await controller.modes.setProjectDefault(sessionId, state.projectDefault === state.selected ? null : state.selected)
      if (request !== requestRef.current) return
      setState(current => ({
        ...current,
        busy: false,
        effective: response.mode,
        override: response.sessionOverride,
        next: response.nextOverride,
        projectKey: response.projectKey,
        projectDefault: response.projectDefault?.squadId ?? null,
      }))
    } catch (reason) {
      if (request === requestRef.current) setState(current => ({ ...current, busy: false, error: errorText(reason) }))
    }
  }

  const label = !state.initialized ? t('modeLoading') : state.override === 'enabled' ? t('modeTeam') : state.override === 'disabled' ? t('modeSolo') : t('modeInherited')
  const activeName = state.effective?.squadName ?? ''
  const nextValue = typeof state.next === 'object' && state.next !== null ? 'team' : state.next ?? 'inherit'

  return <div ref={rootRef} className="atg-composer-wrap" data-testid="agent-team-composer">
    <button
      ref={triggerRef}
      type="button"
      className={`atg-composer-trigger mode-${state.override}${state.error !== '' || catalog.status === 'error' ? ' has-error' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={`${t('modePanel')}: ${label}${activeName === '' ? '' : `, ${activeName}`}`}
      onClick={() => { setOpen(value => !value) }}
    >
      <span className="atg-mode-dot" aria-hidden="true" />
      <span>{label}</span>
      {activeName !== '' && <strong>{activeName}</strong>}
      {state.effective !== null && effectiveActivation !== 'always' && <span className="atg-activation-badge">{t(effectiveActivation === 'manual' ? 'manualBadge' : 'smartBadge')}</span>}
      <span aria-hidden="true">⌄</span>
    </button>
    {open && <section ref={panelRef} id={panelId} tabIndex={-1} className={`atg-mode-panel placement-${panelPlacement.side}`} style={{ maxHeight: panelPlacement.maxHeight }} role="dialog" aria-label={t('modePanel')}>
      <header><div><strong>{t('modePanel')}</strong><small>{selectedTeam?.name ?? t('noTeams')}</small></div><button type="button" className="atg-icon" aria-label={t('close')} onClick={() => { setOpen(false); triggerRef.current?.focus() }}>×</button></header>
      {(state.error !== '' || catalog.status === 'error') && <div className="atg-recovery" role="alert"><strong>{t('connectionError')}</strong><span>{t('reconnecting')}</span><small>{state.error || catalog.error}</small><button type="button" className="atg-button ghost" onClick={() => { void controller.load(true).catch(() => undefined) }}>{t('retry')}</button></div>}
      {!hasSquads ? <div className="atg-empty compact"><strong>{t('noTeams')}</strong><span>{t('noTeamsHint')}</span><button type="button" className="atg-button primary" onClick={openTeamSettings}>{t('createFirstTeam')}</button></div> : <>
        <label className="atg-field"><span>{t('selectedTeam')}</span><select value={state.selected} disabled={locked} onChange={event => {
          const selected = event.currentTarget.value
          setState(current => ({ ...current, selected }))
          if (state.override === 'enabled') void runModeAction(() => controller.modes.set(sessionId, 'enabled', selected))
        }}>{catalog.data.squads.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {state.effective !== null && effectiveActivation !== 'always' && <div className={`atg-activation-note mode-${effectiveActivation}`} role="note"><span>{t(effectiveActivation === 'manual' ? 'manualActiveHint' : 'smartActiveHint')}</span>{effectiveActivation === 'manual' && <button type="button" className="atg-button ghost" disabled={locked} onClick={() => { setNextTeam(state.effective?.squadId ?? '') }}>{t('useNextTeamNow')}</button>}</div>}
        <fieldset className="atg-choice-group"><legend>{t('durableChoice')}</legend>
          <ModeChoice groupName={modeGroupName} checked={state.override === 'inherit'} disabled={locked} label={t('inheritProject')} description={state.projectDefault === null ? t('noProjectDefault') : catalog.data.squads.find(item => item.id === state.projectDefault)?.name ?? state.projectDefault} onChange={() => { setDurable('inherit') }} />
          <ModeChoice groupName={modeGroupName} checked={state.override === 'enabled'} disabled={locked || state.selected === ''} label={t('explicitTeam')} description={selectedTeam?.name ?? ''} onChange={() => { setDurable('enabled') }} />
          <ModeChoice groupName={modeGroupName} checked={state.override === 'disabled'} disabled={locked} label={t('explicitSolo')} onChange={() => { setDurable('disabled') }} />
        </fieldset>
        <label className="atg-field"><span>{t('nextMessage')}</span><select value={nextValue} disabled={locked} onChange={event => { setNext(event.currentTarget.value as 'inherit' | 'solo' | 'team') }}><option value="inherit">{t('nextInherit')}</option><option value="team">{t('nextTeam')}</option><option value="solo">{t('nextSolo')}</option></select>{nextValue !== 'inherit' && <small>{t('nextOverrideActive')}</small>}</label>
        {typeof state.next === 'object' && state.next !== null && <div className="atg-note" role="status"><span>{t('nextQueuedTeam', { name: state.next.squadName, id: state.next.squadId })}</span>{state.next.squadId !== state.selected && <button type="button" className="atg-button ghost" disabled={locked || state.selected === ''} onClick={() => { setNextTeam(state.selected) }}>{t('replaceNextTeam')}</button>}</div>}
        {state.projectKey !== null && <button type="button" className={`atg-button ghost wide${state.projectDefault === state.selected ? ' is-active' : ''}`} disabled={locked || state.selected === ''} aria-label={state.projectDefault === state.selected ? t('clearProjectDefault') : t('setProjectDefault')} onClick={() => { void toggleProject() }}>{state.projectDefault === state.selected ? '✓ ' : ''}{state.projectDefault === state.selected ? t('clearProjectDefault') : t('setProjectDefault')}</button>}
        {lastRun !== null && <div className="atg-last-run"><span className={`atg-status-dot status-${lastRun.status}`} /><span><strong>{t('lastRun')}: {t(statusKey(lastRun.status))}</strong><small>{formatDuration(lastRun.startedAt, lastRun.endedAt)} · {lastRun.usage.providerReported ? `${formatTokens(lastRun.usage.totalTokens)} ${t('tokens')}` : t('metering')}</small></span></div>}
        <button type="button" className="atg-link-button" onClick={openTeamSettings}>{t('edit')} {selectedTeam?.name ?? t('teams')} →</button>
      </>}
    </section>}
  </div>
}

function ModeChoice({ groupName, checked, disabled, label, description, onChange }: { groupName: string; checked: boolean; disabled: boolean; label: string; description?: string; onChange(): void }): ReactNode {
  return <label className={`atg-mode-choice${checked ? ' is-active' : ''}`}><input type="radio" name={groupName} checked={checked} disabled={disabled} onChange={onChange} /><span><strong>{label}</strong>{description !== undefined && description !== '' && <small>{description}</small>}</span></label>
}

/**
 * DSH currently exposes no public imperative "open this settings section" service.
 * Invoke its semantic, accessible controls instead of depending on CSS classes or
 * private component state. If the shell changes, the panel remains useful and the
 * user-visible Settings → Teams path still works.
 */
export function openTeamSettings(): void {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  const selectTeamSection = (): boolean => {
    const root = document.querySelector<HTMLElement>('[role="dialog"]')
    if (root === null) return false
    const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => ['小队', 'Teams'].includes(item.textContent?.trim() ?? ''))
    button?.click()
    return button !== undefined
  }
  if (dialog !== null && selectTeamSection()) return
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')]
    .find(item => /设置|settings/i.test(`${item.getAttribute('aria-label') ?? ''} ${item.textContent ?? ''}`))
  trigger?.click()
  let attempts = 0
  const seek = (): void => {
    attempts += 1
    if (!selectTeamSection() && attempts < 12) setTimeout(seek, 50)
  }
  seek()
}
