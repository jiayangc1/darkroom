import { execFileSync } from 'node:child_process';

function table() {
  try {
    return execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  } catch {
    return [];
  }
}

/** All descendants of pid (Chrome runs in its own process group, so groups aren't enough). */
export function descendants(pid) {
  const rows = table();
  const out = [];
  const queue = [pid];
  while (queue.length) {
    const p = queue.shift();
    for (const r of rows) {
      if (r.ppid === p) {
        out.push(r.pid);
        queue.push(r.pid);
      }
    }
  }
  return out;
}

const kill = (pid) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
};

/** SIGKILL pid and everything under it. */
export function killTree(pid) {
  const kids = descendants(pid);
  kill(pid);
  kids.forEach(kill);
}

/** SIGKILL every process whose command line contains `marker` (leftover Chrome from a crash). */
export function killByCommand(marker) {
  let n = 0;
  for (const r of table()) {
    if (r.pid !== process.pid && r.command.includes(marker)) {
      kill(r.pid);
      n++;
    }
  }
  return n;
}
