// Run by npm run build before tsc (SF-097): removes dist/, so only the current sources are
// compiled and npm test runs no compiled test of a source deleted since.
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
