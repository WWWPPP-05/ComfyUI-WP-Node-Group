# Reverse Prompting and Reference Fusion

## Contents

1. Evidence-first reverse prompting
2. Observation checklist
3. Reconstruction prompt ordering
4. Close recreation workflow
5. Multi-image role mapping
6. Common errors

## 1. Evidence-first reverse prompting

Separate the process into three layers:

1. Observation: what is visibly present.
2. Inference: what is likely but not certain.
3. Generation instruction: how to express high-confidence evidence in a prompt.

Do not collapse these layers. An image can look cinematic without proving a specific camera, lens, film stock, or production method.

## 2. Observation checklist

### Image type and medium

- photograph, illustration, animation, 3D, collage, print, painting
- polished or raw
- realistic or stylized
- visible grain, brush, halftone, paper, scan, CGI, linework

### Subjects

- exact count
- primary/secondary hierarchy
- apparent adult status when relevant
- hair, face, silhouette, clothing
- pose and gesture geometry
- gaze and expression
- hand-object contact

### Composition

- ratio and orientation
- close-up, medium, full-body, wide
- camera height and angle
- wide-angle distortion or compressed perspective
- position in frame
- symmetry, diagonals, negative space
- crop points and occlusions

### Scene layers

- foreground
- middle ground
- background
- atmosphere
- scale relationships

### Light and color

- source direction
- hardness
- contrast
- rim/fill/backlight
- dominant and accent colors
- saturation and temperature

### Material and style

- reflective, matte, translucent, fibrous, wet, rough, polished
- surface response to light
- production clues

### Text

- exact transcription when legible
- line breaks
- placement
- font class
- color and effect

## 3. Reconstruction prompt ordering

Write in visible-priority order:

1. image type
2. primary subject and central action
3. composition and camera
4. subject appearance and interaction
5. environment and scale
6. lighting and palette
7. material and style
8. text
9. positive constraints

This order usually improves faithfulness compared with starting from abstract mood words.

## 4. Close recreation workflow

Prompting controls semantic content, but close recreation usually also requires image conditioning.

Recommended starting bands, clearly labeled as practical heuristics:

- Low denoise / low transformation: preserve layout and identity-like visual features.
- Moderate denoise: preserve broad composition while allowing material and style changes.
- High denoise: use the source mainly as inspiration.

Exact numeric bands are workflow- and sampler-dependent. If the user asks for numbers, provide conservative starting ranges and state they are not official Krea settings.

Potential controls:

- image-to-image latent initialization
- pose or skeleton control
- depth control
- edge/line control
- face/detail restoration
- style reference or IPAdapter-like conditioning
- regional or mask-based editing

Only name a node or model as compatible after checking the user's actual workflow.

## 5. Multi-image role mapping

Create a table internally or visibly:

| Image | Transfer | Do not transfer |
|---|---|---|
| 1 | pose, crop, gaze | clothing, face, background |
| 2 | palette, material | composition, subject identity |
| 3 | architecture | weather, people |

Resolve conflicts by the user's stated priority. If no priority exists, use:

1. subject and pose
2. composition
3. hard text constraints
4. palette/material
5. style/atmosphere

Do not average incompatible visual directions without telling the user.

## 6. Common errors

### Hallucinated detail

Fix: mark uncertainty; omit unsupported facts.

### Attribute leakage

Fix: use separate subject clauses and explicit ownership.

### Over-description

Fix: remove invisible micro-details and repeated mood adjectives.

### Wrong priority

Fix: put the most important subject/action/composition in the first two sentences.

### Style-only reverse prompt

Fix: describe pose, framing, space, and lighting before style adjectives.

### Prompt-only reconstruction promise

Fix: state the need for source-image conditioning when close matching is required.
