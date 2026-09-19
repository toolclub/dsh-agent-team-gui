import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import AxeBuilder from '@axe-core/playwright'
import { chromium } from 'playwright'
import { DshWebFixture } from './dsh-fixture.mjs'
import { invariant, isExpectedRestartHostDescribe404 } from './common.mjs'

function isAgentTeamRequest(request, endpoint) {
  return request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/agentTeamGui'
    && request.postDataJSON()?.payload?.endpoint === endpoint
}

function isAgentTeamResponse(response, endpoint) {
  return isAgentTeamRequest(response.request(), endpoint)
}

async function assertNoSeriousAccessibilityViolations(page, selector, label) {
  const report = await new AxeBuilder({ page }).include(selector).analyze()
  const blocking = report.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
  invariant(blocking.length === 0, [
    `${label} has serious/critical accessibility violations:`,
    ...blocking.flatMap(violation => [
      `- ${violation.id} (${violation.impact}): ${violation.help}; ${violation.nodes.length} node(s)`,
      ...violation.nodes.map(node => `  target ${node.target.join(' ')}: ${node.failureSummary ?? 'no failure summary'}; ${node.html.slice(0, 400)}`),
    ]),
  ].join('\n'))
}

async function waitForPersistedTeamNote(fixture, squadId, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await fixture.rpc('snapshot')
    const squad = latest.squads?.find(candidate => candidate.id === squadId)
    if (squad?.collabNote === expected) return
    await delay(100)
  }
  const actual = latest?.squads?.find(candidate => candidate.id === squadId)?.collabNote
  throw new Error(`Settings save was not durable: expected collabNote ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function controlledPanel(page, trigger, label) {
  const panelId = await trigger.getAttribute('aria-controls')
  invariant(panelId !== null && panelId.trim() !== '' && !/\s/.test(panelId), `${label} has no valid aria-controls target`)
  const panel = page.locator(`[id=${JSON.stringify(panelId)}]`)
  invariant(await panel.count() === 1, `${label} aria-controls does not resolve exactly one panel: ${panelId}`)
  return panel
}

async function assertEditorActionsLayout(settingsRoot, editorName, label) {
  const editor = settingsRoot.getByRole('main', { name: editorName })
  const scrollBody = editor.locator(':scope > .atg-editor-scroll')
  const actions = scrollBody.locator(':scope > .atg-editor-actions')
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  invariant(await scrollBody.count() === 1, `${label} has no unique editor scroll body`)
  invariant(await actions.count() === 1, `${label} has no unique editor action row`)
  invariant(await actions.getByRole('button').count() === 2, `${label} must expose exactly Discard and Save`)
  const geometry = await editor.evaluate(element => {
    const body = element.querySelector(':scope > .atg-editor-scroll')
    const footer = body?.querySelector(':scope > .atg-editor-actions')
    if (!(body instanceof HTMLElement) || !(footer instanceof HTMLElement)) return undefined
    const initialFooterTop = footer.getBoundingClientRect().top
    body.scrollTop = body.scrollHeight
    const editorRect = element.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    const footerRect = footer.getBoundingClientRect()
    const previousRect = footer.previousElementSibling?.getBoundingClientRect()
    return {
      editor: { left: editorRect.left, right: editorRect.right, bottom: editorRect.bottom },
      body: { left: bodyRect.left, right: bodyRect.right, bottom: bodyRect.bottom, overflowY: getComputedStyle(body).overflowY },
      footer: {
        left: footerRect.left,
        right: footerRect.right,
        top: footerRect.top,
        bottom: footerRect.bottom,
        position: getComputedStyle(footer).position,
      },
      initialFooterTop,
      previousBottom: previousRect?.bottom,
      scrollable: body.scrollHeight > body.clientHeight + 2,
      reachedEnd: body.scrollHeight <= body.clientHeight + 2 || body.scrollTop > 0,
    }
  })
  invariant(geometry !== undefined, `${label} editor layout could not be measured`)
  invariant(!['absolute', 'fixed', 'sticky'].includes(geometry.footer.position), `${label} action row still floats over content (${geometry.footer.position})`)
  invariant(!geometry.scrollable || geometry.footer.top < geometry.initialFooterTop - 1, `${label} action row did not move with the scrolled form`)
  invariant(geometry.previousBottom === undefined || geometry.footer.top >= geometry.previousBottom - 2, `${label} action row overlaps the preceding form content`)
  invariant(geometry.footer.bottom <= geometry.body.bottom + 2, `${label} action row is not reachable at the end of the form`)
  invariant(geometry.footer.left >= geometry.body.left - 2 && geometry.footer.right <= geometry.body.right + 2, `${label} action row is horizontally clipped`)
  invariant(!geometry.scrollable || (/^(auto|scroll)$/.test(geometry.body.overflowY) && geometry.reachedEnd), `${label} body cannot reach its final field`)
  await scrollBody.evaluate(element => { element.scrollTop = 0 })
}

async function waitForVisibleOnboardingAction(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  do {
    // Prefer the credential-free exit. In particular, never confuse the
    // disabled "Save and continue" action with the welcome acknowledgement.
    for (const name of [/^(Configure later|稍后配置)$/, /^(Continue|继续)$/]) {
      const actions = page.getByRole('button', { name })
      for (let index = 0; index < await actions.count(); index += 1) {
        const action = actions.nth(index)
        if (
          await action.isVisible().catch(() => false)
          && await action.isEnabled().catch(() => false)
        ) return action
      }
    }
    if (Date.now() < deadline) await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return undefined
}

async function completeOnboarding(page) {
  for (let step = 0; step < 4; step += 1) {
    const action = await waitForVisibleOnboardingAction(page, step === 0 ? 15_000 : 5_000)
    const visibleOverlay = page.locator('[class*="onboardingOverlay"]:visible')
    if (action === undefined) {
      invariant(await visibleOverlay.count() === 0, 'fresh-profile onboarding is visible but exposes no enabled safe action')
      return
    }
    const dialog = action.locator('xpath=ancestor::*[@role="dialog"]').first()
    const dialogElement = await dialog.elementHandle()
    invariant(dialogElement !== null, 'fresh-profile onboarding action is not owned by a dialog')
    const actionLabel = (await action.textContent())?.trim() || '<unlabelled>'
    const dialogTitle = (await dialog.getByRole('heading').first().textContent().catch(() => null))?.trim() || '<untitled>'
    process.stdout.write(`Onboarding: ${JSON.stringify(dialogTitle)} -> ${JSON.stringify(actionLabel)} (visible/enabled)\n`)
    await action.click()
    // A step is complete only after the exact dialog node goes away. Merely
    // sleeping can click the same transition twice and leave the next modal
    // invisibly queued over the application.
    await page.waitForFunction(element => !element.isConnected, dialogElement, { timeout: 15_000 })
    process.stdout.write(`Onboarding: ${JSON.stringify(dialogTitle)} detached\n`)
  }
  invariant(await page.locator('[class*="onboardingOverlay"]:visible').count() === 0, 'fresh-profile onboarding exceeded four bounded steps')
}

const fixture = await DshWebFixture.create()
let browser
let context
let page
let failed = true
try {
  await fixture.install()
  const browserBaseUrl = await fixture.start()
  // stop() deliberately clears the fixture's mutable baseUrl while the Host is
  // offline. Event listeners must retain the origin of this browser journey so
  // an expected reconnect probe can still be matched during that interval.
  invariant(typeof browserBaseUrl === 'string' && browserBaseUrl !== '', 'browser fixture did not expose its initial base URL')
  const seed = await fixture.seedDefinitions('browser-smoke')
  const createdSessionId = await fixture.createBrowserSession()
  // Chromium receives the same credential-free, temporary Home/XDG/DSH roots as
  // the Host process. This keeps browser helpers and crash diagnostics away from
  // the operator's real profile as well as from ~/.dsh.
  browser = await chromium.launch({ headless: true, env: fixture.env })
  // Axe needs an explicit persistent BrowserContext; Playwright's convenience
  // browser.newPage() creates an implementation-owned context that cannot be
  // safely instrumented by @axe-core/playwright.
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  page = await context.newPage()
  const runtimeErrors = []
  const failedResponses = []
  let restartInProgress = false
  let restartGraceUntil = 0
  page.on('pageerror', error => runtimeErrors.push(`pageerror: ${error.message}`))
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  page.on('console', message => {
    const location = message.location()
    // Chromium can deliver the console record for the official reconnect probe
    // shortly after the successful snapshot response. Keep a bounded grace
    // period tied to the deliberate restart instead of a racy boolean flip.
    const intentionalRestart = restartInProgress || Date.now() <= restartGraceUntil
    const expectedTransportClose = intentionalRestart
      && /WebSocket connection|ERR_CONNECTION_REFUSED|ERR_INCOMPLETE_CHUNKED_ENCODING/i.test(message.text())
    const expectedHostDescribe404 = isExpectedRestartHostDescribe404({
      intentionalRestart,
      baseUrl: browserBaseUrl,
      sourceUrl: location.url,
      message: message.text(),
    })
    if (message.type() === 'error' && !expectedTransportClose && !expectedHostDescribe404) {
      const source = location.url === '' ? '' : ` @ ${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`
      runtimeErrors.push(`console: ${message.text()}${source}`)
    }
  })
  const modeRequest = page.waitForRequest(
    request => isAgentTeamRequest(request, 'mode/get'),
    { timeout: 60_000 },
  )
  const snapshotResponse = page.waitForResponse(
    response => isAgentTeamResponse(response, 'snapshot'),
    { timeout: 60_000 },
  )
  await page.goto(fixture.launchUrl, { waitUntil: 'domcontentloaded' })
  await completeOnboarding(page)
  const response = await snapshotResponse
  invariant(response.ok(), `browser snapshot request returned HTTP ${response.status()}`)
  const modeEnvelope = (await modeRequest).postDataJSON()
  const sessionId = modeEnvelope?.payload?.payload?.sessionId
  invariant(typeof sessionId === 'string' && sessionId !== '', 'browser mode/get did not identify the active session')
  invariant(sessionId === createdSessionId, `browser selected ${sessionId} instead of the isolated session ${createdSessionId}`)

  const composer = page.locator('[data-testid="agent-team-composer"]')
  const legacyControl = page.locator([
    'select[aria-label="选择小队"]',
    'select[aria-label="Select team"]',
    '[role="switch"][aria-label="小队模式"]',
    '[role="switch"][aria-label="Team mode"]',
  ].join(','))
  await Promise.race([
    composer.first().waitFor({ state: 'visible', timeout: 30_000 }),
    legacyControl.first().waitFor({ state: 'visible', timeout: 30_000 }),
  ])

  const interactive = composer.locator('button,select,[role="switch"]').or(legacyControl)
  invariant(await interactive.count() > 0, 'team composer exposes no interactive control')
  const trigger = composer.locator('button[aria-haspopup="dialog"]').first()
  const assertColdMode = async (state, label) => {
    if (state === 'inherit') await fixture.rpc('mode/inherit', { sessionId })
    else await fixture.rpc('mode/set', {
      sessionId,
      state,
      ...(state === 'enabled' ? { squadId: seed.squadId } : {}),
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    // The official credential step intentionally has process-local dismissal,
    // so every true cold reload can present it again in this credential-free
    // fixture. Dismiss it through its real UI before touching plugin chrome.
    await completeOnboarding(page)
    await trigger.filter({ hasText: label }).waitFor({ state: 'visible', timeout: 15_000 })
    invariant(await trigger.isEnabled(), `${state} composer trigger stayed disabled after cold refresh`)
  }
  await assertColdMode('disabled', /Solo|单人/)
  await assertColdMode('enabled', /Team|小队/)
  await assertColdMode('inherit', /Inherited|继承/)

  invariant(await page.locator('[class*="onboardingOverlay"]:visible').count() === 0, 'official onboarding returned before Composer interaction')
  await trigger.click()
  const queuePanel = await controlledPanel(page, trigger, 'composer one-shot trigger')
  await queuePanel.waitFor({ state: 'visible', timeout: 5_000 })
  const panelBounds = await queuePanel.boundingBox()
  const panelViewport = page.viewportSize()
  invariant(
    panelBounds !== null
      && panelViewport !== null
      && panelBounds.x >= -2
      && panelBounds.y >= -2
      && panelBounds.x + panelBounds.width <= panelViewport.width + 2
      && panelBounds.y + panelBounds.height <= panelViewport.height + 2,
    `Composer panel is clipped by the 1440x900 viewport (${panelBounds === null ? 'no box' : `${panelBounds.x},${panelBounds.y} ${panelBounds.width}x${panelBounds.height}`})`,
  )
  const panelScroll = await queuePanel.evaluate(element => {
    const overflowY = getComputedStyle(element).overflowY
    const needsScroll = element.scrollHeight > element.clientHeight + 2
    element.scrollTop = element.scrollHeight
    const reachesEnd = !needsScroll || element.scrollTop > 0
    element.scrollTop = 0
    return { needsScroll, overflowY, reachesEnd }
  })
  invariant(
    !panelScroll.needsScroll || (/^(auto|scroll)$/.test(panelScroll.overflowY) && panelScroll.reachesEnd),
    `Composer panel content is not keyboard/scroll reachable (overflow-y ${panelScroll.overflowY})`,
  )
  const nextMessage = queuePanel
    .getByText(/^(Next message only|仅下一条消息)$/)
    .locator('xpath=ancestor::label[1]')
    .locator('select')
  const selectNext = async state => {
    await nextMessage.waitFor({ state: 'visible', timeout: 5_000 })
    invariant(await nextMessage.count() === 1, 'Composer one-shot choice is not uniquely labelled')
    const previous = await nextMessage.inputValue()
    invariant(await nextMessage.isEnabled(), `Composer one-shot choice is disabled before ${state} selection (current ${previous})`)
    invariant(previous !== state, `Composer one-shot choice was already ${state}; the UI transition would not be exercised`)
    process.stdout.write(`Composer one-shot: ${previous} -> ${state} (visible/enabled)\n`)
    const [response] = await Promise.all([
      page.waitForResponse(candidate =>
        isAgentTeamResponse(candidate, 'mode/next-set'),
        { timeout: 15_000 },
      ),
      nextMessage.selectOption(state),
    ])
    const envelope = await response.json()
    invariant(envelope?.result?.ok === true, `Composer could not queue next-message ${state}`)
    return fixture.rpc('mode/get', { sessionId })
  }
  const queuedSolo = await selectNext('solo')
  invariant(queuedSolo.nextOverride === 'solo', 'Composer next-message Solo was not durable through RPC')
  const queuedTeam = await selectNext('team')
  invariant(queuedTeam.nextOverride?.squadId === seed.squadId, 'Composer next-message Team did not queue the selected team')
  await page.keyboard.press('Escape')
  await queuePanel.waitFor({ state: 'hidden', timeout: 5_000 })

  // Keep the exception active for the whole deliberate outage. Starting a
  // fixed deadline before stop made a slow CI restart outlive its own grace
  // period. After the first healthy snapshot, retain only a short allowance
  // for Chromium console records that are delivered after the HTTP response.
  restartInProgress = true
  restartGraceUntil = 0
  await fixture.stop()
  const consumedNext = await fixture.consumeNextOverrideForEligibleMessage(sessionId, 'browser-smoke-one-shot-message')
  invariant(consumedNext?.state === 'team' && consumedNext.squadId === seed.squadId, 'eligible message did not claim the queued Team override')
  invariant(
    await fixture.consumeNextOverrideForEligibleMessage(sessionId, 'browser-smoke-second-message') === undefined,
    'a second eligible message consumed the same one-shot override',
  )
  const seededRunId = await fixture.seedOrphanedRun(seed, sessionId)
  const reconnectSnapshot = page.waitForResponse(candidate =>
    isAgentTeamResponse(candidate, 'snapshot'),
    { timeout: 30_000 },
  )
  const restartedBaseUrl = await fixture.start()
  invariant(restartedBaseUrl === browserBaseUrl, `browser Host restart changed origin from ${browserBaseUrl} to ${restartedBaseUrl}`)
  invariant((await reconnectSnapshot).ok(), 'browser did not refresh the team catalog after Host restart')
  restartInProgress = false
  restartGraceUntil = Date.now() + 15_000
  await trigger.filter({ hasText: /Inherited|继承/ }).waitFor({ state: 'visible', timeout: 15_000 })
  invariant(await trigger.isEnabled(), 'team composer remained disabled after live Host restart')
  const recoveredRun = await fixture.rpc('run/get', { id: seededRunId })
  invariant(recoveredRun.run?.status === 'interrupted' && recoveredRun.run?.phase === 'settled', 'browser restart fixture did not reconcile the active run')
  invariant(recoveredRun.run?.members?.[0]?.status === 'interrupted', 'browser restart fixture left its active member running')
  const consumedMode = await fixture.rpc('mode/get', { sessionId })
  invariant(consumedMode.nextOverride === null, 'consumed one-shot mode reappeared after Host restart')
  const enabledCount = await page.locator([
    '[data-testid="agent-team-composer"] button:not([disabled])',
    '[data-testid="agent-team-composer"] select:not([disabled])',
    'select[aria-label="选择小队"]:not([disabled])',
    'select[aria-label="Select team"]:not([disabled])',
    '[role="switch"][aria-label="小队模式"]:not([disabled])',
    '[role="switch"][aria-label="Team mode"]:not([disabled])',
  ].join(',')).count()
  invariant(enabledCount > 0, 'team composer remained disabled after refresh')

  const composerTrigger = page.locator('[data-testid="agent-team-composer"] button[aria-haspopup="dialog"]').first()
  await composerTrigger.focus()
  await page.keyboard.press('Space')
  let modePanel = await controlledPanel(page, composerTrigger, 'composer trigger')
  await modePanel.waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForFunction(element => document.activeElement === element, await modePanel.elementHandle(), { timeout: 5_000 })
  await page.keyboard.press('Tab')
  invariant(await modePanel.evaluate(element => element.contains(document.activeElement)), 'Tab moved focus outside the composer panel')
  await assertNoSeriousAccessibilityViolations(page, '[data-testid="agent-team-composer"]', 'composer panel')
  await page.keyboard.press('Escape')
  await modePanel.waitFor({ state: 'hidden', timeout: 5_000 })
  await page.waitForFunction(element => document.activeElement === element, await composerTrigger.elementHandle(), { timeout: 5_000 })
  await page.keyboard.press('Space')
  await modePanel.waitFor({ state: 'visible', timeout: 5_000 })

  const modeBeforeProject = await fixture.rpc('mode/get', { sessionId })
  invariant(typeof modeBeforeProject.projectKey === 'string' && modeBeforeProject.projectKey !== '', 'browser session exposes no project key for project-default verification')
  const setProjectResponse = page.waitForResponse(candidate =>
    isAgentTeamResponse(candidate, 'project/default-set'),
    { timeout: 15_000 },
  )
  const setProject = modePanel.getByRole('button', { name: /^(Set as this project’s default team|设为当前项目默认小队)$/ })
  const [, setProjectResult] = await Promise.all([setProject.click(), setProjectResponse])
  invariant((await setProjectResult.json())?.result?.ok === true, 'Composer could not set the project default')
  const projectSet = await fixture.rpc('mode/get', { sessionId })
  invariant(
    projectSet.sessionOverride === 'inherit'
      && projectSet.projectDefault?.squadId === seed.squadId
      && projectSet.mode?.squadId === seed.squadId,
    'project default did not become the effective inherited Team mode',
  )
  await page.keyboard.press('Escape')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await completeOnboarding(page)
  await composerTrigger.filter({ hasText: /Inherited|继承/ }).waitFor({ state: 'visible', timeout: 15_000 })
  await composerTrigger.focus()
  await page.keyboard.press('Space')
  modePanel = await controlledPanel(page, composerTrigger, 'composer project-default trigger')
  await modePanel.waitFor({ state: 'visible', timeout: 5_000 })
  const clearProjectResponse = page.waitForResponse(candidate =>
    isAgentTeamResponse(candidate, 'project/default-set'),
    { timeout: 15_000 },
  )
  const clearProject = modePanel.getByRole('button', { name: /^(Clear this project’s default team|取消当前项目默认小队)$/ })
  const [, clearProjectResult] = await Promise.all([clearProject.click(), clearProjectResponse])
  invariant((await clearProjectResult.json())?.result?.ok === true, 'Composer could not clear the project default')
  const projectCleared = await fixture.rpc('mode/get', { sessionId })
  invariant(projectCleared.sessionOverride === 'inherit' && projectCleared.projectDefault === null && projectCleared.mode === null, 'cleared project default remained effective')
  await page.keyboard.press('Escape')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await completeOnboarding(page)
  await composerTrigger.filter({ hasText: /Inherited|继承/ }).waitFor({ state: 'visible', timeout: 15_000 })
  const projectAfterReload = await fixture.rpc('mode/get', { sessionId })
  invariant(projectAfterReload.projectDefault === null && projectAfterReload.mode === null, 'cleared project default returned after cold reload')
  await composerTrigger.focus()
  await page.keyboard.press('Space')
  modePanel = await controlledPanel(page, composerTrigger, 'composer theme trigger')
  await modePanel.waitFor({ state: 'visible', timeout: 5_000 })

  const themeSignature = async colorScheme => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.waitForTimeout(100)
    await assertNoSeriousAccessibilityViolations(page, '[data-testid="agent-team-composer"]', `${colorScheme} composer theme`)
    return modePanel.evaluate(element => {
      const style = getComputedStyle(element)
      return {
        background: style.backgroundColor,
        color: style.color,
        border: style.borderTopColor,
        layerToken: style.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
        labelToken: style.getPropertyValue('--dsw-alias-label-primary').trim(),
      }
    })
  }
  const lightTheme = await themeSignature('light')
  const darkTheme = await themeSignature('dark')
  invariant(JSON.stringify(lightTheme) !== JSON.stringify(darkTheme), `light and dark Harness tokens produced the same composer theme: ${JSON.stringify(lightTheme)}`)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })

  const editTeam = page.locator('[data-testid="agent-team-composer"] [role="dialog"] button').filter({ hasText: /Edit|编辑/ }).first()
  await editTeam.focus()
  await page.keyboard.press('Space')
  const settingsRoot = page.locator('[data-testid="agent-team-settings"]')
  await settingsRoot.waitFor({ state: 'visible', timeout: 15_000 })
  invariant(await settingsRoot.getByRole('button').count() > 0, 'team Settings root has no actionable controls')
  const teamsTab = settingsRoot.getByRole('tab', { name: /^(Teams|小队)/ }).first()
  const membersTab = settingsRoot.getByRole('tab', { name: /^(Member library|成员库)/ }).first()
  const recipesTab = settingsRoot.getByRole('tab', { name: /^(Recipes & data|配方与数据)/ }).first()
  await teamsTab.focus()
  await page.keyboard.press('ArrowRight')
  invariant(await membersTab.evaluate(element => document.activeElement === element), 'ArrowRight did not move to the next Settings tab')
  if (await membersTab.getAttribute('aria-selected') !== 'true') await page.keyboard.press('Space')
  invariant(await membersTab.getAttribute('aria-selected') === 'true', 'Members Settings tab could not be activated from the keyboard')
  await assertEditorActionsLayout(settingsRoot, /^(Member editor|成员编辑器)$/, 'desktop Member editor')
  await page.keyboard.press('End')
  invariant(await recipesTab.evaluate(element => document.activeElement === element), 'End did not move to the last Settings tab')
  await page.keyboard.press('Home')
  invariant(await teamsTab.evaluate(element => document.activeElement === element), 'Home did not move to the first Settings tab')
  if (await teamsTab.getAttribute('aria-selected') !== 'true') await page.keyboard.press('Space')
  invariant(await teamsTab.getAttribute('aria-selected') === 'true', 'Teams Settings tab could not be restored from the keyboard')
  await assertEditorActionsLayout(settingsRoot, /^(Team editor|小队编辑器)$/, 'desktop Team editor')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(100)
  await assertEditorActionsLayout(settingsRoot, /^(Team editor|小队编辑器)$/, '390px Team editor')
  await membersTab.click()
  await assertEditorActionsLayout(settingsRoot, /^(Member editor|成员编辑器)$/, '390px Member editor')
  await teamsTab.click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(100)
  const expectedNote = 'Hermetic browser keyboard and persistence verification.'
  const usageMode = settingsRoot.getByLabel(/^(Team usage|小队使用方式)$/)
  await usageMode.selectOption('model-tool')
  invariant(await settingsRoot.getByLabel(/^(Response|响应方式)$/).isDisabled(), 'on-demand mode offered an unsupported background tool dispatch')
  const note = settingsRoot.locator('#team-note')
  await note.fill(expectedNote)
  const saveTeam = settingsRoot.getByRole('button', { name: /^(Save|保存)$/ }).last()
  invariant(await saveTeam.isEnabled(), 'editing a saved team did not enable Save')
  await saveTeam.focus()
  await page.keyboard.press('Space')
  await saveTeam.waitFor({ state: 'visible' })
  await page.waitForFunction(element => element instanceof HTMLButtonElement && element.disabled, await saveTeam.elementHandle())
  await waitForPersistedTeamNote(fixture, seed.squadId, expectedNote)
  const savedOnDemand = await fixture.rpc('snapshot')
  invariant(savedOnDemand.squads.find(team => team.id === seed.squadId)?.triggerMode === 'model-tool', 'usage mode was not persisted through the Settings form')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await completeOnboarding(page)
  if (!await settingsRoot.isVisible()) {
    await composerTrigger.click()
    await page.locator('[data-testid="agent-team-composer"] [role="dialog"] button').filter({ hasText: /Edit|编辑/ }).first().click()
  }
  await settingsRoot.waitFor({ state: 'visible', timeout: 15_000 })
  invariant(await usageMode.inputValue() === 'model-tool', 'saved usage mode did not survive browser reload')
  await assertNoSeriousAccessibilityViolations(page, '[data-testid="agent-team-settings"]', 'team Settings')

  // Reject local files before File.text/JSON.parse or any loopback request.
  // This exercises a real browser File path rather than a mocked component event.
  await recipesTab.click()
  const recipesRoot = settingsRoot.locator('[data-testid="agent-team-recipes"]')
  await recipesRoot.waitFor({ state: 'visible', timeout: 10_000 })
  const importRequests = []
  const observeImportRequest = request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/agentTeamGui') return
    const endpoint = request.postDataJSON()?.payload?.endpoint
    if (new URL(request.url()).pathname === '/api/agentTeamGui' && [
      'recipe/preview',
      'recipe/import',
      'import/preview',
      'import',
    ].includes(endpoint)) importRequests.push(endpoint)
  }
  page.on('request', observeImportRequest)
  try {
    const fileInputs = recipesRoot.locator('input[type="file"]')
    invariant(await fileInputs.count() === 2, 'Recipes/Data does not expose separate recipe and definition file inputs')
    await fileInputs.nth(0).setInputFiles({
      name: 'oversize-recipe.json',
      mimeType: 'application/json',
      buffer: Buffer.alloc((4 * 1024 * 1024) + 1, 0x20),
    })
    await recipesRoot.getByRole('alert').filter({ hasText: /(?:cannot exceed 4 MiB|不能超过 4 MiB)/ }).waitFor({ state: 'visible', timeout: 5_000 })
    await fileInputs.nth(1).setInputFiles({
      name: 'oversize-definitions.json',
      mimeType: 'application/json',
      buffer: Buffer.alloc((16 * 1024 * 1024) + 1, 0x20),
    })
    await recipesRoot.getByRole('alert').filter({ hasText: /(?:cannot exceed 16 MiB|不能超过 16 MiB)/ }).waitFor({ state: 'visible', timeout: 5_000 })
    await page.waitForTimeout(100)
    invariant(importRequests.length === 0, `oversize local files crossed the RPC boundary: ${importRequests.join(', ')}`)
    await assertNoSeriousAccessibilityViolations(page, '[data-testid="agent-team-recipes"]', 'oversize import errors')
  } finally {
    page.off('request', observeImportRequest)
  }
  await page.keyboard.press('Escape')
  if (await settingsRoot.isVisible().catch(() => false)) {
    const closeSettings = page.getByRole('button', { name: /^(Close|关闭)$/ }).last()
    if (await closeSettings.isVisible().catch(() => false)) await closeSettings.click()
  }

  // Harness intentionally hides conversation.view tabs while a Session is
  // truly blank. Engage this credential-free, effective-Solo Session through
  // the official API, cancel immediately, then navigate with the real tab.
  const modeBeforeEngagement = await fixture.rpc('mode/get', { sessionId })
  invariant(modeBeforeEngagement.mode === null, 'browser fixture must be Solo before official Session engagement')
  await fixture.engageBrowserSession(sessionId)
  const runNavigation = page.getByRole('button', { name: /^(Team runs|小队运行)$/ }).or(
    page.getByRole('tab', { name: /^(Team runs|小队运行)$/ }),
  ).first()
  await runNavigation.waitFor({ state: 'visible', timeout: 15_000 })
  await runNavigation.focus()
  await page.keyboard.press('Space')
  const runCenter = page.locator('[data-testid="agent-team-run-center"]')
  await runCenter.waitFor({ state: 'visible', timeout: 15_000 })
  invariant(await runCenter.getByRole('button').count() > 0, 'Run Center has no actionable controls')
  const runSummary = runCenter.locator(`[data-run-id="${seededRunId}"] .atg-run-summary`)
  await runSummary.waitFor({ state: 'visible', timeout: 15_000 })
  await runSummary.focus()
  await page.keyboard.press('Space')
  invariant(await runSummary.getAttribute('aria-expanded') === 'true', 'Space did not expand the seeded Run Card')
  await runCenter.getByRole('region', { name: /^(Execution chain|执行链)$/ }).waitFor({ state: 'visible' })
  const recoveredMember = runCenter.locator(`[data-run-id="${seededRunId}"] .atg-run-member > summary`).first()
  await recoveredMember.click()
  await runCenter.getByRole('region', { name: /^(System retry diagnosis|系统重试诊断)$/ }).waitFor({ state: 'visible' })
  invariant(await runCenter.getByText('Host restarted during diagnosis. No automatic continuation.').count() === 1, 'interrupted diagnosis was not surfaced in Run Center')
  await assertNoSeriousAccessibilityViolations(page, '[data-testid="agent-team-run-center"]', 'Run Center')

  const settledCancel = await fixture.rpc('run/cancel', { id: seededRunId })
  invariant(settledCancel.cancelled === false, 'run/cancel falsely reported cancelling an already interrupted run')
  const retryResponsePromise = page.waitForResponse(candidate =>
    isAgentTeamResponse(candidate, 'run/retry'),
    { timeout: 15_000 },
  )
  const retryButton = runCenter.locator(`[data-run-id="${seededRunId}"]`).getByRole('button', { name: /^(Retry full run|重试整次运行)$/ })
  await retryButton.focus()
  const [, retryResponse] = await Promise.all([page.keyboard.press('Space'), retryResponsePromise])
  const retryEnvelope = await retryResponse.json()
  invariant(retryEnvelope?.result?.ok === true, `Run Center retry failed: ${retryEnvelope?.result?.error?.message ?? 'invalid response'}`)
  const retriedRunId = retryEnvelope.result.value?.id
  invariant(typeof retriedRunId === 'string' && retryEnvelope.result.value?.retryOf === seededRunId, 'retry did not create a linked run')
  const retried = await fixture.rpc('run/get', { id: retriedRunId })
  invariant(retried.run?.retryOf === seededRunId, 'retry lineage was not durable')

  const retriedSummary = runCenter.locator(`[data-run-id="${retriedRunId}"] .atg-run-summary`)
  await retriedSummary.waitFor({ state: 'visible', timeout: 15_000 })
  await retriedSummary.focus()
  await page.keyboard.press('Space')
  const stopButton = runCenter.locator(`[data-run-id="${retriedRunId}"]`).getByRole('button', { name: /^(Stop run|停止运行)$/ })
  if (await stopButton.isVisible().catch(() => false)) {
    try {
      await stopButton.focus()
      const [cancelResponse] = await Promise.all([
        page.waitForResponse(candidate =>
          isAgentTeamResponse(candidate, 'run/cancel'),
          { timeout: 15_000 },
        ),
        page.keyboard.press('Space'),
      ])
      const cancelEnvelope = await cancelResponse.json()
      invariant(cancelEnvelope?.result?.ok === true && cancelEnvelope.result.value?.cancelled === true, 'Run Center Stop did not cancel the active retry')
    } catch (error) {
      // A credential-free fresh profile may fail the real provider route between the
      // visibility check and the key press. That race is valid only after it settled.
      const settledRetry = await fixture.rpc('run/get', { id: retriedRunId })
      invariant(
        ['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(settledRetry.run?.status),
        `Run Center Stop failed while retry remained ${settledRetry.run?.status ?? 'missing'}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else {
    const settledRetry = await fixture.rpc('run/get', { id: retriedRunId })
    invariant(
      ['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(settledRetry.run?.status),
      `retry has neither a Stop action nor a settled state (${settledRetry.run?.status ?? 'missing'})`,
    )
  }

  const insightsResponsePromise = page.waitForResponse(candidate =>
    isAgentTeamResponse(candidate, 'insights/summary'),
    { timeout: 15_000 },
  )
  const runsTab = runCenter.getByRole('tab', { name: /^(Team runs|小队运行)$/ })
  const insightsTab = runCenter.getByRole('tab', { name: /^(Insights|洞察)$/ })
  await runsTab.focus()
  const [, insightsResponse] = await Promise.all([page.keyboard.press('ArrowRight'), insightsResponsePromise])
  invariant(await insightsTab.evaluate(element => document.activeElement === element), 'ArrowRight did not move to the Run Center Insights tab')
  invariant(await insightsTab.getAttribute('aria-selected') === 'true', 'ArrowRight did not activate Run Center Insights')
  const insightsEnvelope = await insightsResponse.json()
  invariant(insightsEnvelope?.result?.ok === true && insightsEnvelope.result.value?.runCount >= 1, 'Run Center insights did not aggregate the seeded run')
  const insightsRoot = runCenter.locator('[data-testid="agent-team-insights"]')
  await insightsRoot.waitFor({ state: 'visible', timeout: 15_000 })
  await assertNoSeriousAccessibilityViolations(page, '[data-testid="agent-team-insights"]', 'Run Center insights')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  const width = await runCenter.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return {
      content: element.scrollWidth,
      visible: element.clientWidth,
      left: rect.left,
      right: rect.right,
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }
  })
  invariant(width.content <= width.visible + 2, `narrow Run Center overflows horizontally (${width.content}px > ${width.visible}px)`)
  invariant(width.left >= -2 && width.right <= width.viewport + 2, `narrow Run Center is clipped by the viewport (${width.left}px..${width.right}px of ${width.viewport}px)`)
  invariant(width.document <= width.viewport + 2, `narrow page requires horizontal scrolling (${width.document}px > ${width.viewport}px)`)
  await fixture.assertDefinitions(seed)

  if (process.env.SMOKE_SCREENSHOT_DIR) {
    const directory = resolve(process.env.SMOKE_SCREENSHOT_DIR)
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: resolve(directory, 'browser-smoke-narrow.png'), fullPage: true })
  }
  invariant(runtimeErrors.length === 0, [
    'browser emitted runtime errors:',
    ...runtimeErrors,
    ...(failedResponses.length === 0 ? [] : ['HTTP failures observed:', ...failedResponses]),
  ].join('\n'))
  process.stdout.write(`Browser smoke passed at ${browserBaseUrl} (cold/one-shot/project modes, Host restart, Settings, retry/cancel, insights, light/dark axe, keyboard, and 390px layout).\n`)
  failed = false
} finally {
  if (failed && page !== undefined && process.env.SMOKE_SCREENSHOT_DIR) {
    try {
      const directory = resolve(process.env.SMOKE_SCREENSHOT_DIR)
      await mkdir(directory, { recursive: true })
      await page.screenshot({ path: resolve(directory, 'browser-smoke-failure.png'), fullPage: true })
    } catch (error) {
      process.stderr.write(`Could not capture browser failure evidence: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  await browser?.close()
  await fixture.close({ failed })
}
