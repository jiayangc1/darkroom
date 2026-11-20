import { useEffect, useState } from 'react';
import { UserProfile } from '@clerk/react';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { api, errorText } from '../api.js';
import CopyButton from '../components/CopyButton.jsx';

export default function Settings() {
  const [secret, setSecret] = useState(null);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/webhook-secret').then((r) => setSecret(r.data.secret)).catch((e) => setError(errorText(e)));
  }, []);

  const rotate = async () => {
    if (!window.confirm('Make a new signing secret? Webhooks are signed with the new one right away, so update your receiver first.')) return;
    try {
      setSecret((await api.post('/webhook-secret/rotate')).data.secret);
      setShown(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div>
      <div className="eyebrow">Account</div>
      <h1 className="h-display mt-1 text-5xl">Settings</h1>

      <section className="mt-10 max-w-2xl">
        <h2 className="text-lg font-semibold">Webhook signing secret</h2>
        <p className="mt-1 text-sm text-dim">
          When a job has a <code className="code">webhookUrl</code>, Darkroom POSTs the finished job there with a{' '}
          <code className="code">Darkroom-Signature</code> header: HMAC-SHA256 of <code className="code">{'"<t>.<body>"'}</code> with this secret.
        </p>
        {secret && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <code className="code rounded bg-tray px-3 py-2">{shown ? secret : `${secret.slice(0, 10)}${'•'.repeat(24)}`}</code>
            <button className="btn" onClick={() => setShown((s) => !s)}>{shown ? <EyeOff size={14} /> : <Eye size={14} />} {shown ? 'Hide' : 'Show'}</button>
            <CopyButton text={secret} />
            <button className="btn btn-danger" onClick={rotate}><RefreshCw size={14} /> Rotate</button>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-stopbath">{error}</p>}
      </section>

      <section className="mt-12">
        <h2 className="mb-4 text-lg font-semibold">Sign-in and profile</h2>
        <UserProfile routing="hash" />
      </section>
    </div>
  );
}
