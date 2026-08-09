#!/usr/bin/env python3
"""
Scrape the full ODU course catalog into data/courses.yaml.

    python3 scripts/scrape_courses.py            # normal (uses scripts/.cache)
    python3 scripts/scrape_courses.py --refresh  # ignore cache, refetch everything
    python3 scripts/scrape_courses.py --subjects phys,math

Raw HTML is cached under scripts/.cache/ so reruns are free.  The run is
idempotent: the same cache always produces the same YAML.

Output contract: data/SCHEMA.md, `courses.yaml` section.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, OrderedDict
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup  # type: ignore
import yaml  # type: ignore

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prereq_parser import COURSE_RE, ParseResult, parse_requirement  # noqa: E402

BASE = "https://catalog.odu.edu"
INDEX_URL = BASE + "/courses/"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE_DIR = os.path.join(HERE, ".cache")
OUT_YAML = os.path.join(ROOT, "data", "courses.yaml")
OUT_REPORT = os.path.join(ROOT, "data", "courses_review.md")

USER_AGENT = "ODU semester-planner course scraper (academic advising tool)"
DELAY_SECONDS = 0.4

TERM_WORDS = {
    "fall": "fall",
    "spring": "spring",
    "summer": "summer",
    "winter": "winter",
}


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------


def fetch(url: str, cache_name: str, refresh: bool = False) -> str:
    """Fetch ``url``, caching the raw HTML under scripts/.cache/."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, cache_name)
    if not refresh and os.path.exists(path) and os.path.getsize(path) > 2000:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    data = urllib.request.urlopen(req, timeout=60).read()
    with open(path, "wb") as fh:
        fh.write(data)
    time.sleep(DELAY_SECONDS)
    return data.decode("utf-8", errors="replace")


def subject_slugs(index_html: str) -> List[str]:
    slugs = set(re.findall(r'href="/courses/([a-z0-9\-]+)/"', index_html))
    if not slugs:  # the markup changed; fall back to a looser match
        slugs = set(re.findall(r"/courses/([a-z0-9\-]+)/", index_html))
    return sorted(slugs)


# --------------------------------------------------------------------------
# Field extraction
# --------------------------------------------------------------------------


def _text(node) -> str:
    if node is None:
        return ""
    return re.sub(r"\s+", " ", node.get_text()).strip()


CREDIT_RE = re.compile(
    r"\(\s*([\d.]+)(?:\s*(?:-|–|to)\s*([\d.]+))?\s*Credit\s+Hours?\s*\)", re.IGNORECASE
)


def parse_credits(text: str) -> Optional[Dict[str, float]]:
    m = CREDIT_RE.search(text or "")
    if not m:
        return None

    def num(s: str):
        f = float(s)
        return int(f) if f == int(f) else f

    lo = num(m.group(1))
    hi = num(m.group(2)) if m.group(2) else lo
    return {"min": lo, "max": hi}


CODE_PART_RE = re.compile(r"^\s*([A-Z]{2,4})\s*(\d{3}[A-Z]{0,2})\s*$")


def parse_header_code(raw: str) -> Tuple[Optional[str], List[str]]:
    """Turn a header like ``PHYS 425/525`` into (primary code, crosslist)."""
    raw = re.sub(r"\s+", " ", (raw or "")).strip()
    if not raw:
        return None, []

    parts = [p.strip() for p in raw.split("/") if p.strip()]
    codes: List[str] = []
    last_subject: Optional[str] = None
    for part in parts:
        m = CODE_PART_RE.match(part)
        if m:
            last_subject = m.group(1).upper()
            codes.append("%s %s" % (last_subject, m.group(2).upper()))
            continue
        # A bare number continues the previous subject: "PHYS 425/525".
        m = re.match(r"^(\d{3}[A-Z]{0,2})$", part)
        if m and last_subject:
            codes.append("%s %s" % (last_subject, m.group(1).upper()))
            continue
        # Unrecognised fragment -- fall back to the generic course regex.
        found = COURSE_RE.findall(part)
        for subj, num_ in found:
            last_subject = subj.upper()
            codes.append("%s %s" % (last_subject, num_.upper()))

    if not codes:
        return None, []
    crosslist = codes if len(codes) > 1 else []
    return codes[0], crosslist


OFFERED_RE = re.compile(r"\(\s*offered\s*([^)]*)\)", re.IGNORECASE)


def parse_terms(description: str) -> Optional[List[str]]:
    """Pull ``(offered fall, spring)`` out of the description."""
    if not description:
        return None
    found: List[str] = []
    for m in OFFERED_RE.finditer(description):
        blob = m.group(1).lower()
        for word, canon in TERM_WORDS.items():
            if re.search(r"\b" + word + r"\b", blob) and canon not in found:
                found.append(canon)
    if not found:
        return None
    order = ["fall", "spring", "summer", "winter"]
    return sorted(found, key=order.index)


