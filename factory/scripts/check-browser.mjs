// Run by npm run test:browser before the browser tests (SF-091): stops the run when Playwright's
// Chromium is not installed (npm install downloads no browser; npm run browsers does).
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

let path = '';
try {
  path = chromium.executablePath();
} catch {
  // Playwright knows no Chromium for this platform: the same answer as a missing file.
}
if (path === '' || !existsSync(path)) {
  process.stderr.write('No browser: run npm run browsers\n');
  process.exit(1);
}
