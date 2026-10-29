#!/usr/bin/env python3
"""Basic structural validation for the krea2-prompt-suite skill."""

from __future__ import annotations

import re
import sys
from pathlib import Path

REQUIRED = [
    "SKILL.md",
    "agents/openai.yaml",
    "references/krea2-core.md",
    "references/prompt-architecture.md",
    "references/modes.md",
    "references/reverse-and-reference.md",
    "references/genre-presets.md",
    "references/comfyui-node-prompts.md",
    "references/evaluation.md",
    "assets/krea2-request.schema.json",
    "assets/system-prompts/qwen3vl-reverse-analyzer.txt",
    "assets/system-prompts/runninghub-krea2-compiler.txt",
    "assets/system-prompts/krea2-universal-vision-creator.txt",
    "scripts/krea2_prompt_compiler.py",
]


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    errors: list[str] = []

    for rel in REQUIRED:
        path = root / rel
        if not path.is_file():
            errors.append(f"missing: {rel}")

    skill = root / "SKILL.md"
    if skill.is_file():
        raw = skill.read_bytes()
        if raw.startswith(b"\xef\xbb\xbf"):
            errors.append("SKILL.md must be UTF-8 without BOM")
        text = raw.decode("utf-8")
        match = re.match(r"^---\n(.*?)\n---\n", text, flags=re.S)
        if not match:
            errors.append("SKILL.md is missing YAML frontmatter at byte 0")
        else:
            frontmatter = match.group(1)
            for key in ("name", "description"):
                if not re.search(rf"^{key}:\s*.+$", frontmatter, flags=re.M):
                    errors.append(f"frontmatter missing {key}")
            name_match = re.search(r"^name:\s*(.+)$", frontmatter, flags=re.M)
            if name_match:
                name = name_match.group(1).strip()
                if not re.fullmatch(r"[a-z0-9-]{1,64}", name):
                    errors.append("skill name must use lowercase letters, digits, and hyphens")
                if root.name != name:
                    errors.append(f"folder name {root.name!r} does not match skill name {name!r}")

    if errors:
        print("FAILED")
        for error in errors:
            print(f"- {error}")
        return 1

    print("PASS: skill structure and frontmatter look valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
