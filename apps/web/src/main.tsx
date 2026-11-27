import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ThemeProvider } from './lib/theme'
import { databaseConfigError } from './lib/environment'
import { loadAppConfig } from './lib/appConfig'
import { DemoAnalytics } from './components/DemoAnalytics'
// Fonts are bundled and served from our own origin, never fetched from Google:
// a third-party font request sends every visitor's IP address to Google, which
// the data protection agreement does not list as a recipient.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import './index.css'

// Start the runtime-config fetch before React mounts, so screens that lay out
// around it – the admin login's demo panel above all – have it on their first
// frame instead of shifting once it lands.
void loadAppConfig()

// Builds before 1.0.0 kept up to 50 Supabase responses (names, companies, entries) in a
// service-worker cache for an hour. Nothing writes to it now; delete what tablets still hold.
if ('caches' in window) void caches.delete('supabase-cache').catch(() => undefined)

// A preview or local build wired to the production database must not start.
const environmentError = databaseConfigError(import.meta.env.VITE_SUPABASE_URL, __VERCEL_ENV__)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      {environmentError ? (
        <main className="flex min-h-screen items-center justify-center bg-bg p-6">
          <div role="alert" className="max-w-lg rounded-xl border border-error bg-error-subtle p-6 text-fg">
            <h1 className="mb-2 text-lg font-semibold">Falsche Datenbank</h1>
            <p className="text-sm leading-relaxed">{environmentError}</p>
          </div>
        </main>
      ) : (
        <BrowserRouter>
          <App />
        </BrowserRouter>
      )}
    </ThemeProvider>
    <DemoAnalytics />
  </StrictMode>,
)
