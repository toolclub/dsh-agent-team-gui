import type { SquadMemberHandoff } from '../types.ts'

/** One attributed delivery; full outputs remain in the durable run store. */
export interface HandoffDelivery {
  readonly agentId: string
  readonly status?: string
  readonly handoff?: SquadMemberHandoff
  readonly error?: string
}

function textAtMost(text: string, width: number): string {
  if (text.length <= width) return text
  if (width === 0) return ''
  const head = Math.ceil((width - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`
}

function project(delivery: HandoffDelivery, width?: number) {
  const trim = (text: string): string => width === undefined ? text : textAtMost(text, width)
  const list = (items: string[]): string[] => width === undefined
    ? [...items]
    : items.slice(0, Math.ceil(width / 64)).map(trim)
  return {
    agentId: delivery.agentId,
    ...(delivery.status === undefined ? {} : { status: trim(delivery.status) }),
    ...(delivery.handoff === undefined ? {} : { handoff: {
      summary: trim(delivery.handoff.summary),
      deliverables: list(delivery.handoff.deliverables),
      risks: list(delivery.handoff.risks),
      changedFiles: list(delivery.handoff.changedFiles),
    } }),
    ...(delivery.error === undefined ? {} : { error: trim(delivery.error) }),
    chainTruncated: width !== undefined,
  }
}

/**
 * Serialize complete JSON within a character budget, including JSON escaping.
 * Reserve every delivery's identity first and divide the remaining space fairly
 * so an early verbose member cannot displace later members. If even identity
 * records do not fit, report their omission explicitly instead of cutting JSON.
 */
export function boundedHandoffChain(deliveries: readonly HandoffDelivery[], maxChars = 12_000): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) throw new RangeError('handoff chain budget must be at least 256 characters')
  type Row = ReturnType<typeof project>
  const encode = (rows: Row[], omitted: number): string => {
    const truncated = omitted > 0 || rows.some(row => row.chainTruncated)
    return JSON.stringify({
      handoffs: rows,
      chainTruncated: truncated,
      omittedHandoffs: omitted,
      ...(truncated ? { note: 'Some handoff content is omitted. Full attributed outputs remain in Run Center.' } : {}),
    })
  }
  const complete = deliveries.map(delivery => project(delivery))
  const full = encode(complete, 0)
  if (full.length <= maxChars) return full

  const selected: Array<{ delivery: HandoffDelivery; row: Row }> = []
  for (const delivery of deliveries) {
    const row = project(delivery, 0)
    const rows = [...selected.map(item => item.row), row]
    if (encode(rows, deliveries.length - rows.length).length <= maxChars) selected.push({ delivery, row })
  }
  const omitted = deliveries.length - selected.length
  const rows = selected.map(item => item.row)
  const remaining = maxChars - encode(rows, omitted).length
  const extraPerRow = selected.length === 0 ? 0 : Math.floor(remaining / selected.length)

  for (const [index, { delivery, row }] of selected.entries()) {
    const budget = JSON.stringify(row).length + extraPerRow
    const fullRow = project(delivery)
    if (JSON.stringify(fullRow).length <= budget) {
      rows[index] = fullRow
      continue
    }
    let low = 0
    let high = Math.max(delivery.handoff?.summary.length ?? 0, delivery.error?.length ?? 0, 1_000)
    while (low < high) {
      const width = Math.ceil((low + high) / 2)
      if (JSON.stringify(project(delivery, width)).length <= budget) low = width
      else high = width - 1
    }
    rows[index] = project(delivery, low)
  }
  return encode(rows, omitted)
}
