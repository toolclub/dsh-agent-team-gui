import { useSyncExternalStore } from 'react'

export const AGENT_TEAM_LOCALE_NS = 'agent-team-gui'

export interface LocaleSnapshot {
  active: 'zh' | 'en' | string
  revision: number
}

export interface LocaleService {
  getSnapshot(): LocaleSnapshot
  subscribe(listener: () => void): () => void
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}

const zh = {
  teams: '小队', members: '成员库', recipes: '配方与数据', runs: '小队运行', insights: '洞察',
  settingsIntro: '创建可复用的小队、成员与安全的执行策略。基础设置保持简单，高级能力按需展开。',
  refresh: '刷新', retry: '重试', save: '保存', saving: '正在保存…', cancel: '取消', discard: '放弃修改', edit: '编辑',
  create: '新建', clone: '复制', remove: '删除', export: '导出', import: '导入', preview: '预览', clear: '清理',
  loading: '正在读取小队…', reconnecting: '小队服务暂时不可用，正在重新连接。', reconnectDetail: '你的配置仍保存在本地。连接恢复后会自动重新读取。', incompatibleHost: 'Agent Team GUI 前后端版本不一致。请重启 DeepSeek Harness，然后刷新页面。',
  requestTimeout: '请求超时。控件已恢复，可以重试；小队服务恢复后也会自动重新连接。',
  slotCrashed: '小队界面遇到不兼容的数据', slotCrashedDetail: 'DeepSeek Harness 主界面仍可继续使用。请重试；若问题持续，请重启 Host 后刷新页面。',
  noTeams: '还没有小队', noTeamsHint: '从模板开始，或创建第一个小队。', createFirstTeam: '创建第一个小队', openSettings: '打开小队设置',
  noMembers: '还没有可复用成员。', newTeam: '新建小队', newMember: '新建成员', teamList: '小队列表', memberList: '成员列表',
  teamEditor: '小队编辑器', memberEditor: '成员编辑器', editorActions: '编辑操作', basic: '基础设置', orchestration: '编排策略', resilience: '可靠性与预算', permissions: '工具权限',
  teamName: '小队名称', teamNamePlaceholder: '例如：产品交付组', collaborationNote: '协作说明', collaborationPlaceholder: '说明小队擅长什么，以及成员如何合作。',
  selectMembers: '选择成员', fixedOrder: '固定顺序', fixedOrderHint: '关闭时由主 Agent 根据当前任务生成依赖图。', executionOrder: '执行顺序',
  executionMode: '执行方式', inheritPluginDefault: '继承插件默认', inheritCurrent: '继承（当前为 {value}）', fixedOrderSerial: '固定顺序（串行）', legacyPlanningFull: '保持旧默认（完整对话）', serial: '串行', parallel: '并行', contextMode: '上下文模式', spawn: '独立上下文', fork: '继承对话', chain: '串行传递',
  activationMode: '触发策略', always: '每次都运行', smart: '智能判断', manual: '仅手动触发', memberSelection: '成员选择', allMembers: '全部成员', adaptive: '按任务选择',
  responseMode: '响应方式', foreground: '前台完成后汇总', background: '后台运行', planningContext: '规划上下文', current: '仅当前请求', recent: '最近对话', full: '完整对话',
  plannerMaxTokens: '规划 Token 上限', teamLeader: '备用规划成员', noLeader: '自动选择', failurePolicy: '失败处理', continue: '继续其他成员', stop: '立即停止', retryOnce: '使用回退模型重试一次',
  maxConcurrency: '最大并发', memberTimeout: '成员超时（毫秒）', tokenBudget: '小队 Token 软预算', handoffSummaryLimit: '成员交接摘要上限（字符）', handoffSummaryHint: '留空使用默认 16,000。完整原始输出仍保存在运行中心；依赖与主模型提示词另有聚合边界。',
  qualityGate: '审核返工闭环', qualityGateHint: '审核不通过时，只让指定修复成员返工，并限制为最多两轮。', enableQuality: '启用质量门', reviewer: '审核成员', repairOwner: '修复成员', maxRounds: '最多返工轮数', criteria: '审核标准',
  memberName: '成员名称', rolePrompt: '角色提示词', provider: '提供方', model: '模型', maxTokens: '输出 Token 上限', primaryRoute: '主模型', fallbackRoute: '回退模型', allowTools: '允许工具', denyTools: '禁止工具',
  unsaved: '有未保存修改', unsavedConfirm: '当前编辑内容尚未保存。放弃修改并继续吗？', savedTeam: '小队“{name}”已保存。', savedMember: '成员“{name}”已保存。',
  externalChanges: '检测到来自其他窗口、导入或 Host 重连的配置变化。已保留你的未保存编辑；保存前请确认差异。', saveBeforePreview: '请先保存当前小队，再预览与已保存配置一致的计划。',
  remoteOverwriteConfirm: '保存期间检测到远端配置已变化。仍要用当前编辑覆盖远端版本吗？',
  deleteMemberAffected: '删除成员“{name}”会同时从这些小队移除：{names}。继续吗？', deleteMemberBlocked: '请先调整这些小队再删除成员：{names}。它是唯一成员或质量门负责人。', deleteSquadAffected: '删除小队“{name}”会永久删除其版本历史，并清除关联的会话选择、下一条选择和项目默认。继续吗？',
  required: '此字段不能为空。', chooseMemberError: '至少选择一名成员。', nameLength: '名称不能超过 120 个字符。', promptLength: '角色提示词不能超过 50,000 个字符。', longTextLength: '此说明不能超过 20,000 个字符。', memberCountError: '小队最多包含 32 名成员。', routeLength: '提供方和模型 ID 最多 200 个字符。', toolCountError: '允许和禁止列表各最多 256 个工具。', toolNameLengthError: '每个工具名最多 200 个字符。', positiveInteger: '请输入正整数。', agentTokenRange: '输出上限必须为 1–1,000,000 Token。', concurrencyRange: '最大并发必须为 1–32。', timeoutRange: '超时必须为 1,000–3,600,000 毫秒。', plannerRange: '规划上限必须为 256–8192 Token。', budgetRange: '小队预算必须为 1–100,000,000 Token。', handoffSummaryRange: '交接摘要上限必须为 1,000–32,000 个字符。',
  chainParallelConflict: 'Chain 上下文需要串行执行。', retryFallbackWarning: '选择回退重试时，所有成员都应配置回退模型。', fallbackPairError: '回退提供方和模型必须同时选择。', toolConflictError: '同一工具不能同时允许和禁止。', unknownToolWarning: '部分工具不在当前快捷目录中；它们可能来自对话 preset。可以保存，实际运行会按父对话 scope 验证。', qualityMembersError: '审核和修复成员必须属于当前小队。', qualityDistinctError: '审核和修复成员不能是同一个。',
  templates: '快速模板', templateHint: '使用已配置模型创建可继续编辑的小队。', development: '全栈开发', reviewTeam: '并行审查', productTeam: '产品设计',
  configureModels: '请先在设置的“模型”中配置至少一个模型。', templateCreated: '已创建“{name}”，可以继续调整成员和策略。', copyName: '{name} 副本', invalidJson: 'JSON 格式无效。',
  versions: '版本历史', restorePreview: '预览恢复', confirmRestore: '确认恢复此版本', restoreMembers: '将恢复 {count} 个成员快照', restoreAffectedTeams: '共享成员会同时改变这些小队：{names}', staleRestorePreview: '定义已发生变化，恢复预览已经失效。请重新预览这个版本。', diagnose: '检查配置', diagnosticsPassed: '小队检查通过。', diagnosticsFailed: '小队检查未通过。',
  modeTeam: '小队', modeSolo: '单人', modeInherited: '继承', modeLoading: '加载中', modePanel: '小队模式设置', durableChoice: '本对话模式', inheritProject: '继承项目默认', explicitTeam: '始终使用小队', explicitSolo: '始终使用单人',
  manualBadge: '手动', smartBadge: '智能', manualActiveHint: '这个小队设为“仅手动触发”：普通发送不会启动成员。可将下一条消息显式设为小队。', smartActiveHint: '这个小队会先判断任务是否需要多人协作；简单请求可能被有意跳过。', useNextTeamNow: '下一条使用这个小队',
  selectedTeam: '选择小队', projectDefault: '项目默认', setProjectDefault: '设为当前项目默认小队', clearProjectDefault: '取消当前项目默认小队', noProjectDefault: '未设置',
  nextMessage: '仅下一条消息', nextInherit: '跟随对话模式', nextTeam: '下一条使用小队', nextSolo: '下一条使用单人', nextOverrideActive: '一次性模式会在下一次发送后自动清除。', nextQueuedTeam: '已排队：{name}（{id}）', replaceNextTeam: '改为当前选中小队',
  lastRun: '最近运行', noRuns: '这个对话还没有小队运行记录。', close: '关闭', connectionError: '无法连接小队服务',
  runIntro: '查看计划、依赖阶段、成员输出与 Provider 上报的 Token 用量。', filterAll: '全部状态', filterLive: '进行中', filterFailed: '需要关注', filterDone: '已完成',
  statusPlanning: '规划中', statusQueued: '排队中', statusRunning: '运行中', statusCompleted: '已完成', statusPartial: '部分完成', statusFailed: '失败', statusCancelled: '已取消', statusInterrupted: '已中断', statusTimedOut: '已超时', statusSkipped: '已跳过',
  statusPending: '等待中', tokens: 'Token', retryOf: '重试自 {id}', phaseMember: '成员执行', phaseQuality: '审核', phaseRepair: '修复', repairAttempts: '{count} 次修复尝试', viewRun: '查看运行',
  protocolDeliveryWarning: '成员已交付非空文本，但 DSH 子运行以 error 停止；本次按完成处理，停止原因已保留。',
  stopRun: '停止运行', retryRun: '重试整次运行', retryMember: '仅重试此成员', exportRun: '导出运行', runGone: '这条运行记录已被清理或超出保留范围；列表已刷新。', clearHistory: '清理已结束历史', clearConfirm: '确定清理当前对话中已结束的运行历史吗？',
  plan: '执行计划', planDecisionRun: '运行', planDecisionSkip: '跳过', dependencyStages: '依赖阶段', dependencyStagesScroll: '可横向滚动的依赖阶段，共 {count} 个阶段', stage: '阶段 {n}', leadSynthesis: '主 Agent 汇总', handoffToLead: '交给主 Agent 汇总', handoffReady: '小队交接已就绪；不追踪主 Agent 的最终回答', handoffWaiting: '等待小队完成后交接', qualityLoop: '审核与返工',
  phaseQueued: '等待执行', phasePlanning: '正在规划', phaseMembers: '成员执行中', phaseQualityReview: '正在审核', phaseQualityRepair: '正在修复', phaseSynthesis: '正在生成小队交接', phaseSettled: '小队运行已结束', qualityRoundProgress: '第 {round}/{max} 轮',
  tokenUsage: 'Provider 上报的 Token 用量', tokenDisclaimer: '缓存读取通常价格更低。本插件没有可靠价格表，因此不会虚构金额。', uncachedInput: '非缓存输入', cacheRead: '缓存读取', cacheWrite: '缓存写入', output: '输出', plannerUsage: '规划器', totalUsage: '总用量', metering: '统计中…',
  memberUsage: '成员执行', qualityUsage: '审核', repairUsage: '修复', runCount: '运行次数', successRate: '完成率', cacheRate: '缓存命中占比', partialMetering: '部分计量', meteringCoverage: 'Token 计量覆盖 {metered}/{total} 次运行；未计量运行不会被虚构为 0。', meteringCoverageDetailed: '完整 {full} · 部分 {partial} · 未计量 {none}', sampleCoverage: '计量 {metered}/{total}', byTeam: '按小队', byModel: '按模型', byProject: '按项目', last7Days: '最近 7 天', last30Days: '最近 30 天', allTime: '全部时间',
  taskForPreview: '输入一个示例任务', taskPlaceholder: '例如：为登录流程补充可访问性测试', previewPlan: '试运行计划', previewOnly: '会调用规划模型并计入 Token，但不会启动任何成员。', plannerRoute: '规划模型', usageUnavailable: 'Provider 未上报用量',
  recipeTitle: '小队配方', recipeHint: '配方包含一个小队和成员定义，不包含凭证。导入前必须预览并映射不可用模型。', recipeJson: '配方 JSON', recipeFile: '选择配方文件', recipeUrl: 'HTTPS 配方地址', fetchPreview: '获取并预览',
  mergePolicy: '导入策略', merge: '按 ID 合并', copyPolicy: '创建副本', validRecipe: '配方校验通过', invalidRecipe: '配方无法导入', conflicts: '冲突', conflictMember: '成员冲突', conflictTeam: '小队冲突', conflictNameChange: '现有：{existing} → 导入：{incoming}', missingRoutes: '缺少模型路由', unknownMember: '未知成员', routeUnavailableReason: '原因：{message}', technicalDetails: '技术详情', routeRemap: '模型重新映射', applyRecipe: '确认导入配方', recipeAffectedTeams: '按 ID 合并会修改共享成员定义，并影响这些现有小队：{names}',
  backup: '全部定义备份', backupHint: '只迁移成员与小队定义；不包含运行历史、会话选择、项目默认或版本历史。导入前必须预览。', mergeImport: '合并定义', replaceImport: '替换全部定义', definitionBackupApplied: '定义备份已导入。', definitionCounts: '将导入 {agents} 名成员、{squads} 个小队', definitionConflicts: '冲突：{agents} 名成员、{squads} 个小队', definitionAffectedTeams: '共享成员定义变化会影响这些现有小队：{names}', definitionDeletions: '替换会删除 {agents} 名成员、{squads} 个小队、{modes} 条会话选择、{projects} 个项目默认和 {versions} 个版本。', applyDefinitionBackup: '确认导入定义', replaceBackupConfirm: '替换会删除预览中列出的现有定义和关联选择。确定继续吗？', staleRecipePreview: '定义或模型映射已变化，配方预览已经失效。请重新预览后再导入。', staleDefinitionPreview: '定义已发生变化，备份预览已经失效。请重新选择文件并预览。', recipeTooLarge: '配方 JSON 不能超过 4 MiB（按 UTF-8 计算）。', definitionTooLarge: '定义备份不能超过 16 MiB（按 UTF-8 计算）。', fileReadFailed: '无法读取文件：{message}', retention: '历史保留', retentionHint: '自动保留默认关闭，不会静默删除历史；需要时可配置正数上限，或手动清理已结束记录。',
  openConversationPreview: '打开一个对话后，才能使用其主 Agent 预览计划。', moveUp: '上移 {name}', moveDown: '下移 {name}',
  membersCount: '{count} 名成员', autoPlan: '动态依赖编排', fixedPlan: '固定顺序', dirtyBadge: '未保存', advanced: '高级设置',
} as const

