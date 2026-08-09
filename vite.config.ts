import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { parse } from 'yaml';

/**
 * Import `.yaml` files as parsed JSON modules. Parsing happens at build time so the
 * browser never ships a YAML parser, and editing a catalog file still hot-reloads.
 */
function yamlPlugin(): Plugin {
	return {
		name: 'yaml-as-json',
		transform(code, id) {
			if (!/\.ya?ml$/.test(id)) return null;
			return {
				code: `export default ${JSON.stringify(parse(code))};`,
				map: null
			};
		}
	};
}

export default defineConfig({
	plugins: [yamlPlugin(), tailwindcss(), sveltekit()],
	test: {
		include: ['src/**/*.test.ts']
	}
});
