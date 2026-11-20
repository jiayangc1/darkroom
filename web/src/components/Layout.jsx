import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { UserButton, useAuth } from '@clerk/react';
import { Film, KeyRound, Wallet, Settings as SettingsIcon, Rocket, Shield } from 'lucide-react';
import { api, setTokenGetter, errorText } from '../api.js';
import FilmEdge from './FilmEdge.jsx';
import StatusLine from './StatusLine.jsx';
import WaitingRoom from '../pages/WaitingRoom.jsx';

const NAV = [
  { to: '/app', label: 'Jobs', icon: Film, end: true },
  { to: '/app/start', label: 'Connect an agent', icon: Rocket },
  { to: '/app/keys', label: 'API keys', icon: KeyRound },
  { to: '/app/billing', label: 'Credits', icon: Wallet },
  { to: '/app/settings', label: 'Settings', icon: SettingsIcon },
];

export default function Layout() {
  const { getToken } = useAuth();
  setTokenGetter(getToken);
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const location = useLocation();

  const refreshMe = useCallback(() => api.get('/me').then((r) => setMe(r.data)).catch((e) => setError(errorText(e))), []);
  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  const nav = me?.isAdmin ? [...NAV, { to: '/app/admin', label: 'Admin', icon: Shield }] : NAV;
  const waiting = me?.account.plan === 'waitlist' && !me.isAdmin && location.pathname !== '/app/start';

  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
      <aside className="border-b border-seam md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-5 py-4 md:block">
          <a href="/app" className="h-display text-3xl text-paper">Darkroom</a>
          <div className="flex items-center gap-3 md:mt-3">
            <StatusLine />
            <span className="md:hidden"><UserButton /></span>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm ${isActive ? 'bg-tray text-paper' : 'text-dim hover:text-paper'}`}
            >
              <Icon size={16} strokeWidth={1.75} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden px-5 py-4 md:absolute md:bottom-0 md:block md:w-full">
          {me && (
            <div className="mb-3">
              <div className="eyebrow">Credit</div>
              <div className="font-mono text-lg">${Number(me.account.available).toFixed(2)}</div>
            </div>
          )}
          <UserButton />
        </div>
      </aside>
      <main className="min-w-0">
        <FilmEdge>
          {Array.from({ length: 12 }, (_, i) => `DARKROOM ${String(i + 1).padStart(2, '0')} ▸ SAFETY FILM ▸ `).join('')}
        </FilmEdge>
        <div className="mx-auto max-w-5xl px-4 py-8 md:px-10">
          {error && <p className="panel mb-6 border-stopbath/50 p-4 text-stopbath">{error}</p>}
          {me && (waiting ? <WaitingRoom me={me} refreshMe={refreshMe} /> : <Outlet context={{ me, refreshMe }} />)}
        </div>
      </main>
    </div>
  );
}
