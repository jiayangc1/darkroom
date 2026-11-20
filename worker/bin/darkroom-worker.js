#!/usr/bin/env node
// darkroom-worker start | pause [--now] [--reason text] | resume | status
const [cmd, ...args] = process.argv.slice(2);

const usage = `usage:
  darkroom-worker start                  run the worker (launchd does this)
  darkroom-worker pause [--now] [--reason text]
                                         stop taking jobs; --now also gives back the current job
  darkroom-worker resume                 take jobs again
  darkroom-worker status                 show pause state, memory and current job`;

if (cmd === 'start') {
  const { start } = await import('../src/index.js');
  await start();
} else if (cmd === 'pause') {
  const { pause } = await import('../src/pause.js');
  const i = args.indexOf('--reason');
  pause({ now: args.includes('--now'), reason: i >= 0 ? args[i + 1] : undefined });
  console.log(args.includes('--now') ? 'Paused; the current job (if any) will be handed back.' : 'Paused; the current job (if any) will finish first.');
} else if (cmd === 'resume') {
  const { resume } = await import('../src/pause.js');
  resume();
  console.log('Resumed (a PAUSE_SCHEDULE window may still apply).');
} else if (cmd === 'status') {
  const { state, readStatus } = await import('../src/pause.js');
  const { freeGb, pressureLevel } = await import('../src/memory.js');
  const p = state();
  const s = readStatus();
  console.log(`pause:     ${p.paused ? `yes (${p.reason}${p.now ? ', now' : ''})` : 'no'}`);
  console.log(`memory:    ${(await freeGb()).toFixed(1)} GB available, pressure ${await pressureLevel()}`);
  if (s) {
    let alive = false;
    try {
      process.kill(s.pid, 0);
      alive = true;
    } catch {
      /* not running */
    }
    console.log(`worker:    ${alive ? `running (pid ${s.pid})` : 'not running'} — ${s.state}${s.jobId ? ` job ${s.jobId} ${Math.round((s.progress || 0) * 100)}% ${s.stage || ''}` : ''}`);
    console.log(`updated:   ${s.at}`);
  } else console.log('worker:    no status yet');
} else {
  console.log(usage);
  process.exit(cmd ? 1 : 0);
}
