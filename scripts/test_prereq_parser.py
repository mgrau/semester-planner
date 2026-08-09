"""Tests for scripts/prereq_parser.py.

Runnable two ways::

    python3 scripts/test_prereq_parser.py     # no dependencies
    pytest scripts/test_prereq_parser.py      # if pytest is installed
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from prereq_parser import parse_requirement  # noqa: E402

C = lambda code, g=None: ({"course": code, "min_grade": g} if g else {"course": code})  # noqa: E731


CASES = [
    # ---- the shapes named in the task -----------------------------------
    (
        "MATH 211 with a grade of C or better",
        C("MATH 211", "C"),
    ),
    (
        "PHYS 231N or PHYS 226N or PHYS 261N with a grade of C or better, and both "
        "MATH 211 and MATH 212 each with a grade of C or better",
        {
            "all_of": [
                {"one_of": [C("PHYS 231N", "C"), C("PHYS 226N", "C"), C("PHYS 261N", "C")]},
                {"all_of": [C("MATH 211", "C"), C("MATH 212", "C")]},
            ]
        },
    ),
    (
        "PHYS 231N or PHYS 226N or PHYS 261N with a grade of C or better, and both "
        "MATH 211 and MATH 212 with each a grade of C or better",
        {
            "all_of": [
                {"one_of": [C("PHYS 231N", "C"), C("PHYS 226N", "C"), C("PHYS 261N", "C")]},
                {"all_of": [C("MATH 211", "C"), C("MATH 212", "C")]},
            ]
        },
    ),
    (
        "PHYS 261N with a grade of C or better; MATH 211 and MATH 212, each with a "
        "grade of C or better",
        {
            "all_of": [
                C("PHYS 261N", "C"),
                {"all_of": [C("MATH 211", "C"), C("MATH 212", "C")]},
            ]
        },
    ),
    (
        "PHYS 232N or PHYS 227N or PHYS 262N and MATH 212",
        {
            "all_of": [
                {"one_of": [C("PHYS 232N"), C("PHYS 227N"), C("PHYS 262N")]},
                C("MATH 212"),
            ]
        },
    ),
    (
        "PHYS 297, and PHYS 226N or PHYS 231N or PHYS 261N, and permission of instructor",
        {
            "all_of": [
                C("PHYS 297"),
                {"one_of": [C("PHYS 226N"), C("PHYS 231N"), C("PHYS 261N")]},
                {"note": "permission of instructor"},
            ]
        },
    ),
    ("Permission of the instructor", {"note": "Permission of the instructor"}),
    (
        "Admission to the Monarch Teach Program; PHYS 232N or MATH 212; and a grade of "
        "C or better in ENGL 211C or ENGL 221C or ENGL 231C",
        {
            "all_of": [
                {"note": "Admission to the Monarch Teach Program"},
                {"one_of": [C("PHYS 232N"), C("MATH 212")]},
                {"one_of": [C("ENGL 211C", "C"), C("ENGL 221C", "C"), C("ENGL 231C", "C")]},
            ]
        },
    ),
    # ---- other shapes found in the live catalog -------------------------
    ("PHYS 101N", C("PHYS 101N")),
    (
        "MATH 102M or MATH 103M or MATH 162M or MATH 166",
        {"one_of": [C("MATH 102M"), C("MATH 103M"), C("MATH 162M"), C("MATH 166")]},
    ),
    (
        "PHYS 111N and MATH 102M (or MATH 103M ) or MATH 162M or MATH 166",
        {
            "all_of": [
                C("PHYS 111N"),
                {"one_of": [C("MATH 102M"), C("MATH 103M"), C("MATH 162M"), C("MATH 166")]},
            ]
        },
    ),
    ("MATH 211 , with a grade of C or better", C("MATH 211", "C")),
    (
        "PHYS 232N or PHYS 227N or PHYS 262N and MATH 312 or MATH 285",
        {
            "all_of": [
                {"one_of": [C("PHYS 232N"), C("PHYS 227N"), C("PHYS 262N")]},
                {"one_of": [C("MATH 312"), C("MATH 285")]},
            ]
        },
    ),
    (
        "PHYS 319 , PHYS 355 and MATH 312",
        {"all_of": [C("PHYS 319"), C("PHYS 355"), C("MATH 312")]},
    ),
    (
        "PHYS 621 , and PHYS 721 or PHYS 821",
        {"all_of": [C("PHYS 621"), {"one_of": [C("PHYS 721"), C("PHYS 821")]}]},
    ),
    (
        "PHYS 621 and either PHYS 721 or PHYS 821",
        {"all_of": [C("PHYS 621"), {"one_of": [C("PHYS 721"), C("PHYS 821")]}]},
    ),
    (
        "PHYS 704 or PHYS 804 , PHYS 721 or PHYS 821",
        {
            "all_of": [
                {"one_of": [C("PHYS 704"), C("PHYS 804")]},
                {"one_of": [C("PHYS 721"), C("PHYS 821")]},
            ]
        },
    ),
    # comma list whose last connective is "or" -> one_of (the HIST pattern)
    (
        "HIST 100H, HIST 101H, HIST 102H, or HIST 205H",
        {"one_of": [C("HIST 100H"), C("HIST 101H"), C("HIST 102H"), C("HIST 205H")]},
    ),
    (
        "SPAN 311, SPAN 312W, SPAN 323, and SPAN 330",
        {"all_of": [C("SPAN 311"), C("SPAN 312W"), C("SPAN 323"), C("SPAN 330")]},
    ),
    # slash inside prereq prose means "or"
    (
        "SPED 400/SPED 500 and SPED 432/SPED 532",
        {
            "all_of": [
                {"one_of": [C("SPED 400"), C("SPED 500")]},
                {"one_of": [C("SPED 432"), C("SPED 532")]},
            ]
        },
    ),
    # trailing "or permission" escapes the whole conjunction
    (
        "PHYS 323 and PHYS 452 or permission of the instructor",
        {
            "one_of": [
                {"all_of": [C("PHYS 323"), C("PHYS 452")]},
                {"note": "permission of the instructor"},
            ]
        },
    ),
    # prefix grade with a trailing conjoined note ("and permission", not "or")
    (
        "grade of C or better in ENGL 211C or ENGL 221C or ENGL 231C and permission of "
        "the instructor",
        {
            "all_of": [
                {"one_of": [C("ENGL 211C", "C"), C("ENGL 221C", "C"), C("ENGL 231C", "C")]},
                {"note": "permission of the instructor"},
            ]
        },
    ),
    ("A grade of C or better in ENGL 110C", C("ENGL 110C", "C")),
    (
        "A grade of C or better in MATH 307 and MATH 312",
        {"all_of": [C("MATH 307", "C"), C("MATH 312", "C")]},
    ),
    ("Completion of PSYC 201S with a grade of C (2.0) or higher", C("PSYC 201S", "C")),
    (
        "ACCT 305 with a C or better and ACCT 306 with a C- or better",
        {"all_of": [C("ACCT 305", "C"), C("ACCT 306", "C-")]},
    ),
    ("RT 261 with a minimum grade of C-", C("RT 261", "C-")),
    # prose with internal "and" but no course codes is never shredded
    (
        "Approval by department is required; Additional support may be provided by the "
        "Monarch Internship and Co-Op Office in the semester prior to enrollment",
        {
            "all_of": [
                {"note": "Approval by department is required"},
                {
                    "note": "Additional support may be provided by the Monarch Internship "
                    "and Co-Op Office in the semester prior to enrollment"
                },
            ]
        },
    ),
    (
        "Junior standing or permission of the instructor",
        {"note": "Junior standing or permission of the instructor"},
    ),
    (
        "MATH 211 or equivalent",
        {"one_of": [C("MATH 211"), {"note": "equivalent"}]},
    ),
    (
        "CS 150 , CS 151 or CS 153 ; PHYS 319 ; PHYS 323 ; and MATH 212",
        {
            "all_of": [
                {"one_of": [C("CS 150"), C("CS 151"), C("CS 153")]},
                C("PHYS 319"),
                C("PHYS 323"),
                C("MATH 212"),
            ]
        },
    ),
    (
        "PHYS 303 or ECE 287 , and PHYS 323",
        {"all_of": [{"one_of": [C("PHYS 303"), C("ECE 287")]}, C("PHYS 323")]},
    ),
    (
        "PHYS 603 , PHYS 604 , PHYS 704 / PHYS 804 , PHYS 727 / PHYS 827 or permission "
        "of the instructor",
        {
            "one_of": [
                {
                    "all_of": [
                        C("PHYS 603"),
                        C("PHYS 604"),
                        {"one_of": [C("PHYS 704"), C("PHYS 804")]},
                        {"one_of": [C("PHYS 727"), C("PHYS 827")]},
                    ]
                },
                {"note": "permission of the instructor"},
            ]
        },
    ),
    ("MATH 212 or permission of instructor", {"one_of": [C("MATH 212"), {"note": "permission of instructor"}]}),
    (None, None),
    ("", None),
]


def _run_case(text, expected):
    res = parse_requirement(text)
    assert res.expr == expected, (
        "\n  input:    %r\n  expected: %r\n  actual:   %r\n  reasons:  %r"
        % (text, expected, res.expr, res.reasons)
    )


def test_cases():
    failures = []
    for text, expected in CASES:
        try:
            _run_case(text, expected)
        except AssertionError as e:
            failures.append(str(e))
    assert not failures, "\n%d/%d cases failed:%s" % (
        len(failures),
        len(CASES),
        "\n".join(failures),
    )


def test_never_drops_course_codes():
    """Every code in the source must survive into the tree or be flagged."""
    samples = [
        "PHYS 231N or PHYS 226N or PHYS 261N with a grade of C or better, and both "
        "MATH 211 and MATH 212 each with a grade of C or better",
        "One 300-level English course or permission of instructor and a grade of C or "
        "better in one of the following: ENGL 211C, ENGL 221C, or ENGL 231C",
        "ENGL 110C and 3 credit hours in PHIL or REL, or permission of instructor",
        "C or better in MKTG 311 (or equivalent) or instructor permission",
    ]
    from prereq_parser import COURSE_RE, _collect_codes, normalize_code

    for s in samples:
        res = parse_requirement(s)
        src = {normalize_code(*m) for m in COURSE_RE.findall(s)}
        got = _collect_codes(res.expr)
        assert src <= got, "%r lost %r" % (s, src - got)


def test_unparsed_prose_is_flagged():
    res = parse_requirement("Wibble wobble prerequisite from another dimension")
    assert res.expr == {"note": "Wibble wobble prerequisite from another dimension"}
    assert res.needs_review is True


def test_known_prose_is_not_flagged():
    for s in ["Permission of the instructor", "Junior standing", "Graduate standing",
              "departmental approval", "Admission to the BSN program"]:
        res = parse_requirement(s)
        assert res.needs_review is False, "%r was flagged: %r" % (s, res.reasons)


def test_placement_leaf():
    res = parse_requirement("Appropriate math placement score")
    assert "placement" in res.expr


def _main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for t in tests:
        try:
            t()
            print("PASS %s" % t.__name__)
        except AssertionError as e:
            failures += 1
            print("FAIL %s%s" % (t.__name__, e))
    print("\n%d/%d test functions passed (%d cases)" % (len(tests) - failures, len(tests), len(CASES)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(_main())