const en: Record<keyof typeof zh, string> = {
  teams: 'Teams', members: 'Member library', recipes: 'Recipes & data', runs: 'Team runs', insights: 'Insights',
  settingsIntro: 'Build reusable teams, members, and safe execution policies. Basics stay simple; advanced controls expand on demand.',
  refresh: 'Refresh', retry: 'Retry', save: 'Save', saving: 'Saving…', cancel: 'Cancel', discard: 'Discard changes', edit: 'Edit',
  create: 'Create', clone: 'Clone', remove: 'Delete', export: 'Export', import: 'Import', preview: 'Preview', clear: 'Clear',
  loading: 'Loading teams…', reconnecting: 'The team service is temporarily unavailable. Reconnecting…', reconnectDetail: 'Your configuration remains stored locally and will reload after reconnecting.', incompatibleHost: 'Agent Team GUI client/host versions do not match. Restart DeepSeek Harness, then refresh the page.',
  requestTimeout: 'The request timed out. Controls are unlocked so you can retry; reconnection also continues in the background.',
  slotCrashed: 'The team view received incompatible data', slotCrashedDetail: 'The rest of DeepSeek Harness is still usable. Retry here; if it persists, restart the Host and refresh the page.',
  noTeams: 'No teams yet', noTeamsHint: 'Start from a template or create your first team.', createFirstTeam: 'Create first team', openSettings: 'Open team settings',
  noMembers: 'No reusable members yet.', newTeam: 'New team', newMember: 'New member', teamList: 'Team list', memberList: 'Member list',
  teamEditor: 'Team editor', memberEditor: 'Member editor', editorActions: 'Editor actions', basic: 'Basics', orchestration: 'Orchestration', resilience: 'Reliability & budget', permissions: 'Tool permissions',
  teamName: 'Team name', teamNamePlaceholder: 'e.g. Product delivery', collaborationNote: 'Collaboration note', collaborationPlaceholder: 'Describe what this team does well and how its members collaborate.',
  selectMembers: 'Select members', fixedOrder: 'Fixed order', fixedOrderHint: 'When off, the lead Agent creates a task-specific dependency graph.', executionOrder: 'Execution order',
  executionMode: 'Execution', inheritPluginDefault: 'Inherit plugin default', inheritCurrent: 'Inherit (currently {value})', fixedOrderSerial: 'Fixed order (serial)', legacyPlanningFull: 'Keep legacy default (full conversation)', serial: 'Serial', parallel: 'Parallel', contextMode: 'Context', spawn: 'Independent', fork: 'Inherit conversation', chain: 'Pass results serially',
  activationMode: 'Activation', always: 'Run every time', smart: 'Smart decision', manual: 'Manual only', memberSelection: 'Member selection', allMembers: 'All members', adaptive: 'Task-specific subset',
  responseMode: 'Response', foreground: 'Finish before synthesis', background: 'Run in background', planningContext: 'Planning context', current: 'Current request only', recent: 'Recent conversation', full: 'Full conversation',
  plannerMaxTokens: 'Planner token limit', teamLeader: 'Fallback planner', noLeader: 'Auto-select', failurePolicy: 'On failure', continue: 'Continue other members', stop: 'Stop immediately', retryOnce: 'Retry once with fallback',
  maxConcurrency: 'Max concurrency', memberTimeout: 'Member timeout (ms)', tokenBudget: 'Team soft token budget', handoffSummaryLimit: 'Member handoff summary limit (characters)', handoffSummaryHint: 'Leave blank for the 16,000 default. Complete raw output remains in Run Center; dependency and lead prompts keep separate aggregate bounds.',
  qualityGate: 'Review and repair loop', qualityGateHint: 'If review fails, only the chosen repair owner reruns, for at most two bounded rounds.', enableQuality: 'Enable quality gate', reviewer: 'Reviewer', repairOwner: 'Repair owner', maxRounds: 'Maximum repair rounds', criteria: 'Review criteria',
  memberName: 'Member name', rolePrompt: 'Role prompt', provider: 'Provider', model: 'Model', maxTokens: 'Output token limit', primaryRoute: 'Primary model', fallbackRoute: 'Fallback model', allowTools: 'Allowed tools', denyTools: 'Denied tools',
  unsaved: 'Unsaved changes', unsavedConfirm: 'This editor has unsaved changes. Discard them and continue?', savedTeam: 'Saved team “{name}”.', savedMember: 'Saved member “{name}”.',
  externalChanges: 'Configuration changed after an import, another window, or a Host reconnect. Your unsaved edits were preserved; review them before saving.', saveBeforePreview: 'Save this team first so the preview matches its stored configuration.',
  remoteOverwriteConfirm: 'The stored configuration changed while you were editing. Overwrite that newer version with your current draft?',
  deleteMemberAffected: 'Deleting “{name}” also removes it from these teams: {names}. Continue?', deleteMemberBlocked: 'Adjust these teams before deleting the member: {names}. It is the only member or owns the quality gate.', deleteSquadAffected: 'Deleting team “{name}” permanently deletes its version history and clears linked session choices, next-message choices, and project defaults. Continue?',
  required: 'This field is required.', chooseMemberError: 'Select at least one member.', nameLength: 'Names must be 120 characters or fewer.', promptLength: 'Role prompts must be 50,000 characters or fewer.', longTextLength: 'This description must be 20,000 characters or fewer.', memberCountError: 'A team can contain at most 32 members.', routeLength: 'Provider and model IDs must be 200 characters or fewer.', toolCountError: 'Allow and deny lists can each contain at most 256 tools.', toolNameLengthError: 'Each tool name must be 200 characters or fewer.', positiveInteger: 'Enter a positive integer.', agentTokenRange: 'Output limit must be between 1 and 1,000,000 tokens.', concurrencyRange: 'Concurrency must be between 1 and 32.', timeoutRange: 'Timeout must be between 1,000 and 3,600,000 ms.', plannerRange: 'Planner limit must be 256–8,192 tokens.', budgetRange: 'Team budget must be between 1 and 100,000,000 tokens.', handoffSummaryRange: 'Handoff summary limit must be between 1,000 and 32,000 characters.',
  chainParallelConflict: 'Chain context requires serial execution.', retryFallbackWarning: 'Every member should have a fallback model when retry-once is selected.', fallbackPairError: 'Fallback provider and model must be selected together.', toolConflictError: 'A tool cannot be both allowed and denied.', unknownToolWarning: 'Some tools are outside this shortcut catalog and may come from a conversation preset. Saving is allowed; dispatch validates the actual parent scope.', qualityMembersError: 'Reviewer and repair owner must belong to this team.', qualityDistinctError: 'Reviewer and repair owner must be different members.',
  templates: 'Quick templates', templateHint: 'Create an editable team using your configured model routes.', development: 'Full-stack delivery', reviewTeam: 'Parallel review', productTeam: 'Product design',
  configureModels: 'Configure at least one model in Settings → Models first.', templateCreated: 'Created “{name}”. You can keep adjusting members and policies.', copyName: '{name} Copy', invalidJson: 'Invalid JSON.',
  versions: 'Version history', restorePreview: 'Preview restore', confirmRestore: 'Restore this version', restoreMembers: 'Will restore {count} member snapshots', restoreAffectedTeams: 'Shared members will also change these teams: {names}', staleRestorePreview: 'Definitions changed, so this restore preview expired. Preview this version again.', diagnose: 'Check configuration', diagnosticsPassed: 'Team checks passed.', diagnosticsFailed: 'Team checks failed.',
  modeTeam: 'Team', modeSolo: 'Solo', modeInherited: 'Inherited', modeLoading: 'Loading', modePanel: 'Team mode settings', durableChoice: 'Conversation mode', inheritProject: 'Inherit project default', explicitTeam: 'Always use team', explicitSolo: 'Always stay Solo',
  manualBadge: 'Manual', smartBadge: 'Smart', manualActiveHint: 'This team is Manual: a normal send will not start members. Explicitly use the team for the next message instead.', smartActiveHint: 'This team first decides whether collaboration is useful; it may intentionally skip simple requests.', useNextTeamNow: 'Use this team next',
  selectedTeam: 'Select team', projectDefault: 'Project default', setProjectDefault: 'Set as this project’s default team', clearProjectDefault: 'Clear this project’s default team', noProjectDefault: 'Not set',
  nextMessage: 'Next message only', nextInherit: 'Follow conversation mode', nextTeam: 'Use team next', nextSolo: 'Use Solo next', nextOverrideActive: 'The one-shot choice is consumed automatically after the next send.', nextQueuedTeam: 'Queued: {name} ({id})', replaceNextTeam: 'Requeue selected team',
  lastRun: 'Last run', noRuns: 'No team runs in this conversation yet.', close: 'Close', connectionError: 'Cannot connect to the team service',
  runIntro: 'Inspect plans, dependency stages, member output, and provider-reported token usage.', filterAll: 'All statuses', filterLive: 'Live', filterFailed: 'Needs attention', filterDone: 'Completed',
  statusPlanning: 'Planning', statusQueued: 'Queued', statusRunning: 'Running', statusCompleted: 'Completed', statusPartial: 'Partial', statusFailed: 'Failed', statusCancelled: 'Cancelled', statusInterrupted: 'Interrupted', statusTimedOut: 'Timed out', statusSkipped: 'Skipped',
  statusPending: 'Pending', tokens: 'Tokens', retryOf: 'Retry of {id}', phaseMember: 'Member execution', phaseQuality: 'Review', phaseRepair: 'Repair', repairAttempts: '{count} repair attempt(s)', viewRun: 'View run',
  protocolDeliveryWarning: 'The member delivered non-empty text but the DSH child stopped with error. This delivery counts as completed and the stop reason remains recorded.',
  stopRun: 'Stop run', retryRun: 'Retry full run', retryMember: 'Retry this member only', exportRun: 'Export run', runGone: 'This run was cleared or aged out of retention; the list has been refreshed.', clearHistory: 'Clear settled history', clearConfirm: 'Clear settled run history for this conversation?',
  plan: 'Execution plan', planDecisionRun: 'Run', planDecisionSkip: 'Skip', dependencyStages: 'Dependency stages', dependencyStagesScroll: 'Scrollable dependency stages, {count} stages', stage: 'Stage {n}', leadSynthesis: 'Lead Agent synthesis', handoffToLead: 'Hand off to the lead Agent', handoffReady: 'Team handoff is ready; the lead Agent’s final reply is not tracked', handoffWaiting: 'Waiting to hand off after the team finishes', qualityLoop: 'Review and repair',
  phaseQueued: 'Waiting to run', phasePlanning: 'Planning', phaseMembers: 'Members running', phaseQualityReview: 'Reviewing', phaseQualityRepair: 'Repairing', phaseSynthesis: 'Preparing team handoff', phaseSettled: 'Team run settled', qualityRoundProgress: 'Round {round}/{max}',
  tokenUsage: 'Provider-reported token usage', tokenDisclaimer: 'Cache reads are usually priced lower. This plugin has no reliable price table and does not fabricate currency costs.', uncachedInput: 'Uncached input', cacheRead: 'Cache read', cacheWrite: 'Cache write', output: 'Output', plannerUsage: 'Planner', totalUsage: 'Total usage', metering: 'Metering…',
  memberUsage: 'Member execution', qualityUsage: 'Review', repairUsage: 'Repair', runCount: 'Runs', successRate: 'Completion rate', cacheRate: 'Cache-read share', partialMetering: 'Partially metered', meteringCoverage: 'Token metering covers {metered}/{total} runs; unmetered runs are never fabricated as zero.', meteringCoverageDetailed: 'Full {full} · partial {partial} · unmetered {none}', sampleCoverage: '{metered}/{total} metered', byTeam: 'By team', byModel: 'By model', byProject: 'By project', last7Days: 'Last 7 days', last30Days: 'Last 30 days', allTime: 'All time',
  taskForPreview: 'Enter a sample task', taskPlaceholder: 'e.g. Add accessibility tests to the sign-in flow', previewPlan: 'Plan preview', previewOnly: 'Calls the planner model and counts its tokens, but starts no members.', plannerRoute: 'Planner model', usageUnavailable: 'Usage not reported by provider',
  recipeTitle: 'Team recipes', recipeHint: 'A recipe contains one team and its member definitions, never credentials. Preview and remap unavailable models before import.', recipeJson: 'Recipe JSON', recipeFile: 'Choose recipe file', recipeUrl: 'HTTPS recipe URL', fetchPreview: 'Fetch and preview',
  mergePolicy: 'Import policy', merge: 'Merge by ID', copyPolicy: 'Create a copy', validRecipe: 'Recipe is valid', invalidRecipe: 'Recipe cannot be imported', conflicts: 'Conflicts', conflictMember: 'Member conflict', conflictTeam: 'Team conflict', conflictNameChange: 'Existing: {existing} → Incoming: {incoming}', missingRoutes: 'Missing model routes', unknownMember: 'Unknown member', routeUnavailableReason: 'Reason: {message}', technicalDetails: 'Technical details', routeRemap: 'Model remapping', applyRecipe: 'Import reviewed recipe', recipeAffectedTeams: 'Merging by ID changes shared member definitions and affects these existing teams: {names}',
  backup: 'Definition backup', backupHint: 'Migrates member and team definitions only—not run history, session choices, project defaults, or version history. Preview is required.', mergeImport: 'Merge definitions', replaceImport: 'Replace all definitions', definitionBackupApplied: 'Definition backup imported.', definitionCounts: 'Will import {agents} members and {squads} teams', definitionConflicts: 'Conflicts: {agents} members and {squads} teams', definitionAffectedTeams: 'Shared member-definition changes affect these existing teams: {names}', definitionDeletions: 'Replace will delete {agents} members, {squads} teams, {modes} session choices, {projects} project defaults, and {versions} versions.', applyDefinitionBackup: 'Import reviewed definitions', replaceBackupConfirm: 'Replace will delete the existing definitions and related selections shown in the preview. Continue?', staleRecipePreview: 'Definitions or model mappings changed, so this recipe preview expired. Preview it again before importing.', staleDefinitionPreview: 'Definitions changed, so this backup preview expired. Select the file and preview it again.', recipeTooLarge: 'Recipe JSON cannot exceed 4 MiB measured as UTF-8.', definitionTooLarge: 'Definition backup cannot exceed 16 MiB measured as UTF-8.', fileReadFailed: 'Could not read the file: {message}', retention: 'History retention', retentionHint: 'Automatic retention is off by default and never silently deletes history. Configure positive limits when wanted, or clear settled records manually.',
  openConversationPreview: 'Open a conversation to preview with its lead Agent.', moveUp: 'Move {name} up', moveDown: 'Move {name} down',
  membersCount: '{count} members', autoPlan: 'Dynamic dependency plan', fixedPlan: 'Fixed order', dirtyBadge: 'Unsaved', advanced: 'Advanced settings',
}

export type MessageKey = keyof typeof zh
export const DICTIONARIES: Record<'zh' | 'en', Record<MessageKey, string>> = { zh, en }

export type Translate = (key: MessageKey, params?: Record<string, unknown>) => string

export class ClientI18n {
  private readonly fallback = { active: 'zh', revision: 0 } as LocaleSnapshot
  private readonly translate: (key: string, params?: Record<string, unknown>) => string

  constructor(readonly locale?: LocaleService) {
    this.translate = locale?.bind(AGENT_TEAM_LOCALE_NS) ?? ((key, params) => interpolate(zh[key as MessageKey] ?? key, params))
  }

  readonly getSnapshot = (): LocaleSnapshot => this.locale?.getSnapshot() ?? this.fallback
  readonly subscribe = (listener: () => void): (() => void) => this.locale?.subscribe(listener) ?? (() => undefined)
  readonly t: Translate = (key, params) => this.translate(key, params)
}

export function useI18n(i18n: ClientI18n): { active: string; t: Translate } {
  const snapshot = useSyncExternalStore(i18n.subscribe, i18n.getSnapshot, i18n.getSnapshot)
  return { active: snapshot.active, t: i18n.t }
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => key in params ? String(params[key]) : match)
}
