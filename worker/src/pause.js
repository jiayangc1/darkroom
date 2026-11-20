import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import config, { pauseFile, statusFile } from './config.js';

/** Parse "09:00-18:00,22:00-02:00" into minute ranges. Ranges may wrap past midnight. */
export function parseSchedule(text) {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => {
      const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(r);
      if (!m) throw new Error(`Bad PAUSE_SCHEDULE range "${r}" (use HH:MM-HH:MM)`);
      return { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]), text: r };
    });
}

const schedule = parseSchedule(config.pauseSchedule);

function inSchedule(d = new Date()) {
  const t = d.getHours() * 60 + d.getMinutes();
  return schedule.find((r) => (r.from <= r.to ? t >= r.from && t < r.to : t >= r.from || t < r.to)) || null;
}

/** When the schedule range `r` (active at `d`) ends: the next occurrence of r.to. */
function rangeEnd(r, d = new Date()) {
  const end = new Date(d);
  end.setHours(Math.floor(r.to / 60), r.to % 60, 0, 0);
  if (end <= d) end.setDate(end.getDate() + 1);
  return end.toISOString();
}

/** @returns {{ paused: boolean, now: boolean, reason: string|null, until: string|null }} */
export function state() {
  try {
    const p = JSON.parse(readFileSync(pauseFile, 'utf8'));
    if (p.paused) return { paused: true, now: !!p.now, reason: p.reason || 'paused by command', until: null };
  } catch {
    /* no pause file */
  }
  const r = inSchedule();
  if (r) return { paused: true, now: false, reason: `scheduled pause ${r.text}`, until: rangeEnd(r) };
  return { paused: false, now: false, reason: null, until: null };
}

export function pause({ now = false, reason } = {}) {
  mkdirSync(path.dirname(pauseFile), { recursive: true });
  writeFileSync(pauseFile, JSON.stringify({ paused: true, now, reason: reason || null, at: new Date().toISOString() }));
}

export function resume() {
  rmSync(pauseFile, { force: true });
}

export function writeStatus(s) {
  try {
    mkdirSync(path.dirname(statusFile), { recursive: true });
    writeFileSync(statusFile, JSON.stringify({ ...s, pid: process.pid, at: new Date().toISOString() }));
  } catch {
    /* best effort */
  }
}

export function readStatus() {
  try {
    return JSON.parse(readFileSync(statusFile, 'utf8'));
  } catch {
    return null;
  }
}