def parse_attributes(number: str, description: str) -> List[str]:
    """Only the attributes SCHEMA.md documents: W = writing intensive."""
    attrs: List[str] = []
    if number.upper().endswith("W"):
        attrs.append("W")
    elif re.search(r"\bwriting[- ]intensive\b", description or "", re.IGNORECASE):
        attrs.append("W")
    return attrs


REQ_LABELS = {
    "prereq": re.compile(r"^prerequisites?\b", re.IGNORECASE),
    "coreq": re.compile(r"^corequisites?\b", re.IGNORECASE),
    "precoreq": re.compile(r"^pre-?\s*(?:or|and/or|and)\s*co-?requisites?\b", re.IGNORECASE),
}


def extract_requirements(block) -> Dict[str, str]:
    """Return {'prereq': text, 'coreq': text, 'precoreq': text} for a block.

    Classification is driven by the visible ``<span class="label">`` text rather
    than the CSS class, so a relabelled span still lands in the right bucket.
    """
    out: Dict[str, str] = {}
    for span in block.select("span.text"):
        classes = span.get("class") or []
        detail = next((c for c in classes if c.startswith("detail-")), "")
        if detail not in ("detail-prereq", "detail-coreq", "detail-precoreq"):
            continue

        label_node = span.select_one("span.label")
        label = _text(label_node)
        # Remove the label so it does not end up in the expression text.
        if label_node is not None:
            label_node.extract()
        body = _text(span).lstrip(":").strip()
        if not body:
            continue

        kind = None
        # "Pre- or corequisite" must be tested before "Prerequisite".
        for key in ("precoreq", "coreq", "prereq"):
            if REQ_LABELS[key].match(label):
                kind = key
                break
        if kind is None:
            kind = {
                "detail-prereq": "prereq",
                "detail-coreq": "coreq",
                "detail-precoreq": "precoreq",
            }[detail]

        out[kind] = (out[kind] + "; " + body) if kind in out else body
    return out


def parse_block(block, subject: str) -> Optional[Dict[str, Any]]:
    header = _text(block.select_one("span.detail-xrefcode"))
    code, crosslist = parse_header_code(header)
    if not code:
        return None

    title = _text(block.select_one("span.detail-title"))
    hours = _text(block.select_one("span.detail-hours_html"))
    description = " ".join(
        _text(p) for p in block.select("p.courseblockextra") if _text(p)
    ).strip()

    subj, _, number = code.partition(" ")
    record: "OrderedDict[str, Any]" = OrderedDict()
    record["code"] = code
    record["subject"] = subj
    record["number"] = number
    record["title"] = title

    review_reasons: List[str] = []

    credits = parse_credits(hours)
    if credits is not None:
        record["credits"] = credits
    else:
        review_reasons.append("could not parse credit hours from %r" % hours)

    if description:
        record["description"] = description

    reqs = extract_requirements(block)
    unparsed: List[str] = []
    for key in ("prereq", "coreq", "precoreq"):
        raw = reqs.get(key)
        if not raw:
            continue
        res: ParseResult = parse_requirement(raw)
        if res.expr is not None:
            record[key] = res.expr
        record["raw_%s_text" % key] = raw
        if res.needs_review:
            review_reasons.extend("%s: %s" % (key, r) for r in res.reasons)
        unparsed.extend(res.unparsed)

    terms = parse_terms(description)
    if terms:
        record["terms"] = terms

    attrs = parse_attributes(number, description)
    if attrs:
        record["attributes"] = attrs
    if crosslist:
        record["crosslist"] = crosslist

    if review_reasons:
        record["needs_review"] = True

    record["_review_reasons"] = review_reasons  # stripped before writing
    record["_unparsed"] = unparsed
    record["_subject_page"] = subject
    return record


# --------------------------------------------------------------------------
# YAML emission
# --------------------------------------------------------------------------


class _Dumper(yaml.SafeDumper):
    """Block-style YAML that keeps our key order and quotes course numbers."""

    def ignore_aliases(self, data):  # noqa: D401
        return True


def _dict_repr(dumper, data):
    return dumper.represent_mapping("tag:yaml.org,2002:map", data.items())


_Dumper.add_representer(OrderedDict, _dict_repr)


