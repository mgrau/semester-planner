"""
Parse ODU catalog prerequisite / corequisite English into the recursive
expression trees defined in data/SCHEMA.md.

Expression shapes produced::

    {"course": "MATH 211", "min_grade": "C"}   # leaf, min_grade optional
    {"note": "Permission of the instructor"}   # leaf, unresolved prose
    {"placement": "Math placement level 4"}    # leaf, test score / placement
    {"all_of": [expr, ...]}
    {"one_of": [expr, ...]}

Design notes (English precedence in the ODU catalog is NOT boolean precedence):

* ``;`` is the strongest separator and always means AND.
* ``and`` binds *looser* than ``or``.  "A or B or C and D" is read as
  "(A or B or C) and D", which is what the catalog means, not the boolean
  "A or B or (C and D)".
* A comma list takes the operator of the last explicit connective:
  "A, B, C or D" -> one_of; "A, B, C and D" -> all_of.  A comma list with no
  explicit connective defaults to all_of and is flagged ambiguous.
* A grade qualifier trailing a group distributes over the whole group:
  "A or B or C with a grade of C or better" -> all three need a C.
* "both X and Y" / "either X or Y" bind tightly (they are turned into
  parenthesised groups before splitting).
* A segment containing no course code at all is never split -- it becomes a
  single ``note`` leaf.  This keeps prose like "Approval by department is
  required" from being shredded on its internal "and".

Nothing is ever dropped: any span of text we cannot resolve to courses becomes
a ``note`` leaf, and the ParseResult reports it so the caller can set
``needs_review: true``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------
# Regexes
# --------------------------------------------------------------------------

# Subject codes are 2-4 uppercase letters; numbers are 3 digits with an
# optional 1-2 letter suffix (231N, 211C, 468W, 102M).
COURSE_RE = re.compile(r"\b([A-Z]{2,4})\s?(\d{3}[A-Z]{0,2})\b")

# A letter grade, optionally followed by a numeric gloss: "C", "C-", "C (2.0)".
_GRADE = r"([A-D][+-]?)(?:\s*\(\s*[\d.]+\s*\))?"

# Marker characters used to hide grade phrases from the splitter.
_POST = "\x01"  # postfix grade token:  \x01<i>\x01
_PRE = "\x02"  # prefix  grade token:  \x02<i>\x02

# Postfix grade phrases, longest / most specific first.  Each captures the
# grade letter.  A leading comma and/or "and" is absorbed so it does not
# survive as a spurious separator.
_LEAD = r",?\s*(?:and\s+)?"
_OB = r"\s+or\s+(?:better|higher|above)"
_G = r"\"?" + _GRADE + r"\"?"  # the catalog sometimes quotes the letter: a grade of "C"

_POSTFIX_GRADE_PATTERNS = [
    # "must be passed with a grade of C or higher" -- has to come before the
    # plain "with a grade of ..." rule or "must be passed" is left stranded.
    _LEAD + r"(?:must\s+be\s+)?(?:passed|completed)\s+with\s+(?:a|an)?\s*(?:minimum\s+)?grades?\s+of\s+" + _G + r"(?:" + _OB + r")?",
    _LEAD + r"(?:all|each|both)\s+with\s+(?:a|an)?\s*(?:minimum\s+)?grades?\s+of\s+" + _G + _OB,
    _LEAD + r"with\s+(?:each|all|both)\s+(?:a|an)?\s*(?:minimum\s+)?grades?\s+of\s+" + _G + _OB,
    _LEAD + r"(?:all|each|both)\s+with\s+(?:a|an)?\s*(?:minimum\s+)?grades?\s+of\s+" + _G,
    _LEAD + r"with\s+(?:a|an)?\s*(?:minimum\s+)?grades?\s+of\s+" + _G + _OB,
    _LEAD + r"with\s+(?:a|an)?\s*(?:minimum\s+)?grades?\s+of\s+" + _G,
    _LEAD + r"with\s+(?:a|an)\s+" + _G + _OB,
    _LEAD + r"(?:each\s+|all\s+|both\s+)?(?:with\s+)?(?:a|an)\s+(?:minimum\s+)?grades?\s+of\s+" + _G + _OB,
    _LEAD + r"(?:minimum\s+)?grades?\s+of\s+" + _G + _OB,
    _LEAD + r"with\s+" + _G + _OB,
    _LEAD + r"minimum\s+grades?\s+(?:of\s+)?" + _G,
]

# Prefix grade phrases: "a grade of C or better in <expr>", "C or better in <expr>".
_PIN = r"\s+in\s+(?:one\s+of\s+the\s+following:?\s*|the\s+following:?\s*)?"
_PREFIX_GRADE_PATTERNS = [
    r"(?:with\s+)?(?:a|an)\s+(?:minimum\s+)?grades?\s+of\s+" + _G + _OB + _PIN,
    r"(?:with\s+)?(?:minimum\s+)?grades?\s+of\s+" + _G + _OB + _PIN,
    r"(?:with\s+)?(?:a|an)\s+(?:minimum\s+)?grades?\s+of\s+" + _G + _PIN,
    r"(?:with\s+)?(?:minimum\s+)?grades?\s+of\s+" + _G + _PIN,
    r"\b" + _G + _OB + _PIN,
]

# Prose that we understand well enough not to flag for human review.
_BENIGN_NOTE_RE = re.compile(
    r"^(?:written\s+|departmental\s+|department\s+|instructor\s+|graduate\s+)?"
    r"(?:permission|consent|approval|approved)\b"
    r"|^(?:senior|junior|sophomore|freshman|graduate|undergraduate)\s+standing\b"
    r"|^(?:department|departmental|instructor|faculty|advisor|adviser)\s+"
    r"(?:permission|approval|consent)\b"
    r"|\b(?:permission|consent|approval)\s+of\s+(?:the\s+)?"
    r"(?:instructor|department|chief|program|advisor|adviser|dean|faculty|chair)\b"
    r"|^(?:instructor|department|departmental|faculty|advisor|adviser)'s\s+"
    r"(?:permission|approval|consent)\b"
    r"|^(?:admission|admitted)\s+(?:to|into)\b"
    r"|^equivalent$"
    r"|^(?:its\s+)?equivalent\b"
    r"|^approval\s+by\s+department\b"
    # "MATH 102M or MATH 103M or higher": a level qualifier on the list before it. There is no
    # course to name, and the courses it qualifies are already leaves of the same choice.
    r"|^(?:or\s+)?(?:higher|above)$"
    # "High school chemistry" is a real entry condition, just not one expressed as a course.
    r"|^high\s+school\b",
    re.IGNORECASE,
)

#: "CHEM 105N strongly recommended" is advice, not a prerequisite.
_RECOMMENDATION_RE = re.compile(
    r"\b(?:strongly\s+|highly\s+)?recommend(?:ed|s)?\b|\bsuggested\b",
    re.IGNORECASE,
)

#: Words that make a clause binding, so a recommendation alongside them is not the whole story.
_REQUIREMENT_WORD_RE = re.compile(r"\b(?:required|must|prerequisite)\b", re.IGNORECASE)

_PLACEMENT_RE = re.compile(
    r"\bplacement\b|\bplaced\s+into\b|\bSAT\b|\bACT\b|\bAccuplacer\b"
    r"|\bmath\s+placement\b|\btest\s+score\b|\bqualifying\s+(?:exam|score)\b",
    re.IGNORECASE,
)

# Filler that can wrap a bare course code without changing its meaning.
_LEADING_FILLER_RE = re.compile(
    r"^(?:"
    r"(?:successful(?:ly)?\s+)?completion\s+of|"
    r"successfully\s+completed?|completed?|"
    r"credit\s+(?:for|in)|passing(?:\s+grade\s+in)?|passed|"
    r"prerequisites?:|corequisites?:|"
    r"(?:any\s+)?one\s+of\s+the\s+following:?|any\s+of\s+the\s+following:?|"
    r"the\s+following:?|(?:any\s+)?one\s+of:?|any\s+of:?|either|both|all\s+of:?|"
    r"in|of|a|an|the|and|or"
    r")\s+",
    re.IGNORECASE,
)

_TRAILING_FILLER_RE = re.compile(
    r"\s*(?:,)?\s*(?:"
    r"or\s+(?:its\s+)?equivalent|or\s+equivalents?|"
    r"\(\s*or\s+(?:its\s+)?equivalent\s*\)|"
    r"must\s+be\s+(?:passed|completed)|(?:is\s+)?(?:passed|completed)|"
    r"is\s+required|are\s+required|required"
    r")\.?$",
    re.IGNORECASE,
)

# Trailing "or permission of the instructor" style escape hatch.
_TRAILING_PERMISSION_RE = re.compile(
    r"^(?P<body>.+?)[,;]?\s+or\s+(?P<perm>(?:written\s+|departmental\s+|department\s+|instructor\s+)?"
    r"(?:permission|consent|approval)\b.*)$",
    re.IGNORECASE | re.DOTALL,
)


# --------------------------------------------------------------------------
# Result container
# --------------------------------------------------------------------------


@dataclass
class ParseResult:
    expr: Optional[Dict[str, Any]]
    needs_review: bool = False
    #: prose fragments that became ``note`` leaves and are not recognised
    unparsed: List[str] = field(default_factory=list)
    #: human readable reasons the record was flagged
    reasons: List[str] = field(default_factory=list)


class _Ctx:
    """Mutable state threaded through the recursive descent."""

    def __init__(self) -> None:
        self.grades: List[str] = []  # postfix grade token payloads
        self.pre_grades: List[str] = []  # prefix grade token payloads
        self.needs_review = False
        self.unparsed: List[str] = []
        self.reasons: List[str] = []

    def flag(self, reason: str) -> None:
        self.needs_review = True
        if reason not in self.reasons:
            self.reasons.append(reason)


# --------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------


def normalize_code(subject: str, number: str) -> str:
    return "%s %s" % (subject.upper(), number.upper())


def _collapse(text: str) -> str:
    text = text.replace(" ", " ").replace("’", "'")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _strip_label(text: str) -> str:
    return re.sub(
        r"^\s*(?:pre-?\s*(?:and|or)?\s*co-?requisites?|prerequisites?|corequisites?|"
        r"pre-?\s*or\s+co-?requisites?)\s*:\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )


def _normalize(text: str, ctx: _Ctx) -> str:
    """Clean up punctuation and mask grade phrases so the splitter is safe."""
    text = _collapse(text)
    text = _strip_label(text)

    # "and/or" is an or; "&" and "(or)" are written out.
    text = re.sub(r"\band\s*/\s*or\b", " or ", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*&\s*", " and ", text)
    text = re.sub(r"\(\s*(and|or)\s*\)", r" \1 ", text, flags=re.IGNORECASE)

    # Space out course codes written without a space, then tidy punctuation.
    text = re.sub(r"\s+([,;])", r"\1", text)
    text = re.sub(r"([,;])(?=\S)", r"\1 ", text)
    text = re.sub(r"\.\s*$", "", text)

    # "PHYS 704/PHYS 804" and "SPED 400/500" both mean "or" inside prereq prose.
    text = re.sub(
        r"([A-Z]{2,4}\s?\d{3}[A-Z]{0,2})\s*/\s*(?=[A-Z]{2,4}\s?\d{3})", r"\1 or ", text
    )
    text = re.sub(
        r"([A-Z]{2,4})(\s?)(\d{3}[A-Z]{0,2})\s*/\s*(\d{3}[A-Z]{0,2})\b",
        lambda m: "%s%s%s or %s %s" % (m.group(1), m.group(2), m.group(3), m.group(1), m.group(4)),
        text,
    )

    # "CHEM 121N-CHEM 122N" is a two-course sequence: both are required.
    text = re.sub(
        r"([A-Z]{2,4}\s?\d{3}[A-Z]{0,2})\s*-\s*(?=[A-Z]{2,4}\s?\d{3})", r"\1 and ", text
    )
    text = re.sub(
        r"\b([A-Z]{2,4})(\s?)(\d{3}[A-Z]{0,2})\s*-\s*(\d{3}[A-Z]{0,2})\b",
        lambda m: "%s%s%s and %s %s" % (m.group(1), m.group(2), m.group(3), m.group(1), m.group(4)),
        text,
    )

    # Elided subject in a list: "BIOL 240 or 241" -> "BIOL 240 or BIOL 241".
    text = re.sub(
        r"\b([A-Z]{2,4})\s?(\d{3}[A-Z]{0,2})((?:\s*,)?\s+(?:and|or)\s+)(\d{3}[A-Z]{0,2})\b",
        lambda m: "%s %s%s%s %s" % (m.group(1), m.group(2), m.group(3), m.group(1), m.group(4)),
        text,
    )

    # "MATH 102M (or MATH 103M)" -> "MATH 102M or MATH 103M"
    text = re.sub(r"\(\s*(or|and)\s+([^()]*?)\s*\)", r" \1 \2 ", text, flags=re.IGNORECASE)
    text = _collapse(text)

    # Mask grade phrases before any splitting happens.
    text = _mask_grades(text, ctx)

    # "both A and B" / "either A or B" bind tightly -> parenthesise.
    text = re.sub(
        r"\bboth\s+([^,;()]+?)\s+and\s+([^,;()]+?)(?=$|[,;)])",
        r"(\1 and \2)",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\beither\s+([^,;()]+?)\s+or\s+([^,;()]+?)(?=$|[,;)])",
        r"(\1 or \2)",
        text,
        flags=re.IGNORECASE,
    )

    # Stray duplicated preposition seen in the catalog ("in in one of the ...").
    text = re.sub(r"\bin\s+in\b", "in", text, flags=re.IGNORECASE)
    return _collapse(text)


def _mask_grades(text: str, ctx: _Ctx) -> str:
    for pat in _PREFIX_GRADE_PATTERNS:
        def _sub_pre(m: "re.Match[str]") -> str:
            ctx.pre_grades.append(m.group(1).upper())
            return "%s%d%s" % (_PRE, len(ctx.pre_grades) - 1, _PRE)

        text = re.sub(pat, _sub_pre, text, flags=re.IGNORECASE)

    for pat in _POSTFIX_GRADE_PATTERNS:
        def _sub_post(m: "re.Match[str]") -> str:
            ctx.grades.append(m.group(1).upper())
            return " %s%d%s" % (_POST, len(ctx.grades) - 1, _POST)

        text = re.sub(pat, _sub_post, text, flags=re.IGNORECASE)

    return text


# --------------------------------------------------------------------------
# Paren-aware splitting
# --------------------------------------------------------------------------


def _split_top(text: str, pattern: "re.Pattern[str]") -> List[Tuple[str, str]]:
    """Split ``text`` on ``pattern`` at paren depth 0.

    Returns a list of ``(connective, chunk)``; the first connective is ``""``.
    The pattern must expose the connective word in group ``"op"`` (optional).
    """
    out: List[Tuple[str, str]] = []
    depth = 0
    last = 0
    op = ""
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "(":
            depth += 1
            i += 1
            continue
        if ch == ")":
            depth = max(0, depth - 1)
            i += 1
            continue
        if depth == 0:
            m = pattern.match(text, i)
            if m:
                out.append((op, text[last:i]))
                try:
                    op = (m.groupdict().get("op") or ",").lower()
                except IndexError:  # pragma: no cover - defensive
                    op = ","
                op = "," if op.strip() in {",", ""} else op.strip()
                i = m.end()
                last = i
                continue
        i += 1
    out.append((op, text[last:]))
    return out


_SEMI_RE = re.compile(r"\s*;\s*")
# Element separators: an optional comma plus an optional and/or.
_SEP_RE = re.compile(
    r"(?:,\s*(?:(?P<op>and|or)\s+)?|\s+(?P<op2>and|or)\s+)", re.IGNORECASE
)


def _split_elements(text: str) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    depth = 0
    last = 0
    op = ""
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif depth == 0:
            m = _SEP_RE.match(text, i)
            if m:
                chunk = text[last:i]
                if chunk.strip():
                    out.append((op, chunk))
                    op = (m.group("op") or m.group("op2") or ",").lower()
                    i = m.end()
                    last = i
                    continue
        i += 1
    tail = text[last:]
    if tail.strip() or not out:
        out.append((op, tail))
    return out


# --------------------------------------------------------------------------
# Grade helpers
# --------------------------------------------------------------------------

_POST_TOKEN_RE = re.compile(_POST + r"(\d+)" + _POST)
_PRE_TOKEN_RE = re.compile(_PRE + r"(\d+)" + _PRE)


def _pop_trailing_grade(text: str, ctx: _Ctx) -> Tuple[str, Optional[str]]:
    text = text.strip().rstrip(",;")
    m = _POST_TOKEN_RE.search(text)
    if m and not text[m.end():].strip(" ,;"):
        return text[: m.start()].strip().rstrip(",;"), ctx.grades[int(m.group(1))]
    return text, None


def _pop_leading_grade(text: str, ctx: _Ctx) -> Tuple[str, Optional[str]]:
    text = text.strip()
    m = _PRE_TOKEN_RE.match(text)
    if m:
        return text[m.end():].strip(), ctx.pre_grades[int(m.group(1))]
    return text, None


def apply_min_grade(expr: Optional[Dict[str, Any]], grade: Optional[str]) -> Optional[Dict[str, Any]]:
    """Recursively stamp ``min_grade`` onto every course leaf that lacks one."""
    if expr is None or grade is None:
        return expr
    if "course" in expr:
        if "min_grade" not in expr:
            expr = dict(expr)
            expr["min_grade"] = grade
        return expr
    for key in ("all_of", "one_of"):
        if key in expr:
            return {key: [apply_min_grade(e, grade) for e in expr[key]]}
    if "n_of" in expr:
        inner = dict(expr["n_of"])
        inner["options"] = [apply_min_grade(e, grade) for e in inner["options"]]
        return {"n_of": inner}
    return expr


def _strip_tokens(text: str, ctx: _Ctx) -> str:
    """Render any leftover grade tokens back to readable English."""

    def post(m: "re.Match[str]") -> str:
        return " with a grade of %s or better" % ctx.grades[int(m.group(1))]

    def pre(m: "re.Match[str]") -> str:
        return "a grade of %s or better in " % ctx.pre_grades[int(m.group(1))]

    text = _POST_TOKEN_RE.sub(post, text)
    text = _PRE_TOKEN_RE.sub(pre, text)
    return _collapse(text)


# --------------------------------------------------------------------------
# Core recursive descent
# --------------------------------------------------------------------------


def _combine(op: str, parts: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    parts = [p for p in parts if p]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    # Nesting is preserved rather than flattened: the catalog's own grouping
    # ("both X and Y", parenthesised runs, semicolon clauses) is evidence about
    # intent that an advisor auditing the tree will want to see.
    key = "one_of" if op == "or" else "all_of"
    return {key: list(parts)}


def _has_course(text: str) -> bool:
    return bool(COURSE_RE.search(text))


def _parse_segment(text: str, ctx: _Ctx) -> Optional[Dict[str, Any]]:
    text = text.strip().strip(",").strip()
    if not text:
        return None

    # Fully parenthesised -> unwrap.
    if text.startswith("(") and text.endswith(")"):
        depth = 0
        wraps = True
        for i, ch in enumerate(text):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and i != len(text) - 1:
                    wraps = False
                    break
        if wraps:
            inner = _parse_segment(text[1:-1], ctx)
            return inner

    # Leading connective left over from a split ("and permission of ...").
    text = re.sub(r"^(?:and|or)\s+", "", text, flags=re.IGNORECASE).strip()

    # Prefix grade: "a grade of C or better in <rest>" -> grade applies to rest.
    body, pre_grade = _pop_leading_grade(text, ctx)
    if pre_grade is not None:
        return apply_min_grade(_parse_segment(body, ctx), pre_grade)

    # Trailing grade covering this whole segment.
    body, post_grade = _pop_trailing_grade(text, ctx)
    if post_grade is not None:
        return apply_min_grade(_parse_segment(body, ctx), post_grade)

    # ';' always means AND.
    semis = [c for _, c in _split_top(text, _SEMI_RE) if c.strip()]
    if len(semis) > 1:
        return _combine("and", [p for p in (_parse_segment(s, ctx) for s in semis) if p])

    # A clause that only recommends is advice about the whole clause, not about its last
    # course. "CHEM 321 and CHEM 441 recommended" was becoming `CHEM 321 AND note(441)`, which
    # made CHEM 321 a hard prerequisite the catalog never demanded. Kept whole instead.
    #
    # A clause carrying a requirement word as well is left to the normal path, so that
    # "a microbiology course required and a pathogenesis course recommended" does not lose the
    # part that binds.
    if _RECOMMENDATION_RE.search(text) and not _REQUIREMENT_WORD_RE.search(text):
        return _leaf(text, ctx)

    # Prose with no course code at all is a single note -- never shred it.
    if not _has_course(text):
        return _leaf(text, ctx)

    # "<something involving and/;> or permission of the instructor" -- the
    # escape hatch applies to everything before it.
    m = _TRAILING_PERMISSION_RE.match(text)
    if m and re.search(r"\s+and\s+|[;,]", m.group("body"), re.IGNORECASE):
        body_expr = _parse_segment(m.group("body"), ctx)
        perm_expr = _leaf(m.group("perm"), ctx)
        return _combine("or", [e for e in (body_expr, perm_expr) if e])

    return _parse_list(text, ctx)


def _parse_list(text: str, ctx: _Ctx) -> Optional[Dict[str, Any]]:
    elements = [(op, c.strip()) for op, c in _split_elements(text) if c.strip()]
    if len(elements) <= 1:
        return _leaf(text, ctx)

    ops = [op for op, _ in elements[1:]]
    explicit = [o for o in ops if o in ("and", "or")]
    chunks_all = [c for _, c in elements]

    if not explicit:
        # Bare comma list -- default to AND but say so.
        ctx.flag("comma list with no explicit and/or connective")
        return _build_group("and", chunks_all, ctx)

    # Does a comma ever follow an 'or'?  If not, the commas are just an Oxford
    # list ("A, B, C or D") and the whole run takes the explicit operator.  If
    # one does ("A or B, C or D"), the commas are separating whole groups.
    comma_after_or = any(
        ops[j] == "," and "or" in ops[:j] for j in range(len(ops))
    )

    if all(o == "and" for o in explicit):
        return _build_group("and", chunks_all, ctx)
    if all(o == "or" for o in explicit) and not comma_after_or:
        return _build_group("or", chunks_all, ctx)

    # 'or' binds tighter than 'and'.  Build or-runs, join them with all_of.
    groups: List[List[str]] = [[elements[0][1]]]
    group_is_or: List[bool] = [False]
    for idx in range(1, len(elements)):
        op, chunk = elements[idx]
        if op == "or":
            groups[-1].append(chunk)
            group_is_or[-1] = True
        elif op == "and" or comma_after_or:
            groups.append([chunk])
            group_is_or.append(False)
        else:  # a comma continuing the current run
            groups[-1].append(chunk)

    parts: List[Dict[str, Any]] = []
    for chunks, is_or in zip(groups, group_is_or):
        built = _build_group("or" if is_or else "and", chunks, ctx)
        if built:
            parts.append(built)
    return _combine("and", parts)


def _build_group(op: str, chunks: List[str], ctx: _Ctx) -> Optional[Dict[str, Any]]:
    """Build one operator group, distributing a trailing grade over all of it."""
    chunks = [c.strip() for c in chunks if c.strip()]
    if not chunks:
        return None

    group_grade: Optional[str] = None
    last, g = _pop_trailing_grade(chunks[-1], ctx)
    if g is not None:
        # A grade at the end of the final element qualifies the whole group,
        # e.g. "A or B or C with a grade of C or better".
        group_grade = g
        chunks = chunks[:-1] + [last] if last else chunks[:-1]

    parts = [p for p in (_parse_segment(c, ctx) for c in chunks) if p]
    expr = _combine(op, parts)
    return apply_min_grade(expr, group_grade)


def _leaf(text: str, ctx: _Ctx) -> Optional[Dict[str, Any]]:
    original = _strip_tokens(text, ctx).strip().strip(",;.").strip()
    if not original:
        return None

    working = original
    # Peel filler until stable.
    for _ in range(6):
        new = _TRAILING_FILLER_RE.sub("", _LEADING_FILLER_RE.sub("", working)).strip()
        new = new.strip(",;.").strip()
        if new == working:
            break
        working = new
    if not working:
        working = original

    # "Placement into ENGL 110C" is a placement, not a course requirement.
    if re.match(r"^(?:placement|placed|placement\s+testing)\b", working, re.IGNORECASE):
        return {"placement": original}

    # A recommendation names a course without requiring it. Emitting a course leaf here would
    # turn "CHEM 105N strongly recommended" into a hard prerequisite; keep the wording instead.
    if _RECOMMENDATION_RE.search(working):
        return {"note": original}

    codes = COURSE_RE.findall(working)
    if len(codes) == 1:
        code = normalize_code(*codes[0])
        residual = COURSE_RE.sub("", working, count=1)
        residual = re.sub(r"[\s,;.()\-]+", " ", residual).strip()
        if not residual:
            return {"course": code}
        # A course plus leftover prose we could not interpret: keep both so we
        # never lose the qualification, and flag it.
        ctx.flag("course leaf with unparsed qualifier")
        ctx.unparsed.append(original)
        return {"all_of": [{"course": code}, {"note": original}]}

    if len(codes) > 1:
        # Multiple codes with no connective we recognised.
        ctx.flag("multiple course codes in one unsplit clause")
        ctx.unparsed.append(original)
        return {"note": original}

    if _PLACEMENT_RE.search(original):
        return {"placement": original}

    if _BENIGN_NOTE_RE.search(original) or _BENIGN_NOTE_RE.search(working):
        return {"note": original}

    ctx.flag("unrecognised prose")
    ctx.unparsed.append(original)
    return {"note": original}


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------


def parse_requirement(text: Optional[str]) -> ParseResult:
    """Parse a prerequisite / corequisite string into a ParseResult."""
    if text is None:
        return ParseResult(None)
    raw = _collapse(text)
    if not raw or raw.lower() in {"none", "n/a", "na"}:
        return ParseResult(None)

    ctx = _Ctx()
    try:
        normalized = _normalize(raw, ctx)
        expr = _parse_segment(normalized, ctx)
    except Exception as exc:  # pragma: no cover - safety net, never drop text
        return ParseResult(
            {"note": raw},
            needs_review=True,
            unparsed=[raw],
            reasons=["parser exception: %s" % exc],
        )

    if expr is None:
        return ParseResult(
            {"note": raw}, needs_review=True, unparsed=[raw], reasons=["empty parse"]
        )

    # Safety net: every course code in the source must survive into the tree.
    src_codes = {normalize_code(*m) for m in COURSE_RE.findall(raw)}
    got_codes = _collect_codes(expr)
    missing = src_codes - got_codes
    if missing:
        ctx.flag("dropped course codes: %s" % ", ".join(sorted(missing)))
        ctx.unparsed.append(raw)

    return ParseResult(expr, ctx.needs_review, ctx.unparsed, ctx.reasons)


def _collect_codes(expr: Optional[Dict[str, Any]]) -> set:
    if not expr:
        return set()
    if "course" in expr:
        return {expr["course"]}
    out: set = set()
    for key in ("all_of", "one_of"):
        for e in expr.get(key, []):
            out |= _collect_codes(e)
    if "n_of" in expr:
        for e in expr["n_of"].get("options", []):
            out |= _collect_codes(e)
    for key in ("note", "placement"):
        if key in expr:
            out |= {normalize_code(*m) for m in COURSE_RE.findall(expr[key])}
    return out
