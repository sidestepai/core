#!/usr/bin/env python3
"""Build the Slack Block Kit payload for a release announcement.

Reads REPO / TAG / NAME / URL / BODY from the environment and writes the
payload to stdout. Kept out of the workflow's `run:` block so it can be
tested directly: see .github/scripts/test_slack_release_message.py.

GitHub release notes are GitHub-flavored markdown; Slack speaks `mrkdwn`,
which shares almost none of the block syntax. Rather than paste the whole
body in and let headings and tables render as literal `##` and `|`, this
posts a scannable summary — intro paragraph, section headings as bullets,
button to the full notes.
"""

from __future__ import annotations

import json
import os
import re

# Slack's hard limits. A section over 3000 chars is rejected outright.
SECTION_LIMIT = 3000
HEADER_LIMIT = 150
INTRO_BUDGET = 1200
MAX_HIGHLIGHTS = 8

# Structural sections that carry no information as a bare bullet. Anything
# describing a change — including "Breaking" — is deliberately not here.
BORING_HEADINGS = {
    "also",
    "note",
    "notes",
    "misc",
    "other",
    "compatibility",
    "verification",
    "housekeeping",
    "credits",
    "acknowledgements",
    "full changelog",
}


def escape(text: str) -> str:
    """Slack requires exactly these three entities escaped, and no others."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(text: str) -> str:
    """GitHub inline markdown -> Slack mrkdwn. Backticks pass through as-is."""
    text = escape(text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)  # images: drop
    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r"<\2|\1>", text)  # links
    text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text, flags=re.S)  # bold
    text = re.sub(r"__(.+?)__", r"*\1*", text, flags=re.S)
    return text.strip()


def blocks_to_mrkdwn(text: str) -> str:
    """Block-level markdown Slack has no syntax for: tables and list bullets.

    A pipe table renders as literal `|` rows in Slack, and clipping can slice
    one mid-row, so rows are flattened to `• a — b` lines here rather than
    left to leak.

    Runs on raw markdown, before `inline()` — splitting cells on `|` is only
    safe while links are still `[text](url)` and not yet `<url|text>`.
    """
    out: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("|") and stripped.count("|") >= 2:
            if re.fullmatch(r"[\s:|-]*-[\s:|-]*", stripped.strip("|")):
                continue  # table separator row
            cells = [c for c in (c.strip() for c in stripped.strip("|").split("|")) if c]
            out.append("•  " + "  —  ".join(cells) if cells else "")
            continue
        out.append(re.sub(r"^(\s*)[-*+]\s+", r"\1•  ", line))
    return "\n".join(out)


def strip_boilerplate(body: str) -> str:
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    lines = [
        ln
        for ln in body.splitlines()
        if not re.match(r"^\s*\*\*Full changelog\*\*", ln, re.I)
        and "Generated with [Claude Code]" not in ln
    ]
    return "\n".join(lines).strip()


def split_sections(body: str) -> tuple[str, list[str]]:
    """Return (intro, [heading, ...]) — text before the first heading, then headings."""
    intro: list[str] = []
    headings: list[str] = []
    for line in body.splitlines():
        m = re.match(r"^#{1,6}\s+(.*\S)\s*$", line)
        if m:
            headings.append(m.group(1))
        elif not headings:
            intro.append(line)
    return "\n".join(intro).strip(), headings


def clip(text: str, budget: int) -> str:
    """Trim to a paragraph, then sentence, then word boundary — never mid-table."""
    if len(text) <= budget:
        return text
    window = text[:budget]
    for boundary in ("\n\n", ". ", " "):
        cut = window.rfind(boundary)
        if cut > budget // 2:
            return window[:cut].rstrip(" .\n") + "…"
    return window.rstrip() + "…"


def build(repo: str, tag: str, name: str, url: str, body: str, pkg: str = "") -> dict:
    body = strip_boilerplate(body)
    intro_md, headings = split_sections(body)

    # No headings means the whole body is the intro; give it the full budget.
    intro = clip(inline(blocks_to_mrkdwn(intro_md)), SECTION_LIMIT if not headings else INTRO_BUDGET)

    title = name.strip() or tag
    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": clip(title, HEADER_LIMIT), "emoji": True}},
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"*{escape(repo)}* · `{escape(tag)}` · released"}],
        },
    ]

    if intro:
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": intro}})

    headings = [h for h in headings if h.strip().lower().rstrip(":") not in BORING_HEADINGS]
    if headings:
        shown = headings[:MAX_HIGHLIGHTS]
        bullets = "\n".join(f"•  {inline(h)}" for h in shown)
        if len(headings) > len(shown):
            bullets += f"\n•  _…and {len(headings) - len(shown)} more_"
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": clip(f"*In this release*\n{bullets}", SECTION_LIMIT)},
            }
        )

    buttons = [
        {
            "type": "button",
            "style": "primary",
            "text": {"type": "plain_text", "text": "Release notes", "emoji": False},
            "url": url,
        }
    ]
    if pkg:
        buttons.append(
            {
                "type": "button",
                "text": {"type": "plain_text", "text": f"{pkg} on npm", "emoji": False},
                "url": f"https://www.npmjs.com/package/{pkg}/v/{tag.lstrip('v')}",
            }
        )
    blocks.append({"type": "actions", "elements": buttons})

    return {"text": f"{repo} released {tag}", "blocks": blocks}


def main() -> None:
    payload = build(
        repo=os.environ["REPO"],
        tag=os.environ["TAG"],
        name=os.environ.get("NAME", ""),
        url=os.environ["URL"],
        body=os.environ.get("BODY", "") or "",
        pkg=os.environ.get("NPM_PACKAGE", "").strip(),
    )
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
