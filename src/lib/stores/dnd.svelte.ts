/**
 * Drag state for moving courses between semesters.
 *
 * HTML5 drag-and-drop cannot carry a live object reference through dataTransfer, so the
 * dragged item is parked here for the duration of the gesture. It also tracks the pending
 * insertion point, which is what lets the semester lists open a gap and shift in real time
 * rather than only highlighting a drop target.
 */
class DragState {
	fromSemesterId = $state<string | null>(null);
	code = $state<string | null>(null);
	/** Label shown inside the insertion gap. */
	label = $state<string>('');
	/** Height of the chip being dragged, so the gap matches its size exactly. */
	height = $state(44);

	/** Semester currently under the pointer. */
	overSemesterId = $state<string | null>(null);
	/** Index within that semester's *visible* list where the course would land. */
	overIndex = $state<number | null>(null);

	/**
	 * Hides the original chip once the browser has snapshotted its drag image. Removing it
	 * before that point would drag an invisible ghost, so the flag is set on a macrotask.
	 */
	hideSource = $state(false);

	/** True once geometry has been captured and hit-testing can begin. */
	ready = $state(false);

	/**
	 * Vertical midpoints of every semester's chips, captured once from the settled layout.
	 *
	 * Measuring live during the drag oscillates: opening the gap moves the chips, which moves
	 * the midpoint the pointer is tested against, which moves the gap back, and the courses
	 * visibly bounce. Frozen geometry breaks that loop — the insertion point changes only when
	 * the pointer genuinely crosses a boundary. Not `$state`: read in event handlers, never
	 * rendered.
	 */
	geometry = new Map<string, number[]>();

	start(semesterId: string, code: string, label: string, height: number) {
		this.fromSemesterId = semesterId;
		this.code = code;
		this.label = label;
		this.height = height;
		this.overSemesterId = null;
		this.overIndex = null;
		this.ready = false;
		this.geometry.clear();

		// Two steps, because the layout has to settle before it can be measured:
		// the macrotask lets the browser take its drag-image snapshot, then the animation
		// frame lets the DOM reflow with the source hidden and no gap inserted anywhere.
		setTimeout(() => {
			if (!this.code) return;
			this.hideSource = true;
			this.overSemesterId = null;
			requestAnimationFrame(() => {
				if (!this.code) return;
				this.snapshot();
				this.ready = true;
			});
		}, 0);
	}

	/** Capture chip midpoints for every term from the current, settled layout. */
	private snapshot() {
		this.geometry.clear();
		if (typeof document === 'undefined') return;
		for (const list of document.querySelectorAll('[data-semester-list]')) {
			const id = list.getAttribute('data-semester-list');
			if (!id) continue;
			const mids = [...list.querySelectorAll('[data-chip="1"]')].map((n) => {
				const r = n.getBoundingClientRect();
				return r.top + r.height / 2;
			});
			this.geometry.set(id, mids);
		}
	}

	hoverAt(semesterId: string, index: number) {
		this.overSemesterId = semesterId;
		this.overIndex = index;
	}

	end() {
		this.fromSemesterId = null;
		this.code = null;
		this.label = '';
		this.overSemesterId = null;
		this.overIndex = null;
		this.hideSource = false;
		this.ready = false;
		this.geometry.clear();
	}

	get active() {
		return this.code !== null;
	}
}

export const drag = new DragState();
