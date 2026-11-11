// The factory's package directory (factory/), as a URL: compiled to dist/src/package-root.js, the
// package root is two levels up. The handbook, package.json and the skills folder are found from it.
export const PACKAGE_ROOT = new URL('../../', import.meta.url);