def _clean(record: Dict[str, Any]) -> "OrderedDict[str, Any]":
    out: "OrderedDict[str, Any]" = OrderedDict()
    for k, v in record.items():
        if k.startswith("_"):
            continue
        out[k] = v
    return out


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def detect_catalog_year(index_html: str) -> Optional[str]:
    m = re.search(r"(20\d{2})\s*[-–]\s*(20\d{2})", index_html)
    if m:
        return "%s-%s" % (m.group(1), m.group(2))
    return None


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="ignore the HTML cache")
    ap.add_argument("--subjects", help="comma separated subject slugs (default: all)")
    args = ap.parse_args(argv)

    index_html = fetch(INDEX_URL, "index.html", refresh=args.refresh)
    slugs = subject_slugs(index_html)
    if args.subjects:
        wanted = {s.strip().lower() for s in args.subjects.split(",") if s.strip()}
        slugs = [s for s in slugs if s in wanted]
    print("subjects to scrape: %d" % len(slugs), file=sys.stderr)

    records: List[Dict[str, Any]] = []
    seen: Dict[str, Dict[str, Any]] = {}
    failed: List[Tuple[str, str]] = []
    empty: List[str] = []
    duplicates = 0

    for i, slug in enumerate(slugs, 1):
        url = "%s/courses/%s/" % (BASE, slug)
        try:
            html = fetch(url, "%s.html" % slug, refresh=args.refresh)
        except (urllib.error.URLError, OSError) as exc:
            failed.append((slug, str(exc)))
            print("  [%3d/%d] %-8s FAILED: %s" % (i, len(slugs), slug, exc), file=sys.stderr)
            continue

        soup = BeautifulSoup(html, "html.parser")
        blocks = soup.select("div.courseblock")
        if not blocks:
            empty.append(slug)

        added = 0
        for block in blocks:
            rec = parse_block(block, slug)
            if rec is None:
                continue
            if rec["code"] in seen:
                duplicates += 1
                continue
            seen[rec["code"]] = rec
            records.append(rec)
            added += 1
        print("  [%3d/%d] %-8s %4d courses" % (i, len(slugs), slug, added), file=sys.stderr)

    records.sort(key=lambda r: (r["subject"], r["number"]))

    meta = OrderedDict()
    meta["source"] = INDEX_URL
    meta["scraped_at"] = _dt.date.today().isoformat()
    year = detect_catalog_year(index_html)
    if year:
        meta["catalog_year"] = year
    meta["generator"] = "scripts/scrape_courses.py"
    meta["subject_count"] = len(slugs)
    meta["course_count"] = len(records)

    doc = OrderedDict()
    doc["meta"] = meta
    doc["courses"] = [_clean(r) for r in records]

    os.makedirs(os.path.dirname(OUT_YAML), exist_ok=True)
    with open(OUT_YAML, "w", encoding="utf-8") as fh:
        yaml.dump(
            doc,
            fh,
            Dumper=_Dumper,
            default_flow_style=False,
            allow_unicode=True,
            sort_keys=False,
            width=100,
        )
    print("wrote %s (%d courses)" % (OUT_YAML, len(records)), file=sys.stderr)

    write_report(records, slugs, failed, empty, duplicates, meta)
    print("wrote %s" % OUT_REPORT, file=sys.stderr)
    return 0


