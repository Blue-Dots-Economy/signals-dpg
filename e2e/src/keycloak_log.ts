import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractOtp } from './mailpit.js';

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Phone-channel OTP oracle for Keycloak targets.
 *
 * The local stack runs the OTP SPI with `KC_SPI_SMS_PROVIDER=log`, which writes
 * the code to the Keycloak container's log instead of sending an SMS. Reading it
 * back needs `docker logs`, so this only works against a container you can reach
 * — a shared dev target cannot serve this oracle and the capability gate skips
 * those tests there rather than pretending they passed.
 */
export async function readKeycloakLogOtp(
  container: string,
  identifier: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  // Only scan lines written since the flow started, so a previous run's code for
  // the same number can't be picked up.
  const since = new Date(Date.now() - 60_000).toISOString();

  while (Date.now() < deadline) {
    try {
      const { stdout, stderr } = await exec('docker', ['logs', '--since', since, container], {
        maxBuffer: 20 * 1024 * 1024,
      });
      const lines = `${stdout}\n${stderr}`.split('\n').reverse();
      // The national part is what the SMS provider logs; match on the longest
      // suffix so "+919…" and "919…" both hit.
      const tail = identifier.replace(/^\+/, '').slice(-10);
      for (const line of lines) {
        if (!line.includes(tail)) continue;
        // Blank the number out first so its own digits can't be read as the
        // code, then let extractOtp's labelled match ("…code is: 921732") do the
        // rest — the line also carries a timestamp whose year is a 4-digit run.
        const code = extractOtp(line.split(tail).join(' '));
        if (code) return code;
      }
    } catch {
      // container gone / docker unavailable — treated as "no oracle"
      return undefined;
    }
    await sleep(700);
  }
  return undefined;
}

