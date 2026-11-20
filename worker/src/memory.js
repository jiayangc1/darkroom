import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const run = promisify(execFile);
const GB = 1024 ** 3;

/** Memory macOS could hand to a new process right now: free + inactive + purgeable + speculative pages. */
export async function freeGb() {
  if (process.platform !== 'darwin') return os.freemem() / GB;
  const { stdout } = await run('/usr/bin/vm_stat');
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] || 16384);
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] || 0);
  const free = pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable') + pages('Pages speculative');
  return (free * pageSize) / GB;
}

/** macOS memory pressure: kern.memorystatus_vm_pressure_level 1 = normal, 2 = warn, 4 = critical. */
export async function pressureLevel() {
  if (process.platform !== 'darwin') return 'normal';
  try {
    const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
    const n = Number(stdout.trim());
    return n >= 4 ? 'critical' : n >= 2 ? 'warn' : 'normal';
  } catch {
    return 'normal';
  }
}
