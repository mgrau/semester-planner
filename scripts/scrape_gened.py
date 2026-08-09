#!/usr/bin/env python3
"""Scrape ODU's University General Education Requirements into data/gened.yaml.

Source: https://catalog.odu.edu/undergraduate/general-education-requirements/
(/undergraduate/requirements-undergraduate-degrees/ redirects here.)

The page carries one <a name="..."> anchor per Lower-Division category; those anchor
ids are used verbatim as the category `id` because program pages link to them, which
makes them the join key across datasets.

Usage:
    python3 scripts/scrape_gened.py            # use cached HTML if present
    python3 scripts/scrape_gened.py --refresh  # re-download and overwrite the cache
    python3 scripts/scrape_gened.py --no-review  # skip regenerating gened_review.md

Idempotent: given the same cached HTML the output bytes are identical (meta.scraped_at
is derived from the cache file's mtime, not from "now").
"""

from __future__ import annotations

import argparse
import datetime as _dt
import pathlib
import re
import sys
from collections import OrderedDict

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("missing dependency: pip install requests")
try:
    from bs4 import BeautifulSoup
except ImportError:  # pragma: no cover
    sys.exit("missing dependency: pip install beautifulsoup4")
try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("missing dependency: pip install pyyaml")


SOURCE_URL = "https://catalog.odu.edu/undergraduate/general-education-requirements/"

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "scripts" / ".cache"
CACHE_FILE = CACHE_DIR / "gened.html"
OUT_YAML = ROOT / "data" / "gened.yaml"
OUT_REVIEW = ROOT / "data" / "gened_review.md"

# Lower-division category anchors, in catalog order.  `transferforgened` and
# `honorscoursesgened` are also anchors on this page but are policy sections, not
# categories, and are captured under `policies` / `honors_approved` instead.
CATEGORY_ANCHORS = [
    "written",
    "oral",
    "math",
    "language",
    "information",
    "behavior",
    "creativity",
    "interpret",
    "literature",
    "nature",
    "philosophy",
    "impact",
]

POLICY_ANCHORS = ["transferforgened", "honorscoursesgened"]

HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


# --------------------------------------------------------------------------- utils


def norm(text: str) -> str:
    """Collapse whitespace, including the catalog's non-breaking spaces.

    Also removes the stray space the catalog's inline course links leave in front of
    punctuation ("... register for ENGL 211C ." -> "... register for ENGL 211C.").
    That is a markup artifact, not the catalog's wording.
    """
    out = re.sub(r"\s+", " ", (text or "").replace("\xa0", " ")).strip()
    return re.sub(r"\s+([.,;:)])", r"\1", out)


