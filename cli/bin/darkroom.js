#!/usr/bin/env node
// darkroom submit <bundleDir|bundle.tar.gz> --composition <id> [--props file.json] [--out video.mp4]
//                 [--scale n] [--frames a-b] [--crf n] [--no-wait]
// darkroom status <jobId>
// darkroom cancel <jobId>
// Env: DARKROOM_API_URL, DARKROOM_API_KEY
import { execFile } from 'node:child_process';
import { createWriteStream, openAsBlob, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const API = (process.env.DARKROOM_API_URL || '').replace(/\/$/, '');
const KEY = process.env.DARKROOM_API_KEY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-wait') opts.noWait = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { pos, opts };
}

async function api(method, p, body) {
  const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${KEY}` }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`error ${res.status}: ${data?.error?.code || ''} ${data?.error?.message || ''}`);
  return data;
}

async function tarDir(dir) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'darkroom-'));
  const file = path.join(tmp, 'bundle.tar.gz');
  await promisify(execFile)('tar', ['-czf', file, '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return { file, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

function printJob(j) {
  const pct = `${Math.round((j.progress || 0) * 100)}%`.padStart(4);
  process.stdout.write(`\r${j.status.padEnd(16)} ${pct} ${(j.stage || '').padEnd(12)}`);
}

async function wait(id, out) {
  let last = '';
  for (;;) {
    const j = await api('GET', `/v1/jobs/${id}`);
    const line = `${j.status}${j.progress}${j.stage}`;
    if (line !== last) printJob(j);
    last = line;
    if (['done', 'failed', 'canceled', 'expired'].includes(j.status)) {
      process.stdout.write('\n');
      if (j.status !== 'done') die(`${j.status}: ${j.error?.code || ''} ${j.error?.message || ''}`);
      console.log(`video: ${j.outputUrl}`);
      if (out) {
        const res = await fetch(j.outputUrl);
        if (!res.ok) die(`download failed: ${res.status}`);
        await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
        console.log(`saved: ${out}`);
      }
      return;
    }
    await sleep(3000);
  }
}

async function submit(src, opts) {
  if (!src || !opts.composition) die('usage: darkroom submit <bundleDir|bundle.tar.gz> --composition <id> [--props file.json] [--out video.mp4] [--scale n] [--frames a-b] [--crf n] [--no-wait]');
  const job = { composition: opts.composition };
  if (opts.props) job.inputProps = JSON.parse(await readFile(opts.props, 'utf8'));
  if (opts.scale) job.scale = Number(opts.scale);
  if (opts.crf) job.crf = Number(opts.crf);
  if (opts.frames) {
    const m = /^(\d+)-(\d+)$/.exec(opts.frames);
    if (!m) die('--frames must look like 0-149');
    job.frameRange = [Number(m[1]), Number(m[2])];
  }
  const isDir = statSync(src).isDirectory();
  const packed = isDir ? await tarDir(src) : { file: src, cleanup: async () => {} };
  try {
    const form = new FormData();
    form.set('job', JSON.stringify(job));
    form.set('bundle', await openAsBlob(packed.file), 'bundle.tar.gz');
    console.log(`uploading ${(statSync(packed.file).size / 1024 ** 2).toFixed(1)} MB…`);
    const j = await api('POST', '/v1/jobs', form);
    console.log(`job ${j.id} (Remotion ${j.remotionVersion})`);
    if (!opts.noWait) await wait(j.id, opts.out);
  } finally {
    await packed.cleanup();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (!API || !KEY) die('Set DARKROOM_API_URL and DARKROOM_API_KEY');
const { pos, opts } = parseArgs(rest);
if (cmd === 'submit') await submit(pos[0], opts);
else if (cmd === 'status') console.log(JSON.stringify(await api('GET', `/v1/jobs/${pos[0]}`), null, 2));
else if (cmd === 'cancel') console.log(JSON.stringify(await api('DELETE', `/v1/jobs/${pos[0]}`), null, 2));
else if (cmd === 'wait') await wait(pos[0], opts.out);
else die('commands: submit | status <id> | wait <id> [--out file] | cancel <id>');
