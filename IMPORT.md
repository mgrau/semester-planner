# Importing a student from Banner Plus

[Banner Plus](https://github.com/mgrau/banner_plus) is a bookmarklet that runs
inside ODU's Banner Faculty Self-Service. From a student's record there it can
open this planner with that student's identity and their whole registration
history already in the URL — every term, every course, every grade.

The planner should create that student if it has never seen them, and update
them if it has.

**None of this is built yet.** Banner Plus emits the link today; this document
specifies what to do with it. The same file lives in
[banner_plus/IMPORT.md](https://github.com/mgrau/banner_plus/blob/main/IMPORT.md)
— it is a contract between two repositories, so a change to one has to be a
change to both.

---

## The link

```
https://mgrau.github.io/semester-planner/#import=<base64url(JSON)>
```

**A fragment, not a query string.** Everything after `#` stays in the browser:
it is not sent in the HTTP request, so it never reaches GitHub's servers and
never appears in a log. The payload is a named student's transcript, so that
distinction is the whole reason for the choice — and it is also why the
fragment must be cleared once read.

**base64url**: standard base64 over the UTF-8 bytes, with `+` → `-`, `/` → `_`,
and trailing `=` dropped. To decode, reverse the substitutions, re-pad to a
multiple of four, `atob`, then `TextDecoder`.

A typical four-year transcript encodes to 5–8 KB, well inside every browser's
URL limit. Refuse anything over, say, 512 KB rather than trust an unbounded
string.

## The payload

```json
{
  "v": 1,
  "source": "banner-plus",
  "generated": "2026-08-27T14:03:11.000Z",
  "student": {
    "uin": "01234567",
    "firstName": "Jane",
    "lastName": "Doe",
    "email": "jdoe001@odu.edu",
    "majors": ["Physics"],
    "college": "College of Sciences",
    "standing": "Junior",
    "admitTerm": { "season": "fall", "year": 2024 },
    "confidential": false
  },
  "terms": [
    {
      "season": "fall",
      "year": 2024,
      "code": "202410",
      "courses": [
        {
          "code": "PHYS 101N",
          "title": "Conceptual Physics",
          "credits": 4,
          "grade": "B+",
          "status": "completed",
          "crn": "10001"
        }
      ]
    }
  ]
}
```

### Envelope

| Field | | |
| --- | --- | --- |
| `v` | number | Format version. `1` today. A version we do not know should be refused, not guessed at. |
| `source` | string | Who produced it. `"banner-plus"`. |
| `generated` | string | ISO 8601, UTC. Lets the confirmation say "this is from three weeks ago". |

### `student`

Everything here comes from Banner and is **claimed, not verified** — treat it
as a proposal to be confirmed, not as truth to be applied.

| Field | | |
| --- | --- | --- |
| `uin` | string | The eight-digit university ID, leading zeros intact. **The identity key** — see Matching. |
| `firstName`, `lastName` | string | Split from Banner's `LAST, FIRST M` and title-cased. `lastName` is everything before the comma, so compound surnames survive. |
| `email` | string? | |
| `majors` | string[] | Banner's own major text, verbatim and unmapped — `["Physics"]`, `["Physics & Electrical Engn"]`. Primary first, then any secondary curricula. **Mapping these to a `programId` is our job**, since only we know our catalog. |
| `college` | string? | |
| `standing` | string? | `"Freshman"` … `"Senior"`. Banner's classification, which is credit-based and can disagree with how long they have been here. |
| `admitTerm` | term? | When they started. Absent for a student Banner has no admit term for. |
| `confidential` | boolean | Banner's directory-information flag. Anything we print or export should carry it through. |

### `terms`

One entry per term the student has a registration record for, **oldest first**.
Terms with no registration are simply absent — a contiguous span is ours to
fill in.

| Field | | |
| --- | --- | --- |
| `season` | string | `"fall" \| "spring" \| "summer" \| "winter"`. Matches our `Term` type exactly. |
| `year` | number | **Calendar** year — see below. |
| `code` | string? | Banner's raw term code, for tracing. Do not parse it. |
| `courses` | course[] | |

#### Calendar year, not academic year

ODU's term code is `YYYY` + a two-digit part-of-term whose first digit is the
season: `1` fall, `2` spring, `3` summer. **`YYYY` is the academic year**, so
Fall 2026, Spring 2027 and Summer 2027 all carry the prefix `2026`.

`year` in this payload is always the **calendar** year the term falls in.
Spring 2027 is `{ "season": "spring", "year": 2027 }`, from code `202720`.
Getting this wrong shifts two thirds of a transcript by a year, and it is the
single most likely bug on either side of this contract. The conversion has
already been done for us — `year` is ready to use as `Semester.year`.

### `courses`

| Field | | |
| --- | --- | --- |
| `code` | string | `"PHYS 101N"` — subject, one space, catalog number. The same shape as `Course.code`, so it is a direct key into the catalog. **Suffixes are significant** and must not be stripped: `N` marks a lab science, `W` writing-intensive, `H` honours, and the catalog lists them as distinct courses. |
| `title` | string? | Banner's title. Useful mainly for a course our catalog does not have — a transfer equivalency, a discontinued course. |
| `credits` | number | |
| `grade` | string? | Banner's final grade, verbatim: `"A"`, `"B+"`, `"P"`, `"W"`. Absent while in progress. Not normalised: our `Grade` type is `A \| B \| C \| D`, so a mapping is needed and everything else — `P`, `S`, `CR` — has no `Grade` to become. |
| `status` | string | `"completed" \| "in-progress" \| "withdrawn"`. Derived by Banner Plus: a withdrawal-shaped registration status or `W` grade is `withdrawn`; no final grade is `in-progress`; anything else is `completed`. |
| `crn` | string? | Banner's section number. Only meaningful within its term. |

A `withdrawn` course is neither credit earned nor a course in progress.
Dropping it is right; putting it on the plan would book credit that was never
earned.

---

## What to do with it

**Completed and in-progress coursework becomes `Semester` entries, not
`PriorCredit`s.** Both count toward requirements — `takenFrom()` unions them —
but only a semester records *when*, and having the semesters filled out is the
point of the exercise. `priorCredits` stays what it is: transfer, AP, dual
enrolment, and category waivers, none of which Banner's registration history
knows about. The import never writes one.

| Payload | Us |
| --- | --- |
| `student.uin` | `Student.studentId` |
| `student.firstName` / `lastName` | `firstName` / `lastName`, `name` derived |
| `student.majors` | `programId`, via a mapping we own |
| `student.admitTerm` | `startTerm` / `startYear` |
| `terms[]` | `semesters[]`, `id` as `` `${term}-${year}` `` |
| `terms[].courses[]` | `PlannedCourse[]` |

Everything that enters the roster from outside already goes through
`roster.upsert()` → `normalizeStudent()`. An import should too, rather than
building a `Student` and pushing it in beside them.

### Two small additions to make

`PlannedCourse` cannot currently express a course that has already been taken:

```ts
export interface PlannedCourse {
  // ...
  /** Where this slot came from. Absent means an advisor put it there by hand. */
  origin?: 'banner' | 'auto';
  /** Final grade, for a course already completed. Verbatim from the registrar. */
  grade?: string;
  /** completed | in-progress. Absent means planned but not yet taken. */
  status?: 'completed' | 'in-progress';
}
```

`origin` is what makes a re-import safe: without it there is no way to tell a
row this import wrote last month from one the advisor typed, and the merge
below would have to choose between clobbering advisor work and never updating.
The existing `auto?: boolean` is close but means something narrower — placed by
the autopopulate planner — so widening it would lose that distinction.

### Mapping a major to a program

`majors` carries Banner's words. Ours are program ids. The obvious pairs:

| Banner | `programId` |
| --- | --- |
| Physics | `physics-bs` |
| Astrophysics | `physics-astrophysics-bs` |
| Physics-Professional | `physics-professional-bs` |
| Physics & Electrical Engn | `physics-electrical-engineering-bs` |
| Secondary Physics Educ (6-12) | `physics-secondary-education-6-12-bs` |

Match the first major that maps, and fall back to leaving `programId` for the
advisor to pick rather than guessing — `physics-bs` is the wrong default for an
astrophysics student, and the requirement panel is where they would find out.
ODU's combined major names multiply faster than an exact list keeps up with, so
a substring rule is worth having under the exact one.

### Matching

Match on `uin`, compared with leading zeros stripped from both sides, against
`Student.studentId`. Banner writes `01234567`; a record typed by hand may say
`UIN 01234567` or `1234567`, so compare the digit runs, not the strings.

No match → create. One match → update. **More than one match → stop and ask**;
two records with one UIN is a data problem to surface, not to silently pick a
winner in.

### Merge rules, when the student already exists

The governing rule: **the import owns what Banner knows, and nothing else.**
An advisor's work must survive a re-import, because re-importing after a
registration change is the normal case, not the exception.

Replace:

- Every `Semester` the payload names, but **only the courses in it whose
  `origin` is `'banner'`**. A course an advisor added to a past term stays.
- `firstName`, `lastName`, `email` — Banner is authoritative.

Add:

- Semesters the payload names that the student does not have.

Leave alone, always:

- `notes`, `priorCredits`, `placements`, `settings`, `catalogYear`, `id`.
- **Every term after the last one in the payload.** That is the plan — the
  thing this app exists to hold — and no import should touch it.
- `programId` and `startTerm`/`startYear` once set. Banner's major and admit
  term seed a new record; on an existing one they are a suggestion, and an
  advisor who changed the program did so for a reason. Show the difference, do
  not apply it.

### Before applying it

Show what will happen and let the advisor confirm: create or update, whose
record, how many terms and courses, and anything that disagrees with what is
already stored. We already take this line with pasted transcripts —
"intentionally NOT trusted: every row it produces is shown to the advisor for
confirmation" — and a URL that anyone can construct deserves it more, not less.

Then **clear the fragment** with `history.replaceState` so a reload does not
re-import, and so a screenshot or a shared URL does not carry a student's
transcript with it.

---

## Shape of the work

1. `src/lib/import/bannerPlus.ts` — decode, validate the envelope, and turn a
   payload into a `Student` plus a summary of what would change. Pure, so it
   can be tested without a browser.
2. Two fields on `PlannedCourse`, above.
3. A major → `programId` map, next to whatever else knows about programs.
4. Read `location.hash` on mount in `+page.svelte`; on `#import=`, open a
   confirmation dialog built from the summary.
5. On confirm, `roster.upsert()`; either way, `history.replaceState`.
6. Tests: a v1 payload round-trips; the calendar-year conversion holds for a
   spring term; a re-import leaves notes, prior credits and future terms
   untouched; an advisor's hand-placed course in a past term survives; an
   unknown `v` is refused; two students with one UIN stops.

## What the import deliberately does not carry

- **Photographs.** They are large, and a degree plan does not need a face.
- **Meeting times, rooms, instructors.** Banner Plus shows them; a plan is
  about terms and credits.
- **Transfer credit, AP, placement.** Banner's registration history is ODU
  coursework. Everything else stays the advisor's to enter.
- **Anything from the student self-service host** — the official GPA, holds,
  test scores. A different origin, unreadable from where Banner Plus runs.

## Version history

**v1** — first. Terms, courses, grades, identity.