def fetch(refresh: bool = False) -> str:
    """Return the page HTML, caching it under scripts/.cache/gened.html."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if CACHE_FILE.exists() and not refresh:
        return CACHE_FILE.read_text(encoding="utf-8")
    resp = requests.get(
        SOURCE_URL,
        timeout=60,
        allow_redirects=True,
        headers={"User-Agent": "semester-planner-scraper/1.0 (+academic advising tool)"},
    )
    resp.raise_for_status()
    resp.encoding = resp.encoding or "utf-8"
    CACHE_FILE.write_text(resp.text, encoding="utf-8")
    return resp.text


def cache_date() -> str:
    ts = CACHE_FILE.stat().st_mtime if CACHE_FILE.exists() else _dt.datetime.now().timestamp()
    return _dt.datetime.fromtimestamp(ts).date().isoformat()


# ------------------------------------------------------------------ course codes

CODE_RE = re.compile(r"([A-Z][A-Z&]*(?:/[A-Z][A-Z&]*)*)\s+(\d+[A-Z]*)")


def expand_code(label: str) -> list[str]:
    """'PHIL/REL 150P' -> ['PHIL 150P', 'REL 150P']; 'PHYS 231N' -> ['PHYS 231N'].

    Cross-listed catalog labels are expanded so each entry is a single catalog code
    with one space, matching the course identity rule in SCHEMA.md.  Compound labels
    such as 'HIST/HNRS 386T/SCI 302T' yield HIST 386T, HNRS 386T and SCI 302T.
    """
    label = norm(label)
    if not label:
        return []
    out: list[str] = []
    for m in CODE_RE.finditer(label):
        number = m.group(2)
        out.extend(f"{s} {number}" for s in m.group(1).split("/"))
    return out or [label]


# ------------------------------------------------------------------ page sections


def section_nodes(soup: BeautifulSoup, anchor_id: str) -> tuple[str, list]:
    """Return (heading text, [sibling elements]) for the section holding an anchor.

    A section runs from the heading that contains the anchor up to the next heading
    of the same or higher rank.
    """
    a = soup.find("a", attrs={"name": anchor_id}) or soup.find("a", id=anchor_id)
    if a is None:
        raise KeyError(f"anchor #{anchor_id} not found on the page")
    heading = a.find_parent(HEADINGS)
    if heading is None:
        raise KeyError(f"anchor #{anchor_id} is not inside a heading")
    level = int(heading.name[1])
    nodes = []
    node = heading.find_next_sibling()
    while node is not None:
        if node.name in HEADINGS and int(node.name[1]) <= level:
            break
        nodes.append(node)
        node = node.find_next_sibling()
    return norm(heading.get_text(" ")), nodes


def group_for(soup: BeautifulSoup, anchor_id: str) -> str | None:
    """The h3 ('I. Skills' / 'II. Ways of Knowing') a category sits under."""
    a = soup.find("a", attrs={"name": anchor_id})
    heading = a.find_parent(HEADINGS)
    h3 = heading.find_previous("h3")
    if h3 is None:
        return None
    return re.sub(r"^[IVX]+\.\s*", "", norm(h3.get_text(" "))) or None


def clean_name(heading_text: str) -> str:
    """'D. Language and Culture*' -> 'Language and Culture'."""
    txt = re.sub(r"^[A-Z]\.\s*", "", norm(heading_text))
    return txt.rstrip("*").strip()


# ----------------------------------------------------------------- courselist table


def row_comment(tr) -> str:
    """Text of a comment / area-header row, excluding the credit-hours cell."""
    span = tr.find("span", class_="courselistcomment")
    if span is not None:
        return norm(span.get_text(" "))
    td = tr.find("td", attrs={"colspan": True})
    if td is not None:
        return norm(td.get_text(" "))
    return norm(tr.get_text(" "))


def parse_courselist(table) -> dict:
    """Parse a <table class="sc_courselist"> into codes, verbatim labels and comments."""
    approved: list[str] = []
    approved_raw: list[str] = []
    combinations: list[list[str]] = []
    top_level: list[str] = []
    n_indented = 0
    comments: list[str] = []
    total_credits: int | float | None = None
    hour_values: list[float] = []
    area: str | None = None
    areas: "OrderedDict[str, list[str]]" = OrderedDict()

    for tr in table.find_all("tr"):
        classes = tr.get("class") or []
        if "hidden" in classes or "noscript" in classes:
            continue

        hourscol = tr.find("td", class_="hourscol")
        hours_txt = norm(hourscol.get_text(" ")) if hourscol else ""

        if "listsum" in classes:
            total_credits = to_number(hours_txt)
            continue

        if "areaheader" in classes:
            area = row_comment(tr)
            areas.setdefault(area, [])
            continue

        codecol = tr.find("td", class_="codecol")
        if codecol is None:
            # Comment / instruction row: <td colspan="2"><span class="courselistcomment">
            text = row_comment(tr)
            if text:
                comments.append(text)
            if hours_txt:
                hour_values.append(to_number(hours_txt) or 0)
            continue

        raw = norm(codecol.get_text(" "))
        is_or = "orclass" in classes or raw.lower().startswith("or ")
        links = [norm(a.get_text(" ")) for a in codecol.find_all("a", class_="code")]
        if not links:
            if raw:
                comments.append(raw)
            continue

        codes: list[str] = []
        for label in links:
            codes.extend(expand_code(label))
        approved_raw.append(raw)
        for c in codes:
            if c not in approved:
                approved.append(c)
        if len(links) > 1:  # an "&" row: both courses are required together
            combinations.append(codes)
        # <div class="blockindent"> marks a course sitting under a "Select one of the
        # following" comment; an un-indented course row is required outright.
        if codecol.find("div", class_="blockindent"):
            n_indented += 1
        elif not is_or:
            top_level.extend(codes)
        if area is not None:
            areas[area].extend(codes)
        if hours_txt and not is_or:
            hour_values.append(to_number(hours_txt) or 0)

    if total_credits is None and hour_values:
        total_credits = sum(hour_values)

    return {
        "approved": approved,
        "approved_raw": approved_raw,
        "combinations": combinations,
        "required": top_level if n_indented else [],
        "comments": comments,
        "credits": tidy_number(total_credits),
        "areas": areas,
    }


def to_number(text: str):
    text = norm(text)
    m = re.match(r"^(\d+(?:\.\d+)?)", text)
    return float(m.group(1)) if m else None


def tidy_number(value):
    if value is None:
        return None
    if float(value) == int(value):
        return int(value)
    return value


# ------------------------------------------------------------------- text harvest


def prose_from(nodes) -> list[str]:
    """Verbatim paragraph / list / footnote text following a heading, tables skipped."""
    out = []
    for node in nodes:
        if node.name == "table":
            continue
        if node.name in ("p", "dl"):
            text = norm(node.get_text(" "))
            if text:
                out.append(text)
        elif node.name in ("ol", "ul"):
            for li in node.find_all("li", recursive=False):
                text = norm(li.get_text(" "))
                if text:
                    out.append(text)
    return out


def first_table(nodes):
    for node in nodes:
        if node.name == "table" and "sc_courselist" in (node.get("class") or []):
            return node
        if getattr(node, "find", None):
            t = node.find("table", class_="sc_courselist")
            if t is not None:
                return t
    return None


# ------------------------------------------------------------------------- honors


def honors_by_category(soup: BeautifulSoup, name_to_id: dict) -> dict:
    """Map category id -> honors course codes, from the honors courselist areaheaders."""
    _, nodes = section_nodes(soup, "honorscoursesgened")
    table = first_table(nodes)
    if table is None:
        return {}
    parsed = parse_courselist(table)
    result: dict[str, list[str]] = {}
    for area, codes in parsed["areas"].items():
        cid = name_to_id.get(area.lower())
        if cid and codes:
            result.setdefault(cid, [])
            for c in codes:
                if c not in result[cid]:
                    result[cid].append(c)
    return result


# ------------------------------------------------------------------ upper division


def upper_division(soup: BeautifulSoup) -> list[dict]:
    """The Upper-Division Requirements section, modeled as two extra categories.

    These have no catalog anchors, so ids are ours: `upper-division-writing-intensive`
    and `upper-division-outside-major`.
    """
    h2 = None
    for h in soup.find_all("h2"):
        if "Upper-Division Requirements" in norm(h.get_text(" ")):
            h2 = h
            break
    if h2 is None:
        return []

    # Collect the h3 subsections under this h2.
    subsections: "OrderedDict[str, list[str]]" = OrderedDict()
    current = None
    node = h2.find_next_sibling()
    while node is not None and not (node.name == "h2"):
        if node.name == "h3":
            current = norm(node.get_text(" "))
            subsections[current] = []
        elif current is not None:
            subsections[current].extend(prose_from([node]))
        node = node.find_next_sibling()

    cats = []

    wi_key = next((k for k in subsections if k.startswith("Writing Intensive")), None)
    if wi_key:
        text = " ".join(subsections[wi_key])
        m = re.search(r"\((\d+)\s*credits?\)", text)
        cat = OrderedDict()
        cat["id"] = "upper-division-writing-intensive"
        cat["name"] = wi_key
        cat["group"] = "Upper-Division Requirements (junior and senior years)"
        if m:
            cat["credits"] = int(m.group(1))
        cat["notes"] = "\n\n".join(subsections[wi_key])
        cat["approved"] = []
        cat["notes"] += (
            "\n\nApproved courses are not listed on this page; Writing Intensive courses "
            "are identified per major by the W attribute in the course catalog."
        )
        cats.append(cat)

    outside_key = next((k for k in subsections if k.startswith("Upper-Division Studies")), None)
    if outside_key:
        options = []
        for key, paras in subsections.items():
            if not key.startswith("Option "):
                continue
            label = key.split(":", 1)[0].strip()
            title = key.split(":", 1)[1].strip() if ":" in key else key
            body = " ".join(paras)
            credits = None
            m = re.search(r"(\d+)\s*(?:credit\s*)?hours", title) or re.search(
                r"\b(six|twelve|\d+)\s*(?:credit\s*)?hours", body
            )
            if m:
                word = m.group(1).lower()
                credits = {"six": 6, "twelve": 12}.get(word, None)
                if credits is None and word.isdigit():
                    credits = int(word)
            opt = OrderedDict()
            opt["id"] = label.lower().replace(" ", "-")
            opt["name"] = title
            if credits is not None:
                opt["credits"] = credits
            opt["notes"] = "\n\n".join(paras)
            options.append(opt)

        cat = OrderedDict()
        cat["id"] = "upper-division-outside-major"
        cat["name"] = outside_key
        cat["group"] = "Upper-Division Requirements (junior and senior years)"
        # Deliberately no `credits`: the catalog states a different figure per option
        # (12 hours for A/B, 6 for D, unspecified for C) and never a single number.
        cat["notes"] = "\n\n".join(subsections[outside_key])
        cat["options"] = options
        cat["approved"] = []
        cat["needs_review"] = True
        cats.append(cat)

    return cats


# --------------------------------------------------------------------------- build


def build(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    main = soup.find(id="textcontainer") or soup

    edition = soup.find(id="edition")
    catalog_year = None
    if edition:
        m = re.search(r"(20\d\d\s*-\s*20\d\d)", norm(edition.get_text(" ")))
        if m:
            catalog_year = m.group(1).replace(" ", "")

    categories = []
    name_to_id = {}
    for anchor in CATEGORY_ANCHORS:
        heading, nodes = section_nodes(main, anchor)
        name = clean_name(heading)
        name_to_id[name.lower()] = anchor
        table = first_table(nodes)
        parsed = parse_courselist(table) if table is not None else {
            "approved": [], "approved_raw": [], "combinations": [],
            "required": [], "comments": [], "credits": None, "areas": {},
        }
        notes = parsed["comments"] + prose_from(nodes)

        cat = OrderedDict()
        cat["id"] = anchor
        cat["name"] = name
        cat["group"] = group_for(main, anchor)
        cat["credits"] = parsed["credits"]
        if notes:
            cat["notes"] = "\n\n".join(notes)
        if parsed["required"]:
            cat["required"] = parsed["required"]
        cat["approved"] = parsed["approved"]
        cat["approved_raw"] = parsed["approved_raw"]
        if parsed["combinations"]:
            cat["combinations"] = parsed["combinations"]
        categories.append(cat)

    honors = honors_by_category(main, name_to_id)
    for cat in categories:
        if cat["id"] in honors:
            cat["honors_approved"] = honors[cat["id"]]

    categories.extend(upper_division(main))

    policies = []
    for anchor in POLICY_ANCHORS:
        heading, nodes = section_nodes(main, anchor)
        text = prose_from(nodes)
        pol = OrderedDict()
        pol["id"] = anchor
        pol["name"] = clean_name(heading)
        pol["text"] = "\n\n".join(text)
        policies.append(pol)

    # Program-wide rules stated before the lower-division section.
    intro = []
    for p in main.find_all("p"):
        t = norm(p.get_text(" "))
        if t.startswith("Students may not use courses in the discipline of their declared major"):
            intro.append(t)
        elif t.startswith("Since the Skills and Ways of Knowing are needed"):
            intro.append(t)
        elif t.startswith("All lower-level requirements within this program may be met"):
            intro.append(t)
    if intro:
        pol = OrderedDict()
        pol["id"] = "general-policies"
        pol["name"] = "General Education Program Policies"
        pol["text"] = "\n\n".join(intro)
        policies.insert(0, pol)

    doc = OrderedDict()
    doc["meta"] = OrderedDict(
        source=SOURCE_URL,
        scraped_at=Quoted(cache_date()),
        catalog_year=Quoted(catalog_year) if catalog_year else None,
    )
    doc["categories"] = categories
    doc["policies"] = policies
    return doc


# ----------------------------------------------------------------------- yaml dump


class Quoted(str):
    """A string that must be emitted with explicit quotes (dates, catalog year)."""


class _Dumper(yaml.SafeDumper):
    pass


def _repr_ordereddict(dumper, data):
    return dumper.represent_mapping("tag:yaml.org,2002:map", data.items())


def _repr_str(dumper, data):
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_Dumper.add_representer(OrderedDict, _repr_ordereddict)
_Dumper.add_representer(str, _repr_str)
_Dumper.add_representer(
    Quoted, lambda d, x: d.represent_scalar("tag:yaml.org,2002:str", str(x), style='"')
)


def dump_yaml(doc: dict) -> str:
    header = (
        "# Generated by scripts/scrape_gened.py -- do not edit by hand.\n"
        f"# Source: {SOURCE_URL}\n"
    )
    body = yaml.dump(
        doc,
        Dumper=_Dumper,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=100,
    )
    return header + body


# --------------------------------------------------------------------------- verify


def verify(doc: dict) -> list[str]:
    problems = []
    cats = {c["id"]: c for c in doc["categories"]}
    for anchor in CATEGORY_ANCHORS:
        if anchor not in cats:
            problems.append(f"missing category: {anchor}")
            continue
        c = cats[anchor]
        if not c.get("credits"):
            problems.append(f"{anchor}: credits missing or zero")
        if not c.get("approved"):
            problems.append(f"{anchor}: empty approved list")
    spot = [
        ("written", "ENGL 110C"),
        ("nature", "PHYS 231N"),
        ("nature", "CHEM 121N"),
        ("oral", "COMM 101R"),
        ("literature", "ENGL 112L"),
        ("math", "MATH 162M"),
    ]
    for cid, code in spot:
        if cid in cats and code not in cats[cid].get("approved", []):
            problems.append(f"{cid}: expected {code} in approved list")
    return problems


# --------------------------------------------------------------------------- review


def write_review(doc: dict) -> str:
    lines = [
        "# Gen-ed scrape review",
        "",
        f"Source: {doc['meta']['source']}  ",
        f"Catalog year: {doc['meta']['catalog_year']}  ",
        f"Scraped: {doc['meta']['scraped_at']}",
        "",
        "Generated by `scripts/scrape_gened.py`. Regenerate rather than editing.",
        "",
        "## Categories",
        "",
        "| id | name | group | credits | # approved | # catalog rows | # honors |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for c in doc["categories"]:
        lines.append(
            "| `{id}` | {name} | {group} | {cr} | {na} | {nr} | {nh} |".format(
                id=c["id"],
                name=c["name"],
                group=c.get("group") or "-",
                cr=c.get("credits", "-") if c.get("credits") is not None else "-",
                na=len(c.get("approved") or []),
                nr=len(c.get("approved_raw") or []),
                nh=len(c.get("honors_approved") or []),
            )
        )
    lines += ["", "## Courses named in a note but absent from `approved`", ""]
    any_extra = False
    for c in doc["categories"]:
        extra = notes_only_codes(c)
        if extra:
            any_extra = True
            lines.append(f"- `{c['id']}`: {', '.join(extra)}")
    if not any_extra:
        lines.append("- none")
    lines += [
        "",
        "These appear in the catalog's prose or in a courselist comment row but are not "
        "rows of the approved table, so they were deliberately not added to `approved`.",
    ]
    lines += ["", "## Interpretations", "", INTERPRETATIONS.strip(), ""]
    return "\n".join(lines)


def notes_only_codes(cat: dict) -> list[str]:
    """Course codes mentioned in a category's notes that are not in its approved list."""
    text = cat.get("notes") or ""
    known = set(cat.get("approved") or []) | set(cat.get("honors_approved") or [])
    out: list[str] = []
    for m in CODE_RE.finditer(text):
        for code in expand_code(m.group(0)):
            if code not in known and code not in out:
                out.append(code)
    return out


