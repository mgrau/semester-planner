# ODU Semester Planner

A degree-planning tool for chief departmental advisors, built around the ODU Physics and
Astrophysics majors. It holds a student's whole 8+ semester path, checks it against the real
catalog's prerequisites and requirements, and exports something you can hand to a student.

Everything runs in the browser. There is no server and no database — student plans live in
localStorage and travel as YAML files.

## Running it

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # 119 tests, incl. end-to-end against the real catalog
npm run build        # static site in build/
```

## Layout

One page, three full-height columns that scroll independently — the page itself never scrolls.
Below 1024px it reflows to a single column; see **On a phone** below.

- **Left** — the current advisee with **Edit** (name, student ID, major, start term) and
  **Switch**, then plan settings, credit already earned, and conflicts at the bottom filling the
  remaining height.
- **Centre** — the semester grid, four across. Eight terms fit without scrolling; a longer plan
  scrolls inside this column.
- **Right** — the requirement checker: major requirements above, general education below.

The roster lives in a modal, grouped by starting cohort and listed as *Last, First · Term ·
Major*, each row with edit, save-to-YAML, and delete actions. The same edit dialog opens from
either place. It opens automatically when no advisee is selected, since there is nothing else to do
then. Everywhere outside that list, students are shown as *First Last*.

Catalog policy prose is kept out of the requirement rows; a **more** button opens a popover with
the full wording and the approved-course list.

## On a phone

Below `lg` the three columns become one, ordered **plan → requirements → conflicts → student**,
so the schedule is what you land on. The secondary panes collapse to tappable headers that keep
their counts visible while closed ("Requirements 9/14", "Conflicts none").

The asides use `display: contents` below `lg`, which makes their sections grid children in their
own right and lets each carry its own `order`. That keeps a single DOM: rendering a separate
mobile tree would mean two places to change every pane.

**Drag-and-drop does not exist on touch** — `dragstart` and friends never fire there, and the
hover-only lock and remove buttons are equally unreachable. Tapping a course opens an action
sheet instead: move to any term (with the resulting credit load shown per term), lock, remove,
or choose a course for a placeholder. Drag remains the desktop path; a drag that ends over a
drop target suppresses the click that follows so the sheet does not open on top of the move.

The header carries the student's identity — name, start term, major — rather than a side panel,
since it is the one piece of chrome that never collapses and the one thing every pane is about.
It is sticky, so that plus the credit count and conflict badges stay in view while a long plan
scrolls. Detail sheds as width shrinks: the app title contracts to "ODU", the catalog year and
major drop out, and "Fall 2026" becomes "Fa26". The name never does. Tapping the student name opens the roster, since the student pane is collapsed at the
bottom. The six export buttons collapse into one **Export** menu below `sm`, defined once and
rendered either as a menu or as a button row. The plan toolbar uses a **container query** rather
than a viewport breakpoint: below `30rem` *of column width* the buttons drop their labels and
stand on their icons, which is the right trigger because that column is also narrow on a small
laptop showing all three panes. Modals go full-bleed rather than floating in a
letterbox.

## What it does

- **Roster** of students, each with a program, catalog year, start term, and credit-load settings.
- **Auto-populate** a full plan from the greedy critical-path planner, then drag courses between
  terms by hand. Lock a course to pin it where you put it; re-running the planner works around
  locked courses.
- **Live drag feedback.** The dragged course lifts out of its term, a gap opens where it would
  land, and the surrounding courses animate out of the way as the pointer moves. The target
  term's credit badge previews the load it *would* carry, turning red before you drop if that
  would overload it. Dropping between two courses reorders within a term as well as across them.
- **Live validation**: prerequisites in the wrong order, unmet co/pre-corequisites, courses in
  terms they are not offered, overloaded or underloaded terms, duplicates.
- **Requirement tracking** for both the major and general education, with ODU's double-counting
  rules applied — a course can count toward the major and a gen-ed category at once, but not
  toward two gen-ed categories. A reserved placeholder slot counts toward its category and is
  shown striped with "course not chosen yet", so booked-but-unchosen never reads as done.
- **Credit count** in the header covers everything the plan allocates, including credits reserved
  for a requirement whose course is not chosen yet, with the reserved share called out
  separately. Allocated is the number an advisor is asking about; naming the course comes later.
- **Prior credit**: transfer, AP, and dual-enrollment courses, plus requirements satisfied
  outright (a Language & Culture waiver is recorded this way rather than as a special flag).
- **Placement, kept separate from credit.** A physics major places into calculus rather than
  taking MATH 163. That satisfies the prerequisite but awards nothing, so it lives in
  `Student.placements` and shows as "Placed past (no credit)" — never in the credit ledger and
  never in the credit total. New students get a checklist split into **Placement and background**
  (writing placement, high-school chemistry, Language and Culture waiver, ready for Calculus I —
  all on by default) and **Mathematics already earned** (MATH 212 / 211 / 163 / 166 / 162M, off
  by default). With the defaults, the planner has to assume nothing at all.
- **Transcript paste**: drop in DegreeWorks or transcript text and confirm the rows it finds.
- **Exports**: a formatted paste for Google Sheets **with live formulas** — term totals are
  `=SUM(...)` over their courses and the grand total sums the term totals, so the numbers follow
  an edit instead of going stale; TSV; a re-importable student YAML; and a one-page print view whose
  "Save as PDF" produces real selectable text — the plan, both requirement checklists and any
  unresolved conflicts, sized to fill a single sheet.

## Layout

```
data/                  catalog data, scraped from catalog.odu.edu — the source of truth
  SCHEMA.md            the contract every generated file follows
  courses.yaml         7,813 courses with parsed prerequisite trees
  gened.yaml           12 lower-division gen-ed categories + approved lists
  programs/*.yaml      7 physics degree programs
  local/preferences.yaml   HAND-MAINTAINED. Departmental advising practice — safe from --refresh
  *_review.md          per-scraper notes on what needed interpretation — worth reading
scripts/               the scrapers (Python, stdlib + PyYAML). Idempotent, HTML cached.
src/lib/engine/        prerequisite logic, requirement satisfaction, planner, validation
src/lib/components/    Svelte UI
```

## Departmental preferences

`data/local/preferences.yaml` is the one data file you edit by hand. It records how the
department actually advises, where that differs from the catalog, and the scrapers never touch
it. Three things live there:

- **`prefer`** — courses the planner reaches for first when a requirement offers a choice.
  Currently PHYS 489W + PHYS 490W, so plans get the two-semester senior thesis sequence.
- **`avoid`** — chosen only when nothing preferred fits. Currently PHYS 499W, the one-semester
  capstone the catalog happens to list first.
- **`category_filters`** — gen-ed categories the catalog defines by a rule rather than a course
  list. Writing Intensive is `attributes: [W]`, so any W course satisfies it and the planner
  does not reserve a redundant slot when the thesis sequence already covers it.
- **`program_labels`** — short names for the roster ("Astrophysics", not "Physics with a Major in
  Astrophysics (BS)").
- **`requirement_labels`** — readable names for requirement groups, since the catalog labels many
  of them from the table row they came from ("Select two of the following:" → "Electives",
  "PHYS 120 or PHYS 309" → "Seminar", "PHYS 499W or PHYS 489W & PHYS 490W" → "Senior Thesis").
  A key is either a bare requirement id (all programs) or `<programId>:<requirementId>`, which
  wins. Ids are the `id:` fields in `data/programs/*.yaml`.
- **`term_offerings`** — when a course is actually taught. The catalog states this for only 10
  of the 126 PHYS/ASTP courses, and ODU publishes no rotation, so without it the planner assumes
  every course runs every term and will put a fall-only course in the spring. Twelve are recorded
  from the department; courses that genuinely run every semester (the intro sequences, the senior
  thesis courses, introductory astronomy) and the sporadic upper-division electives are
  deliberately left unconstrained rather than given invented terms.
- **`discontinued`** — courses ODU no longer offers. They stay in the catalog so a returning
  student's credit can still be named, but the planner will not schedule them and a plan
  containing one is flagged. PHYS 120 is listed, which leaves PHYS 309 as the Seminar requirement.
- **`earliest_year`** — the year of study a course may first be scheduled in. The catalog asks
  only for ENGL 211C before Senior Thesis, so nothing but class standing keeps PHYS 489W out of
  the sophomore year; this puts the thesis sequence in terms 7 and 8 where it belongs.
- **`major_view`** — how the major requirements are grouped for the advisor. The catalog gives a
  flat wall of ~26 rows; this regroups the *same* courses into Physics 1 & 2 (with the preferred
  261N/262N sequence first), Physics 300-level, Physics 400-level, and then everything else under
  "Other requirements". Nothing is added or dropped — a test asserts every required course
  survives the regrouping, and level groups deliberately claim only outright-required courses so
  an unchosen alternative never shows up as missing.

## Color coding

Course chips carry a left stripe by role: **blue** physics/major, **violet** mathematics,
**emerald** lab science, **cyan** computing, **amber** general education, **slate** electives,
and a dashed grey outline for an unfilled requirement slot. Status keeps the background channel
(red for a prerequisite conflict, amber for a warning) so a problem never gets lost behind the
category color. The legend above the grid shows only the kinds present in that plan.

## How the planner decides

It is a greedy critical-path scheduler. Each term it places the eligible course with the longest
chain of dependents still ahead of it. The "take math until you can start physics, then take
physics" rule falls out of that rather than being special-cased — MATH 211 sorts first because
the entire physics sequence sits behind it.

Three deliberate choices worth knowing about:

1. **Open gen-ed categories become placeholders, not courses.** The planner knows a student owes
   3 credits of Human Creativity; it does not know they want ARTH 121A. Click a placeholder to
   pick from that category's approved list.
2. **It reserves room for gen ed each term** instead of front-loading the major. Without this the
   major fills years 1–3 and every gen-ed course strands in a fifth and sixth year.
3. **Missing prerequisites get scheduled, not assumed away.** If a student has not been declared
   ready for Calculus I, the plan contains MATH 162M and MATH 163 ahead of MATH 211, and honestly
   runs to 4.5 years. The planner never quietly grants a student something it needed. Chains
   terminate on their own — MATH 162M's prerequisite is an SAT/ACT score, not another course.

   The counterpart is that readiness is *declared*, not guessed: the new-student checklist has
   **Ready for Calculus I** on by default, which places past the precalculus sequence without
   awarding credit. With it ticked, the plan is eight terms and the planner emits no notes at
   all.

**Auto-populate never edits the student record.** It reads the constraints — credit earned,
placements, locked courses, settings — and returns a schedule plus notes, nothing else. A test
asserts the result has exactly the keys `semesters`, `notes`, and `unplaced`, and that the caller
only ever assigns `semesters`.

## Data caveats

The catalog data is scraped, and the scrapers were honest about what they could not parse.
Before trusting this for a real advising session, read `data/*_review.md`. The things most worth
knowing:

- **884 of 7,813 courses (11%) are flagged `needs_review`** — their prerequisite text did not
  fully parse. The app marks these with an info-level notice when they appear in a plan. Nothing
  was silently dropped; unparsed text is preserved as a note.
- **Unresolvable prerequisite clauses pass rather than block** — but an instructor override is
  not treated as a free pass. "PHYS 323 and PHYS 452 **or permission of the instructor**" still
  requires both courses; the permission branch is reported as a note for a human to act on.
  Only permission-style wording is discounted this way: prose that names a real alternative
  ("MATH 102M or higher", "High school chemistry, CHEM 103, or CHEM 105N") still satisfies its
  clause, since treating those as overrides would force remedial courses into every plan.
- **Gen-ed pairs that must be taken together** (CHEM 121N & CHEM 122N) are listed individually in
  `gened.yaml`'s `approved` list, with the pairing recorded separately in `combinations`. The
  requirement engine does not yet enforce the pairing, so it would let CHEM 121N alone count.
- **Most double-counts are category-level, not course-level.** The physics pages say only
  "Mathematics: satisfied by the major" without naming a course, so the app marks those
  categories satisfied wholesale. The EE program page is more specific and does name courses.
- **MATH 211 is not on the gen-ed Mathematics approved list.** That is what the catalog says; the
  major covers the category instead.
- Requirement rows the catalog states as prose rather than course lists (and the narrative degree
  policies — C-or-better rules, senior assessment, the Physics Exit Exam) are parsed and kept in
  `data/`, but are **not** shown in the UI. They are on `program.untrackable` and
  `program.policies` if you ever want to surface them again.

## Refreshing the catalog

```sh
python3 scripts/scrape_courses.py --refresh
python3 scripts/scrape_gened.py --refresh
python3 scripts/scrape_programs.py --refresh
```

Each caches raw HTML and produces byte-identical output on a re-run, so a diff shows exactly what
ODU changed.

## Known rough edges

- The full course catalog ships to the browser as one ~890 KB gzipped chunk. Fine for an internal
  tool; would want splitting by subject if this ever went public.
- Term availability comes from prose in course descriptions ("offered fall, spring"), which the
  catalog supplies for only 10 of 126 PHYS/ASTP courses. The gap is filled by `term_offerings` in
  `data/local/preferences.yaml`. Anything in neither is assumed available every term.
- Variable-credit courses (PHYS 297 is 1–3) are planned at their minimum.
- The requirement assignment is greedy, most-constrained-first. It is not provably optimal when a
  course could satisfy several elective pools, but it is stable and explainable.

*Advising aid only. Verify against DegreeWorks and the official catalog before registration.*
