# 推广素材：可复用的多模型开发小队

这些文字配合[界面导览](https://github.com/toolclub/dsh-agent-team-gui/blob/main/assets/promotion-walkthrough-zh.mp4)和
[首次任务教程](../first-team.zh-CN.md)使用。视频是基于实际产品截图制作的界面导览，截图包含
预置示例数据；不要将其称为真实任务录像、速度对比或成本测评。

## 社区短帖

我做了一个 DeepSeek Harness Web 插件：把规划、实现和审核保存成一支可复用的小队。

每个 Agent 可以独立选择模型和工具权限；发送任务后，可以查看分工、成员输出、审核与
Provider 上报的 Token 用量。小队可以跨项目、跨对话复用，也能通过不含凭证的 JSON 配方分享。

现在提供预编译安装包，以及一份三人小队配方。你可以先把三个成员都绑定到同一个可用模型，
再按教程做一个无依赖的待办清单，检查文件、测试和成员交接。

- 项目：https://github.com/toolclub/dsh-agent-team-gui
- 中文上手：https://github.com/toolclub/dsh-agent-team-gui/blob/main/docs/first-team.zh-CN.md
- 下载：https://github.com/toolclub/dsh-agent-team-gui/releases/tag/v1.0.1

这是非官方社区插件，需要可用的 DSH Web 环境。欢迎试用；有帮助的话，欢迎点个 Star。
也欢迎反馈实际任务、模型分工和卡住的步骤，我会据此继续改进。

## 掘金／知乎文章

建议标题：**给 DeepSeek Harness 配一支可复用的开发小队：规划、实现、审核各司其职**

让多个模型参与一个任务时，我希望保留的不只是某次对话的提示词，还有每个角色的模型选择、
职责、工具权限，以及后续可以再次使用的协作配置。

为此，我做了开源插件 **dsh-agent-team-gui**。它运行在 DeepSeek Harness 的 Web profile 中，
把成员和小队放进 Settings；日常使用时，在普通输入框旁选择已保存的小队即可。

### 可以怎样使用

以仓库附带的 Full-stack delivery 配方为例：

| 成员 | 负责什么 |
| --- | --- |
| Product planner | 拆出验收标准、边界条件和交接要求 |
| Implementation engineer | 完成文件修改，执行检查，提供实际输出 |
| Quality reviewer | 独立检查实现与测试证据，指出需要返工的地方 |

每名成员可以使用不同模型，也可以先使用同一条已配置的模型路由。对话主模型负责生成分工和
汇总结果；运行中心展示依赖关系、成员输出和审核过程，方便你检查每一步发生了什么。

### 从一个小任务开始

我准备了[完整教程](https://github.com/toolclub/dsh-agent-team-gui/blob/main/docs/first-team.zh-CN.md)：
导入 JSON 配方，映射自己的模型，在空临时项目中创建无依赖的待办清单。任务要求交付
`index.html`、`app.mjs`、`app.test.mjs`、`README.md`，并用 `node --test` 检查新增、空白拒绝、
完成切换、删除和计数。

这是供你复现的示例任务，目前没有附带该任务的真实模型运行成绩。演示视频使用产品截图与
示例数据，帮助理解操作入口。实际效果、耗时和 Token 用量取决于你的模型、工具和任务。

### 安装

先确认 DSH Web 可以正常运行，已有可用模型。插件 v1.0.1 提供包含编译产物的发布包：

```sh
dsh plugin --profile web add -w https://github.com/toolclub/dsh-agent-team-gui/releases/download/v1.0.1/dsh-agent-team-gui-1.0.1.tgz
dsh --profile web
```

如果 DSH 已经运行，安装后重启进程并刷新页面。预编译路径不需要插件的 Git `prepare` 构建
授权；版本、环境和常见问题都列在教程中。声明兼容 DSH `>=0.1.0-rc.5 <0.2.0`，当前发布
验证使用 DSH `0.1.1-rc.2`。

### 我希望收到什么反馈

最有用的是一个具体任务：你给哪些成员分配了什么模型，是否成功安装，是否完成了第一次任务，
以及有没有再次使用这支小队。运行中心能查看 Provider 实际上报的 Token；部分或缺失计量
不会填成零，也不会凭空估算价格。

项目采用 MIT 许可证。欢迎使用、改进和分享自己的配方；有帮助的话，欢迎给仓库点个 Star。

项目地址：https://github.com/toolclub/dsh-agent-team-gui

## B站发布信息

- 标题：**给 DeepSeek Harness 配一个多模型开发小队｜80 秒界面导览**
- 视频：`assets/promotion-walkthrough-zh.mp4`
- 封面：`assets/promotion-walkthrough-poster.png`
- 简介：开源 DSH Web 插件，把规划、实现、审核保存为可复用小队。视频展示实际产品截图，
  使用预置示例数据，并非真实模型任务录像或性能测评。安装包、示例配方和上手教程见
  https://github.com/toolclub/dsh-agent-team-gui 。欢迎试用，有帮助的话欢迎 Star。
- 标签建议：DeepSeek、开源、AI编程、多智能体、开发工具。

## 试用反馈模板

```text
安装来源和插件版本：
OS / Node / pnpm / DSH 版本：
这次想完成的任务：
小队角色和模型（不含凭证）：
是否安装成功：
是否生成了可核验的结果：
具体失败步骤或最有帮助的功能：
几天后是否又使用了这支小队：
```

反馈入口：https://github.com/toolclub/dsh-agent-team-gui/discussions/1
