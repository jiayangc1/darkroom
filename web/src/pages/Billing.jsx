import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router';
import { api, errorText } from '../api.js';
import { useConfig } from '../config.js';
import { dateTime, money } from '../format.js';

const KIND = { purchase: 'Credit purchase', trial: 'Free trial', grant: 'Credit adjustment', charge: 'Render', refund: 'Refund' };

export default function Billing() {
  const config = useConfig();
  const { refreshMe } = useOutletContext();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [buying, setBuying] = useState(null);

  const load = useCallback(() => api.get('/billing').then((r) => setData(r.data)).catch((e) => setError(errorText(e))), []);
  useEffect(() => {
    load();
    if (params.get('paid')) {
      // the webhook usually lands within a second or two
      const t = setTimeout(() => {
        load();
        refreshMe();
      }, 2500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [load, params, refreshMe]);

  const buy = async (pack) => {
    setBuying(pack);
    setError(null);
    try {
      window.location.assign((await api.post('/billing/checkout', { pack })).data.url);
    } catch (e) {
      setError(errorText(e));
      setBuying(null);
    }
  };

  const perMin = Number(config.prices.perMinute);
  return (
    <div>
      <div className="eyebrow">Prepaid</div>
      <h1 className="h-display mt-1 text-5xl">Credits</h1>

      {params.get('paid') && (
        <p className="panel develop mt-6 border-fixer/50 p-4 text-sm">Payment received. Your credit appears below as soon as Stripe confirms it.</p>
      )}

      {data && (
        <div className="mt-8 flex flex-wrap gap-10">
          <div>
            <div className="eyebrow">Available</div>
            <div className="mt-1 font-mono text-4xl">{money(data.available)}</div>
          </div>
          {data.available !== data.balance && (
            <div>
              <div className="eyebrow">Balance</div>
              <div className="mt-1 font-mono text-4xl text-dim">{money(data.balance)}</div>
              <div className="text-xs text-dim">part is reserved for running jobs</div>
            </div>
          )}
        </div>
      )}

      <h2 className="mt-12 text-lg font-semibold">Add credit</h2>
      <p className="mt-1 text-sm text-dim">
        ${perMin.toFixed(2)} per minute of video up to 1080p, billed per second, at least {config.prices.minSeconds} s per render.
        1440p counts double and 4K four times. Failed and canceled renders are free. Sales tax is added at checkout where it applies.
      </p>
      <div className="mt-5 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
        {config.prices.packs.map((p) => (
          <button
            key={p}
            onClick={() => buy(p)}
            disabled={buying !== null}
            className="panel group p-5 text-left hover:border-safelight disabled:opacity-60"
          >
            <div className="font-mono text-3xl group-hover:text-safelight">${p}</div>
            <div className="mt-2 text-sm text-dim">≈ {Math.floor(p / perMin)} min of 1080p</div>
            <div className="mt-4 text-sm font-medium">{buying === p ? 'Opening checkout…' : 'Buy'}</div>
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-stopbath">{error}</p>}

      <h2 className="mt-12 text-lg font-semibold">History</h2>
      <div className="panel mt-4 overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <tbody>
            {data?.ledger.length === 0 && (
              <tr><td className="p-5 text-dim">Nothing yet.</td></tr>
            )}
            {data?.ledger.map((e) => (
              <tr key={e.id} className="border-b border-seam/60 last:border-0">
                <td className="px-4 py-3 text-dim">{dateTime(e.at)}</td>
                <td className="px-4 py-3">
                  {e.kind === 'charge' && e.jobId ? <Link to={`/app/jobs/${e.jobId}`} className="hover:text-safelight">{KIND.charge} · {e.note}</Link> : KIND[e.kind]}
                  {e.kind !== 'charge' && e.note && e.note !== KIND[e.kind] && <span className="text-dim"> · {e.note}</span>}
                </td>
                <td className={`code px-4 py-3 text-right ${Number(e.amount) > 0 ? 'text-fixer' : ''}`}>
                  {Number(e.amount) > 0 ? '+' : ''}{money(e.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
