import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router';
import { api, errorText } from '../api.js';
import JobStatusBadge from '../components/JobStatusBadge.jsx';
import { ACTIVE, ago, money, resolution, seconds } from '../format.js';

export default function Jobs() {
  const { me } = useOutletContext();
  const [jobs, setJobs] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(
    () =>
      api
        .get('/jobs', { params: { limit: 25 } })
        .then((r) => {
          const fresh = r.data.jobs;
          setJobs((prev) => {
            // keep older pages that were already loaded
            if (!prev || prev.length <= fresh.length) return fresh;
            const ids = new Set(fresh.map((j) => j.id));
            const oldest = fresh.length ? new Date(fresh[fresh.length - 1].createdAt) : new Date();
            return [...fresh, ...prev.filter((j) => !ids.has(j.id) && new Date(j.createdAt) < oldest)];
          });
          setNext((n) => n ?? r.data.next);
          setError(null);
        })
        .catch((e) => setError(errorText(e))),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  const active = jobs?.some((j) => ACTIVE.includes(j.status));
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [active, load]);

  const more = async () => {
    const r = await api.get('/jobs', { params: { limit: 25, before: next } });
    setJobs((j) => [...j, ...r.data.jobs]);
    setNext(r.data.jobs.length === 25 ? r.data.next : null);
  };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Renders</div>
          <h1 className="h-display mt-1 text-5xl">Jobs</h1>
        </div>
        <div className="text-right text-sm text-dim">
          <span className="font-mono text-paper">{money(me.account.available)}</span> available ·{' '}
          <Link to="/app/billing" className="text-safelight hover:underline">add credit</Link>
        </div>
      </div>

      {error && <p className="mt-6 text-stopbath">{error}</p>}

      {jobs && jobs.length === 0 && (
        <div className="panel mt-8 p-8">
          <h2 className="text-lg font-semibold">No renders yet</h2>
          <p className="mt-2 max-w-lg text-dim">
            Connect your agent with an API key, then ask it to render a Remotion composition. Jobs show up here as they run.
          </p>
          <Link to="/app/start" className="btn btn-primary mt-5">Connect an agent</Link>
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <div className="panel mt-8 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-seam text-left">
                {['Status', 'Composition', 'Length', 'Size', 'Cost', 'Started'].map((h) => (
                  <th key={h} className="eyebrow px-4 py-3 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-seam/60 last:border-0 hover:bg-room/40">
                  <td className="px-4 py-3"><JobStatusBadge status={j.status} progress={j.progress} /></td>
                  <td className="px-4 py-3">
                    <Link to={`/app/jobs/${j.id}`} className="font-medium hover:text-safelight">{j.composition}</Link>
                    <div className="code text-[11px] text-dim">{j.id.slice(0, 8)}</div>
                  </td>
                  <td className="code px-4 py-3">{seconds(j.video)}</td>
                  <td className="code px-4 py-3">{resolution(j.video)}</td>
                  <td className="code px-4 py-3">
                    {j.cost !== null ? money(j.cost) : j.estimatedCost !== null ? <span className="text-dim">~{money(j.estimatedCost)}</span> : <span className="text-dim">free</span>}
                  </td>
                  <td className="px-4 py-3 text-dim">{ago(j.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && jobs?.length >= 25 && (
        <button className="btn mt-4" onClick={more}>Load older jobs</button>
      )}
    </div>
  );
}
