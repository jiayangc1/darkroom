import { useState } from 'react';
import { Link } from 'react-router';
import { api, errorText } from '../api.js';
import { money } from '../format.js';

const trial = '1.50';

export default function WaitingRoom({ me, refreshMe }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const redeem = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/invite/redeem', { code });
      await refreshMe();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="develop max-w-xl">
      <div className="eyebrow">Waitlist</div>
      <h1 className="h-display mt-2 text-5xl">You're on the list</h1>
      <p className="mt-4 text-dim">
        Darkroom renders on one GPU machine, so accounts are let in a few at a time. Once{' '}
        <span className="text-paper">{me.account.email}</span> is let in, this page turns into your dashboard,
        with {money(trial)} of free rendering to start.
      </p>
      <form onSubmit={redeem} className="panel mt-8 p-5">
        <label htmlFor="invite" className="text-sm font-medium">Have an invite code?</label>
        <div className="mt-3 flex gap-2">
          <input
            id="invite"
            className="field font-mono uppercase tracking-widest"
            placeholder="DRK-XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
          />
          <button className="btn btn-primary" disabled={busy || !code.trim()}>Redeem</button>
        </div>
        {error && <p className="mt-3 text-sm text-stopbath">{error}</p>}
      </form>
      <p className="mt-6 text-sm text-dim">
        Meanwhile, see <Link to="/app/start" className="text-safelight underline-offset-4 hover:underline">how agents connect</Link>.
      </p>
    </div>
  );
}
