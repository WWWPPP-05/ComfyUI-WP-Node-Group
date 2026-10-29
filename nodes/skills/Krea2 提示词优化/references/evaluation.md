# Prompt Evaluation and Repair Rubric

## Contents

1. Scoring dimensions
2. Contradiction checks
3. Failure diagnosis
4. Repair protocol
5. Acceptance criteria

## 1. Scoring dimensions

Score each 0–10.

### Subject clarity

Are subject count, priority, appearance, and ownership of attributes unambiguous?

### Relation clarity

Are actions, contacts, orientation, left/right placement, scale, and overlap explicit?

### Composition control

Are shot size, camera angle, subject placement, negative space, and scene layers usable?

### Lighting and color

Are source direction, softness, contrast, palette, and accent logic coherent?

### Material and style

Are materials concrete and style described through visible production properties?

### Typography

Is exact text quoted with line breaks, placement, hierarchy, and no-extra-text constraints?

### Contradiction risk

Do media, poses, camera angles, lighting, colors, and constraints agree?

### Krea 2 suitability

Does the prompt use coherent natural language and preserve room for intentional exploration?

### Efficiency

Does every phrase contribute visual control or intentional aesthetic direction?

## 2. Contradiction checks

Flag examples such as:

- full-body and extreme close-up simultaneously
- overhead and low-angle camera simultaneously
- soft flat light and hard high-contrast spotlight without a multi-light explanation
- matte and mirror-polished for the same surface
- exact one subject and a crowd
- centered composition and subject strictly on the far-right edge
- clean minimal background and dense decorative environment

## 3. Failure diagnosis

Map common output failures to prompt causes:

- Missing prop: prop appears too late or lacks interaction.
- Wrong clothing assignment: subjects not separated.
- Bad hand-object contact: grip geometry unspecified.
- Composition drift: camera and subject placement vague.
- Generic style: style words lack material and process cues.
- Excess clutter: too many equal-priority objects and adjectives.
- Cropped title: no safe margin or line-break instruction.
- Washed palette: dominant/accent relationship missing.
- Unwanted interpretation: prompt too short for a control task or creativity setting too high.

## 4. Repair protocol

1. Preserve successful prompt modules.
2. Identify the top three failure causes.
3. Rewrite only those modules.
4. Create one diagnostic variant per hypothesis.
5. Keep seed and non-tested settings fixed.
6. Compare outputs before making global changes.

## 5. Acceptance criteria

A production prompt is ready when:

- hard constraints are explicit
- no major contradictions remain
- subject ownership is clear
- spatial relationships are executable
- typography is exact when required
- style is defined through visible properties
- no generic filler dominates
- length matches the control requirement
- settings advice is correctly labeled as official, recommended, or workflow-dependent
