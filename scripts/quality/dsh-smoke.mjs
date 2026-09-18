import { join } from 'node:path'
import { DshWebFixture } from './dsh-fixture.mjs'
import { invariant, readJson, REPOSITORY_ROOT } from './common.mjs'

const fixture = await DshWebFixture.create()
let failed = true
try {
  await fixture.install()
  const firstUrl = await fixture.start()
  const initial = await fixture.assertSnapshot()
  const unauthenticated = await fetch(new URL('/api/agentTeamGui', firstUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'unauthenticated-smoke', method: 'agentTeamGui', payload: { endpoint: 'snapshot', payload: {} } }),
    signal: AbortSignal.timeout(10_000),
  })
  invariant(unauthenticated.status === 401, 'plugin RPC accepted a request without the DSH browser session')
  const seed = await fixture.seedDefinitions()
  await fixture.assertDefinitions(seed)
  const versions = await fixture.rpc('squad/versions', { id: seed.squadId })
  invariant(Array.isArray(versions) && versions.length >= 1 && versions[0].memberSnapshots?.length === 1, 'team version does not contain an immutable member snapshot')
  const recipe = await fixture.rpc('recipe/export', { id: seed.squadId })
  invariant(recipe.format === 'agent-team-gui/recipe' && Array.isArray(recipe.agents), 'recipe/export returned an invalid portable document')
  const recipePreview = await fixture.rpc('recipe/preview', { doc: recipe })
  invariant(recipePreview.valid === true && recipePreview.squad?.id === seed.squadId, 'recipe preview rejected an exported team')
  const exampleRecipe = await readJson(join(REPOSITORY_ROOT, 'examples', 'full-stack-delivery.recipe.json'))
  invariant(Array.isArray(exampleRecipe.agents) && exampleRecipe.agents.length === 3, 'checked-in full-stack recipe has no three-member graph')
  const routeRemap = Object.fromEntries(exampleRecipe.agents.map(agent => [agent.id, { provider: seed.provider, model: seed.model }]))
  const examplePreview = await fixture.rpc('recipe/preview', { doc: exampleRecipe, routeRemap })
  invariant(
    examplePreview.valid === true
      && examplePreview.missingRoutes.length === 0
      && Number.isInteger(examplePreview.definitionRevision)
      && examplePreview.definitionRevision >= 0,
    'checked-in recipe cannot be remapped or returned no versioned preview in the fresh profile',
  )
  const exampleImport = await fixture.rpc('recipe/import', {
    doc: exampleRecipe,
    policy: 'copy',
    routeRemap,
    expectedRevision: examplePreview.definitionRevision,
  })
  invariant(typeof exampleImport.squadId === 'string' && exampleImport.agents === 3, 'checked-in recipe did not import atomically as a copy')
  const sessionId = 'agent-team-smoke-session'
  await fixture.rpc('mode/set', { sessionId, state: 'disabled' })
  const disabledBeforeRestart = await fixture.rpc('mode/get', { sessionId })
  invariant(disabledBeforeRestart.sessionOverride === 'disabled', 'mode/set did not persist explicit Solo')
  const nextTeam = await fixture.rpc('mode/next-set', { sessionId, state: 'team', squadId: seed.squadId })
  invariant(nextTeam.nextOverride?.squadId === seed.squadId, 'one-shot Team mode was not stored separately from explicit Solo')
  const exported = await fixture.rpc('export')
  invariant(exported !== null && typeof exported === 'object', 'export returned no document')
  await fixture.stop()
  const retentionHistory = await fixture.seedRetentionHistory(seed)
  const orphanedRunId = await fixture.seedOrphanedRun(seed)

  const secondUrl = await fixture.start()
  await fixture.assertDefinitions(seed)
  const retainedHistory = await fixture.rpc('run/list', { sessionId: retentionHistory.sessionId, limit: 200 })
  const retainedIds = retainedHistory.runs.map(run => run.id)
  invariant(
    retainedHistory.runs.length === retentionHistory.ids.length
      && retentionHistory.ids.every((id, index) => retainedIds[index] === id)
      && retainedHistory.runs.every(run => run.status === 'completed' && run.phase === 'settled'),
    `default retention changed or pruned the ${retentionHistory.ids.length} old history rows`,
  )
  const disabledAfterRestart = await fixture.rpc('mode/get', { sessionId })
  invariant(disabledAfterRestart.sessionOverride === 'disabled', 'explicit Solo did not survive restart')
  invariant(disabledAfterRestart.nextOverride?.squadId === seed.squadId, 'one-shot Team mode did not survive restart')
  const interrupted = await fixture.rpc('run/get', { id: orphanedRunId })
  invariant(interrupted.run?.status === 'interrupted', `orphaned run stayed ${interrupted.run?.status ?? 'missing'} after restart`)
  invariant(interrupted.run?.phase === 'settled' && typeof interrupted.run?.endedAt === 'number', 'recovered run has no settled phase/end time')
  invariant(interrupted.run?.members?.[0]?.status === 'interrupted', 'recovered run left its active member running')
  invariant(interrupted.run?.chain?.id === orphanedRunId && interrupted.run?.chain?.revision === 0, 'execution-chain metadata did not survive restart')
  invariant(interrupted.run?.members?.[0]?.recovery?.state === 'failed', 'in-flight diagnosis was not reconciled after restart')
  invariant(/restart|stopped/i.test(interrupted.run?.error ?? ''), 'recovered run does not explain why it was interrupted')
  const settledCancel = await fixture.rpc('run/cancel', { id: orphanedRunId })
  invariant(settledCancel.cancelled === false, 'run/cancel falsely reported cancelling an interrupted run')
  const runExport = await fixture.rpc('run/export', { id: orphanedRunId })
  invariant(runExport.format === 'agent-team-gui/run' && runExport.run?.id === orphanedRunId, 'run/export returned an invalid document')
  const insights = await fixture.rpc('insights/summary', { sessionId })
  invariant(insights.runCount === 1 && insights.usage?.providerReported === false, 'insights did not aggregate the interrupted run without inventing metering')
  await fixture.rpc('mode/set', { sessionId, state: 'enabled', squadId: seed.squadId })
  const enabled = await fixture.rpc('mode/get', { sessionId })
  invariant(enabled.sessionOverride === 'enabled' && enabled.mode?.squadId === seed.squadId, 'explicit Team mode was not applied')
  await fixture.rpc('mode/inherit', { sessionId })
  await fixture.rpc('mode/next-set', { sessionId, state: 'inherit' })
  const inherited = await fixture.rpc('mode/get', { sessionId })
  invariant(inherited.sessionOverride === 'inherit' && inherited.nextOverride === null, 'mode/inherit did not clear durable and one-shot conversation state')
  const runs = await fixture.rpc('run/list', { limit: 5 })
  invariant(Array.isArray(runs.runs), 'run/list did not return a runs array')
  const cleared = await fixture.rpc('run/clear', { sessionId, settledOnly: true })
  invariant(cleared.cleared === 1, `run/clear removed ${cleared.cleared ?? 'unknown'} rows instead of the one settled run`)
  const emptyHistory = await fixture.rpc('run/list', { sessionId, limit: 5 })
  invariant(emptyHistory.runs.length === 0, 'run/clear left settled session history behind')
  process.stdout.write(
    `Hermetic DSH smoke passed (API v${fixture.expectedApiVersion}, retention=${retentionHistory.ids.length}, install=${fixture.pluginSpec}, first=${firstUrl}, restart=${secondUrl}).\n`,
  )
  failed = false
} finally {
  await fixture.close({ failed })
}
