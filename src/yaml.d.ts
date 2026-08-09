/**
 * YAML files are transformed into JSON modules by the `yaml-as-json` plugin in vite.config.ts.
 * Their runtime shape is asserted where they are consumed, in src/lib/catalog.ts.
 */
declare module '*.yaml' {
	const value: unknown;
	export default value;
}

declare module '*.yml' {
	const value: unknown;
	export default value;
}
