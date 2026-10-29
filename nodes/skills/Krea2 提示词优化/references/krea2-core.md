# Krea 2 Core Reference

## Contents

1. Identity and family separation
2. Prompting behavior
3. Open-weight variants
4. Hosted variants and controls
5. Reference features
6. Parameter guidance
7. Facts versus recommendations
8. Official sources

## 1. Identity and family separation

Krea 2 is Krea's own text-to-image foundation model family. Do not confuse it with FLUX.1 Krea [dev], which is a separate earlier collaboration/release.

The open-weight Krea 2 family currently includes:

- Krea 2 RAW: undistilled/base checkpoint, diverse and malleable, intended for training, post-training, and experimentation.
- Krea 2 Turbo: distilled few-step checkpoint for fast inference.

The hosted Krea product/API uses variant names such as Medium and Large. Hosted parameters and model positioning must not be mixed with local RAW/Turbo sampler parameters.

## 2. Prompting behavior

Official Krea guidance recommends natural-language prompts. Long, detailed prompts can improve controlled results, while minimal prompts remain valid for open-ended exploration. Therefore, choose prompt length according to intent:

- Exploration: one clear concept with a small number of high-value style or composition cues.
- Controlled generation: dense but non-redundant visual instructions.
- Reverse reconstruction: detailed scene graph and explicit spatial relations.

For visible text, place the exact text in quotation marks and describe its position, line breaks, hierarchy, and type style.

Avoid assuming that keyword lists are forbidden. Compact comma-separated descriptions are acceptable when each phrase has a clear role. Avoid empty quality tags that do not specify visible information.

## 3. Open-weight variants

### RAW

Official repository example at the time this reference was written:

- 52 steps
- CFG 3.5
- trained for up to about 1K

Use RAW for:

- LoRA training
- post-training and research
- high-variation exploration
- workflows that need conventional CFG behavior

### Turbo

Official repository example at the time this reference was written:

- 8 steps
- CFG 0.0
- `mu 1.15`
- approximately 1K–2K output

Use Turbo for:

- fast generation
- deployment and batch work
- applying LoRAs trained on RAW

At CFG 0, do not rely on a traditional negative prompt. Rewrite major exclusions as positive statements, for example: `a clean composition containing only the described subjects, with broad simple forms and no additional decorative objects`.

## 4. Hosted variants and controls

Hosted Krea 2 uses a different surface from local open weights. Current official API positioning describes:

- Medium: smaller, faster, more stable, strong in illustration, anime, painting, and expressive styles.
- Large: more than twice the size of Medium, softer post-training, rawer texture, stronger flexibility and photorealism.

Hosted controls may include:

- creativity
- style references
- moodboards
- intensity
- complexity
- movement

Treat these controls as hosted features. Do not imply that a local ComfyUI checkpoint automatically exposes them.

## 5. Style references and moodboards

Official Krea material distinguishes:

- Style references: precise style transfer from a small number of images with per-image strengths.
- Moodboards: broader visual direction from a larger image collection, including palette, atmosphere, recurring concepts, and creative universe.

For local ComfyUI workflows, analogous reference behavior depends on the installed nodes and conditioning implementation. Do not promise parity without checking the workflow.

## 6. Parameter guidance

Always label parameters as one of:

- Official repository default
- Official hosted parameter
- Workflow-specific recommendation
- Experimental suggestion

Never present personal denoise or CFG recommendations as official Krea requirements.

General practical recommendations:

- Use fixed seeds for prompt comparisons.
- Change one module at a time during A/B testing.
- Keep dimensions compatible with the workflow and VAE requirements.
- For close image-to-image recreation, start with conservative denoise and increase only when more reinterpretation is desired.

## 7. Facts versus recommendations

Use this wording pattern:

- `Official guidance:` fact directly supported by an official source.
- `Recommended starting point:` practical but not guaranteed.
- `Workflow-dependent:` depends on ComfyUI implementation, scheduler, node package, quantization, or reference-conditioning stack.

## 8. Official sources

Verify current details against these sources when freshness matters:

- https://github.com/krea-ai/krea-2
- https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md
- https://github.com/krea-ai/krea-2/blob/main/docs/expansion.txt
- https://www.krea.ai/blog/krea-2-technical-report
- https://www.krea.ai/docs/developers/krea-2/overview
- https://www.krea.ai/docs/user-guide/features/krea-2
- https://huggingface.co/krea/Krea-2-Raw
- https://huggingface.co/krea/Krea-2-Turbo
