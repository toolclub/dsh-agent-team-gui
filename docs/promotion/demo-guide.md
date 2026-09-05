# 界面导览素材

这组素材来自仓库已有的 v0.5 产品截图。截图由真实 DSH Host 与产品 Client 渲染预置的、非敏感示例数据。它们展示界面与信息组织方式，**不是真实模型执行录屏，也不构成性能、耗时、成功率或 Token 消耗基准**。

- [完整视频](https://github.com/toolclub/dsh-agent-team-gui/blob/main/assets/promotion-walkthrough-zh.mp4)：约 80 秒，1920×1080，24 fps，H.264 MP4，中文合成旁白和内嵌中文说明。
- [GIF 预览](https://github.com/toolclub/dsh-agent-team-gui/blob/main/assets/promotion-walkthrough-preview.gif)：29.5 秒，960×540，无声，循环播放。
- [视频封面](https://github.com/toolclub/dsh-agent-team-gui/blob/main/assets/promotion-walkthrough-poster.png)：1920×1080 PNG。
- [旁白字幕](https://github.com/toolclub/dsh-agent-team-gui/blob/main/docs/promotion/demo-captions.zh-CN.srt)：中文 SRT；视频本身另有简短的内嵌说明。

所有内容画面持续显示 `界面演示 · 示例数据 / UI walkthrough · example data`。页脚进一步说明运行结果、耗时与用量为示例，未执行真实模型任务。Token 洞察一幕额外说明数字与完成率为示例。配方一幕明确停在冲突与模型路由预览，没有声称导入已成功。

## 分镜

| 时间 | 内容 |
| --- | --- |
| 00:00–00:10 | 插件介绍与示例数据说明 |
| 00:10–00:20 | 规划、实现、评审三个角色与团队配置 |
| 00:20–00:31 | 输入框旁选择团队、Solo、继承模式与单次覆盖 |
| 00:31–00:42 | Run Center 中的执行计划、依赖阶段与成员状态 |
| 00:42–00:52 | 预置的评审、修复轮次与负责人 |
| 00:52–01:02 | Token 分类、汇总与计量覆盖；强调样例数值 |
| 01:02–01:12 | 配方导入前的冲突与模型路由预览 |
| 01:12–01:20 | GitHub 地址、源码与安装说明、Star 提示 |

## 素材来源与边界

源文件为 `assets/v0.5-teams-settings.png`、`assets/v0.5-composer-mode.png`、`assets/v0.5-run-center.png`、`assets/v0.5-insights.png` 和 `assets/v0.5-recipes.png`。截图采集机制和证据分类见 [v0.5 验收记录](../v0.5-acceptance.md) 与 `scripts/quality/capture-readme.mjs`。

此导览只对这些图片作裁切、等比缩放、排版和场景淡入淡出。没有生成或伪造产品像素，没有加入模拟点击，也没有接触真实用户 DSH 配置或模型凭据。旁白由 macOS `say` 的 Tingting 音色合成，不是用户录音。素材没有背景音乐。

## 重建与检查

渲染脚本不启动应用、不连接模型、不改写源截图。需要 Python、Pillow、支持 `libx264` 的 ffmpeg，以及可用的中英文字体。默认字体和旁白使用 macOS 内置资源；其他系统可传入字体路径和 `--silent`。

```sh
python3 docs/promotion/demo-render.py --ffmpeg /path/to/ffmpeg
```

仅生成画面可加 `--frames-only`。中间画面、合成旁白、拼接片段、联系表与来源 SHA-256 清单保存在已忽略的 `.artifacts/promotion/` 中。发布文件写入上述 `assets/promotion-*` 路径，不修改原有素材或项目依赖。

检查导出视频时应完整解码，并抽取各分镜中部的画面，确认中文、URL、示例数据标记与源截图内容可读。旁白长度应短于对应分镜，计入 0.5 秒开场停顿；导出后还需检查视频与 GIF 的分辨率、时长和文件大小。源码或截图更新后应重新验证文案，不应沿用旧样例来宣称新版本执行效果。

2026-09-05 导出检查：MP4 完整解码 1,920 帧，无解码错误；容器时长 80.09 秒，大小 2,079,241 字节。8 个分镜中部的成片抽帧已查看，文字、示例标识与项目地址均可读。所有合成旁白都能在各自分镜内播完。GIF 为 8 帧、29.5 秒，大小 440,652 字节；PNG 封面为 272,330 字节。视频采用 `faststart`，便于下载时开始播放。
