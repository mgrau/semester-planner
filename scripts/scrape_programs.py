#!/usr/bin/env python3
"""Scrape ODU Physics department degree programs into data/programs/<slug>.yaml.

Sources every program linked from https://catalog.odu.edu/undergraduate/sciences/physics/
plus the explicit seed list below.  Raw HTML is cached under scripts/.cache/programs/ so
repeated runs are offline and idempotent; pass --refresh to re-download.

Output conforms to data/SCHEMA.md (`programs/<slug>.yaml` section).

Usage:
    python3 scripts/scrape_programs.py            # use cache when present
    python3 scripts/scrape_programs.py --refresh  # re-download every page
    python3 scripts/scrape_programs.py --only physics-bs
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys
import time
import urllib.parse
import urllib.request

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required: pip install pyyaml")

try:
    from bs4 import BeautifulSoup, NavigableString, Tag
except ImportError:  # pragma: no cover
    sys.exit("beautifulsoup4 is required: pip install beautifulsoup4")


BASE = "https://catalog.odu.edu"
DEPT_URL = f"{BASE}/undergraduate/sciences/physics/"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE_DIR = os.path.join(HERE, ".cache", "programs")
OUT_DIR = os.path.join(ROOT, "data", "programs")
REVIEW_PATH = os.path.join(ROOT, "data", "programs_review.md")

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) semester_planner-scraper/1.0"

# Explicit seed list (catalog order); anything else found on the department page is appended.
SEED_SLUGS = [
    "physics-bs",
    "physics-professional-bs",
    "physics-astrophysics-bs",
    "physics-electrical-engineering-bs",
    "physics-business-administration-bs-mba",
]

# Gen-ed category ids, keyed by the catalog anchor on /requirements-undergraduate-degrees/.
GENED_IDS = {
    "written", "oral", "math", "language", "information", "behavior",
    "creativity", "interpret", "literature", "nature", "philosophy", "impact",
}

# Fallback name -> id map (the live map is built from each page's own anchors).
GENED_NAME_FALLBACK = {
    "written communication": "written",
    "oral communication": "oral",
    "mathematics": "math",
    "language and culture": "language",
    "information literacy and research": "information",
    "human behavior": "behavior",
    "human creativity": "creativity",
    "interpreting the past": "interpret",
    "literature": "literature",
    "philosophy and ethics": "philosophy",
    "the nature of science": "nature",
    "nature of science": "nature",
    "impact of technology": "impact",
}

COURSE_RE = re.compile(r"^[A-Z]{2,5} \d{3}[A-Z]?$")
SELECT_RE = re.compile(r"^select\s+(\w+)\s+of the following", re.I)
WORD_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}


# --------------------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------------------
def fetch(url: str, cache_name: str, refresh: bool = False) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, cache_name)
    if os.path.exists(path) and not refresh:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        html = resp.read().decode("utf-8", "replace")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)
    time.sleep(0.5)  # be polite to the catalog
    return html


def discover_slugs(refresh: bool = False) -> list[str]:
    html = fetch(DEPT_URL, "_index.html", refresh)
    found = []
    for href in re.findall(r'href="(/undergraduate/sciences/physics/[^"]+)"', html):
        seg = [p for p in href.split("/") if p]
        if not seg or seg[-1].endswith(".pdf"):
            continue
        slug = seg[-1]
        if slug != "physics" and slug not in found:
            found.append(slug)
    ordered = [s for s in SEED_SLUGS if s in found or True]
    for s in sorted(found):
        if s not in ordered:
            ordered.append(s)
    return ordered


# --------------------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------------------
def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def tight_text(node) -> str:
    """get_text with no injected separator (the catalog's own spacing is already correct).

    <br> is a line break in the source, so it becomes a space rather than nothing.
    """
    clone = BeautifulSoup(str(node), "html.parser")
    for br in clone.find_all("br"):
        br.replace_with(" ")
    return norm(clone.get_text(""))


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", norm(text).lower()).strip("-")
    return s or "group"


def parse_credits(text: str):
    """'4' -> 4, '0-6' -> '0-6', '' -> None. Never invents a number."""
    t = norm(text)
    if not t:
        return None
    if re.fullmatch(r"\d+", t):
        return int(t)
    if re.fullmatch(r"\d+\.\d+", t):
        return float(t)
    if re.fullmatch(r"\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?", t):
        return re.sub(r"\s*-\s*", "-", t)
    return t


def credits_low(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        m = re.match(r"(\d+(?:\.\d+)?)", value)
        if m:
            return float(m.group(1))
    return 0.0


def sup_markers(node) -> list[str]:
    return [norm(s.get_text()) for s in node.find_all("sup") if norm(s.get_text())]


def strip_sups(node) -> str:
    clone = BeautifulSoup(str(node), "html.parser")
    for s in clone.find_all("sup"):
        s.decompose()
    return tight_text(clone)


def course_codes(node) -> list[str]:
    codes = []
    for a in node.find_all("a", class_="code"):
        code = norm(a.get("title") or a.get_text())
        if COURSE_RE.match(code) and code not in codes:
            codes.append(code)
    return codes


def code_alternatives(node) -> list[list[str]]:
    """Split a code cell into alternatives on the literal word 'or'.

    'PHYS 499W or PHYS 489W & PHYS 490W' -> [['PHYS 499W'], ['PHYS 489W', 'PHYS 490W']]
    'CHEM 121N and CHEM 122N'            -> [['CHEM 121N', 'CHEM 122N']]
    """
    alts: list[list[str]] = [[]]
    for el in node.descendants:
        if isinstance(el, Tag):
            if el.name == "a" and "code" in (el.get("class") or []):
                code = norm(el.get("title") or el.get_text())
                if COURSE_RE.match(code):
                    alts[-1].append(code)
            continue
        if isinstance(el, NavigableString):
            if el.parent is not None and el.parent.name == "a":
                continue
            if re.search(r"\bor\b", norm(str(el)), re.I):
                alts.append([])
    return [a for a in alts if a]


def first_element(node):
    for child in node.children:
        if isinstance(child, NavigableString):
            if norm(str(child)):
                return child
            continue
        if isinstance(child, Tag):
            return child
    return None


def is_option_row(codecol) -> bool:
    """True when the whole code cell is indented (a member of a 'Select ...' pool)."""
    first = first_element(codecol)
    return isinstance(first, Tag) and "blockindent" in (first.get("class") or [])


def continuation(codecol) -> str | None:
    """'and' / 'or' for a wrapped second line inside one code cell, else None."""
    for el in codecol.find_all(class_="blockindent"):
        if el is first_element(codecol):
            continue
        lead = norm(el.get_text())[:3].lower()
        if lead.startswith("&"):
            return "and"
        if lead.startswith("or"):
            return "or"
    return None


def sentences(text: str) -> list[str]:
    text = norm(text)
    if not text:
        return []
    parts = re.split(r"(?<=[a-zA-Z0-9\)\"'])(?<!\s[A-Z])\.\s+(?=[A-Z(])", text)
    merged: list[str] = []
    for p in parts:
        if merged and merged[-1].count("(") > merged[-1].count(")"):
            merged[-1] = merged[-1] + ". " + p  # never split inside a parenthetical
        else:
            merged.append(p)
    out = []
    for p in merged:
        p = p.strip()
        if not p:
            continue
        if not p.endswith((".", ":", ";")):
            p += "."
        out.append(p)
    return out


# --------------------------------------------------------------------------------------
# YAML output with schema-style inline maps
# --------------------------------------------------------------------------------------
class Flow(dict):
    pass


class FlowList(list):
    pass


class Quoted(str):
    pass


class Dumper(yaml.SafeDumper):
    pass


Dumper.add_representer(
    Quoted, lambda d, data: d.represent_scalar("tag:yaml.org,2002:str", str(data), style='"')
)
Dumper.add_representer(
    Flow, lambda d, data: d.represent_mapping("tag:yaml.org,2002:map", data, flow_style=True)
)
Dumper.add_representer(
    FlowList, lambda d, data: d.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=True)
)


def dump_yaml(obj) -> str:
    return yaml.dump(
        obj, Dumper=Dumper, sort_keys=False, allow_unicode=True, default_flow_style=False, width=110
    )


# --------------------------------------------------------------------------------------
# course-list table parsing
# --------------------------------------------------------------------------------------
def parse_courselist(table) -> tuple[list[dict], object]:
    """Flatten one sc_courselist into ordered rows plus the table's Total Credit Hours."""
    rows, total = [], None
    for tr in table.find_all("tr"):
        classes = tr.get("class") or []
        if "hidden" in classes:
            continue
        hours_td = tr.find("td", class_="hourscol")
        credits = parse_credits(hours_td.get_text()) if hours_td else None
        if "listsum" in classes:
            total = credits
            continue
        header = tr.find("span", class_="courselistcomment areaheader") or tr.find(
            "span", class_=lambda c: c and "areaheader" in c
        )
        if "areaheader" in classes or header is not None:
            rows.append({"kind": "area", "text": norm((header or tr).get_text(" "))})
            continue
        codecol = tr.find("td", class_="codecol")
        comment = tr.find("span", class_="courselistcomment")
        if codecol is None and comment is not None:
            gened = None
            for a in comment.find_all("a", href=True):
                frag = urllib.parse.urlparse(a["href"]).fragment
                if frag in GENED_IDS:
                    gened = frag
                    break
            rows.append({
                "kind": "comment",
                "text": strip_sups(comment),
                "gened": gened,
                "credits": credits,
                "markers": sup_markers(comment),
                "codes": course_codes(comment),
            })
            continue
        if codecol is None:
            continue
        tds = tr.find_all("td")
        title_td = None
        for td in tds:
            if td is codecol or "hourscol" in (td.get("class") or []):
                continue
            title_td = td
            break
        rows.append({
            "kind": "course",
            "codes": course_codes(codecol),
            "join": continuation(codecol),
            "option": is_option_row(codecol),
            "alternative": "orclass" in classes,
            "credits": credits,
            "title": strip_sups(title_td) if title_td else "",
            "markers": sup_markers(codecol) + (sup_markers(title_td) if title_td else []),
        })
    return rows, total


LEVEL_RULE_RE = re.compile(
    r"(\d)00\s*(?:or\s*(\d)00)?\s*-?\s*level\s+([A-Z]{2,5})\s+courses?", re.I
)


def rule_filter(text: str):
    m = LEVEL_RULE_RE.search(text)
    if not m:
        return None
    levels = [int(m.group(1)) * 100]
    if m.group(2):
        levels.append(int(m.group(2)) * 100)
    return Flow({"level_min": min(levels), "subject": FlowList([m.group(3).upper()])})


class GroupBuilder:
    """Turns flattened course-list rows into SCHEMA requirement groups."""

    def __init__(self, ctx):
        self.ctx = ctx  # ProgramParser, for warnings + gened lookups
        self.groups: list[dict] = []
        self.ids: dict[str, int] = {}

    def new_id(self, base: str) -> str:
        base = slugify(base)[:48].strip("-") or "group"
        n = self.ids.get(base, 0) + 1
        self.ids[base] = n
        return base if n == 1 else f"{base}-{n}"

    def add(self, group: dict, at=None) -> dict:
        if at is None:
            self.groups.append(group)
        else:
            self.groups.insert(at, group)
        return group

    def run(self, rows, section=None, default_area=None):
        area = default_area
        area_start = len(self.groups)
        core: list[dict] = []          # required single/paired courses in the current area
        pool = None                    # pending "Select N of the following:" group
        choice = None                  # pending course-with-or-alternatives group

        def flush_core():
            nonlocal core, area_start
            if not core:
                return
            codes = []
            for entry in core:
                for c in entry["codes"]:
                    if c not in codes:
                        codes.append(c)
            total = sum(credits_low(e["credits"]) for e in core if e["credits"] is not None)
            exact = all(isinstance(e["credits"], (int, float)) for e in core if e["credits"] is not None)
            label = area or section or ""
            if re.fullmatch(r"requirements?", label, re.I):
                label = ""
            g = {
                "id": self.new_id(f"{label}-required" if label else "required"),
                "name": f"{label} Required Courses".strip(),
                "all_of": FlowList(codes),
            }
            if section:
                g["section"] = section
            if area and area != section:
                g["area"] = area
            if exact and total:
                g["credits"] = int(total) if float(total).is_integer() else total
            markers = sorted({m for e in core for m in e["markers"]})
            if markers:
                g["footnote_refs"] = FlowList(markers)
            self.add(g, at=area_start)
            core = []

        def close_pool():
            nonlocal pool
            if pool is not None:
                if not pool["group"]["one_of"]:
                    self.groups.remove(pool["group"])
                pool = None

        def close_choice():
            nonlocal choice
            choice = None

        for row in rows:
            if row["kind"] == "area":
                close_pool(); close_choice(); flush_core()
                area = row["text"]
                area_start = len(self.groups)
                continue

            if row["kind"] == "comment":
                text = row["text"]
                if row["gened"]:
                    close_pool(); close_choice()
                    g = {
                        "id": self.new_id(f"gened-{row['gened']}"),
                        "name": text,
                        "gened": row["gened"],
                    }
                    if row["credits"] is not None:
                        g["credits"] = row["credits"]
                    if section:
                        g["section"] = section
                    self.add(g)
                    continue
                m = SELECT_RE.match(text)
                if m:
                    close_choice()
                    close_pool()
                    g = {
                        "id": self.new_id(f"{area or section or 'select'}-select"),
                        "name": text,
                        "one_of": FlowList([]),
                    }
                    if row["credits"] is not None:
                        g["credits"] = row["credits"]
                    if section:
                        g["section"] = section
                    if area and area != section:
                        g["area"] = area
                    if row["markers"]:
                        g["footnote_refs"] = FlowList(row["markers"])
                    self.add(g)
                    pool = {"group": g, "n": WORD_NUM.get(m.group(1).lower())}
                    continue
                # a free-text requirement (no course list)
                close_pool(); close_choice()
                g = {
                    "id": self.new_id(text),
                    "name": text,
                    "notes": text,
                }
                if row["credits"] is not None:
                    g["credits"] = row["credits"]
                if row["codes"]:
                    g["one_of"] = FlowList(row["codes"])
                filt = rule_filter(text)
                if filt:
                    g["filter"] = filt
                    g["needs_review"] = True
                if section:
                    g["section"] = section
                if area and area != section:
                    g["area"] = area
                self.add(g)
                continue

            # kind == course
            codes = row["codes"]
            if not codes:
                continue

            if row["option"]:
                if pool is not None:
                    if len(codes) > 1 and row["join"] == "and":
                        pool["group"]["one_of"].append(Flow({"all_of": FlowList(codes)}))
                        pool["group"]["needs_review"] = True
                    else:
                        for c in codes:
                            pool["group"]["one_of"].append(c)
                    continue
                if choice is not None:
                    if len(codes) > 1 and row["join"] == "and":
                        choice["one_of"].append(Flow({"all_of": FlowList(codes)}))
                    else:
                        choice["one_of"].extend(codes)
                    continue
                self.ctx.warn(f"indented course row with no open selection group: {codes}")
                core.append(row)
                continue

            close_pool()

            if row["alternative"]:
                if choice is None:
                    if not core:
                        self.ctx.warn(f"'or' row with nothing to attach to: {codes}")
                        core.append(row)
                        continue
                    prev = core.pop()
                    base = Flow({"all_of": FlowList(prev["codes"])}) if len(prev["codes"]) > 1 else prev["codes"][0]
                    label = " or ".join(
                        [" & ".join(prev["codes"])] + [" & ".join(codes)]
                    )
                    choice = {
                        "id": self.new_id(f"{'-'.join(prev['codes'])}-or"),
                        "name": label,
                        "one_of": FlowList([base]),
                    }
                    if prev["credits"] is not None:
                        choice["credits"] = prev["credits"]
                    if section:
                        choice["section"] = section
                    if area and area != section:
                        choice["area"] = area
                    markers = sorted(set(prev["markers"]) | set(row["markers"]))
                    if markers:
                        choice["footnote_refs"] = FlowList(markers)
                    self.add(choice)
                if len(codes) > 1 and row["join"] == "and":
                    choice["one_of"].append(Flow({"all_of": FlowList(codes)}))
                else:
                    choice["one_of"].extend(codes)
                choice["name"] = " or ".join(
                    [c if isinstance(c, str) else " & ".join(c["all_of"]) for c in choice["one_of"]]
                )
                continue

            close_choice()
            if len(codes) > 1 and row["join"] == "or":
                # inline "X or Y" in a single cell
                g = {
                    "id": self.new_id("-".join(codes) + "-or"),
                    "name": " or ".join(codes),
                    "one_of": FlowList(codes),
                }
                if row["credits"] is not None:
                    g["credits"] = row["credits"]
                if section:
                    g["section"] = section
                if area and area != section:
                    g["area"] = area
                self.add(g)
                continue
            core.append(row)

        close_pool()
        close_choice()
        flush_core()
        return self.groups


# --------------------------------------------------------------------------------------
# plan-of-study (sc_plangrid) parsing
# --------------------------------------------------------------------------------------
def parse_plangrid(table, ctx) -> tuple[list[dict], object]:
    terms: list[dict] = []
    grand_total = None
    year = None
    cur = None
    pool = None

    def close_pool():
        nonlocal pool
        if pool is not None and not pool["one_of"]:
            cur["items"].remove(pool)
        pool = None

    for tr in table.find_all("tr"):
        classes = tr.get("class") or []
        if "hidden" in classes:
            continue
        if "plangridyear" in classes:
            close_pool()
            year = norm(tr.get_text(" "))
            continue
        if "plangridterm" in classes:
            close_pool()
            cur = {"year": year, "term": norm(tr.find("th").get_text(" ")), "items": []}
            terms.append(cur)
            continue
        if "plangridsum" in classes:
            close_pool()
            if cur is not None:
                hours = tr.find("td", class_="hourscol")
                cur["credits"] = parse_credits(hours.get_text()) if hours else None
            continue
        if "plangridtotal" in classes:
            close_pool()
            hours = tr.find("td", class_="hourscol")
            grand_total = parse_credits(hours.get_text()) if hours else None
            continue
        if cur is None:
            continue

        codecol = tr.find("td", class_="codecol")
        if codecol is None:
            continue
        hours = tr.find("td", class_="hourscol")
        credits = parse_credits(hours.get_text()) if hours else None
        title_td = tr.find("td", class_="titlecol")
        markers = sup_markers(codecol) + (sup_markers(title_td) if title_td else [])
        codes = course_codes(codecol)
        comment = codecol.find("span", class_="comment")
        text = strip_sups(codecol)

        item: dict | None = None
        if is_option_row(codecol) and pool is not None:
            if len(codes) > 1:
                pool["one_of"].append(Flow({"all_of": FlowList(codes)}))
            else:
                pool["one_of"].extend(codes)
            continue

        close_pool()

        if not codes:
            m = SELECT_RE.match(text)
            item = Flow({"one_of": FlowList([])} if m else {"placeholder": text})
            if m:
                pool = item
            else:
                cat = ctx.category_for(text)
                if cat:
                    item["category"] = cat
        elif len(codes) == 1 and comment is None:
            item = Flow({"course": codes[0]})
            note = title_td.find("span", class_="comment") if title_td else None
            if note is not None:
                item["notes"] = norm(note.get_text(" "))
        elif len(codes) == 1:
            item = Flow({"course": codes[0]})
            if text != codes[0]:
                item["notes"] = text
        else:
            # Multi-course cell ("X and Y", "X or Y", "X or Y & Z").  SCHEMA.md models the
            # "CHEM 121N and CHEM 122N" cell as one_of, so a pure conjunction stays flat and the
            # verbatim cell text is preserved in notes; a real "or" keeps its alternatives, with
            # any conjoined pair nested as all_of.
            alts = code_alternatives(codecol)
            if len(alts) > 1:
                options = [a[0] if len(a) == 1 else Flow({"all_of": FlowList(a)}) for a in alts]
                item = Flow({"one_of": FlowList(options), "notes": text})
            else:
                item = Flow({"one_of": FlowList(codes), "notes": text})

        if credits is not None:
            item["credits"] = credits
        if markers:
            item["footnote_refs"] = FlowList(markers)
        cur["items"].append(item)

    close_pool()
    for t in terms:
        t.setdefault("credits", None)
        if t["credits"] is None:
            t.pop("credits")
        t["items"] = t.pop("items")
    return terms, grand_total


# --------------------------------------------------------------------------------------
# program parser
# --------------------------------------------------------------------------------------
SATISFIES_RE = re.compile(
    r"^([A-Z]{2,5} \d{3}[A-Z]?)\s+satisfies\s+(?:both\s+)?(.+?)\.?$", re.I
)
MEETS_RE = re.compile(r"\((?:meets|satisfies|fulfills)\s+(.+?)\s+requirements?\)", re.I)
CATS_MET_RE = re.compile(
    r"general education requirements?\s+(?:for|in)\s+(.+?)\s+(?:are|is)\s+"
    r"(?:met|satisfied)\s+(?:through|by)\s+the\s+[\w /]*?\b(?:major|degree)",
    re.I,
)


class ProgramParser:
    def __init__(self, slug: str, html: str, scraped_at: str):
        self.slug = slug
        self.url = f"{BASE}/undergraduate/sciences/physics/{slug}/"
        self.soup = BeautifulSoup(html, "html.parser")
        self.scraped_at = scraped_at
        self.warnings: list[str] = []
        self.gened_names: dict[str, str] = {}   # normalized name -> id
        self.double_counts: list[Flow] = []
        self.policies: list[str] = []
        self.footnotes: list[Flow] = []
        self.plan_footnotes: list[Flow] = []
        self.plan_notes: list[str] = []
        self._collect_gened_names()

    # -- helpers -----------------------------------------------------------------
    def warn(self, msg: str):
        self.warnings.append(msg)

    def _collect_gened_names(self):
        for name, cid in GENED_NAME_FALLBACK.items():
            self.gened_names[name] = cid
        for a in self.soup.find_all("a", href=True):
            frag = urllib.parse.urlparse(a["href"]).fragment
            if frag in GENED_IDS:
                self.gened_names[self._nname(a.get_text())] = frag

    @staticmethod
    def _nname(text: str) -> str:
        t = norm(text).lower().replace("&", "and")
        t = re.sub(r"[^a-z0-9 ]+", " ", t)
        t = re.sub(r"\s+", " ", t).strip()
        return re.sub(r"^the ", "", t)

    def category_for(self, text: str) -> str | None:
        """Map free text onto a gen-ed category id; exact match first, then substring."""
        t = self._nname(text)
        if t in self.gened_names:
            return self.gened_names[t]
        for name in sorted(self.gened_names, key=len, reverse=True):
            if len(name) >= 8 and name in t:
                return self.gened_names[name]
        return None

    def catalog_year(self) -> str | None:
        el = self.soup.find(id="edition")
        if el:
            m = re.search(r"(\d{4}-\d{4})", el.get_text(" "))
            if m:
                return m.group(1)
        return None

    def title(self) -> str:
        h1 = self.soup.find("h1", class_="page-title")
        if not h1:
            return self.slug
        clone = BeautifulSoup(str(h1), "html.parser")
        for s in clone.find_all("span", class_="degree"):
            s.decompose()
        return norm(clone.get_text(" "))

    def degree(self) -> str | None:
        m = re.search(r"\(([A-Z/]{2,12})\)\s*$", self.title())
        if m:
            return m.group(1)
        h1 = self.soup.find("h1", class_="page-title")
        span = h1.find("span", class_="degree") if h1 else None
        return norm(span.get_text(" ")) if span else None

    # -- double counts -----------------------------------------------------------
    def add_double_count(self, course: str | None, target_text: str, source: str):
        cat = self.category_for(re.sub(r"\brequirements?\b", "", target_text, flags=re.I))
        entry = Flow()
        if course:
            entry["course"] = course
        if cat:
            entry["satisfies"] = cat
        else:
            entry["satisfies_requirement"] = norm(target_text)
        entry["source"] = norm(source)
        key = (entry.get("course"), entry.get("satisfies"), entry.get("satisfies_requirement"))
        for existing in self.double_counts:
            ekey = (existing.get("course"), existing.get("satisfies"),
                    existing.get("satisfies_requirement"))
            if ekey == key:
                if entry["source"] not in existing["source"]:
                    existing["source"] = existing["source"] + " / " + entry["source"]
                return
        self.double_counts.append(entry)

    def scan_category_statements(self, text: str, gened_groups: dict | None = None):
        """'General education requirements for X, Y and Z are met through the major.'"""
        m = CATS_MET_RE.search(norm(text))
        if not m:
            return
        source = next((s for s in sentences(text) if CATS_MET_RE.search(s)), norm(text))
        # Category names contain "and" ("philosophy and ethics"), so split on commas first and
        # only fall back to splitting on "and" when a comma-item does not resolve.
        names: list[str] = []
        for part in re.split(r",\s*", m.group(1)):
            part = norm(re.sub(r"^and\s+", "", norm(part), flags=re.I))
            if not part:
                continue
            if self.category_for(part):
                names.append(part)
            else:
                names.extend(norm(q) for q in re.split(r"\s+and\s+", part) if norm(q))
        for name in names:
            cat = self.category_for(name)
            if not cat:
                self.warn(f"unmapped category in 'met through the major' list: {name!r}")
                continue
            self.add_double_count(None, name, source)
            if gened_groups and cat in gened_groups:
                gened_groups[cat]["satisfied_by_major"] = True
                gened_groups[cat].setdefault("notes", source)

    def scan_satisfies(self, text: str):
        """Extract explicit '<COURSE> satisfies <requirement>' statements. No inference."""
        text = norm(text)
        m = SATISFIES_RE.match(text)
        if not m:
            return
        course, targets = m.group(1), m.group(2)
        # The catalog's pattern is "satisfies both the X requirement and the Y requirement".
        # Only split on an "and" that introduces a new "the ..." clause, so that category names
        # containing "and" (Information Literacy and Research) survive intact.
        for part in re.split(r"\s+and\s+(?=the\s+)", targets):
            part = norm(re.sub(r"^(?:the|both)\s+", "", part, flags=re.I))
            part = re.sub(r"\s+in the .*$", "", part, flags=re.I)
            part = re.sub(r"^PHYS\s+(?=[A-Z])", "", part)
            if part:
                self.add_double_count(course, part, text)

    # -- narrative ---------------------------------------------------------------
    def collect_footnotes(self, container, target=None):
        for dl in container.find_all("dl", class_="sc_footnotes"):
            marker = None
            for child in dl.find_all(["dt", "dd"]):
                if child.name == "dt":
                    marker = norm(child.get_text(" "))
                else:
                    text = tight_text(child)
                    (self.footnotes if target is None else target).append(
                        Flow({"marker": marker or "", "text": text})
                    )
                    self.scan_satisfies(text)

    # -- main --------------------------------------------------------------------
    def parse(self) -> dict:
        req = self.soup.find(id="requirementstextcontainer")
        guide = self.soup.find(id="degreeprogramguidetextcontainer")
        overview = self.soup.find(id="textcontainer")

        builder = GroupBuilder(self)
        totals = []
        gened_groups: dict[str, dict] = {}

        if req is not None:
            heading = None
            upper = None  # open "Upper-Division General Education" group, if any
            for el in req.children:
                if not isinstance(el, Tag):
                    continue
                if el.name in ("h2", "h3", "h4"):
                    heading = norm(el.get_text(" "))
                    upper = None
                    if re.search(r"upper-division general education", heading, re.I):
                        upper = {
                            "id": builder.new_id("upper-division-gened"),
                            "name": heading,
                            "section": heading,
                        }
                        builder.add(upper)
                    continue
                if upper is not None and el.name in ("ul", "ol"):
                    upper["options"] = [norm(li.get_text(" ")) for li in el.find_all("li")]
                    continue
                if upper is not None and el.name == "p":
                    note = tight_text(el)
                    upper["notes"] = (upper["notes"] + " " + note) if upper.get("notes") else note
                    continue
                if el.name == "table" and "sc_courselist" in (el.get("class") or []):
                    rows, total = parse_courselist(el)
                    if total is not None:
                        totals.append(total)
                    is_gened_table = sum(1 for r in rows if r.get("gened")) >= 3
                    section = heading or ("Lower-Division General Education" if is_gened_table else None)
                    start = len(builder.groups)
                    builder.run(rows, section=section, default_area=None if is_gened_table else heading)
                    if is_gened_table:
                        for g in builder.groups[start:]:
                            if g.get("gened"):
                                gened_groups[g["gened"]] = g
                    for row in rows:
                        if row["kind"] == "course" and row.get("title"):
                            mm = MEETS_RE.search(row["title"])
                            if mm and row["codes"]:
                                self.add_double_count(
                                    row["codes"][0], mm.group(1),
                                    f"{row['codes'][0]} — {row['title']}",
                                )
                    continue
                if el.name == "p":
                    self.scan_category_statements(tight_text(el), gened_groups)
                    self._gened_note(el, gened_groups)
                    continue
                if el.name in ("ul", "ol"):
                    for li in el.find_all("li"):
                        self.policies.extend(sentences(tight_text(li)))

            self.collect_footnotes(req)

        plan, plan_total = ([], None)
        if guide is not None:
            grid = guide.find("table", class_="sc_plangrid")
            if grid is not None:
                plan, plan_total = parse_plangrid(grid, self)
            self.collect_footnotes(guide, self.plan_footnotes)
            seen_grid = False
            for el in guide.children:
                if not isinstance(el, Tag):
                    continue
                if el.name == "table" and "sc_plangrid" in (el.get("class") or []):
                    seen_grid = True
                    continue
                if seen_grid and el.name == "p":
                    note = tight_text(el)
                    if note:
                        self.plan_notes.append(note)
                        self.scan_category_statements(note)

        program: dict = {
            "id": self.slug,
            "name": self.title(),
        }
        deg = self.degree()
        if deg:
            program["degree"] = deg
        program["department"] = "Physics"
        tc = self.total_credits(totals)
        if tc is not None:
            program["total_credits"] = tc
        if totals:
            program["credits_listed"] = totals[-1] if len(totals) == 1 else FlowList(totals)
        if overview is not None:
            paras = overview.find_all("p")
            if paras:
                desc = tight_text(paras[0])
                if desc:
                    program["description"] = desc
                # Some pages (secondary education) put admission / continuance / licensure rules
                # on the overview tab; those are advisor-checklist policies, so keep them.
                extra: list[str] = []
                for el in overview.find_all(["p", "li"]):
                    if el is paras[0] or el.find_parent("li") is not None:
                        continue
                    extra.extend(sentences(tight_text(el)))
                self.policies.extend(extra)
            else:
                desc = tight_text(overview)
                if desc:
                    program["description"] = desc
        program["requirements"] = builder.groups
        if self.double_counts:
            program["double_counts"] = self.double_counts
        if self.policies:
            seen, uniq = set(), []
            for p in self.policies:
                if p not in seen:
                    seen.add(p)
                    uniq.append(p)
            program["policies"] = uniq
        if self.footnotes:
            program["footnotes"] = self.footnotes
        if self.plan_notes:
            program["plan_notes"] = self.plan_notes
        if self.plan_footnotes:
            program["plan_footnotes"] = self.plan_footnotes
        if plan:
            program["plan_of_study"] = plan
            if plan_total is not None:
                program["plan_total_credits"] = plan_total

        return {
            "meta": {
                "source": self.url,
                "scraped_at": Quoted(self.scraped_at),
                "catalog_year": Quoted(self.catalog_year() or ""),
            },
            "program": program,
        }

    def _gened_note(self, p: Tag, gened_groups: dict[str, dict]):
        """Handle the '<Category>: satisfied by the major' / ': CS 120G or ...' notes."""
        text = tight_text(p)
        if not text or ":" not in text:
            if text:
                self.policies.extend(sentences(text))
            return
        left, right = text.split(":", 1)
        cat = self.category_for(left)
        codes = course_codes(p)
        if cat is None:
            self.policies.extend(sentences(text))
            return
        group = gened_groups.get(cat)
        if re.search(r"satisfied by the major", right, re.I):
            if group is not None:
                group["satisfied_by_major"] = True
                group["notes"] = text
            self.add_double_count(None, left, text)
            return
        if codes:
            if group is not None:
                group["one_of"] = FlowList(codes)
                group["notes"] = text
            return
        self.policies.extend(sentences(text))

    def total_credits(self, table_totals):
        """Degree total, taken from the catalog's own 'minimum of N credit hours' sentence."""
        req = self.soup.find(id="requirementstextcontainer")
        text = norm(req.get_text(" ")) if req else ""
        m = re.search(r"minimum of (\d{2,3}) credit hours", text)
        if not m:
            return table_totals[-1] if len(table_totals) == 1 else None
        base = int(m.group(1))
        par = re.search(r"\((\d{2,3}) credit hours for the dual degree[^)]*\)", text)
        if par and self.is_dual_degree():
            return int(par.group(1))
        return base

    def is_dual_degree(self) -> bool:
        req = self.soup.find(id="requirementstextcontainer")
        if req is None:
            return False
        for el in req.find_all(["h2", "h3", "h4"]) + req.find_all(
            "span", class_=lambda c: c and "areaheader" in c
        ):
            if "dual degree" in norm(el.get_text(" ")).lower():
                return True
        return "dual degree" in self.title().lower()


# --------------------------------------------------------------------------------------
# review report
# --------------------------------------------------------------------------------------
SUSPECTED_TEMPLATE = """\
### Suspected (NOT in the YAML — catalog does not state the course-level mapping)

{items}
"""


def build_review(results: list[tuple[str, dict, ProgramParser]]) -> str:
    today = _dt.date.today().isoformat()
    out = [
        "# Programs scrape — review notes",
        "",
        f"Generated by `scripts/scrape_programs.py` on {today}. "
        "Source: catalog.odu.edu undergraduate Physics department.",
        "",
        "This file records what the parser read straight off the page versus what needed a "
        "judgement call, plus double-count relationships that look real but that the catalog "
        "does not actually state. Nothing in the *suspected* sections has been written into the "
        "YAML.",
        "",
    ]

    out += [
        "## Cross-cutting interpretation notes",
        "",
        "- **Multi-course plan-of-study cells.** `SCHEMA.md` models the "
        "`CHEM 121N and CHEM 122N` cell as `{one_of: [CHEM 121N, CHEM 122N], credits: 4}`, so "
        "every multi-course plan cell is emitted as `one_of`, including the ones the catalog "
        "joins with *and*. The verbatim cell text is preserved in `notes:` on the item so the "
        "conjunction is recoverable. Recommend adding an `all_of` item shape to the plan-of-study "
        "vocabulary.",
        "- **Requirement groups.** A catalog section heading (`areaheader`) becomes an `area`. "
        "Within an area, plain required rows are collapsed into one `*-required` group "
        "(`all_of`), while every *or*-alternative row and every `Select N of the following:` pool "
        "becomes its own group so each group has exactly one of `all_of` / `one_of`, per schema.",
        "- **`credits` on `*-required` groups** is the sum of the catalog's own per-row hours, "
        "emitted only when every row in the group had an exact (non-range) number.",
        "- **`total_credits`** comes from the narrative sentence \"a minimum of 120 credit hours "
        "(150 credit hours for the dual degree...)\", using 150 for pages whose major table is "
        "headed *dual degree*. `credits_listed` keeps the requirement table's own "
        "*Total Credit Hours* value, which is a range and excludes electives/language.",
        "- **`double_counts` shapes.** Entries use `satisfies: <gened-id>` when the catalog names "
        "a general-education category, and `satisfies_requirement: \"<text>\"` when it names a "
        "non-gen-ed requirement (e.g. \"PHYS 303 requirement\"). Category-level statements with "
        "no course named (\"Mathematics: satisfied by the major\") are emitted with `satisfies` "
        "but no `course`. Every entry carries `source:` with the catalog's own wording.",
        "- **Footnote markers** are kept as `footnote_refs`. Requirement-table footnotes resolve "
        "against `footnotes:`; degree-program-guide footnotes resolve against `plan_footnotes:` "
        "(they are separate lists because both tabs reuse the `*` marker for different text). "
        "Narrative paragraphs printed under the plan grid are kept verbatim in `plan_notes:` — "
        "that is where the term-availability rules live (\"PHYS 420 is offered fall only\").",
        "- **Extra keys beyond SCHEMA.md**, all additive and safe to ignore: `section` / `area` on "
        "requirement groups, `gened` (the catalog anchor, the join key to `gened.yaml`), "
        "`satisfied_by_major`, `options` (the upper-division A/B/C/D list), `credits_listed`, "
        "`description`, `policies`, `footnotes`, `plan_footnotes`, `plan_notes`, "
        "`plan_total_credits`, `footnote_refs`.",
        "- **Plan-of-study term subtotals were checked**: for every program, the sum of the item "
        "credits in each term equals the catalog's own `Credit Hours` subtotal row (ranges "
        "compared on their lower bound). No term needed patching.",
        "- **`physics-minor` is included** even though it is not a degree; it comes off the same "
        "department page and uses the same shapes (`degree: Minor`, no plan of study).",
        "- **Not scraped:** nothing on the department page was skipped except the PDF link.",
        "",
    ]

    for slug, data, parser in results:
        prog = data["program"]
        reqs = prog.get("requirements", [])
        plan = prog.get("plan_of_study", [])
        out += [f"## {slug}", "", f"- Source: {data['meta']['source']}",
                f"- Name: {prog.get('name')}",
                f"- total_credits: {prog.get('total_credits')} "
                f"(requirement table total: {prog.get('credits_listed')})",
                f"- Requirement groups: {len(reqs)}",
                f"- Plan-of-study terms: {len(plan)}"
                + (f" (plan credit total: {prog['plan_total_credits']})"
                   if "plan_total_credits" in prog else ""),
                f"- Policies captured: {len(prog.get('policies', []))}; "
                f"footnotes: {len(prog.get('footnotes', []))} "
                f"(+{len(prog.get('plan_footnotes', []))} on the plan grid); "
                f"plan notes: {len(prog.get('plan_notes', []))}",
                ""]
        mismatches = []
        for t in plan:
            got = sum(credits_low(i.get("credits")) for i in t["items"])
            want = credits_low(t.get("credits"))
            if abs(got - want) > 0.01:
                mismatches.append(f"{t['year']}/{t['term']}: items sum {got:g} vs stated {t.get('credits')}")
        out.append(
            "- Plan term subtotals: all match the catalog" if plan and not mismatches
            else ("- Plan term subtotal MISMATCHES: " + "; ".join(mismatches) if mismatches
                  else "- Plan term subtotals: n/a (no plan of study on this page)")
        )
        out.append("")
        sections: dict[str, list[str]] = {}
        for g in reqs:
            key = g.get("area") or g.get("section") or "(no section)"
            cr = g.get("credits")
            sections.setdefault(key, []).append(
                f"{g['id']}" + (f" [{cr} cr]" if cr is not None else "")
            )
        out.append("### Requirement groups by section")
        out.append("")
        for key, ids in sections.items():
            out.append(f"- **{key}** ({len(ids)}): " + ", ".join(ids))
        out.append("")

        out.append("### Confirmed double counts (stated by the catalog)")
        out.append("")
        dcs = prog.get("double_counts") or []
        if dcs:
            for d in dcs:
                course = d.get("course", "(no course named)")
                target = d.get("satisfies") or d.get("satisfies_requirement")
                out.append(f"- `{course}` → `{target}` — \"{d['source']}\"")
        else:
            out.append("- none stated on this page")
        out.append("")

        notes = PROGRAM_NOTES.get(slug)
        if notes:
            out.append("### Things that needed interpretation")
            out.append("")
            out.extend(notes)
            out.append("")

        suspected = SUSPECTED.get(slug)
        if suspected:
            out.append(SUSPECTED_TEMPLATE.format(items="\n".join(suspected)))
        if parser.warnings:
            out.append("### Parser warnings")
            out.append("")
            for w in sorted(set(parser.warnings)):
                out.append(f"- {w}")
            out.append("")
    return "\n".join(out) + "\n"


# Per-program parse decisions worth a human's eyes.
PROGRAM_NOTES = {
    "physics-bs": [
        "- The `**` footnote (\"At least one three-credit course must be at the 400-level\") is "
        "attached to the `physics-major-select-2` pool via `footnote_refs`, not turned into a "
        "machine-checkable rule.",
        "- The `CHEM 121N & CHEM 122N` and `CHEM 123N & CHEM 124N` rows are conjunctions rendered "
        "on two lines in one cell; all four codes land in the `all_of` of "
        "`physics-major-required`, which is the correct reading (all four are required).",
    ],
    "physics-professional-bs": [
        "- Same `**` 400-level footnote handling as physics-bs.",
        "- The \"Math Minor\" advisory paragraph (two extra math courses give an applied math "
        "minor) is kept in `policies`, not modelled as a requirement.",
    ],
    "physics-astrophysics-bs": [
        "- `PHYS 499W or PHYS 489W & PHYS 490W` is the one place a nested expression was needed: "
        "`one_of: [PHYS 499W, {all_of: [PHYS 489W, PHYS 490W]}]`. SCHEMA.md does not show a nested "
        "shape inside a requirement `one_of`, but flattening it would say the 489W/490W sequence "
        "is two independent alternatives, which is wrong.",
        "- `ASTP 495 Special Topics in Astrophysics` carries the catalog's parenthetical topic "
        "list in the requirement table title; only the code is stored (titles live in courses.yaml).",
    ],
    "physics-electrical-engineering-bs": [
        "- Three levels of `areaheader` nest on this page (\"Physics and Electrical Engineering\" "
        "wrapping \"Common Course Requirements\" / \"Physics Course Requirements\" / \"Engineering "
        "Course Requirements\"). The HTML gives no depth, so only the innermost heading is kept as "
        "`area`; the outer wrapper is dropped.",
        "- `ECE Tech Elective I, II, III, IV` (12 cr) is a free-text row with no course list; the "
        "selection rule is footnote 5 on the plan grid and is preserved verbatim in "
        "`plan_footnotes`, not encoded as a `filter`.",
        "- `total_credits: 150` comes from the shared \"(150 credit hours for the dual degree...)\" "
        "parenthetical, selected because this page's major table is headed *Dual Degree*. The "
        "requirement table's own total is 154-160.",
    ],
    "physics-business-administration-bs-mba": [
        "- `Approved Physics Seminar` (1 cr) and `Complete MBA coursework` (45 cr) are free-text "
        "requirement rows with no course list; they are emitted as groups with `notes` + `credits` "
        "and no `all_of`/`one_of`.",
        "- `total_credits: 150` from \"Students in this major must earn a minimum of 150 credit "
        "hours (120 discrete... undergraduate and 30... graduate)\".",
    ],
    "physics-secondary-education-6-12-bs": [
        "- The professional education core appears twice by design: once as its own 26-credit "
        "course table (`professional-education-core-required`) and once as a 26-credit pointer row "
        "inside the major table (`complete-the-professional-education-core-require`). Both are "
        "kept; a planner should count the credits once.",
        "- The plan grid lists `PHYS 499W`, `PHYS 489W` and `PHYS 490W` as three separate options "
        "of one \"Select one of the following:\" (3 cr). That is what the page shows, even though "
        "the requirement table treats 489W+490W as a two-course sequence. Left verbatim.",
        "- The overview tab on this page carries admission / continuance / Praxis / background-"
        "check rules; those are captured in `policies` (which is why this program has ~35 policy "
        "lines and the others have ~11).",
        "- The graduation policy here is program-specific (2.75 GPA, no grade below C-, Teacher "
        "Candidate Internship) and differs from the shared physics paragraph.",
    ],
    "physics-minor": [
        "- `Two 300 or 400-level PHYS courses` (6 cr) is the only place a `filter:` was "
        "synthesised (`{level_min: 300, subject: [PHYS]}`); the group is flagged "
        "`needs_review: true` and keeps the catalog's wording in `notes`.",
        "- The prerequisite sequences (PHYS 231N-232N etc.) are stated as prerequisites *for* the "
        "minor and are deliberately not requirement groups; they are in `policies`.",
    ],
}


# Hand-written, deliberately kept OUT of the YAML: relationships that look true but that the
# catalog never states in so many words.  Reviewed by a human, then promoted if confirmed.
SUSPECTED_COMMON = [
    "- `MATH 211` → `math` — the page says only \"Mathematics: satisfied by the major\"; it never "
    "names which major course does it. MATH 211 is the obvious candidate (it is the first math "
    "course in the major and appears in Freshman/Fall of the plan).",
    "- `PHYS 261N`/`PHYS 231N`/`PHYS 226N` + `PHYS 262N`/`PHYS 232N`/`PHYS 227N` (or the CHEM "
    "121N/122N + 123N/124N sequence) → `nature` — the page says only \"Nature of Science: "
    "satisfied by the major\". The 8-credit category needs two lab courses from different "
    "disciplines, which the major's PHYS+CHEM requirements would cover, but the catalog does not "
    "say which pair is applied.",
    "- `ENGL 110C` → `written` and `ENGL 211C`/`ENGL 231C` → `written` — both appear in the plan "
    "of study and are named in the graduation policy, and Written Communication is 6 credits, but "
    "the requirement tables never annotate them as satisfying the category.",
    "- `CS 120G`/`CS 121G`/`OEAS 130G` → `information` — the catalog restricts the Information "
    "Literacy category to these three courses for this major (that restriction *is* in the YAML "
    "as `one_of` on the `gened-information` group), but it does not frame it as a double count "
    "with a major requirement.",
]

SUSPECTED = {
    "physics-bs": SUSPECTED_COMMON,
    "physics-professional-bs": SUSPECTED_COMMON,
    "physics-astrophysics-bs": SUSPECTED_COMMON + [
        "- `ASTP 103N`/`ASTP 104N` → `nature` — a 4-credit lab science inside the major; not "
        "annotated as double counting.",
    ],
    "physics-business-administration-bs-mba": SUSPECTED_COMMON,
    "physics-secondary-education-6-12-bs": SUSPECTED_COMMON,
    "physics-electrical-engineering-bs": [
        "- The course-level mapping behind the five categories this page *does* say are \"met "
        "through the major\" (math, nature, information, impact, philosophy). Only `ENMA 480` → "
        "`philosophy` and `ENGN 121` → `information` are named; nothing names the math or nature "
        "courses, and nothing names an impact-of-technology course at all — that one is worth an "
        "advisor's confirmation, since no obviously-matching course appears in the requirement "
        "tables.",
        "- `ECE 481W` → the writing-intensive (W) requirement — the graduation policy requires a W "
        "course in the major and `PHYS 499W`/`PHYS 489W`+`PHYS 490W` are required separately, so "
        "ECE 481W is probably not the W course used for the physics half. Unstated either way.",
        "- The lower-division gen-ed line on this page reads 21-27 credits rather than the 30-36 "
        "on the other BS pages, consistent with the five absorbed categories, but the arithmetic "
        "is not spelled out.",
    ],
    "physics-minor": [
        "- none; the minor page carries no gen-ed table and no double-count language.",
    ],
}


# --------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="re-download pages instead of using the cache")
    ap.add_argument("--only", action="append", help="limit to these slugs")
    ap.add_argument("--no-review", action="store_true", help="skip writing data/programs_review.md")
    args = ap.parse_args(argv)

    scraped_at = _dt.date.today().isoformat()
    slugs = discover_slugs(args.refresh)
    if args.only:
        slugs = [s for s in slugs if s in set(args.only)]

    os.makedirs(OUT_DIR, exist_ok=True)
    results = []
    for slug in slugs:
        url = f"{BASE}/undergraduate/sciences/physics/{slug}/"
        html = fetch(url, f"{slug}.html", args.refresh)
        parser = ProgramParser(slug, html, scraped_at)
        data = parser.parse()
        text = dump_yaml(data)
        yaml.safe_load(text)  # fail fast if we ever emit something unloadable
        path = os.path.join(OUT_DIR, f"{slug}.yaml")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        nreq = len(data["program"].get("requirements", []))
        nplan = len(data["program"].get("plan_of_study", []))
        print(f"{slug:44s} groups={nreq:3d} plan_terms={nplan:2d} "
              f"total_credits={data['program'].get('total_credits')}")
        results.append((slug, data, parser))

    if not args.no_review and not args.only:
        with open(REVIEW_PATH, "w", encoding="utf-8") as fh:
            fh.write(build_review(results))
        print(f"wrote {REVIEW_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
