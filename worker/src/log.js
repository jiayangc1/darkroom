import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import config from './config.js';

const MAX_BYTES = 20 * 1024 * 1024;
const KEEP = 3;
let ready = false;
let written = 0;

function rotateIfNeeded() {
  if (!ready) {
    mkdirSync(path.dirname(config.logFile), { recursive: true });
    try {
      written = statSync(config.logFile).size;
    } catch {
      written = 0;
    }
    ready = true;
  }
  if (written < MAX_BYTES) return;
  for (let i = KEEP - 1; i >= 1; i--) {
    try {
      renameSync(`${config.logFile}.${i}`, `${config.logFile}.${i + 1}`);
    } catch {
      /* missing */
    }
  }
  try {
    renameSync(config.logFile, `${config.logFile}.1`);
  } catch {
    /* missing */
  }
  written = 0;
}

/** Log to the rotating file and to stdout. */
export function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  process.stdout.write(line);
  try {
    rotateIfNeeded();
    appendFileSync(config.logFile, line);
    written += Buffer.byteLength(line);
  } catch {
    /* logging must never crash the worker */
  }
}
