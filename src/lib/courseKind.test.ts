import { describe, expect, it } from 'vitest';
import { buildKindIndex, kindOf } from './courseKind';
import { catalog } from './catalog';

const index = buildKindIndex(catalog);
const kind = (code: string) => kindOf(code, false, index);

describe('course colour by subject', () => {
	it('colours every MATH course as mathematics', () => {
		const math = [...catalog.courses.keys()].filter((c) => c.startsWith('MATH '));
		expect(math.length).toBeGreaterThan(20);
		for (const code of math) {
			expect(kind(code), `${code} should be mathematics`).toBe('math');
		}
	});

	it('does not let gen-ed membership recolour a math course', () => {
		// MATH 162M is on the general-education mathematics list, and was taking its colour from
		// that rather than from being a maths course.
		expect(catalog.genEd.some((c) => c.approved?.includes('MATH 162M'))).toBe(true);
		expect(kind('MATH 162M')).toBe('math');
	});

	it('colours a maths course that is neither required nor gen-ed approved', () => {
		// MATH 163 is only ever pulled in as a prerequisite, so it used to fall through to
		// "elective".
		expect(kind('MATH 163')).toBe('math');
	});

	it('keeps the other technical subjects on their own colours', () => {
		expect(kind('PHYS 231N')).toBe('major');
		expect(kind('ASTP 313')).toBe('major');
		expect(kind('CHEM 121N')).toBe('science');
		expect(kind('CS 151')).toBe('computing');
		expect(kind('STAT 130M')).toBe('math');
	});

	it('leaves general education for the non-technical subjects', () => {
		expect(kind('ENGL 110C')).toBe('gened');
		expect(kind('PHIL 150P')).toBe('gened');
	});

	it('resolves a cross-listed code to the same colour as its twin', () => {
		expect(kind('PHYS 525')).toBe(kind('PHYS 425'));
	});

	it('still marks an unfilled requirement slot as a placeholder', () => {
		expect(kindOf('placeholder:creativity:0', true, index)).toBe('placeholder');
	});
});
