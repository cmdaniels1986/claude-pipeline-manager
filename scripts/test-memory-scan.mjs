// Runtime test for the startup memory-bank scan (src/main/memoryScan.ts).
// Builds a fake Claude config dir with several project memory stores, points
// CLAUDE_CONFIG_DIR + a fake HOME at it, and checks the scan finds the banks,
// flags the cross-project one as active/injected, and reports counts + titles.
// Run: node scripts/test-memory-scan.mjs
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

// point the scanner at a throwaway config dir; the "home" store key must match
// how the code encodes homedir(), so derive the encoded home the same way.
const cfg = mkdtempSync(join(tmpdir(), 'memscan-cfg-'))
process.env.CLAUDE_CONFIG_DIR = cfg
const encodedHome = homedir().replace(/[\\/:]/g, '-')

const bank = (key, index, extraFiles) => {
  const dir = join(cfg, 'projects', key, 'memory')
  mkdirSync(dir, { recursive: true })
  if (index != null) writeFileSync(join(dir, 'MEMORY.md'), index)
  for (const f of extraFiles ?? []) writeFileSync(join(dir, f), '# ' + f)
}

// the cross-project (home) store — should be flagged active/injected
bank(
  encodedHome,
  ['# Memory Index', '', '- [Commit Rule](feedback.md) — push it', '- [Pipeline Mgr](proj.md) — the app'].join('\n'),
  ['feedback.md', 'proj.md']
)
// a couple of project-specific stores that would shadow it in a normal session
bank('C--Users-cmdan-OneDrive-Desktop-BrewScience', '# Memory Index\n\n- [Brew Thing](b.md) — beer', ['b.md'])
bank('C--Users-cmdan-dev-demo-pipeline', '# Memory Index\n\n- [Demo](d.md) — demo', ['d.md'])
// an empty memory folder (no index, no files) — should be ignored
bank('C--Users-cmdan-empty', null, [])

const out = join(process.cwd(), 'scripts', '.tmp-memscan.mjs')
await build({
  entryPoints: ['src/main/memoryScan.ts'],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const { scanMemoryBanks } = await import(pathToFileURL(out).href)

let passed = 0
const ok = (cond, msg) => (cond ? (passed++, console.log('✓ ' + msg)) : (console.error('✗ ' + msg), (process.exitCode = 1)))

const scan = scanMemoryBanks()

ok(scan.ok, 'scan.ok is true when the cross-project store exists')
ok(scan.active && scan.active.key === encodedHome, 'active bank is the encoded-home cross-project store')
ok(scan.active.active === true, 'active bank is flagged as injected')
ok(scan.active.entries === 2, 'active bank entry count parsed from MEMORY.md')
ok(scan.active.files === 2, 'active bank memory-file count (excludes MEMORY.md)')
ok(scan.active.sampleTitles[0] === 'Commit Rule', 'sample titles parsed for recognition')
ok(scan.banks.length === 3, 'found all three non-empty banks (empty folder ignored)')
ok(scan.banks[0].active, 'active bank sorts first')
ok(scan.banks.filter((b) => !b.active).length === 2, 'two project-specific banks reported for context')

// --- not-ok path: no home store at all ---
const cfg2 = mkdtempSync(join(tmpdir(), 'memscan-empty-'))
process.env.CLAUDE_CONFIG_DIR = cfg2
const scan2 = scanMemoryBanks()
ok(!scan2.ok && scan2.active === null, 'scan.ok is false when there is no cross-project store')
ok(typeof scan2.reason === 'string' && scan2.reason.includes('MEMORY.md'), 'reason explains where it looked')

rmSync(out, { force: true })
rmSync(cfg, { recursive: true, force: true })
rmSync(cfg2, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
process.exit(process.exitCode ?? 0)
