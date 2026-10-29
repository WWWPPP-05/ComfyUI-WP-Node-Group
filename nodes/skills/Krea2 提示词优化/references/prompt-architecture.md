# K2-SCENE Prompt Architecture

## Contents

1. Design rule
2. Module definitions
3. Length profiles
4. Constraint language
5. Typography grammar
6. Ambiguity control
7. Final compilation order

## 1. Design rule

A strong Krea 2 prompt is a coherent visual specification, not a checklist that blindly includes every possible field. Use only modules that materially affect the image.

The K2-SCENE architecture contains eleven modules:

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

## 2. Module definitions

### Medium

State what type of image is being made:

- editorial fashion photograph
- cinematic film still
- hand-painted anime key visual
- minimalist vector poster
- stylized 3D product render
- traditional Chinese ink painting
- mixed-media analog collage

Avoid conflicting media unless deliberate hybridization is the concept.

### Subject hierarchy

Specify:

- exact count
- primary versus secondary subject
- scale relationship
- frame position
- silhouette priority

Example:

`One adult woman is the unmistakable primary subject on the right third of the frame; an enormous white boar rises behind her at roughly four times her height.`

### Appearance

Use generation-relevant visible traits:

- age category when relevant and visually supported
- hair shape and movement
- face shape and expression
- body silhouette
- clothing construction
- accessories

Avoid unsupported identity, ethnicity, brand, or biography claims.

### Pose and interaction

Describe:

- stance or seated/crouched geometry
- torso rotation
- limb positions
- weight distribution
- gaze direction
- hand-object contact
- interaction between subjects

Example:

`She crouches with both knees bent and her weight low over her heels; her torso twists slightly toward the viewer, her left hand rests on her thigh, and her right hand makes a loose outward fanning gesture.`

### Camera and composition

Choose only meaningful controls:

- shot size
- camera height
- viewing angle
- wide/normal/telephoto perspective
- frame placement
- symmetry or asymmetry
- leading lines
- negative space
- focus and depth of field

Do not invent a lens model or focal length unless it is visually necessary or requested.

### Environment and spatial layering

Describe foreground, middle ground, background, and atmosphere. State relationships rather than listing objects.

Example:

`Broad sheets of wet black ink spread across pale stone in the foreground; the woman occupies a circular platform in the middle ground; temple columns dissolve into mist behind the animal.`

### Lighting

Use:

`source + direction + softness + shadow behavior + highlight behavior + secondary light`

Example:

`Soft diffused daylight enters from the upper left, producing gentle facial shadows and a broad pearlescent highlight across the animal's white fur; a faint warm rim light separates both figures from the mist.`

### Color system

Define:

- dominant colors
- secondary colors
- accent color
- saturation
- brightness range
- warm/cool relationship
- contrast

Example:

`A restrained palette of warm ivory, charcoal black, and muted cinnabar red; most of the frame remains pale and low-saturation, while red appears only in typography and small fabric details.`

### Materials and texture

Name the material and how it behaves under light:

- brushed aluminum with narrow linear highlights
- matte unglazed ceramic with soft chalky absorption
- translucent silk with gentle edge glow
- polished black marble with controlled reflections
- fibrous handmade paper with imperfect ink absorption

### Style and production method

Describe style by visual properties, not only artist names:

`late-1970s Japanese editorial illustration with flat screen-printed color fields, restrained geometry, imperfect ink registration, and visible fibrous paper grain`

### Typography and positive constraints

For text:

- exact quoted text
- line breaks
- placement
- size hierarchy
- font class
- color
- spacing
- prohibition of extra text

For constraints, state the desired visible state:

- `a clean restrained composition containing only the described elements`
- `natural anatomically coherent hands with each hand clearly separated from nearby objects`
- `broad simple shapes and generous negative space`

## 3. Length profiles

### Compact

One sentence or 20–60 English words. Use for exploration or simple subjects.

### Production

Roughly 80–220 English words. Use for controlled composition, posters, product images, and portraits.

### Exhaustive

Roughly 180–350 English words only when the scene is genuinely complex. Remove repeated adjectives and low-value quality words.

These are heuristics, not model limits.

## 4. Constraint language

Replace weak negatives with visible positive states:

- `no clutter` → `a restrained background with only three broad geometric forms`
- `no extra people` → `exactly one person appears anywhere in the frame`
- `no cropped title` → `the full title remains inside the safe area with generous margins`
- `no bad hands` → `both hands are fully visible, anatomically coherent, and naturally contacting the described object`

Use a negative prompt only when the workflow supports and benefits from it.

## 5. Typography grammar

Template:

`At [position], [size/hierarchy] [font class] typography reads "[exact text]" [line-break instruction]. The letters are [color/material/effect], remain fully inside the frame, and no additional text appears.`

For Chinese text, preserve exact characters inside quotes. Do not translate or “correct” text unless instructed.

## 6. Ambiguity control

When multiple subjects exist, use explicit clauses:

`On the left... On the right... Behind them...`

When a reference image is uncertain, distinguish:

- observed
- likely
- not reliably visible

Never turn uncertain details into hard prompt facts.

## 7. Final compilation order

Recommended order:

`medium → primary subject → pose/action → appearance/clothing → camera/composition → environment/spatial layers → lighting → palette → materials → style/production → typography → positive constraints`

Reorder when a different element is the true visual priority, such as typography-first posters or environment-first landscapes.
