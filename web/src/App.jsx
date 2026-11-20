import { createBrowserRouter, RouterProvider, Outlet, useNavigate, Navigate } from 'react-router';
import { ClerkProvider, SignIn, SignUp, useAuth } from '@clerk/react';
import { ConfigContext } from './config.js';
import Layout from './components/Layout.jsx';
import Landing from './pages/Landing.jsx';
import Jobs from './pages/Jobs.jsx';
import JobDetail from './pages/JobDetail.jsx';
import GetStarted from './pages/GetStarted.jsx';
import Keys from './pages/Keys.jsx';
import Billing from './pages/Billing.jsx';
import Settings from './pages/Settings.jsx';
import Admin from './pages/admin/Admin.jsx';

const appearance = {
  variables: {
    colorPrimary: '#f0a23b',
    colorBackground: '#22130f',
    colorForeground: '#ede3d1',
    colorMutedForeground: '#8f7768',
    colorInput: '#170d0b',
    colorInputForeground: '#ede3d1',
    colorPrimaryForeground: '#170d0b',
    colorNeutral: '#ede3d1',
    fontFamily: '"Instrument Sans", system-ui, sans-serif',
    borderRadius: '6px',
  },
};

function ClerkRoot({ config }) {
  const navigate = useNavigate();
  return (
    <ClerkProvider
      publishableKey={config.clerkPublishableKey}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
      afterSignOutUrl="/"
      appearance={appearance}
    >
      <ConfigContext.Provider value={config}>
        <Outlet />
      </ConfigContext.Provider>
    </ClerkProvider>
  );
}

function Protected() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="min-h-screen bg-room" />;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  return <Layout />;
}

function AuthPage({ children }) {
  return (
    <div className="min-h-screen grid place-items-center px-4 py-12">
      <div className="flex flex-col items-center gap-8">
        <a href="/" className="h-display text-4xl text-paper">Darkroom</a>
        {children}
      </div>
    </div>
  );
}

export default function App({ config }) {
  const router = createBrowserRouter([
    {
      element: <ClerkRoot config={config} />,
      children: [
        { path: '/', element: <Landing /> },
        { path: '/sign-in/*', element: <AuthPage><SignIn routing="path" path="/sign-in" /></AuthPage> },
        { path: '/sign-up/*', element: <AuthPage><SignUp routing="path" path="/sign-up" /></AuthPage> },
        {
          path: '/app',
          element: <Protected />,
          children: [
            { index: true, element: <Jobs /> },
            { path: 'jobs/:id', element: <JobDetail /> },
            { path: 'start', element: <GetStarted /> },
            { path: 'keys', element: <Keys /> },
            { path: 'billing', element: <Billing /> },
            { path: 'settings', element: <Settings /> },
            { path: 'admin', element: <Admin /> },
          ],
        },
        { path: '*', element: <Navigate to="/" replace /> },
      ],
    },
  ]);
  return <RouterProvider router={router} />;
}
