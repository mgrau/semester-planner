import { stringify, parse } from 'yaml';
import type { Catalog, Student } from '$lib/types';
import { sortSemesters, termLabel } from '$lib/engine/validate';
import { KIND_STYLES, type CourseKind } from '$lib/courseKind';
import { fullName } from '$lib/stores/roster.svelte';
import { programLabel } from '$lib/catalog';

/** Round-trippable export: the full student record, for reloading into the app. */
export function studentToYaml(student: Student): string {
	return stringify({ format: 'odu-planner-student/v1', student }, { lineWidth: 100 });
}

export function studentFromYaml(text: string): Student {
	const doc = parse(text);
	const student = doc?.student ?? doc;
	if (!student?.semesters || !student?.programId) {
		throw new Error('This file does not look like an exported student plan.');
	}
	return student as Student;
}

/** Tab-separated, so it pastes straight into Google Sheets or Excel as columns. */
export function planToTsv(student: Student, catalog: Catalog): string {
	const rows: string[][] = [['Term', 'Course', 'Title', 'Credits', 'Note']];
	for (const sem of sortSemesters(student.semesters)) {
		const label = termLabel(sem);
		if (!sem.courses.length) {
			rows.push([label, '—', '(no courses planned)', '', '']);
			continue;
		}
		for (const c of sem.courses) {
			rows.push([
				label,
				c.placeholder ? '' : c.code,
				c.placeholder ? `${c.placeholder.label} (choose a course)` : (catalog.courses.get(c.code)?.title ?? ''),
				String(c.credits),
				c.note ?? ''
			]);
		}
		rows.push([
			label,
			'',
			'TERM TOTAL',
			String(sem.courses.reduce((s, c) => s + c.credits, 0)),
			''
		]);
	}
	return rows.map((r) => r.map(escapeTsv).join('\t')).join('\n');
}

function escapeTsv(v: string): string {
	return v.replace(/[\t\n]/g, ' ');
}

/** Hex fills matching the on-screen course-kind stripes, for the spreadsheet export. */
const KIND_FILL: Record<CourseKind, string> = {
	major: '#dbeafe',
	math: '#ede9fe',
	science: '#d1fae5',
	computing: '#cffafe',
	gened: '#fef3c7',
	elective: '#f1f5f9',
	placeholder: '#f8fafc'
};

const KIND_TEXT: Record<CourseKind, string> = {
	major: '#1e3a8a',
	math: '#4c1d95',
	science: '#065f46',
	computing: '#155e75',
	gened: '#78350f',
	elective: '#334155',
	placeholder: '#64748b'
};

/** Human-readable kind names, reused from the on-screen legend so the two never drift. */
const KIND_LABEL = Object.fromEntries(
	Object.entries(KIND_STYLES).map(([k, v]) => [k, v.label])
) as Record<CourseKind, string>;

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * An HTML table for the clipboard.
 *
 * Google Sheets and Excel both read the `text/html` clipboard flavor and preserve borders,
 * fills, bold, and merged header rows — none of which survive TSV. The plain-text flavor is
 * written alongside it, so pasting into a plain editor still gives usable columns.
 */
