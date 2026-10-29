#!/usr/bin/env python3
"""Compile structured Krea 2 prompt JSON into a coherent natural-language prompt.

Usage:
    python krea2_prompt_compiler.py request.json
    cat request.json | python krea2_prompt_compiler.py -

This script formats supplied content; it does not infer missing visual facts.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return " ".join(value.strip().split())
    return " ".join(str(value).strip().split())


def sentence(text: str) -> str:
    text = clean_text(text)
    if not text:
        return ""
    return text if text[-1] in ".!?\"”" else text + "."


def flatten_strings(value: Any) -> list[str]:
    out: list[str] = []
    if value is None:
        return out
    if isinstance(value, str):
        if clean_text(value):
            out.append(clean_text(value))
    elif isinstance(value, list):
        for item in value:
            out.extend(flatten_strings(item))
    elif isinstance(value, dict):
        for _, item in value.items():
            out.extend(flatten_strings(item))
    else:
        out.append(clean_text(value))
    return [x for x in out if x]


def subject_clause(subject: dict[str, Any]) -> str:
    ordered = [
        subject.get("identity") or subject.get("type") or subject.get("subject"),
        subject.get("appearance"),
        subject.get("pose"),
        subject.get("action"),
        subject.get("expression"),
        subject.get("gaze"),
        subject.get("clothing"),
        subject.get("accessories"),
        subject.get("props"),
        subject.get("position"),
        subject.get("relations"),
    ]
    parts: list[str] = []
    for item in ordered:
        parts.extend(flatten_strings(item))
    return ", ".join(parts)


def compile_prompt(data: dict[str, Any]) -> str:
    chunks: list[str] = []

    medium = data.get("medium") or data.get("image_type")
    if medium:
        chunks.append(sentence(clean_text(medium)))

    concept = data.get("concept")
    if concept:
        chunks.append(sentence(clean_text(concept)))

    subjects = data.get("subjects") or []
    if isinstance(subjects, list):
        for subject in subjects:
            if isinstance(subject, dict):
                clause = subject_clause(subject)
            else:
                clause = clean_text(subject)
            if clause:
                chunks.append(sentence(clause))

    module_order = [
        "composition",
        "camera",
        "environment",
        "spatial_layers",
        "lighting",
        "color",
        "materials",
        "style",
    ]
    for key in module_order:
        value = data.get(key)
        parts = flatten_strings(value)
        if parts:
            chunks.append(sentence(", ".join(parts)))

    typography = data.get("typography")
    if typography:
        t = typography if isinstance(typography, dict) else {"text": typography}
        exact = clean_text(t.get("text") or t.get("exact_text"))
        position = clean_text(t.get("position"))
        hierarchy = clean_text(t.get("hierarchy"))
        font = clean_text(t.get("font") or t.get("font_class"))
        line_breaks = clean_text(t.get("line_breaks"))
        effect = clean_text(t.get("effect") or t.get("color"))
        parts = []
        if position:
            parts.append(f"At {position}")
        if hierarchy:
            parts.append(hierarchy)
        if font:
            parts.append(font)
        if exact:
            parts.append(f'typography reads "{exact}"')
        if line_breaks:
            parts.append(line_breaks)
        if effect:
            parts.append(effect)
        if t.get("no_extra_text", True):
            parts.append("no additional text appears")
        if parts:
            chunks.append(sentence(", ".join(parts)))

    constraints = flatten_strings(data.get("hard_constraints"))
    if constraints:
        chunks.append(sentence("Positive constraints: " + "; ".join(constraints)))

    return " ".join(chunk for chunk in chunks if chunk).strip()


def load_json(path: str) -> dict[str, Any]:
    if path == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(path).read_text(encoding="utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Top-level JSON must be an object")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="JSON file path or - for stdin")
    parser.add_argument("--json", action="store_true", help="Return JSON with final_prompt_en")
    args = parser.parse_args()

    try:
        data = load_json(args.input)
        prompt = compile_prompt(data)
        if not prompt:
            raise ValueError("No compilable prompt fields were found")
        if args.json:
            print(json.dumps({"final_prompt_en": prompt}, ensure_ascii=False, indent=2))
        else:
            print(prompt)
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