INTERPRETATIONS = """
Everything below is a place where the YAML is not a literal transcription of the page.

- **`id`** is the catalog's own anchor name (`#written`, `#nature`, ...) so program pages
  join on it. `upper-division-writing-intensive` and `upper-division-outside-major` have
  no anchors on the page; those two ids are ours.
- **`credits`** is read from the courselist's "Total Credit Hours" row, not computed.
- **`required`** (only Written Communication) holds courses whose table row is *not*
  indented under a "Select one of the following" comment -- i.e. ENGL 110C is required
  outright and the remaining 3 of the 6 credits come from ENGL 211C or ENGL 231C. Every
  other category's rows are all indented, so no other category gets a `required` key.
- **Cross-listed labels are expanded.** The catalog prints one link per cross-list, e.g.
  `PHIL/REL 150P`, `CS/CYSE/PHIL 202G`, `HIST/HNRS 386T/SCI 302T`. `approved` holds one
  single-subject code per cross-list (`PHIL 150P`, `REL 150P`, ...) so codes join with
  `courses.yaml`; `approved_raw` keeps the catalog's exact label.
- **`&` rows are paired courses**, e.g. `CHEM 121N & CHEM 122N` (lecture + lab). Both
  codes appear individually in `approved`; the pairing is preserved in `combinations`
  and verbatim in `approved_raw`. A planner must treat a `combinations` entry as
  all-or-nothing -- `CHEM 121N` alone does not satisfy the requirement.
- **`orclass` rows** (only `or OEAS 111N` under Nature of Science) are folded into the
  approved pool, per the catalog's own "select one/two of the following" framing. The
  `or` marker survives in `approved_raw`.
- **`notes`** concatenates, verbatim and in page order: the courselist's instruction /
  comment rows, then the prose paragraphs and footnotes that follow the table in that
  section. Nothing is paraphrased.
- **`honors_approved`** comes from the separate "Honors Courses that Meet General
  Education Requirements" table, matched to a category by that table's area headers.
  Those courses are open only to Perry Honors College students (catalog footnote), so
  they are kept out of `approved`.
- **`group`** ("Skills" / "Ways of Knowing") is derived from the enclosing `h3`, with the
  roman numeral stripped.
- **Whitespace only** is normalized in `notes`: non-breaking spaces become spaces and the
  stray space the catalog leaves before punctuation after an inline course link is
  removed. No wording is changed, reordered or summarized.
- **Nothing is added by rule.** Mathematics lists exactly MATH 101M/102M/103M/162M and
  STAT 130M; MATH 211 and other 200-level courses are *not* on the approved list, only
  alluded to by the note "Some programs require more advanced 200-level courses".
  Likewise Language and Culture lists only the first-year sequences actually printed,
  with the "third level in one language / second level in two languages" rule left in
  `notes`.
- **`upper-division-writing-intensive` has an empty `approved` list.** The page states the
  requirement (3 credits, C or better, in the major) but names no courses; W courses are
  flagged per course in the catalog, not here.
- **`upper-division-outside-major` has no `credits` key.** The catalog states a different
  figure per option (12 hours for A and B, 6 for D, unspecified for C) and never a single
  number, so the value is left out and `needs_review: true` is set; per-option credits
  are in `options`.
"""


# ----------------------------------------------------------------------------- main


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="re-download the source page")
    ap.add_argument("--no-review", action="store_true", help="do not write gened_review.md")
    args = ap.parse_args(argv)

    html = fetch(refresh=args.refresh)
    doc = build(html)

    text = dump_yaml(doc)
    OUT_YAML.parent.mkdir(parents=True, exist_ok=True)
    OUT_YAML.write_text(text, encoding="utf-8")

    # Round-trip check: the file we just wrote must load.
    reloaded = yaml.safe_load(OUT_YAML.read_text(encoding="utf-8"))
    problems = verify(reloaded)

    if not args.no_review:
        OUT_REVIEW.write_text(write_review(doc) + "\n", encoding="utf-8")

    lower = [c for c in doc["categories"] if c["id"] in CATEGORY_ANCHORS]
    print(f"wrote {OUT_YAML.relative_to(ROOT)}: {len(doc['categories'])} categories "
          f"({len(lower)} lower-division), "
          f"{sum(len(c.get('approved') or []) for c in doc['categories'])} approved codes")
    if problems:
        print("VERIFY FAILED:")
        for p in problems:
            print("  -", p)
        return 1
    print("verify: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
