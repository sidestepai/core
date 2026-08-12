#!/usr/bin/env python3
"""Tests for the Slack release message builder. Run: python3 this_file.py

Deliberately stdlib-only asserts rather than pytest — this runs on a bare
GitHub runner in the same job that posts, so a malformed payload fails the
workflow instead of Slack rejecting it.
"""

from __future__ import annotations

import json
import sys

from slack_release_message import HEADER_LIMIT, SECTION_LIMIT, build, inline

REPO = "sidestepai/core"
URL = "https://github.com/sidestepai/core/releases/tag/v9.9.9"


def sections(payload: dict) -> list[str]:
    return [b["text"]["text"] for b in payload["blocks"] if b["type"] == "section"]


def check_well_formed(payload: dict) -> None:
    """Every invariant Slack enforces on our behalf, enforced here first."""
    assert payload["text"], "fallback text is what shows in the notification"
    blocks = payload["blocks"]
    assert len(blocks) <= 50
    for b in blocks:
        if b["type"] == "section":
            assert 0 < len(b["text"]["text"]) <= SECTION_LIMIT, len(b["text"]["text"])
        if b["type"] == "header":
            assert 0 < len(b["text"]["text"]) <= HEADER_LIMIT
        if b["type"] == "actions":
            assert all(e["url"].startswith("https://") for e in b["elements"])
            for e in b["elements"]:
                assert len(e["text"]["text"]) <= 75
    json.dumps(payload)  # must survive serialization


def test_inline_conversions() -> None:
    assert inline("**bold**") == "*bold*"
    assert inline("__also bold__") == "*bold*".replace("bold", "also bold")
    assert inline("[text](https://x.dev)") == "<https://x.dev|text>"
    assert inline("`code` stays") == "`code` stays"
    assert inline("a & b < c > d") == "a &amp; b &lt; c &gt; d"
    # A link's URL must not be mangled by the escaping that runs before it.
    assert inline("[a](https://x.dev/?a=1&b=2)") == "<https://x.dev/?a=1&amp;b=2|a>"


def test_headings_become_bullets_not_literal_hashes() -> None:
    body = "Intro line.\n\n## First fix\ndetail\n\n## Second fix\ndetail"
    payload = build(REPO, "v9.9.9", "v9.9.9 — title", URL, body)
    body_text = "\n".join(sections(payload))
    assert "##" not in body_text
    assert "•  First fix" in body_text
    assert "•  Second fix" in body_text
    assert "detail" not in body_text, "section bodies stay behind the link"
    check_well_formed(payload)


def test_tables_never_leak_or_cut_mid_row() -> None:
    table = "| a | b |\n|---|---|\n| 1 | 2 |"
    payload = build(REPO, "v9.9.9", "n", URL, f"Intro.\n\n{table}\n\n## Heading")
    assert "|---|" not in "\n".join(sections(payload))
    check_well_formed(payload)


def test_table_rows_become_bullets_with_cells_intact() -> None:
    table = "| filter | catalog | engine |\n|---|---|---|\n| `csv_encode` | 0 | 3 |"
    intro = sections(build(REPO, "v9.9.9", "n", URL, f"Intro.\n\n{table}\n\n## H"))[0]
    assert "•  filter  —  catalog  —  engine" in intro
    assert "•  `csv_encode`  —  0  —  3" in intro


def test_cells_are_escaped_exactly_once() -> None:
    """Block conversion runs before inline(), so a cell must not double-escape."""
    intro = sections(build(REPO, "v9.9.9", "n", URL, "| a & b | **c** |\n|---|---|"))[0]
    assert "a &amp; b" in intro and "&amp;amp;" not in intro
    assert "*c*" in intro and "**c**" not in intro


def test_long_intro_clipped_at_a_boundary() -> None:
    para = "Sentence about the fix. " * 200
    payload = build(REPO, "v9.9.9", "n", URL, f"{para}\n\n## Heading")
    intro = sections(payload)[0]
    assert intro.endswith("…")
    assert len(intro) <= SECTION_LIMIT
    assert not intro.rstrip("…").endswith(" "), "clipped at a word boundary"


def test_many_headings_are_capped_with_a_remainder() -> None:
    body = "Intro.\n\n" + "\n\n".join(f"## Fix {i}\ntext" for i in range(20))
    payload = build(REPO, "v9.9.9", "n", URL, body)
    highlights = sections(payload)[-1]
    assert "and 12 more" in highlights
    check_well_formed(payload)


def test_structural_headings_are_not_highlights() -> None:
    body = "Intro.\n\n## A real fix\nx\n\n## Also\ny\n\n## Compatibility\nz\n\n## Breaking\nw"
    highlights = sections(build(REPO, "v9.9.9", "n", URL, body))[-1]
    assert "A real fix" in highlights
    assert "Breaking" in highlights, "a change description is never filtered"
    assert "Also" not in highlights and "Compatibility" not in highlights


def test_only_structural_headings_leaves_no_highlight_block() -> None:
    payload = build(REPO, "v9.9.9", "n", URL, "Intro.\n\n## Notes\nx")
    assert sections(payload) == ["Intro."]
    check_well_formed(payload)


def test_empty_and_missing_body() -> None:
    for body in ("", "   \n\n  "):
        payload = build(REPO, "v9.9.9", "", URL, body)
        assert sections(payload) == [], "no empty section — Slack rejects those"
        assert payload["blocks"][0]["text"]["text"] == "v9.9.9", "falls back to the tag"
        check_well_formed(payload)


def test_body_with_no_headings_keeps_the_whole_budget() -> None:
    payload = build(REPO, "v9.9.9", "n", URL, "Just one paragraph, no headings.")
    assert sections(payload) == ["Just one paragraph, no headings."]
    check_well_formed(payload)


def test_boilerplate_stripped() -> None:
    body = "Intro.\n\n**Full changelog**: https://github.com/x/y/compare/a...b"
    assert "Full changelog" not in "\n".join(sections(build(REPO, "v9.9.9", "n", URL, body)))


def test_npm_button_is_optional_and_version_pinned() -> None:
    without = build(REPO, "v9.9.9", "n", URL, "x")
    assert len(without["blocks"][-1]["elements"]) == 1
    with_pkg = build(REPO, "v9.9.9", "n", URL, "x", pkg="@sidestep/core")
    assert with_pkg["blocks"][-1]["elements"][1]["url"].endswith("/@sidestep/core/v/9.9.9")


def test_injection_attempt_in_notes_stays_inert() -> None:
    payload = build(REPO, "v9.9.9", "n", URL, '<!channel> and <https://evil.dev|click>')
    intro = sections(payload)[0]
    assert "<!channel>" not in intro and "&lt;!channel&gt;" in intro


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
