import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../api.js';
import CopyButton from '../../components/CopyButton.jsx';
import JobStatusBadge from '../../components/JobStatusBadge.jsx';
import { ago, money } from '../../format.js';

const TABS = ['Waitlist', 'Invites', 'Accounts', 'Jobs'];

function useList(path, key) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get(path).then((r) => setRows(r.data[key])).catch((e) => setError(errorText(e))), [path, key]);
  useEffect(() => {
    load();
  }, [load]);
  return { rows, error, load, setError };
}

function Waitlist() {
  const { rows, error, load, setError } = useList('/admin/waitlist', 'accounts');
  const approve = async (a) => {
    try {
      await api.post(`/admin/accounts/${a.id}/approve`);
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="panel divide-y divide-seam">
      {error && <p className="p-4 text-stopbath">{error}</p>}
      {rows?.length === 0 && <p className="p-5 text-dim">Nobody is waiting.</p>}
      {rows?.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center gap-4 p-4">
          <span className="flex-1">{a.email || a.name}</span>
          <span className="text-sm text-dim">signed up {ago(a.createdAt)}</span>
          <button className="btn btn-primary" onClick={() => approve(a)}>Let in</button>
        </div>
      ))}
    </div>
  );
}

function Invites() {
  const { rows, error, load, setError } = useList('/admin/invites', 'invites');
  const [form, setForm] = useState({ note: '', maxUses: 1, expiresInDays: 14 });
  const [made, setMade] = useState(null);
  const create = async (e) => {
    e.preventDefault();
    try {
      setMade((await api.post('/admin/invites', form)).data.code);
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const disable = async (code) => {
    await api.post(`/admin/invites/${code}/disable`).catch((e) => setError(errorText(e)));
    load();
  };
  return (
    <div>
      <form onSubmit={create} className="panel flex flex-wrap items-end gap-3 p-4">
        <label className="min-w-48 flex-1 text-sm">Note
          <input className="field mt-1" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="who it's for" />
        </label>
        <label className="w-28 text-sm">Uses
          <input type="number" min="1" className="field mt-1" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: Number(e.target.value) })} />
        </label>
        <label className="w-36 text-sm">Expires in days
          <input type="number" min="1" className="field mt-1" value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })} />
        </label>
        <button className="btn btn-primary">Create code</button>
      </form>
      {made && (
        <div className="panel develop mt-3 flex items-center gap-3 border-safelight/60 p-4">
          <code className="code text-lg text-safelight">{made}</code>
          <CopyButton text={made} />
        </div>
      )}
      {error && <p className="mt-3 text-stopbath">{error}</p>}
      <div className="panel mt-4 divide-y divide-seam">
        {rows?.map((i) => (
          <div key={i.code} className={`flex flex-wrap items-center gap-4 p-3 ${i.disabledAt ? 'opacity-50' : ''}`}>
            <code className="code">{i.code}</code>
            <span className="flex-1 text-sm">{i.note}</span>
            <span className="code text-dim">{i.uses}/{i.maxUses}</span>
            <span className="text-sm text-dim">{i.expiresAt ? `expires ${new Date(i.expiresAt).toLocaleDateString()}` : 'no expiry'}</span>
            {!i.disabledAt && <button className="btn btn-danger" onClick={() => disable(i.code)}>Disable</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Accounts() {
  const { rows, error, load, setError } = useList('/admin/accounts', 'accounts');
  const adjust = async (a, kind) => {
    const amount = window.prompt(kind === 'grant' ? `Grant how many USD to ${a.email || a.name}? (negative to remove)` : `Record a refund of how many USD for ${a.email || a.name}? (refund in Stripe first)`);
    if (!amount) return;
    const note = window.prompt('Note (shown in their history)') || '';
    try {
      await api.post(`/admin/accounts/${a.id}/ledger`, { kind, amountUsd: Number(amount), note });
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const disable = async (a) => {
    if (!window.confirm(`Disable ${a.email || a.name}? Their keys stop working.`)) return;
    await api.post(`/admin/accounts/${a.id}/disable`).catch((e) => setError(errorText(e)));
    load();
  };
  return (
    <div className="panel overflow-x-auto">
      {error && <p className="p-4 text-stopbath">{error}</p>}
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-seam text-left">
            {['Account', 'Plan', 'Balance', 'Jobs', 'Joined', ''].map((h) => <th key={h} className="eyebrow px-4 py-3 font-normal">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows?.map((a) => (
            <tr key={a.id} className={`border-b border-seam/60 last:border-0 ${a.disabledAt ? 'opacity-50' : ''}`}>
              <td className="px-4 py-3">{a.email || a.name}<div className="code text-[11px] text-dim">{a.id.slice(0, 8)}</div></td>
              <td className="code px-4 py-3">{a.disabledAt ? 'disabled' : a.plan}</td>
              <td className="code px-4 py-3">{money(a.balance)}</td>
              <td className="code px-4 py-3">{a.jobs}</td>
              <td className="px-4 py-3 text-dim">{ago(a.createdAt)}</td>
              <td className="px-4 py-3">
                {!a.disabledAt && (
                  <div className="flex justify-end gap-2">
                    <button className="btn" onClick={() => adjust(a, 'grant')}>Grant</button>
                    <button className="btn" onClick={() => adjust(a, 'refund')}>Refund</button>
                    <button className="btn btn-danger" onClick={() => disable(a)}>Disable</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Jobs() {
  const { rows, error } = useList('/admin/jobs', 'jobs');
  return (
    <div className="panel overflow-x-auto">
      {error && <p className="p-4 text-stopbath">{error}</p>}
      <table className="w-full min-w-[720px] text-sm">
        <tbody>
          {rows?.map((j) => (
            <tr key={j.id} className="border-b border-seam/60 last:border-0">
              <td className="px-4 py-2.5"><JobStatusBadge status={j.status} progress={j.progress} /></td>
              <td className="px-4 py-2.5">{j.composition}</td>
              <td className="px-4 py-2.5 text-dim">{j.account}</td>
              <td className="code px-4 py-2.5">{j.cost !== null ? money(j.cost) : '—'}</td>
              <td className="code px-4 py-2.5 text-stopbath">{j.error?.code}</td>
              <td className="px-4 py-2.5 text-dim">{ago(j.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Admin() {
  const [tab, setTab] = useState(TABS[0]);
  return (
    <div>
      <div className="eyebrow">Owner</div>
      <h1 className="h-display mt-1 text-5xl">Admin</h1>
      <div className="mt-8 flex gap-1 border-b border-seam" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-safelight text-paper' : 'border-transparent text-dim hover:text-paper'}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {tab === 'Waitlist' && <Waitlist />}
        {tab === 'Invites' && <Invites />}
        {tab === 'Accounts' && <Accounts />}
        {tab === 'Jobs' && <Jobs />}
      </div>
    </div>
  );
}
