import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { chromium } from 'playwright'
import { invariant, REPOSITORY_ROOT, TemporaryWorkspace } from './common.mjs'
import { DshWebFixture } from './dsh-fixture.mjs'

function isAgentTeamRequest(request, endpoint) {
  return request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/agentTeamGui'
    && request.postDataJSON()?.payload?.endpoint === endpoint
}

const REQUIRED_CAPTURES = [
  'v0.5-teams-settings.png',
  'v0.5-composer-mode.png',
  'v0.5-run-center.png',
  'v0.5-insights.png',
  'v0.5-recipes.png',
  'v0.5-narrow.png',
]

const outputDirectory = resolve(process.env.README_SCREENSHOT_DIR || resolve(REPOSITORY_ROOT, 'assets'))
const captureWorkspace = await TemporaryWorkspace.create('dsh-agent-team-gui-captures-')
const captureDirectory = await captureWorkspace.directory('screenshots')
process.stdout.write(`README capture staging workspace: ${captureWorkspace.root}\n`)
const fixture = await DshWebFixture.create()
let browser
let context
let page
let failed = true
const runtimeErrors = []

function observe(candidate) {
  candidate.on('pageerror', error => { runtimeErrors.push(`pageerror: ${error.message}`) })
  candidate.on('console', message => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`)
  })
}

async function screenshot(name, target = page) {
  const viewport = page.viewportSize()
  if (viewport !== null) {
    // A click may leave an unrelated Harness control in :hover. Clear that
    // transient state so the documented pixels are reproducible.
    await page.mouse.move(viewport.width - 2, 2)
    await page.waitForTimeout(100)
  }
  const path = resolve(captureDirectory, name)
  await target.screenshot({ path, animations: 'disabled' })
  const bytes = await readFile(path)
  invariant(bytes.length > 10_000, `${name} is unexpectedly small (${bytes.length} bytes)`)
  invariant(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${name} is not a PNG`)
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  invariant(width >= 360 && height >= 240, `${name} has an unusable ${width}x${height} canvas`)
}

