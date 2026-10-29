# ComfyUI and RunningHub Node Prompts

## Contents

1. Recommended architecture
2. Vision analyzer settings
3. Prompt compiler settings
4. Single-node mode
5. Output wiring
6. Ready-to-copy assets

## 1. Recommended architecture

For robust reverse prompting, use two stages:

1. Vision analyzer: image → structured evidence.
2. Prompt compiler: structured evidence → Krea 2 natural-language prompt.

This separates visual recognition from prompt writing and reduces hallucinated embellishment.

## 2. Vision analyzer settings

For Qwen3-VL-like nodes, start with:

- temperature: 0.1–0.3
- top_p: 0.85–0.95
- fixed seed
- no randomize-after-generate for repeatable tests
- enough output tokens for complex scenes
- image resolution high enough to preserve typography and small objects, balanced against VRAM

The exact model size depends on available VRAM. Prefer the largest reliably runnable vision model; a 4B model is acceptable for speed but may miss small text or subtle spatial details.

The system prompt is stored at:

`assets/system-prompts/qwen3vl-reverse-analyzer.txt`

## 3. Prompt compiler settings

For the second LLM node:

- temperature: 0.1–0.3 for faithful reconstruction
- top_p: around 0.9
- fixed seed where supported
- no presence or frequency penalty unless repetitive output becomes a real problem
- sufficient max tokens, but do not force verbose output

The compiler must receive the visual analysis as user content, not as a replacement for its system instructions.

The system prompt is stored at:

`assets/system-prompts/runninghub-krea2-compiler.txt`

## 4. Single-node mode

If the API node directly accepts images and uses a strong vision-language model, use:

`assets/system-prompts/krea2-universal-vision-creator.txt`

Single-node mode is simpler but usually provides less control over evidence versus interpretation.

## 5. Output wiring

Recommended output contract:

- `FINAL_PROMPT_EN`: one coherent paragraph for Krea 2.
- `POSITIVE_CONSTRAINTS_EN`: only constraints not already embedded.
- `NEGATIVE_PROMPT_EN`: optional and workflow-dependent.
- `STRUCTURED_NOTES_CN`: optional evidence summary.
- `UNCERTAINTY`: only meaningful uncertainties.

For direct connection to a text-encoding node, request `FINAL_PROMPT_EN` only to avoid labels entering the generation prompt.

## 6. Ready-to-copy assets

- `assets/system-prompts/qwen3vl-reverse-analyzer.txt`
- `assets/system-prompts/runninghub-krea2-compiler.txt`
- `assets/system-prompts/krea2-universal-vision-creator.txt`

When the user asks for a Chinese system prompt, translate the operational instructions but keep field names stable if they are parsed downstream.
