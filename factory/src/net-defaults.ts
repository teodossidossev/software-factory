// Node's network defaults for every factory process (each starts through src/cli.ts). On a slow
// network (TCP connects of 230 to 330 ms, an IPv6 address with no IPv6 route) Node's 250 ms per
// connect attempt cut IPv4 off before the server answered: 3 fetches in 8 failed; with 2.5 s, 6 in 6 passed.
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

export const CONNECT_ATTEMPT_MS = 2500;

// Each address of a name gets CONNECT_ATTEMPT_MS before the next is tried; autoSelectFamily stays
// on, so a host whose IPv6 works is still reached either way.
export function applyNetDefaults(): void {
  setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);
}
