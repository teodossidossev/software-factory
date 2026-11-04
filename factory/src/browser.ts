// Opens a URL in the user's browser through the desktop launcher: xdg-open on Linux, the only
// platform supported. The launcher is run without a shell, with the URL as its one argument, and
// waited for with a bound; a successful launcher exit says the browser was asked, not that the page
// loaded. Failures are FactoryErrors telling the user to open the printed URL by hand.
import { spawn } from 'node:child_process';
import { FactoryError } from './errors.js';
import { withoutHostTokens } from './forge.js';

const LAUNCHER = 'xdg-open';
const LAUNCH_TIMEOUT_MS = 10_000;
const BY_HAND = 'open the URL above by hand.';

export function openInBrowser(url: string, timeoutMs = LAUNCH_TIMEOUT_MS): Promise<void> {
  if (process.platform !== 'linux') {
    return Promise.reject(new FactoryError('open_unsupported', `--open works on Linux only (this is ${process.platform}); ${BY_HAND}`));
  }
  return new Promise((resolve, reject) => {
    // No pipes: a browser started by the launcher may inherit them and must not keep sf waiting.
    const child = spawn(LAUNCHER, [url], { env: withoutHostTokens(), stdio: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL' });
    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      reject(new FactoryError('open_failed', code === 'ENOENT'
        ? `${LAUNCHER} is not on PATH (install xdg-utils); ${BY_HAND}`
        : `${LAUNCHER} could not start (${error.message}); ${BY_HAND}`));
    });
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else if (code === null) {
        reject(new FactoryError('open_failed', `${LAUNCHER} did not finish within ${timeoutMs / 1000} s; ${BY_HAND}`));
      } else {
        reject(new FactoryError('open_failed', `${LAUNCHER} exited with ${code}; ${BY_HAND}`));
      }
    });
  });
}
