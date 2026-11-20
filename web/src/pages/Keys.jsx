import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { KeyRound } from 'lucide-react';
import { api, errorText } from '../api.js';
import CopyButton from '../components/CopyButton.jsx';
import { ago } from '../format.js';

export default function Keys() {
  const [keys, setKeys] = useState(null);
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get('/keys').then((r) => setKeys(r.data.keys)).catch((e) => setError(errorText(e))), []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCreated((await api.post('/keys', { label })).data);
      setLabel('');
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k) => {
    if (!window.confirm(`Revoke ${k.label || k.prefix}? Agents using it stop working immediately.`)) return;
    try {
      await api.delete(`/keys/${k.id}`);
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const live = keys?.filter((k) => !k.revokedAt) || [];
  const revoked = keys?.filter((k) => k.revokedAt) || [];

  return (
    <div>
      <div className="eyebrow">Access</div>
      <h1 className="h-display mt-1 text-5xl">API keys</h1>
      <p className="mt-3 max-w-xl text-dim">
        Give one key to each agent or machine, so you can revoke one without breaking the rest.
        Keys work for both MCP and the REST API — see <Link to="/app/start" className="text-safelight hover:underline">Connect an agent</Link>.
      </p>

      <form onSubmit={create} className="mt-8 flex max-w-xl gap-2">
        <input className="field" placeholder="Label, e.g. laptop Claude Code" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
        <button className="btn btn-primary shrink-0" disabled={busy}><KeyRound size={14} /> Create key</button>
      </form>
      {error && <p className="mt-3 text-sm text-stopbath">{error}</p>}

      {created && (
        <div className="panel develop mt-6 border-safelight/60 p-5">
          <div className="text-sm font-medium">New key{created.label ? ` “${created.label}”` : ''}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="code break-all rounded bg-room px-3 py-2 text-safelight">{created.key}</code>
            <CopyButton text={created.key} />
          </div>
          <p className="mt-3 text-sm text-dim">Copy it now. Darkroom only stores a hash, so it can't show this key again.</p>
          <button className="btn mt-4" onClick={() => setCreated(null)}>I've saved it</button>
        </div>
      )}

      <div className="panel mt-8 divide-y divide-seam">
        {keys && live.length === 0 && <p className="p-5 text-dim">No active keys.</p>}
        {live.map((k) => (
          <div key={k.id} className="flex flex-wrap items-center gap-4 p-4">
            <code className="code text-paper">{k.prefix}…</code>
            <span className="flex-1">{k.label || <span className="text-dim">No label</span>}</span>
            <span className="text-sm text-dim">{k.lastUsedAt ? `used ${ago(k.lastUsedAt)}` : 'never used'}</span>
            <button className="btn btn-danger" onClick={() => revoke(k)}>Revoke</button>
          </div>
        ))}
      </div>
      {revoked.length > 0 && (
        <details className="mt-6 text-sm text-dim">
          <summary className="cursor-pointer">{revoked.length} revoked</summary>
          <ul className="mt-2 space-y-1">
            {revoked.map((k) => <li key={k.id} className="code">{k.prefix}… {k.label} — revoked {ago(k.revokedAt)}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
