import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sbStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * macOS sandbox profile for Remotion's native binaries (ffmpeg, ffprobe, compositor). They decode
 * customer-supplied media, and ffmpeg has its own network protocols (http, tcp, udp, rtp, hls...)
 * and file:// access that our Node guard and Chrome proxy can't see. So: no network at all, no
 * reading the owner's home folder except the job and the renderer, writes only to the job dir.
 */
function profile({ jobDir, readDirs }) {
  const home = os.homedir();
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    `(deny file-read* (subpath ${sbStr(home)}))`,
    `(allow file-read* ${[jobDir, ...readDirs].map((d) => `(subpath ${sbStr(d)})`).join(' ')})`,
    `(deny file-write* (subpath ${sbStr(home)}))`,
    `(allow file-write* (subpath ${sbStr(jobDir)}))`,
  ].join('\n');
}

/**
 * Create <jobDir>/bin with wrapper scripts named like Remotion's binaries; pass it as
 * `binariesDirectory`. Returns the directory, or null where sandboxing isn't available.
 */
export function writeSandboxedBinaries({ realDir, jobDir, readDirs }) {
  if (process.platform !== 'darwin') return null;
  const dir = path.join(jobDir, 'bin');
  mkdirSync(dir, { recursive: true });
  const sbFile = path.join(dir, 'native.sb');
  writeFileSync(sbFile, profile({ jobDir, readDirs: [realDir, ...readDirs] }));
  for (const name of ['ffmpeg', 'ffprobe', 'remotion']) {
    const real = path.join(realDir, name);
    // Remotion spawns these with env = { DYLD_LIBRARY_PATH: <this dir> }; point it back at the real libs.
    writeFileSync(
      path.join(dir, name),
      `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${shq(sbFile)} /usr/bin/env DYLD_LIBRARY_PATH=${shq(realDir)} ${shq(real)} "$@"\n`,
      { mode: 0o700 },
    );
  }
  return dir;
}
