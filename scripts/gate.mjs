#!/usr/bin/env node
// npm run gate – everything that must be true before a branch is pushed for review.
//
//   npm run gate                  check the current branch against origin/main
//   npm run gate -- --base <ref>  against another base (a stacked branch's parent)
//
// It certifies a commit, so it refuses a dirty working tree. Each check prints ✓ or ✗;
// the last line is what goes into the pull request ("Gate passed on <sha>"). A check
// that cannot run here (no Postgres, no Chrome) fails with the reason rather than being
// skipped silently: a skipped check is how a red CI run reaches a reviewer.
//
// The rules behind each check are in AGENTS.md, "Before you push".

import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const baseRef = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main'
const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
const results = []

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}
function run(label, cmd, opts = {}) {
  process.stdout.write(`… ${label}\n`)
  const r = spawnSync(cmd, { cwd: root, shell: true, stdio: opts.quiet ? 'pipe' : 'inherit', env: { ...process.env, ...opts.env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status === 0) return { ok: true, out: r.stdout ?? '' }
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  // A failure without its reason sends the next person to rerun everything by hand.
  if (opts.quiet && !opts.silentFailure) {
    const plain = out.replace(/\u001b\[[0-9;]*m/g, '')
    console.log(plain.split('\n').filter(l => l.trim()).slice(-15).map(l => `    | ${l}`).join('\n'))
  }
  return { ok: false, out }
}
function record(name, ok, note = '') {
  results.push({ name, ok, note })
  console.log(`${ok ? '✓' : '✗'} ${name}${note ? ` – ${note}` : ''}`)
}

// ── What changed ────────────────────────────────────────────────────────────
const branch = git('rev-parse --abbrev-ref HEAD')
const sha = git('rev-parse --short HEAD')
const mergeBase = git(`merge-base ${baseRef} HEAD`)
const changed = git(`diff --name-only ${mergeBase} HEAD`).split('\n').filter(Boolean)
const added = git(`diff -U0 ${mergeBase} HEAD`)
  .split('\n')
  .reduce((acc, line) => {
    if (line.startsWith('+++ b/')) acc.file = line.slice(6)
    else if (line.startsWith('+') && !line.startsWith('+++')) acc.lines.push({ file: acc.file, text: line.slice(1) })
    return acc
  }, { file: '', lines: [] }).lines
const touches = re => changed.some(f => re.test(f))

console.log(`Gate for ${branch} @ ${sha}, against ${baseRef} (${changed.length} files changed)\n`)

record('not on main', branch !== 'main', branch === 'main' ? 'work on a branch' : '')
const dirty = git('status --porcelain')
record('working tree clean', dirty === '', dirty ? 'commit or stash first: the gate certifies a commit' : '')

// ── Static checks, tests, build: the same as CI ─────────────────────────────
for (const [label, cmd] of [
  ['typecheck', 'npm run typecheck'],
  ['typecheck:api', 'npm run typecheck:api'],
  ['lint', 'npm run lint'],
  ['tests', 'npm test'],
  ['build', 'npm run build'],
]) record(label, run(label, cmd, { quiet: true }).ok)

// ── SQL: every migration on a real Postgres, then the behaviour tests ───────
if (touches(/^supabase\//)) {
  const pgBin = [process.env.PG_BIN, 'C:/Program Files/PostgreSQL/17/bin', '/usr/lib/postgresql/17/bin', '/opt/homebrew/opt/postgresql@17/bin']
    .filter(Boolean).find(d => existsSync(path.join(d, process.platform === 'win32' ? 'psql.exe' : 'psql')))
  const env = { PGPORT: process.env.PGPORT ?? '54329', ...(pgBin ? { PATH: `${pgBin}${path.delimiter}${process.env.PATH}` } : {}) }
  const ready = run('postgres reachable', 'pg_isready -q', { quiet: true, silentFailure: true, env }).ok
  if (!ready) record('SQL migrations and behaviour tests', false, `no Postgres on port ${env.PGPORT}; see scripts/test-migrations.sh for a throwaway cluster`)
  else record('SQL migrations and behaviour tests', run('sql', 'bash scripts/test-migrations.sh', { quiet: true, env }).ok)
}

// ── PDFs through a real Chromium, when the PDF path or its engine changed ────
if (touches(/api\/_lib\/(pdf|reportHtml)\.ts$/) || added.some(l => l.file === 'package-lock.json' && /puppeteer|chromium/.test(l.text))) {
  const chrome = process.env.CHROMIUM_PATH ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find(p => existsSync(p))
  if (!chrome) record('PDF render in Chromium', false, 'set CHROMIUM_PATH to a local Chrome or Edge')
  else record('PDF render in Chromium', run('pdf', 'npx --workspace=apps/web vitest run test/pdf-render.chrome.test.ts', { quiet: true, env: { CHROMIUM_PATH: chrome } }).ok)
}

// ── Dependencies: nothing high or critical in what ships ────────────────────
const audit = run('npm audit (runtime)', 'npm audit --omit=dev --json', { quiet: true, silentFailure: true })
let runtimeHigh = 0, devHigh = 0
try { const m = JSON.parse(audit.out).metadata.vulnerabilities; runtimeHigh = m.high + m.critical } catch { runtimeHigh = -1 }
try { const m = JSON.parse(run('npm audit (all)', 'npm audit --json', { quiet: true, silentFailure: true }).out).metadata.vulnerabilities; devHigh = m.high + m.critical } catch { devHigh = -1 }
record('no high or critical advisory at runtime', runtimeHigh === 0, runtimeHigh === -1 ? 'npm audit did not answer' : runtimeHigh ? `${runtimeHigh} found: npm audit --omit=dev` : '')
if (devHigh > 0) console.log(`  note: ${devHigh} high/critical in development dependencies – say so in the PR`)

// ── Hygiene on the lines this branch adds ───────────────────────────────────
const hit = (re, skip = () => false) => added.filter(l => !skip(l) && re.test(l.text))
const show = ls => ls.slice(0, 3).map(l => `${l.file}: ${l.text.trim().slice(0, 60)}`).join(' | ')
const emDash = hit(/\u2014/)
record('no em dash added', emDash.length === 0, emDash.length ? show(emDash) : '')
const invisible = hit(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/, l => /\.test\.(ts|tsx)$/.test(l.file))
record('no invisible Unicode added', invisible.length === 0, invisible.length ? show(invisible) : '')
const secrets = hit(/(sb_secret_[A-Za-z0-9_-]{10,}|re_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY)/)
record('no secret in the diff', secrets.length === 0, secrets.length ? show(secrets) : '')
const envFiles = changed.filter(f => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example'))
record('no .env file committed', envFiles.length === 0, envFiles.join(', '))
const realData = changed.filter(f => /\.local\.sql$|docs\/emails\//.test(f))
record('no real-people data committed', realData.length === 0, realData.join(', '))

// ── Changelog: user-visible change means an entry ────────────────────────────
if (touches(/^(apps\/web\/(src|api)|supabase\/migrations)\//) && /^(feat|fix|hotfix)\//.test(branch)) {
  record('CHANGELOG.md updated', changed.includes('CHANGELOG.md'), 'feat/fix branches list what users see')
}

// ── Verdict ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok)
console.log('')
if (failed.length) {
  console.log(`Gate FAILED on ${sha}: ${failed.map(f => f.name).join(', ')}`)
  process.exit(1)
}
console.log(`Gate passed on ${sha} (${results.length} checks${devHigh > 0 ? `; ${devHigh} high/critical in dev dependencies` : ''}).`)
