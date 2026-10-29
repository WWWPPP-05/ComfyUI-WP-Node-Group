# Krea 2 Prompt Suite

Krea 2 Prompt Suite is a Codex skill for creating, reverse-engineering, repairing, converting, evaluating, and batch-generating prompts specifically for Krea 2 workflows.

It treats Krea 2 as a natural-language image model: prompts should read like coherent visual direction, not loose keyword piles. Short prompts are still useful for exploration, while dense scene-graph prompts are better for controlled generation, recreation, typography, and production work.

## What It Is For

- Krea 2 text-to-image prompt creation.
- Image reverse prompting and close recreation planning.
- Expanding short prompts into controlled Krea 2 prompts.
- Repairing failed generations by rewriting only the failing prompt modules.
- Converting SDXL, Pony, FLUX, Midjourney, Ideogram, Chinese shorthand, or tag-style prompts into Krea 2 natural language.
- Multi-reference prompt planning with explicit image roles.
- Typography, posters, covers, packaging, UI mockups, and exact visible text prompts.
- RAW/Turbo guidance for local ComfyUI-style workflows.
- Hosted Medium/Large guidance when the user is working in the Krea hosted product or API.
- Qwen3-VL, RunningHub, and ComfyUI node system prompts for reverse prompting and prompt compilation.

## Core Prompt Philosophy

Krea 2 prompts work best when each visual attribute is attached to the correct subject.

Instead of:

```text
masterpiece, woman, cinematic, red, chair, dramatic, detailed
```

Prefer:

```text
A cinematic editorial portrait of one adult woman seated on a low red lacquer chair in the right third of the frame. Her torso turns slightly toward the camera, her left hand rests on the chair arm, and a broad field of dark negative space fills the left side for title placement.
```

The skill uses the internal K2-SCENE architecture:

1. Medium
2. Subject hierarchy
3. Appearance
4. Pose and interaction
5. Camera and composition
6. Environment and spatial layering
7. Lighting
8. Color system
9. Materials and texture
10. Style and production method
11. Typography and positive constraints

It only uses the modules that matter for the requested task.

## Modes

The skill routes requests into one or more modes:

- `create` - turn a concept into a new Krea 2 prompt.
- `reverse` - inspect an image and reconstruct a prompt from visible evidence.
- `recreate` - reverse prompt plus image-to-image control recommendations.
- `expand` - expand a short prompt without changing its subject or intent.
- `refine` - clean up an existing Krea 2 prompt.
- `repair` - diagnose a failed result and rewrite only the broken modules.
- `convert` - convert prompts from other model styles into Krea 2 format.
- `multi-reference` - assign explicit roles to reference images and fuse them safely.
- `typography` - create prompts with exact visible text and layout hierarchy.
- `variants` - generate controlled A/B variants.
- `evaluate` - score prompt clarity, contradictions, and model suitability.
- `node-system` - produce vision-analyzer or prompt-compiler system prompts.
- `batch` - create consistent prompt families.

## Output Profiles

Default production output includes:

- `Final Prompt (EN)`
- `Positive Constraints` when useful
- `Negative Prompt` only when the workflow supports it
- `Suggested Settings` when variant-specific guidance is needed
- `Assumptions` when uncertainty affects the result

Machine mode can emit JSON matching `assets/krea2-request.schema.json`.

## RAW, Turbo, And Hosted Krea 2

The skill deliberately separates Krea 2 surfaces:

- Open-weight Krea 2 RAW: more malleable, useful for experimentation, post-training, and LoRA training.
- Open-weight Krea 2 Turbo: fast few-step generation; at CFG 0, important exclusions should be written as positive visible constraints.
- Hosted Krea 2 Medium/Large: different product/API surface with hosted controls such as creativity, style references, moodboards, intensity, complexity, or movement when available.

It also explicitly avoids confusing Krea 2 with FLUX.1 Krea [dev].

## Included Files

- `SKILL.md` - main Codex skill instructions and routing.
- `references/krea2-core.md` - Krea 2 family separation, prompting behavior, RAW/Turbo/Hosted notes, and source links.
- `references/prompt-architecture.md` - K2-SCENE prompt architecture.
- `references/modes.md` - mode-specific procedures.
- `references/reverse-and-reference.md` - reverse prompting and multi-reference guidance.
- `references/genre-presets.md` - genre and visual style presets.
- `references/comfyui-node-prompts.md` - ComfyUI, RunningHub, and Qwen3-VL node prompt guidance.
- `references/evaluation.md` - prompt scoring and repair rubric.
- `assets/system-prompts/` - ready-to-use node system prompts.
- `assets/krea2-request.schema.json` - schema for machine-mode requests.
- `scripts/krea2_prompt_compiler.py` - deterministic compiler from structured JSON to a Krea 2 prompt paragraph.
- `scripts/self_check.py` - structural validation for the skill package.

## Install

Clone or copy this repository into your Codex skills directory:

```powershell
git clone https://github.com/AI-KSK/krea2-prompt-suite.git "$env:CODEX_HOME/skills/krea2-prompt-suite"
```

Or copy a local folder:

```powershell
Copy-Item -Recurse . "$env:CODEX_HOME/skills/krea2-prompt-suite"
```

Then start a new Codex turn. The skill will trigger on requests involving Krea 2, Krea2 prompts, reverse prompting, prompt expansion, ComfyUI or RunningHub Krea 2 workflows, node system prompts, typography prompts, and related Chinese requests such as `Krea2提示词`, `反推`, `扩写`, `改写`, `融合参考图`, or `节点系统提示词`.

## 中文说明

这个 skill 是 Krea 2 专用提示词套件，用来把概念、图片、失败案例、其他模型提示词或中文速记，整理成适合 Krea 2 的自然语言视觉说明。

它的重点不是堆 `masterpiece` 这类泛化标签，而是把主体、动作、构图、空间层次、光线、色彩、材质、文字和约束关系讲清楚。适合 Krea 2 Raw/Turbo、本地 ComfyUI/RunningHub 工作流，以及 Hosted Krea 2 Medium/Large 场景下的提示词设计。
