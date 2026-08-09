<script lang="ts">
	/**
	 * Inline stroke icons on a shared 20×20 grid.
	 *
	 * Inlined rather than pulled from a package: the app ships as a self-contained static site,
	 * and a dozen paths are cheaper than an icon dependency.
	 */
	export type IconName =
		| 'wand'
		| 'eraser'
		| 'plus'
		| 'clipboard'
		| 'table'
		| 'download'
		| 'upload'
		| 'printer'
		| 'lock'
		| 'unlock'
		| 'trash'
		| 'close'
		| 'pencil'
		| 'switch'
		| 'check'
		| 'circle'
		| 'half'
		| 'error'
		| 'warning'
		| 'info'
		| 'search'
		| 'chevron-down'
		| 'chevron-right'
		| 'user';

	interface Props {
		name: IconName;
		/** Tailwind size classes; defaults to a 14px glyph that sits well next to text. */
		class?: string;
	}
	let { name, class: klass = 'h-3.5 w-3.5' }: Props = $props();

	const PATHS: Record<IconName, string> = {
		wand: 'M4 16 14 6m0 0 1.5-1.5M14 6l-1.5-1.5M14 6l1.5 1.5M14 6l-1.5 1.5M6 4v2M5 5h2M15 13v2M14 14h2',
		eraser: 'M8 16H5.5L3.6 14a1.4 1.4 0 0 1 0-2l7-7a1.4 1.4 0 0 1 2 0l3.8 3.8a1.4 1.4 0 0 1 0 2L9.5 16M8 16h8M7.5 8l4.5 4.5',
		plus: 'M10 4.5v11M4.5 10h11',
		clipboard: 'M7.5 4.5h5M7.5 4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1m-5 0H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-10a1 1 0 0 0-1-1h-1.5',
		table: 'M3.5 5.5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1zM3.5 8.5h13M8 8.5V15.5',
		download: 'M10 3.5v8m0 0 3-3m-3 3-3-3M4 14v1.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V14',
		upload: 'M10 16.5v-8m0 0 3 3m-3-3-3 3M4 6V4.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1V6',
		printer: 'M6 7.5V4a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v3.5M6 14H4.5a1 1 0 0 1-1-1V9a1.5 1.5 0 0 1 1.5-1.5h10A1.5 1.5 0 0 1 16.5 9v4a1 1 0 0 1-1 1H14M6 12h8v4.5H6z',
		lock: 'M6 9V7a4 4 0 0 1 8 0v2M5 9h10a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5v-6A.5.5 0 0 1 5 9',
		unlock: 'M6 9V7a4 4 0 0 1 7.5-2M5 9h10a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5v-6A.5.5 0 0 1 5 9',
		trash: 'M4 6h12M8 6V4.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V6m-6 0 .7 9.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L15.5 6',
		close: 'M5.5 5.5l9 9m0-9-9 9',
		pencil: 'M4 16h3l8.2-8.2a1.6 1.6 0 0 0 0-2.3l-.7-.7a1.6 1.6 0 0 0-2.3 0L4 13z',
		switch: 'M4 7.5h10m0 0-3-3m3 3-3 3M16 12.5H6m0 0 3-3m-3 3 3 3',
		check: 'M4.5 10.5 8 14l7.5-8',
		circle: 'M10 4.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11',
		half: 'M10 4.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11M10 4.5v11',
		error: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M7.8 7.8l4.4 4.4m0-4.4-4.4 4.4',
		warning: 'M10 3.8 3.5 15.2a.6.6 0 0 0 .5.9h12a.6.6 0 0 0 .5-.9zM10 8v3.2M10 13.6v.05',
		info: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M10 9v4M10 6.6v.05',
		search: 'M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11M13.2 13.2l3.3 3.3',
		'chevron-down': 'M5.5 8l4.5 4.5L14.5 8',
		'chevron-right': 'M8 5.5 12.5 10 8 14.5',
		user: 'M10 3.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6M4.5 16.5a5.5 5.5 0 0 1 11 0'
	};
</script>

<svg
	class={klass}
	viewBox="0 0 20 20"
	fill="none"
	stroke="currentColor"
	stroke-width="1.6"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	<path d={PATHS[name]} />
</svg>
