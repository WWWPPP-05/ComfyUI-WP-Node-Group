# Multi-Function Mode Guide

## Contents

1. Create
2. Reverse
3. Recreate
4. Expand
5. Refine
6. Repair
7. Convert
8. Multi-reference
9. Typography
10. Variants
11. Evaluate
12. Node-system
13. Batch

## 1. Create

Input: concept, use case, aspect ratio, desired aesthetic.

Procedure:

1. Infer the visual hierarchy.
2. Choose a suitable medium and composition.
3. Build only the modules required for control.
4. Return the requested number of prompts.

Default output: one production prompt and one deliberately more exploratory alternative when the user asks for options.

## 2. Reverse

Input: one image.

Procedure:

1. Observe before interpreting.
2. Capture subject count, appearance, pose, contact, camera, layers, lighting, palette, materials, medium, and text.
3. Build a prompt that reproduces the visible result rather than describing its emotional meaning alone.
4. Mark uncertainty.

Default output: final English prompt plus a short Chinese observation note only when useful.

## 3. Recreate

Input: one image and a target image-to-image workflow.

Add to reverse mode:

- identify which information should be controlled by the source image rather than the text prompt
- recommend conservative, moderate, and creative denoise bands
- identify whether pose, edge, depth, face, style, or composition reference control is likely useful
- warn that exact reconstruction cannot be guaranteed by prompt alone

Do not fabricate node compatibility.

## 4. Expand

Input: a short prompt.

Rules:

- Preserve the original subject, action, count, colors, and spatial relations.
- Do not introduce important new characters, animals, props, or locations without permission.
- Add camera, lighting, material, and spatial detail only where it supports the original intent.
- If the short prompt is intentionally open-ended, provide both a restrained expansion and an exploratory expansion.

## 5. Refine

Input: an existing Krea 2 prompt.

Procedure:

1. Preserve hard constraints.
2. Remove redundancy, contradictions, generic quality tags, and ambiguous ownership.
3. Improve relation language and visual hierarchy.
4. Return a clean replacement prompt, not a commentary-heavy answer unless analysis is requested.

## 6. Repair

Input: prompt plus failed output or a failure description.

Classify failures:

- subject omission
- attribute leakage
- pose or hand failure
- composition drift
- wrong camera perspective
- style dilution
- clutter
- text failure
- color mismatch
- over-literal or over-creative interpretation

Rewrite only the failing modules first. Keep successful modules stable for valid A/B testing.

## 7. Convert

### From tag-based SD/Pony

- Resolve tags into grammatical subject-linked clauses.
- Remove scoring tags and generic quality boilerplate.
- Convert weights into explicit hierarchy or spatial priority.
- Translate negative tags into positive visible constraints when targeting Turbo.

### From Midjourney

- Remove unsupported command flags.
- Convert stylize/chaos intent into descriptive style and variation guidance.
- Preserve aspect ratio as metadata rather than embedding command syntax.

### From Ideogram

- Preserve exact typography and layout instructions.
- Convert structured JSON into coherent prose while retaining field semantics.

### From FLUX or Qwen-Image

- Most natural-language content can be preserved.
- Tighten subject binding, space, material, and style cues for Krea 2.

## 8. Multi-reference

Assign each image exactly one or more explicit roles:

- subject identity/appearance
- pose
- composition
- clothing
- object design
- palette
- texture
- lighting
- style
- atmosphere

Create a role map before the final prompt. State what must not transfer from each image.

Example:

- Image 1: pose and framing only; do not transfer clothing or background.
- Image 2: palette and material language only; do not transfer character identity.
- Image 3: background architecture only.

Then write the final prompt as a unified scene rather than mentioning “Image 1” inside the generation prompt unless the target system supports image-reference tokens.

## 9. Typography

Prioritize exact text and layout before decorative style.

Include:

- exact quoted content
- line count and line breaks
- location and safe margins
- hierarchy and font category
- color and effects
- negative space
- explicit `no additional text` instruction

If exact spelling is mission-critical, recommend post-production or a typography-focused model/workflow as a risk note rather than claiming guaranteed accuracy.

## 10. Variants

Use controlled experimental design:

- Keep seed and all non-tested parameters fixed when possible.
- Change one major module per version.
- Label the changed variable.

Useful axes:

- camera angle
- medium
- lighting
- palette
- degree of motion
- complexity
- prompt literalness versus creativity
- subject scale
- negative space

Do not return superficially reworded duplicates.

## 11. Evaluate

Score 0–10 on:

- subject clarity
- relation clarity
- composition control
- lighting and color control
- material/style specificity
- typography control
- contradiction risk
- model suitability
- efficiency

Return the three highest-impact fixes before rewriting.

## 12. Node-system

Create system prompts for one of two roles:

### Vision analyzer

Image → structured visual evidence. It should not embellish or write final marketing prose.

### Prompt compiler

Structured evidence → Krea 2 prompt. It should preserve evidence, resolve structure, and avoid invention.

Use two-stage processing for the most reliable reverse-prompt workflow.

Read [comfyui-node-prompts.md](comfyui-node-prompts.md) and copy assets from `assets/system-prompts/`.

## 13. Batch

For multiple titles or scenes:

1. Define a shared visual system: ratio, palette family, typography grid, medium, detail level, and brand consistency.
2. Define controlled variation fields: person, pose, prop, background motif, accent color, and title.
3. Generate one prompt per item without shortcuts such as “same as above.”
4. Validate that each title is exact and each subject remains distinct.
