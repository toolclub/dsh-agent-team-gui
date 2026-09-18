import type { ToolGuard, ToolRuntime } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Plugin-owned in-process children may not invoke further delegation tools. */
    agentTeamGuiChild?: boolean
    /** Preserve explicit denies for scope-local tools that restrict() cannot name. */
    agentTeamGuiDeniedTools?: readonly string[]
  }
}

interface ToolShape {
  readonly name: string
  readonly parameters?: unknown
}

const DELEGATION_NAMES = new Set(['dispatch_to_squad', 'subagent', 'subagent_fork', 'subagent_spawn', 'workflow'])

/** Recognize official delegation contracts even when optional route controls are added. */
export function isDelegationTool(tool: ToolShape): boolean {
  if (DELEGATION_NAMES.has(tool.name)) return true
  const parameters = tool.parameters as {
    properties?: Record<string, { type?: string }>
    required?: unknown
  } | undefined
  const properties = parameters?.properties
  if (properties === undefined) return false
  const required = new Set(Array.isArray(parameters?.required) ? parameters.required : [])
  return (properties['description']?.type === 'string' && required.has('description')
      && properties['prompt']?.type === 'string' && required.has('prompt'))
    || (properties['script']?.type === 'string' && required.has('script')
      && properties['meta']?.type === 'object' && required.has('meta'))
}

/** Catch scoped/renamed delegation at execution, including nested PTC calls. */
export function teamChildToolGuard(tools: Pick<ToolRuntime, 'get'>): ToolGuard {
  return execution => {
    if (execution.agent?.options.agentTeamGuiChild !== true) return undefined
    if (execution.agent.options.agentTeamGuiDeniedTools?.includes(execution.name)) {
      return 'This tool is denied by the configured squad member policy.'
    }
    const definition = tools.get(execution.name, execution.agent)
    if (isDelegationTool(definition ?? { name: execution.name })) {
      return 'Squad members cannot create further subagents or workflows; return a handoff to the lead Agent.'
    }
    return undefined
  }
}