def write_report(records, slugs, failed, empty, duplicates, meta) -> None:
    total = len(records)
    with_prereq = sum(1 for r in records if "prereq" in r)
    with_coreq = sum(1 for r in records if "coreq" in r)
    with_precoreq = sum(1 for r in records if "precoreq" in r)
    with_any = sum(
        1 for r in records if any(k in r for k in ("prereq", "coreq", "precoreq"))
    )
    flagged = [r for r in records if r.get("needs_review")]
    with_terms = sum(1 for r in records if "terms" in r)
    crosslisted = sum(1 for r in records if "crosslist" in r)
    no_credits = [r for r in records if "credits" not in r]

    reason_counts: "Counter[str]" = Counter()
    for r in flagged:
        for reason in r["_review_reasons"]:
            field, _, rest = reason.partition(": ")
            reason_counts[rest.split(":")[0].strip() or reason] += 1

    phrase_counts: "Counter[str]" = Counter()
    phrase_example: Dict[str, str] = {}
    for r in records:
        for u in r["_unparsed"]:
            key = _phrase_key(u)
            phrase_counts[key] += 1
            phrase_example.setdefault(key, "%s -- %s" % (r["code"], u))

    lines: List[str] = []
    lines.append("# Course catalog scrape -- review report")
    lines.append("")
    lines.append("Generated by `scripts/scrape_courses.py` on %s." % meta["scraped_at"])
    lines.append("Source: <%s>" % meta["source"])
    if "catalog_year" in meta:
        lines.append("Catalog year: %s" % meta["catalog_year"])
    lines.append("")
    lines.append("## Counts")
    lines.append("")
    lines.append("| metric | count |")
    lines.append("| --- | ---: |")
    lines.append("| subject pages scraped | %d |" % len(slugs))
    lines.append("| subject pages that failed to fetch | %d |" % len(failed))
    lines.append("| subject pages with no course blocks | %d |" % len(empty))
    lines.append("| courses | %d |" % total)
    lines.append("| duplicate course codes skipped | %d |" % duplicates)
    lines.append("| courses with a prerequisite | %d (%.1f%%) |" % (with_prereq, _pct(with_prereq, total)))
    lines.append("| courses with a corequisite | %d |" % with_coreq)
    lines.append("| courses with a pre-/corequisite | %d |" % with_precoreq)
    lines.append("| courses with any requirement | %d (%.1f%%) |" % (with_any, _pct(with_any, total)))
    lines.append("| courses flagged `needs_review: true` | %d (%.1f%%) |" % (len(flagged), _pct(len(flagged), total)))
    lines.append("| courses with parsed `terms` | %d |" % with_terms)
    lines.append("| cross-listed courses | %d |" % crosslisted)
    lines.append("| courses with unparseable credit hours | %d |" % len(no_credits))
    lines.append("")

    if failed:
        lines.append("## Subject pages that failed to fetch")
        lines.append("")
        for slug, err in failed:
            lines.append("- `%s` -- %s" % (slug, err))
        lines.append("")
    if empty:
        lines.append("## Subject pages with no course blocks")
        lines.append("")
        lines.append(", ".join("`%s`" % s for s in empty))
        lines.append("")

    lines.append("## Why courses were flagged")
    lines.append("")
    lines.append("| reason | courses |")
    lines.append("| --- | ---: |")
    for reason, n in reason_counts.most_common():
        lines.append("| %s | %d |" % (reason, n))
    lines.append("")
    lines.append(
        "`needs_review: true` means *a human should look*, not that the record is wrong. "
        "The most common cause by far is prose the parser deliberately kept verbatim as a "
        "`note` leaf (major restrictions, GPA floors, program admission) rather than "
        "guessing at a structure for it."
    )
    lines.append("")

    lines.append("## Most common unparsed prerequisite phrasings")
    lines.append("")
    lines.append(
        "Each of these became a `{note: ...}` leaf. They are grouped by shape "
        "(course codes and digits replaced with `<C>` / `<N>`). Improving the parser "
        "means teaching `scripts/prereq_parser.py` about the ones near the top."
    )
    lines.append("")
    lines.append("| n | shape | example |")
    lines.append("| ---: | --- | --- |")
    for key, n in phrase_counts.most_common(40):
        lines.append(
            "| %d | `%s` | %s |"
            % (n, _md(key)[:90], _md(phrase_example[key])[:110])
        )
    lines.append("")

    lines.append("## Known parser limitations")
    lines.append("")
    lines.extend(
        [
            "- **`X or higher`** (e.g. `MATH 102M or higher`) means \"this course or a",
            "  higher-numbered one\". The parser keeps the course and emits a `{note: \"higher\"}`",
            "  sibling; it does not expand the range.",
            "- **Credit-hour pools** (`3 credit hours in PHIL or REL`, `6 hours of coursework",
            "  from ...`) are not turned into `n_of` nodes. They stay as notes.",
            "- **`n_of`** is defined in the schema but never emitted -- no catalog phrasing",
            "  encountered mapped cleanly onto \"N of the following\".",
            "- **Bare comma lists** with no `and`/`or` (`A, B, C`) default to `all_of` and are",
            "  flagged; the catalog's intent is genuinely ambiguous there.",
            "- **Trailing grade distribution** (`A and B with a grade of C or better`) is applied",
            "  to the whole group. That is certain when the text says \"each\"/\"both\" and a",
            "  judgement call otherwise.",
            "- **`recommended`** qualifiers (`X recommended`) are kept as notes, not dropped and",
            "  not promoted to hard prerequisites.",
        ]
    )
    lines.append("")

    if no_credits:
        lines.append("## Courses with unparseable credit hours")
        lines.append("")
        for r in no_credits[:40]:
            lines.append("- `%s` %s" % (r["code"], r.get("title", "")))
        lines.append("")

    with open(OUT_REPORT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def _pct(n: int, total: int) -> float:
    return (100.0 * n / total) if total else 0.0


def _phrase_key(text: str) -> str:
    key = COURSE_RE.sub("<C>", text)
    key = re.sub(r"\b\d+\b", "<N>", key)
    key = re.sub(r"\s+", " ", key).strip()
    return key


def _md(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


if __name__ == "__main__":
    sys.exit(main())
