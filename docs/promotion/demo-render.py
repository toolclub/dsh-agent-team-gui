#!/usr/bin/env python3
"""Compose an explicitly labelled screenshot walkthrough; never runs DSH or a model.

Needs Pillow and ffmpeg with libx264. macOS `say` supplies optional synthetic narration.
Example: python demo-render.py --ffmpeg /path/to/ffmpeg
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / ".artifacts/promotion"
ASSETS = ROOT / "assets"
W, H = 1920, 1080
BG, INK, MUTED, GREEN = "#F1F3ED", "#172A26", "#62736D", "#147D60"
DISCLAIMER = "界面演示 · 示例数据  /  UI walkthrough · example data"
LIMIT = "真实界面截图导览 · 运行结果、耗时与用量均为示例；未执行真实模型任务。"

SCENES = [
    dict(duration=10, section="多 AGENT 协作", title=["给多 Agent 协作", "一个可视化工作台"],
         body=["配置角色，选择团队", "查看运行，复用协作方式"],
         image="v0.5-run-center.png", crop=(0, 103, 1278, 851),
         note="dsh-agent-team-gui · DeepSeek Harness 插件",
         caption="从团队配置到运行记录，把协作流程放进同一个界面。",
         narration="这是 DeepSeek Harness 的多智能体团队插件。以下为真实界面截图导览，所有运行数据都是示例。"),
    dict(duration=10, section="01 / 团队配置", title=["三种角色", "一套协作配置"],
         body=["产品规划 · 明确范围", "实现工程 · 完成改动", "质量评审 · 检查证据"],
         image="v0.5-teams-settings.png", crop=(608, 156, 1176, 852),
         note="Teams · Full-stack delivery · 3 members",
         caption="先把角色和协作说明保存为团队，后续对话可以继续选择。",
         narration="先创建团队，把产品规划、实现工程和质量评审三个角色，保存成可复用配置。"),
    dict(duration=11, section="02 / 输入框选择", title=["在当前对话", "选择协作方式"],
         body=["团队 / Solo / 继承项目默认", "也可只对下一条消息生效", "入口就在输入框旁"],
         image="v0.5-composer-mode.png", crop=(545, 8, 1327, 594),
         note="Composer · Team mode settings",
         caption="选择团队，并决定它应用于当前对话，还是仅下一条消息。",
         narration="在输入框旁选择团队。当前对话可使用团队、保持单人，或继承项目默认，也支持仅下一条消息。"),
    dict(duration=11, section="03 / RUN CENTER", title=["运行过程", "有迹可循"],
         body=["执行计划", "依赖阶段与成员状态", "在同一处查看"],
         image="v0.5-run-center.png", crop=(0, 0, 1278, 593),
         note="示例依赖阶段：规划 → 实现 → 评审",
         caption="展开运行记录，查看执行计划、依赖阶段与各成员状态。",
         narration="运行中心把执行计划、依赖阶段和成员状态放在一起。示例依次展示规划、实现和评审。"),
    dict(duration=10, section="04 / 评审与修复", title=["从评审到修复", "保留过程记录"],
         body=["查看评审轮次", "确认评审者与修复负责人", "画面展示预置的两轮样例"],
         image="v0.5-run-center.png", crop=(0, 443, 1278, 852),
         note="Review and repair · 此处为预置示例",
         caption="评审与修复记录展示轮次和负责人，便于回看协作过程。",
         narration="在评审与修复区，查看轮次、评审者和修复负责人。这里展示的是预置的两轮样例。"),
    dict(duration=10, section="05 / TOKEN 洞察", title=["看清用量", "花在哪个阶段"],
         body=["规划 / 成员执行 / 评审 / 修复", "按团队、成员、模型和项目汇总", "画面数值不代表实测表现"],
         image="v0.5-insights.png", crop=None,
         note="Insights · 所有数字与完成率均为示例值",
         caption="查看 Token 用量与计量覆盖；画面中的数字只用于说明界面。",
         narration="Token 洞察按规划、成员执行、评审和修复拆分用量。屏幕中的数字只用于演示，不代表实测。"),
    dict(duration=10, section="06 / 配方复用", title=["把协作方式", "保存成配方"],
         body=["导入前预览冲突", "检查缺失的模型路由", "完成映射，再应用配置"],
         image="v0.5-recipes.png", crop=(608, 156, 1176, 852),
         note="Recipes & data · 冲突与模型路由预览",
         caption="示例停在导入预览：先检查冲突和模型路由，再决定如何应用。",
         narration="配方让协作配置可以复用。导入前先预览冲突与缺失的模型路由，再选择对应配置。"),
    dict(duration=8, section="开始使用", title=["复用一支团队，", "从下一条消息开始。"],
         body=[], image=None, crop=None, note="",
         caption="查看源码与安装步骤；觉得有用，欢迎 Star。",
         narration="到 GitHub 查看源码和安装步骤。觉得有用，欢迎点亮一颗 Star。"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg"))
    parser.add_argument("--zh-font", default="/System/Library/Fonts/Hiragino Sans GB.ttc")
    parser.add_argument("--en-font", default="/System/Library/Fonts/Supplemental/Arial.ttf")
    parser.add_argument("--silent", action="store_true", help="Skip synthetic macOS narration")
    parser.add_argument("--frames-only", action="store_true")
    args = parser.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "frames").mkdir(exist_ok=True)

    def font(size, text=""):
        path = args.zh_font if any(ord(c) > 127 for c in text) else args.en_font
        return ImageFont.truetype(path, size)

    def label(draw, xy, value, size=26, fill=INK):
        draw.text(xy, value, font=font(size, value), fill=fill)

    def lines(draw, xy, values, size, spacing, fill=INK):
        for i, value in enumerate(values):
            label(draw, (xy[0], xy[1] + spacing * i), value, size, fill)

    def render_scene(index, scene):
        im = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(im)
        d.rounded_rectangle((60, 40, 100, 80), radius=12, fill=GREEN)
        label(d, (118, 41), "DSH / AGENT TEAM GUI", 28)
        d.rounded_rectangle((1205, 31, 1860, 88), radius=28, fill="#DFEAE0")
        label(d, (1228, 46), DISCLAIMER, 20, GREEN)
        d.line((60, 109, 1860, 109), fill="#D6DDD4", width=2)
        label(d, (80, 166), scene["section"], 23, GREEN)

        if scene["image"]:
            lines(d, (76, 249), scene["title"], 55, 84)
            lines(d, (81, 462), scene["body"], 27, 54, MUTED)
            label(d, (81, 776), "DSH TEAM", 17, GREEN)
            label(d, (81, 810), "Configure. Run. Reuse.", 26, MUTED)

            d.rounded_rectangle((702, 152, 1860, 901), radius=28, fill="#DCE2D8")
            d.rounded_rectangle((698, 146, 1856, 895), radius=28, fill="white")
            shot = Image.open(ASSETS / scene["image"]).convert("RGB")
            if scene["crop"]:
                shot = shot.crop(scene["crop"])
            shot = ImageOps.contain(shot, (1100, 651), Image.Resampling.LANCZOS)
            im.paste(shot, (1277 - shot.width // 2, 482 - shot.height // 2))
            d = ImageDraw.Draw(im)
            d.line((726, 833, 1828, 833), fill="#E8ECE6", width=2)
            label(d, (738, 853), scene["note"], 22, MUTED)
        else:
            lines(d, (76, 250), scene["title"], 80, 120)
            label(d, (82, 526), "dsh-agent-team-gui", 44, GREEN)
            d.rounded_rectangle((80, 638, 1840, 763), radius=25, fill=INK)
            label(d, (118, 674), "github.com/toolclub/dsh-agent-team-gui", 45, "white")
            d.rounded_rectangle((1482, 665, 1805, 735), radius=22, fill="#BFE7B6")
            label(d, (1531, 680), "Star 项目", 32, INK)
            label(d, (82, 814), "源码 · 安装说明 · 使用指南", 29, MUTED)

        d.rounded_rectangle((60, 928, 1860, 990), radius=17, fill=INK)
        cap = scene["caption"]
        bbox = d.textbbox((0, 0), cap, font=font(27, cap))
        label(d, ((W - bbox[2]) / 2, 944), cap, 27, "white")
        label(d, (61, 1005), LIMIT, 20, MUTED)
        label(d, (1680, 1005), f"{index + 1:02d} / {len(SCENES):02d}  ·  v0.5", 20, MUTED)
        for j in range(len(SCENES)):
            x = 60 + j * 226
            d.rounded_rectangle((x, 1053, x + 214, 1058), radius=2,
                                fill=GREEN if j <= index else "#D6DDD4")
        path = WORK / "frames" / f"scene-{index:02d}.png"
        im.save(path, optimize=True)
        return path

    frame_paths = [render_scene(i, scene) for i, scene in enumerate(SCENES)]
    shutil.copyfile(frame_paths[0], ASSETS / "promotion-walkthrough-poster.png")
    proof = Image.new("RGB", (1920, 1080), "#D6DDD4")
    for i, path in enumerate(frame_paths):
        thumb = Image.open(path).resize((640, 360), Image.Resampling.LANCZOS)
        proof.paste(thumb, ((i % 3) * 640, (i // 3) * 360))
    proof.save(WORK / "contact-sheet.jpg", quality=90)

    manifest = {
        "description": "Real product screenshot walkthrough with seeded example data, not model execution",
        "resolution": [W, H], "fps": 24, "durationSeconds": sum(s["duration"] for s in SCENES),
        "narration": "None" if args.silent else "Synthetic Chinese narration: macOS say / Tingting",
        "sourceScreenshots": {
            name: hashlib.sha256((ASSETS / name).read_bytes()).hexdigest()
            for name in sorted({s["image"] for s in SCENES if s["image"]})
        },
        "scenes": SCENES,
    }
    (WORK / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    def stamp(seconds):
        hours, rem = divmod(seconds, 3600)
        minutes, seconds = divmod(rem, 60)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d},000"

    start, subtitles = 0, []
    for index, scene in enumerate(SCENES):
        end = start + scene["duration"]
        subtitles.append(f"{index + 1}\n{stamp(start)} --> {stamp(end)}\n{scene['narration']}\n")
        start = end
    (ROOT / "docs/promotion/demo-captions.zh-CN.srt").write_text("\n".join(subtitles))
    if args.frames_only:
        return
    if not args.ffmpeg:
        raise SystemExit("Pass --ffmpeg /path/to/ffmpeg (libx264 support required)")

    def ffmpeg(*parts):
        subprocess.run([args.ffmpeg, "-y", "-hide_banner", "-loglevel", "warning", *map(str, parts)], check=True)

    clips = []
    for i, (frame, scene) in enumerate(zip(frame_paths, SCENES)):
        duration = scene["duration"]
        clip = WORK / f"clip-{i:02d}.mp4"
        cmd = ["-loop", "1", "-framerate", "24", "-i", frame]
        if not args.silent:
            voice = WORK / f"voice-{i:02d}.aiff"
            subprocess.run(["say", "-v", "Tingting", "-r", "230", "-o", str(voice), scene["narration"]], check=True)
            cmd += ["-i", voice]
        cmd += ["-t", duration, "-vf", f"fade=t=in:st=0:d=0.25,fade=t=out:st={duration-0.25}:d=0.25",
                "-c:v", "libx264", "-preset", "slow", "-tune", "stillimage", "-crf", "22", "-pix_fmt", "yuv420p"]
        if not args.silent:
            cmd += ["-af", f"adelay=500|500,apad=whole_dur={duration},afade=t=out:st={duration-0.25}:d=0.25",
                    "-c:a", "aac", "-b:a", "80k", "-ar", "44100", "-ac", "1"]
        cmd += ["-movflags", "+faststart", clip]
        ffmpeg(*cmd)
        clips.append(clip)
        print(f"Rendered scene {i + 1}/{len(SCENES)}", flush=True)

    concat = WORK / "clips.txt"
    # Generated paths are local and controlled by this script.
    concat.write_text("".join(f"file '{p.name}'\n" for p in clips))
    output = ASSETS / "promotion-walkthrough-zh.mp4"
    mux = ["-f", "concat", "-safe", "0", "-i", concat, "-c:v", "copy"]
    if not args.silent:
        # Re-encode the joined AAC timeline to remove per-clip encoder padding.
        mux += ["-c:a", "aac", "-b:a", "80k", "-af", "aresample=async=1:first_pts=0"]
    ffmpeg(*mux, "-movflags", "+faststart", output)

    # Compact silent preview: readable scene holds; full walkthrough carries narration.
    gif_frames = []
    for path in frame_paths:
        frame = Image.open(path).resize((960, 540), Image.Resampling.LANCZOS)
        gif_frames.append(frame.quantize(colors=128, method=Image.Quantize.MEDIANCUT))
    gif_frames[0].save(ASSETS / "promotion-walkthrough-preview.gif", save_all=True,
                       append_images=gif_frames[1:], duration=[3500] * 7 + [5000], loop=0,
                       optimize=True, disposal=2)
    manifest["outputs"] = {
        p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
        for p in [output, ASSETS / "promotion-walkthrough-preview.gif", ASSETS / "promotion-walkthrough-poster.png"]
    }
    (WORK / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest["outputs"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