export function planToHtmlTable(
	student: Student,
	catalog: Catalog,
	kinds: Map<string, CourseKind>
): string {
	const border = 'border:1px solid #cbd5e1;';
	const rows: string[] = [];

	// Row numbers are tracked so the credit cells can be real formulas rather than frozen
	// numbers: a plan pasted into Sheets is usually about to be edited, and a total that does
	// not follow the edit is worse than no total. Every row is four columns wide so credits
	// always land in column D.
	let row = 0;
	const push = (html: string) => {
		rows.push(html);
		row++;
	};

	push(
		`<tr><td colspan="4" style="${border}background:#003057;color:#ffffff;font-weight:bold;font-size:13pt;padding:6px;">` +
			`${esc(fullName(student))} — ${esc(programLabel(student.programId))}` +
			`</td></tr>`
	);
	push(
		`<tr><td colspan="4" style="${border}background:#eef2f6;color:#334155;padding:4px;">` +
			`Catalog ${esc(student.catalogYear)} · generated ${new Date().toLocaleDateString()} · advising aid only` +
			`</td></tr>`
	);

	const termTotalCells: string[] = [];

	for (const sem of sortSemesters(student.semesters)) {
		const count = sem.courses.length;
		// Header, then the column labels, then the courses.
		const firstCourseRow = row + 3;
		const lastCourseRow = firstCourseRow + count - 1;
		const totalCell = `D${row + 1}`;
		termTotalCells.push(totalCell);

		const total = count ? `=SUM(D${firstCourseRow}:D${lastCourseRow})` : '0';
		push(
			`<tr>` +
				`<td colspan="3" style="${border}background:#1e3a5f;color:#ffffff;font-weight:bold;padding:4px;">${esc(termLabel(sem))}</td>` +
				`<td style="${border}background:#1e3a5f;color:#ffffff;font-weight:bold;text-align:right;padding:4px;">${total}</td>` +
				`</tr>`
		);
		push(
			`<tr>` +
				['Course', 'Title', 'Type', 'Cr']
					.map(
						(h, i) =>
							`<td style="${border}background:#f1f5f9;font-weight:bold;color:#475569;${i === 3 ? 'text-align:right;' : ''}">${h}</td>`
					)
					.join('') +
				`</tr>`
		);

		if (!count) {
			push(
				`<tr><td colspan="3" style="${border}color:#94a3b8;font-style:italic;">No courses planned</td>` +
					`<td style="${border}text-align:right;">0</td></tr>`
			);
			continue;
		}

		for (const c of sem.courses) {
			const kind = kinds.get(c.code) ?? (c.placeholder ? 'placeholder' : 'elective');
			const fill = KIND_FILL[kind];
			const text = KIND_TEXT[kind];
			const isPlaceholder = Boolean(c.placeholder);
			const title = isPlaceholder
				? `${c.placeholder!.label} — choose a course`
				: (catalog.courses.get(c.code)?.title ?? '');
			push(
				`<tr>` +
					`<td style="${border}background:${fill};color:${text};font-weight:bold;font-family:monospace;">${isPlaceholder ? '—' : esc(c.code)}</td>` +
					`<td style="${border}background:${fill};color:${text};${isPlaceholder ? 'font-style:italic;' : ''}">${esc(title)}</td>` +
					`<td style="${border}background:${fill};color:${text};font-size:9pt;">${esc(KIND_LABEL[kind])}</td>` +
					`<td style="${border}background:${fill};color:${text};text-align:right;">${c.credits}</td>` +
					`</tr>`
			);
		}
	}

	// Sum the per-term totals rather than every course row, so the grand total keeps working
	// if a whole term is deleted.
	const grand = termTotalCells.length ? `=SUM(${termTotalCells.join(',')})` : '0';
	push(
		`<tr>` +
			`<td colspan="3" style="${border}background:#003057;color:#ffffff;font-weight:bold;padding:4px;">Total planned credits</td>` +
			`<td style="${border}background:#003057;color:#ffffff;font-weight:bold;text-align:right;padding:4px;">${grand}</td>` +
			`</tr>`
	);

	return `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:10pt;">${rows.join('')}</table>`;
}

/**
 * Put both flavors on the clipboard: rich HTML for Sheets/Excel, TSV for everything else.
 * Falls back to plain text where ClipboardItem is unavailable.
 */
export async function copyPlanToClipboard(
	student: Student,
	catalog: Catalog,
	kinds: Map<string, CourseKind>
): Promise<void> {
	const html = planToHtmlTable(student, catalog, kinds);
	const text = planToTsv(student, catalog);

	if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
		await navigator.clipboard.write([
			new ClipboardItem({
				'text/html': new Blob([html], { type: 'text/html' }),
				'text/plain': new Blob([text], { type: 'text/plain' })
			})
		]);
		return;
	}
	await navigator.clipboard.writeText(text);
}

export function download(filename: string, content: string, mime = 'text/plain') {
	const blob = new Blob([content], { type: `${mime};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export function slugify(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'student';
}