async function promoteCaptures() {
  await mkdir(outputDirectory, { recursive: true })
  const promotionDirectory = await mkdtemp(join(outputDirectory, '.v0.5-capture-'))
  invariant(promotionDirectory.startsWith(`${outputDirectory}${sep}`), 'capture promotion directory escaped its destination')
  const entries = []
  try {
    for (const name of REQUIRED_CAPTURES) {
      const source = resolve(captureDirectory, name)
      const staged = resolve(promotionDirectory, `${name}.new`)
      const target = resolve(outputDirectory, name)
      const backup = resolve(promotionDirectory, `${name}.backup`)
      await copyFile(source, staged)
      invariant((await readFile(source)).equals(await readFile(staged)), `${name} changed while staging promotion`)
      let hadOriginal = false
      try {
        await copyFile(target, backup)
        hadOriginal = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      entries.push({ staged, target, backup, hadOriginal })
    }
    const promoted = []
    try {
      for (const entry of entries) {
        await rename(entry.staged, entry.target)
        promoted.push(entry)
      }
    } catch (error) {
      for (const entry of promoted.reverse()) {
        if (entry.hadOriginal) await rename(entry.backup, entry.target)
        else await rm(entry.target, { force: true })
      }
      throw error
    }
  } finally {
    await rm(promotionDirectory, { recursive: true, force: true })
  }
}

async function assertNoSeriousAccessibilityViolations(selector, label) {
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

async function waitForVisibleOnboardingAction(candidate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  do {
    for (const name of [/^(Configure later|稍后配置)$/, /^(Continue|继续)$/]) {
      const actions = candidate.getByRole('button', { name })
      for (let index = 0; index < await actions.count(); index += 1) {
        const action = actions.nth(index)
        if (
          await action.isVisible().catch(() => false)
          && await action.isEnabled().catch(() => false)
        ) return action
      }
    }
    if (Date.now() < deadline) await candidate.waitForTimeout(100)
  } while (Date.now() < deadline)
  return undefined
}

async function completeOnboarding(candidate) {
  for (let step = 0; step < 4; step += 1) {
    const action = await waitForVisibleOnboardingAction(candidate, step === 0 ? 15_000 : 5_000)
    const visibleOverlay = candidate.locator('[class*="onboardingOverlay"]:visible')
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
    await candidate.waitForFunction(element => !element.isConnected, dialogElement, { timeout: 15_000 })
    process.stdout.write(`Onboarding: ${JSON.stringify(dialogTitle)} detached\n`)
  }
  invariant(await candidate.locator('[class*="onboardingOverlay"]:visible').count() === 0, 'fresh-profile onboarding exceeded four bounded steps')
}

async function controlledPanel(candidate, trigger, label) {
  const panelId = await trigger.getAttribute('aria-controls')
  invariant(panelId !== null && panelId.trim() !== '' && !/\s/.test(panelId), `${label} has no valid aria-controls target`)
  const panel = candidate.locator(`[id=${JSON.stringify(panelId)}]`)
  invariant(await panel.count() === 1, `${label} aria-controls does not resolve exactly one panel: ${panelId}`)
  return panel
}

try {
  await fixture.install()
  await fixture.start()
  const seed = await fixture.seedReadmeDefinitions()
  const createdSessionId = await fixture.createBrowserSession()
  // Keep Chromium caches, crash data, and any browser-side helpers in the same
  // credential-free temporary Home as the isolated DSH profile.
  browser = await chromium.launch({ headless: true, env: fixture.env })
  context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
  })
  page = await context.newPage()
  observe(page)
  const firstModeRequest = page.waitForRequest(
    request => isAgentTeamRequest(request, 'mode/get'),
    { timeout: 60_000 },
  )
  await page.goto(fixture.launchUrl, { waitUntil: 'domcontentloaded' })
  await completeOnboarding(page)
  const sessionId = (await firstModeRequest).postDataJSON()?.payload?.payload?.sessionId
  invariant(typeof sessionId === 'string' && sessionId !== '', 'README capture could not resolve the active conversation session')
  invariant(sessionId === createdSessionId, `README capture selected ${sessionId} instead of the isolated session ${createdSessionId}`)
  await fixture.rpc('mode/set', { sessionId, state: 'enabled', squadId: seed.squadId })

  await page.close()
  page = undefined
  await fixture.stop()
  const runId = await fixture.seedReadmeCompletedRun(seed, sessionId)
  await fixture.start()
  const restoredRun = await fixture.rpc('run/get', { id: runId })
  invariant(restoredRun.run?.status === 'completed' && restoredRun.run?.phase === 'settled', 'README run did not reopen through the Host schema')
  invariant(restoredRun.run?.usage?.providerReported === true && restoredRun.run?.usage?.totalTokens === 9_400, 'README run lost provider usage while reopening')
  invariant(restoredRun.run?.quality?.rounds?.length === 2, 'README run lost its bounded review/repair timeline while reopening')
  page = await context.newPage()
  observe(page)
  const reopenedModeRequest = page.waitForRequest(
    request => isAgentTeamRequest(request, 'mode/get'),
    { timeout: 60_000 },
  )
  const snapshotResponse = page.waitForResponse(
    response => isAgentTeamRequest(response.request(), 'snapshot'),
    { timeout: 60_000 },
  )
  await page.goto(fixture.launchUrl, { waitUntil: 'domcontentloaded' })
  invariant((await snapshotResponse).ok(), 'README capture snapshot request failed')
  invariant((await reopenedModeRequest).postDataJSON()?.payload?.payload?.sessionId === sessionId, 'README capture did not reopen the seeded conversation')
  await completeOnboarding(page)

  const composer = page.locator('[data-testid="agent-team-composer"]')
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  const composerTrigger = composer.locator('button[aria-haspopup="dialog"]').first()
  await composerTrigger.filter({ hasText: /Team|小队/ }).waitFor({ state: 'visible', timeout: 15_000 })
  await composerTrigger.click()
  const modePanel = await controlledPanel(page, composerTrigger, 'README composer trigger')
  await modePanel.waitFor({ state: 'visible', timeout: 10_000 })
  await assertNoSeriousAccessibilityViolations('[data-testid="agent-team-composer"]', 'README composer state')
  await screenshot('v0.5-composer-mode.png')

  const editTeam = modePanel.getByRole('button').filter({ hasText: /Edit|编辑/ }).first()
  await editTeam.click()
  const settings = page.locator('[data-testid="agent-team-settings"]')
  await settings.waitFor({ state: 'visible', timeout: 15_000 })
  await settings.evaluate(element => { element.scrollTop = 0 })
  await assertNoSeriousAccessibilityViolations('[data-testid="agent-team-settings"]', 'README Settings state')
  await screenshot('v0.5-teams-settings.png')

  const recipesTab = settings.getByRole('tab', { name: /^(Recipes & data|配方与数据)/ }).first()
  await recipesTab.click()
  const recipes = settings.locator('[data-testid="agent-team-recipes"]')
  await recipes.waitFor({ state: 'visible', timeout: 10_000 })
  const exportedRecipe = await fixture.rpc('recipe/export', { id: seed.squadId })
  invariant(Array.isArray(exportedRecipe.agents) && exportedRecipe.agents.length === 3, 'README recipe export lost its three-member graph')
  const portableRecipe = structuredClone(exportedRecipe)
  Object.assign(portableRecipe.agents[0], {
    provider: 'portable-provider',
    model: 'portable-primary-model',
    fallbackProvider: 'portable-provider',
    fallbackModel: 'portable-fallback-model',
  })
  const recipeTextarea = recipes
    .getByText(/^(Recipe JSON|配方 JSON)$/)
    .locator('xpath=ancestor::label[1]')
    .locator('textarea')
  await recipeTextarea.fill(JSON.stringify(portableRecipe, null, 2))
  await recipes.getByRole('button', { name: /^(Preview|预览)$/ }).click()
  const recipePreview = recipes.locator('.atg-recipe-preview')
  await recipePreview.waitFor({ state: 'visible', timeout: 10_000 })
  invariant(await recipePreview.locator('.atg-route-remap').count() === 2, 'README recipe preview did not expose primary and fallback route remapping')
  invariant(await recipePreview.locator('.atg-preview-list').count() >= 2, 'README recipe preview did not show both conflicts and missing routes')
  await recipePreview.scrollIntoViewIfNeeded()
  await assertNoSeriousAccessibilityViolations('[data-testid="agent-team-recipes"]', 'README recipe state')
  await screenshot('v0.5-recipes.png')

  await page.keyboard.press('Escape')
  if (await settings.isVisible().catch(() => false)) {
    const close = page.getByRole('button', { name: /^(Close|关闭)$/ }).last()
    if (await close.isVisible().catch(() => false)) await close.click()
  }
  // Session view tabs are deliberately hidden on a blank Harness session.
  // Temporarily force Solo so this official, credential-free engagement cannot
  // dispatch a team, then restore the screenshot's selected squad.
  await fixture.rpc('mode/set', { sessionId, state: 'disabled' })
  await fixture.engageBrowserSession(sessionId)
  await fixture.rpc('mode/set', { sessionId, state: 'enabled', squadId: seed.squadId })
  const runNavigation = page.getByRole('button', { name: /^(Team runs|小队运行)$/ }).or(
    page.getByRole('tab', { name: /^(Team runs|小队运行)$/ }),
  ).first()
  await runNavigation.waitFor({ state: 'visible', timeout: 15_000 })
  await runNavigation.click()
  const runCenter = page.locator('[data-testid="agent-team-run-center"]')
  await runCenter.waitFor({ state: 'visible', timeout: 15_000 })
  const runCard = runCenter.locator(`[data-run-id="${runId}"]`)
  await runCard.waitFor({ state: 'visible', timeout: 15_000 })
  await runCard.locator('.atg-run-summary').click()
  await runCard.locator('.atg-run-detail').waitFor({ state: 'visible', timeout: 10_000 })
  await assertNoSeriousAccessibilityViolations('[data-testid="agent-team-run-center"]', 'README Run Center state')
  await screenshot('v0.5-run-center.png', runCard)

  const insightsTab = runCenter.getByRole('tab', { name: /^(Insights|洞察)$/ })
  await insightsTab.click()
  const insights = runCenter.locator('[data-testid="agent-team-insights"]')
  await insights.waitFor({ state: 'visible', timeout: 10_000 })
  await assertNoSeriousAccessibilityViolations('[data-testid="agent-team-insights"]', 'README Insights state')
  await screenshot('v0.5-insights.png', insights)

  await runCenter.getByRole('tab', { name: /^(Team runs|小队运行)$/ }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await runCard.scrollIntoViewIfNeeded()
  const narrowWidth = await runCenter.evaluate(element => {
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
  invariant(narrowWidth.content <= narrowWidth.visible + 2, `README narrow Run Center overflows horizontally (${narrowWidth.content}px > ${narrowWidth.visible}px)`)
  invariant(narrowWidth.left >= -2 && narrowWidth.right <= narrowWidth.viewport + 2, `README narrow Run Center is clipped (${narrowWidth.left}px..${narrowWidth.right}px of ${narrowWidth.viewport}px)`)
  invariant(narrowWidth.document <= narrowWidth.viewport + 2, `README narrow page requires horizontal scrolling (${narrowWidth.document}px > ${narrowWidth.viewport}px)`)
  await assertNoSeriousAccessibilityViolations('[data-testid="agent-team-run-center"]', 'README narrow state')
  await screenshot('v0.5-narrow.png')

  invariant(runtimeErrors.length === 0, `README capture emitted runtime errors:\n${runtimeErrors.join('\n')}`)
  for (const name of REQUIRED_CAPTURES) invariant((await stat(resolve(captureDirectory, name))).size > 10_000, `${name} was not captured`)
  await promoteCaptures()
  for (const name of REQUIRED_CAPTURES) {
    const digest = createHash('sha256').update(await readFile(resolve(outputDirectory, name))).digest('hex')
    process.stdout.write(`Capture sha256 ${digest} ${name}\n`)
  }
  process.stdout.write(`Captured six sanitized README screenshots from the isolated RC UI in ${outputDirectory}.\n`)
  failed = false
} finally {
  try {
    await context?.close()
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await fixture.close({ failed })
      } finally {
        if (failed) captureWorkspace.preserve()
        await captureWorkspace.cleanup()
      }
    }
  }
}
