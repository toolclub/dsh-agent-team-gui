# 小队按需使用：完整流程与边界

本页描述 v1.3.0 的行为。设置 → 小队 → **小队使用方式**：

- **主 Agent 按需使用**：先进行主 Agent 原本就需要的推理。简单任务直接完成，缺少信息先询问，需要分工才调用小队。没有额外的路由 Agent。
- **Host 强制派工**：Host 先进入小队调度，随后遵循规划策略。Smart 可让规划器跳过；Manual 要求显式下一条 Team 或手动运行操作。

新建小队和内置模板默认按需使用；已保存或导入的配置保持原选择，旧记录缺少该字段时仍按原来的 guaranteed 解释。

```mermaid
flowchart TD
    U[用户发送消息] --> E{有效顶层文本消息且未取消？}
    E -->|否| BASE[交还 DSH 原流程；不消费下一条选择]
    E -->|是| O{本轮显式覆盖？}
    O -->|下一条 Solo| SOLO[记录本轮 Solo；主 Agent 直接处理]
    O -->|下一条 Team| FORCE[Host 直接进入调度]
    O -->|没有| M{对话选择或继承项目默认}
    M -->|Solo 或无有效小队| NORMAL[主 Agent 正常处理]
    M -->|有小队| MANUAL{仅手动策略？}
    MANUAL -->|是| SOLO2[主 Agent 直接处理；等待用户显式触发]
    MANUAL -->|否| MODE{小队使用方式}
    MODE -->|Host 强制派工| FORCE
    MODE -->|主 Agent 按需使用| LEAD[主 Agent 读取任务、上下文和成员能力]
    LEAD --> J{分工是否有价值？}
    J -->|简单或可直接完成| ANSWER[直接完成并回答用户]
    J -->|缺少必要信息| ASK[询问用户，等待补充]
    J -->|需要协作| TOOL[调用 dispatch_to_squad]
    TOOL --> GATE{校验 Solo、手动、所选小队、参数和消息防重复}
    GATE -->|拒绝| NOTICE[向主 Agent 返回明确原因]
    GATE -->|通过| RUN[创建执行链和运行记录]
    FORCE --> CLAIM{首次派工是否已受理？}
    CLAIM -->|是| BASE
    CLAIM -->|否| BG{前台或后台}
    BG -->|前台| RUN
    BG -->|后台| QUEUE[持久排队并启动后台运行]
    QUEUE --> ACK[主 Agent 只确认已启动；用户在运行中心跟进]
    QUEUE --> RUN
    RUN --> P{已有分工、固定顺序或重放计划？}
    P -->|有| VALIDATE[整理并验证执行计划]
    P -->|没有| PLANNER[启动无工具规划器；分工与依赖]
    PLANNER -->|Smart 合法跳过| SKIP[保存 skipped；交回主 Agent 直接处理]
    PLANNER -->|有效计划| VALIDATE
    PLANNER -->|规划失败或无效| FALLBACK[生成确定性的角色分工]
    FALLBACK --> VALIDATE
    VALIDATE --> EXEC[按依赖、并发和预算启动成员]
    EXEC --> RESULT{成员结果}
    RESULT -->|成功| SAVE[保存成果与用量]
    RESULT -->|失败| POLICY{失败策略}
    POLICY -->|continue 或 stop| SAVEFAIL[记录失败，继续其他任务或停止调度]
    POLICY -->|retry-once| CLASSIFY[分类失败并检查已有进展]
    CLASSIFY -->|额度、取消或预算耗尽| SAVEFAIL
    CLASSIFY -->|明确启动连接故障| RETRY[原成员最多重试一次，携带进展]
    CLASSIFY -->|任务问题或不明确| DIAG[系统诊断：证据、原因假设、建议和不确定性]
    DIAG -->|有证据支持的临时故障| RETRY
    DIAG -->|结构性问题、停止或诊断失败| SAVEFAIL
    RETRY --> RETRYRESULT{重试结果}
    RETRYRESULT -->|成功| SAVE
    RETRYRESULT -->|仍失败| SAVEFAIL
    SAVE --> REST[推进剩余任务，保存本轮结果]
    SAVEFAIL --> REST
    REST -->|还有可执行任务| EXEC
    REST -->|本轮结束| Q{满足条件且启用质量门？}
    Q -->|是| REVIEW[审核；按配置最多返工两轮]
    Q -->|否| SETTLE[结算本轮状态与用量]
    REVIEW --> SETTLE
    SETTLE --> RETURN{运行方式}
    RETURN -->|后台| CENTER[运行中心保存完整结果；不自动注入已结束的主回复]
    RETURN -->|前台| SYNTH[主 Agent 接收结果及失败诊断]
    SYNTH --> NEXT{下一步}
    NEXT -->|完成或解释阻塞| ANSWER
    NEXT -->|需要补充信息| ASK
    NEXT -->|需要修订且允许继续| CONT[continue_squad_run：原运行、版本、进展复核、剩余任务]
    CONT --> CG{校验来源、版本、次数、预算和依赖}
    CG -->|重复请求| EXIST[返回已受理结果，不重复启动]
    CG -->|拒绝| NOTICE
    CG -->|通过| SUCCESSOR[同一执行链创建后续运行；复用独立成功成果，重做受影响下游]
    SUCCESSOR --> VALIDATE
    NOTICE --> SYNTH
```

## 审视后的规则

| 边界 | 行为 |
| --- | --- |
| 简单任务 | pre-step 不启动规划器或成员，也不创建运行记录/派工占用；模型仍须自行判断复杂度 |
| 已拒绝、已取消、子 Agent、无新用户文本 | Host 不自动派工，不消费下一条选择 |
| 仅下一条 Solo | 覆盖本轮小队默认，生成明确通知；工具调用也被程序拒绝 |
| 持久 Solo | 模型不能通过全局工具绕过；显式下一条 Team 仍可覆盖一次 |
| 仅手动 | 普通消息不能自动派工，也不能被模型调用小队绕过；使用下一条 Team 或手动运行操作 |
| 换一个 squadId | 有生效小队时，模型不能悄悄派给另一支小队 |
| Adaptive/DAG | 派工时省略 assignments/memberOrder 才走自动规划；显式分工和固定顺序绕过规划器 |
| 固定顺序 | 实际执行全部配置成员；界面显示有效选人方式，不再把智能跳过当成仍然有效 |
| 智能跳过 | 发生在真正进入调度后的规划阶段，已经消耗规划调用；同一消息不能再首次派工 |
| 后台 | 模型工具路径等待结果；后台仅用于 Host 路径，界面显示这个有效限制 |
| 配置更新 | 保存可持久化，撤销不会覆盖原配置；旧记录、复制、导入保留各自选择 |
| 失败继续 | 主 Agent 决定修订；同一消息、同一执行链最多继续一次，沿用原软预算与防重复收据 |
| 失败不等于没做 | 继续任务携带旧产物与进展；独立成功任务复用，受影响下游重新验证 |

模型的复杂度判断是提示词引导，不是数学保证。测试能确认 Host 不抢先派工、工具边界有效、
配置与提示词一致，不能证明所有模型都永远不把简单任务派给小队。

当前继续能力仍保留每个成员一个任务节点；需要用户补充信息时结束自动推进，后续新用户
消息走新的请求处理。后台运行不会自动替换已经发出的主 Agent 回复。普通主 Agent 推理
用量不计入插件运行统计，团队预算基于已报告用量，是软限制。
