import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Download } from 'lucide-react';
import { api, errorText } from '../api.js';
import JobStatusBadge from '../components/JobStatusBadge.jsx';
import { ACTIVE, dateTime, money, resolution, seconds } from '../format.js';
import { statusText } from '../status-text.js';

function Field({ label, children }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

export default function JobDetail() {
  const { id } = useParams();
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [canceling, setCanceling] = useState(false);

  const load = useCallback(() => api.get(`/jobs/${id}`).then((r) => setJob(r.data)).catch((e) => setError(errorText(e))), [id]);
  useEffect(() => {
    load();
  }, [load]);
  const active = job && ACTIVE.includes(job.status);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, load]);

  const cancel = async () => {
    if (!window.confirm('Cancel this render? It will not be charged.')) return;
    setCanceling(true);
    try {
      setJob((await api.delete(`/jobs/${id}`)).data);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCanceling(false);
    }
  };

  if (error) return <p className="text-stopbath">{error}</p>;
  if (!job) return null;

  return (
    <div className="develop">
      <Link to="/app" className="inline-flex items-center gap-1 text-sm text-dim hover:text-paper"><ArrowLeft size={14} /> Jobs</Link>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <h1 className="h-display text-5xl">{job.composition}</h1>
        <JobStatusBadge status={job.status} progress={job.progress} />
      </div>
      <div className="code mt-2 text-dim">{job.id}</div>

      {job.status === 'queued' && (
        <p className="panel mt-6 p-4 text-sm">
          Number <span className="font-mono text-safelight">{job.queuePosition}</span> in line. Render machine: {statusText(job.worker)}.
        </p>
      )}
      {job.status === 'rendering' && (
        <div className="mt-6 h-1.5 overflow-hidden rounded bg-seam">
          <div className="h-full bg-safelight transition-all" style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
      )}
      {job.error && (
        <div className="panel mt-6 border-stopbath/50 p-4">
          <div className="code text-stopbath">{job.error.code}</div>
          <p className="mt-1 text-sm">{job.error.message}</p>
        </div>
      )}

      {job.status === 'done' && job.outputUrl && (
        <div className="mt-8">
          <video src={job.outputUrl} controls playsInline className="max-h-[70vh] max-w-full rounded-lg border border-seam bg-black" />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <a href={job.outputUrl} download className="btn btn-primary"><Download size={14} /> Download mp4</a>
            <span className="text-sm text-dim">Kept until {dateTime(job.expiresAt)}</span>
          </div>
        </div>
      )}

      <dl className="mt-10 grid grid-cols-2 gap-6 md:grid-cols-4">
        <Field label="Length"><span className="code">{seconds(job.video)}</span></Field>
        <Field label="Size"><span className="code">{resolution(job.video)}</span></Field>
        <Field label="Frame rate"><span className="code">{job.video?.fps ? `${job.video.fps} fps` : '—'}</span></Field>
        <Field label="Cost">
          <span className="code">{job.cost !== null ? money(job.cost) : job.estimatedCost !== null ? `~${money(job.estimatedCost)} reserved` : 'free'}</span>
        </Field>
        <Field label="Remotion"><span className="code">{job.remotionVersion || '—'}</span></Field>
        <Field label="Submitted">{dateTime(job.createdAt)}</Field>
        <Field label="Finished">{dateTime(job.finishedAt)}</Field>
        <Field label="Attempts"><span className="code">{job.attempts}</span></Field>
      </dl>

      {active && !job.cancelRequested && (
        <button className="btn btn-danger mt-10" onClick={cancel} disabled={canceling}>Cancel render</button>
      )}
      {active && job.cancelRequested && <p className="mt-10 text-sm text-dim">Canceling…</p>}
    </div>
  );
}
