// Runtime test for Global Memory + linked memory (src/main/sharedMemory.ts):
// saving/updating/removing entries in Claude Code's memory format, the self-healing
// MEMORY.md index, importing memory files picked from another store, linked
// sources (folder / MEMORY.md / single file / missing / duplicate), the injected
// prompt block, and the persisted settings. Uses real temp folders.
// Run: node scripts/test-shared-memory.mjs
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

// isolate the machine memory scan (listMemoryBanks) from the real ~/.claude
const cfg = mkdtempSync(join(tmpdir(), 'sharedmem-cfg-'))
process.env.CLAUDE_CONFIG_DIR = cfg
const encodedHome = homedir().replace(/[\\/:]/g, '-')
const machineDir = join(cfg, 'projects', encodedHome, 'memory')
mkdirSync(machineDir, { recursive: true })
writeFileSync(
  join(machineDir, 'MEMORY.md'),
  '# Memory Index\n\n- [Tools live at C:\\ root](feedback-tools-on-c.md) — new pipelines get their own folder\n- [Sound Creator](sound-creator.md) — local text-to-SFX\n'
)
writeFileSync(
  join(machineDir, 'feedback-tools-on-c.md'),
  '---\nname: feedback-tools-on-c\ndescription: new pipelines get their own C:\\<Tool> folder\nmetadata:\n  type: feedback\n---\n\nEvery new pipeline gets its own C:\\<Tool> folder.\n\n**Why:** keeps venvs apart.\n'
)
writeFileSync(join(machineDir, 'sound-creator.md'), '# Sound Creator\n\nC:\\Sound Creator turns text into sound effects.\n')

const out = join(process.cwd(), 'scripts', '.tmp-sharedmem.mjs')
await build({
  entryPoints: ['src/main/sharedMemory.ts'],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const m = await import(pathToFileURL(out).href)

let passed = 0
const ok = (cond, msg) => (cond ? (passed++, console.log('✓ ' + msg)) : (console.error('✗ ' + msg), (process.exitCode = 1)))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (p) => readFileSync(p, 'utf8')

const root = mkdtempSync(join(tmpdir(), 'sharedmem-'))
const global = join(root, 'Team Memory')

// ---- saving ------------------------------------------------------------------
const s1 = m.saveMemory(
  global,
  { name: 'UE Shader Cache Trap', title: 'Shader cache trap', description: 'delete DDC after engine update', type: 'project', body: 'Delete the DDC after every engine update.\n\n**Why:** stale shaders.' },
  'chad'
)
const f1 = join(global, 'ue-shader-cache-trap.md')
ok(s1.name === 'ue-shader-cache-trap' && s1.path === f1 && !s1.updated, 'save slugs the name and creates the file (folder made on demand)')
const t1 = read(f1)
ok(/^---\nname: ue-shader-cache-trap\n/.test(t1) && t1.includes('description: delete DDC after engine update'), 'file uses Claude memory frontmatter (name, description)')
ok(t1.includes('type: project') && t1.includes('title: Shader cache trap') && t1.includes('author: chad'), 'metadata carries type, title, author')
ok(t1.includes('Delete the DDC after every engine update.') && t1.includes('**Why:** stale shaders.'), 'body is written')
const idx1 = read(join(global, 'MEMORY.md'))
ok(idx1.startsWith('# Global Memory') && idx1.includes('- [Shader cache trap](ue-shader-cache-trap.md) — delete DDC after engine update'), 'MEMORY.md gets a header and an index line')

// update in place: same name, new title → still one line, new title
const s1b = m.saveMemory(global, { name: 'ue-shader-cache-trap', title: 'Shader cache trap (UE 5.8)', description: 'delete DDC after engine updates', body: 'Updated.' }, 'brother')
const idx1b = read(join(global, 'MEMORY.md'))
ok(s1b.updated, 'saving an existing name reports an update')
ok((idx1b.match(/ue-shader-cache-trap\.md/g) ?? []).length === 1 && idx1b.includes('[Shader cache trap (UE 5.8)]'), 'update rewrites its index line in place, no duplicate')
const t1b = read(f1)
ok(t1b.includes('type: project') && t1b.includes('author: brother') && t1b.includes('Updated.'), 'update keeps the earlier type, restamps author, replaces body')

// a human note in MEMORY.md survives later saves
writeFileSync(join(global, 'MEMORY.md'), read(join(global, 'MEMORY.md')) + '\nAsk Chad before deleting anything here.\n')
m.saveMemory(global, { title: 'Door hinge pivot', description: 'door 5D hinge sits on the left jamb', body: 'Left jamb.' }, 'chad')
const idx2 = read(join(global, 'MEMORY.md'))
ok(idx2.includes('Ask Chad before deleting anything here.') && idx2.includes('- [Door hinge pivot](door-hinge-pivot.md)'), 'hand-written lines in MEMORY.md are kept; new entry appended')

// slug guards against path tricks
const evil = m.saveMemory(global, { name: '..\\..\\evil/../x', title: 't', description: 'd', body: 'b' }, 'chad')
ok(evil.path.startsWith(global) && !existsSync(join(root, 'evil.md')), 'a hostile name cannot write outside the folder')
m.removeMemory(global, evil.name)

// YAML turns a bare date into a Date — still read back as a string
writeFileSync(join(global, 'dated.md'), '---\nname: dated\ndescription: has a bare date\nmetadata:\n  updated: 2026-10-01\n  author: someone\n---\n\nbody\n')
const dated = m.listMemoryEntries(global).find((e) => e.name === 'dated')
ok(dated && typeof dated.updated === 'string' && dated.updated.startsWith('2026-10-01'), 'a bare YAML date reads back as an ISO string')

// ---- self-healing index -------------------------------------------------------
// a teammate's file syncs in without an index line; a file vanishes; sync makes a conflict copy
writeFileSync(join(global, 'synced-in.md'), '# Synced in from a teammate\n\nThey wrote this file by hand.\n')
unlinkSync(join(global, 'door-hinge-pivot.md'))
writeFileSync(join(global, 'MEMORY (1).md'), '# conflict copy\n- [Ghost](ghost.md) — nope\n')
m.refreshIndex(global)
const idx3 = read(join(global, 'MEMORY.md'))
ok(idx3.includes('- [Synced in from a teammate](synced-in.md) — They wrote this file by hand.'), 'files without an index line are added (title from heading, hook from first line)')
ok(!idx3.includes('door-hinge-pivot.md'), 'lines for deleted files are dropped')
const names = m.listMemoryEntries(global).map((e) => e.name)
ok(!names.some((n) => n.startsWith('MEMORY')) && !names.includes('ghost'), 'MEMORY.md and its conflict copies are never treated as memories')
const before = read(join(global, 'MEMORY.md'))
m.refreshIndex(global)
ok(read(join(global, 'MEMORY.md')) === before, 'refreshing an up-to-date index is a no-op')

// ---- remove ---------------------------------------------------------------------
ok(m.removeMemory(global, 'synced-in') === true && !existsSync(join(global, 'synced-in.md')), 'remove deletes the file')
ok(!read(join(global, 'MEMORY.md')).includes('synced-in.md'), 'remove drops its index line')
ok(m.removeMemory(global, 'never-existed') === false, 'removing an unknown name reports false')

// ---- importing picked files -------------------------------------------------------
const imp = m.importMemoryFiles(
  global,
  [join(machineDir, 'feedback-tools-on-c.md'), join(machineDir, 'sound-creator.md'), join(machineDir, 'MEMORY.md'), f1],
  'chad'
)
ok(imp.added.join(',') === 'feedback-tools-on-c,sound-creator', 'picked memory files are copied in')
ok(imp.skipped.some((s) => s.file === 'MEMORY.md' && /index/.test(s.reason)), 'picking a MEMORY.md is skipped with a reason')
ok(imp.skipped.some((s) => s.file === 'ue-shader-cache-trap.md' && /already/.test(s.reason)), 'picking a file already in Global Memory is skipped')
const idx4 = read(join(global, 'MEMORY.md'))
ok(idx4.includes('- [Tools live at C:\\ root](feedback-tools-on-c.md)'), 'imported entry keeps the title from its source MEMORY.md')
ok(idx4.includes('- [Sound Creator](sound-creator.md) — local text-to-SFX'), 'a file with no frontmatter takes its hook from the source index')
const imported = read(join(global, 'feedback-tools-on-c.md'))
ok(imported.includes('type: feedback') && imported.includes('author: chad') && imported.includes('**Why:** keeps venvs apart.'), 'imported file keeps its type and body, gains author')
const reimp = m.importMemoryFiles(global, [join(machineDir, 'sound-creator.md')], 'chad')
ok(reimp.updated.join(',') === 'sound-creator' && reimp.added.length === 0, 'importing the same memory again is an update, not a duplicate')

// ---- linked sources ----------------------------------------------------------------
const teammate = join(root, 'Brother Memory')
mkdirSync(teammate)
writeFileSync(join(teammate, 'MEMORY.md'), '# Memory Index\n\n- [Build trick](build-trick.md) — run Build.bat from PowerShell\n')
writeFileSync(join(teammate, 'build-trick.md'), '---\nname: build-trick\ndescription: run Build.bat from PowerShell\n---\n\nRun it from PowerShell.\n')
const loose = join(root, 'one-memory.md')
writeFileSync(loose, '---\nname: one\ndescription: a single note\n---\n\n# One note\n\nA single linked note body.\n')
const L = (path) => ({ id: 'x', path, addedAt: '2026-10-01T00:00:00.000Z' })
const dFolder = m.describeLinked(L(teammate), [machineDir], global)
ok(dFolder.kind === 'folder' && dFolder.exists && dFolder.entries === 1 && dFolder.sampleTitles[0] === 'Build trick', 'a linked folder reports its index entries')
const dIndex = m.describeLinked(L(join(teammate, 'MEMORY.md')), [machineDir], global)
ok(dIndex.kind === 'index' && dIndex.entries === 1, 'linking a MEMORY.md means its whole folder')
const dFile = m.describeLinked(L(loose), [machineDir], global)
ok(dFile.kind === 'file' && dFile.entries === 1 && dFile.sampleTitles[0] === 'One note', 'a single linked file is one entry')
const dMissing = m.describeLinked(L(join(root, 'Z:', 'gone', 'MEMORY.md')), [machineDir], global)
ok(!dMissing.exists && dMissing.kind === 'index' && dMissing.entries === 0, 'an unreachable path is reported, not thrown')
ok(m.describeLinked(L(global), [machineDir], global).duplicateOf === 'global', 'linking the Global Memory folder is flagged as a duplicate')
ok(m.describeLinked(L(join(machineDir, 'MEMORY.md')), [machineDir], global).duplicateOf === 'machine', 'linking a store already on this machine is flagged as a duplicate')

// ---- the injected prompt block ------------------------------------------------------
const unset = m.buildSharedMemoryBlock({ version: 1, globalDir: null, linked: [] }, [machineDir])
ok(unset.includes('global_memory_save') && unset.includes('has not chosen its location'), 'with no location set, terminals still know to call global_memory_save')
const big = join(root, 'big.md')
writeFileSync(big, 'x'.repeat(7000))
const block = m.buildSharedMemoryBlock(
  {
    version: 1,
    globalDir: global,
    linked: [L(teammate), { ...L(loose), id: 'y' }, { ...L(global), id: 'z' }, { ...L(join(root, 'nope')), id: 'w' }, { ...L(big), id: 'v' }]
  },
  [machineDir]
)
ok(block.includes(`Folder: ${global}`) && block.includes('global_memory_save'), 'block names the Global Memory folder and the save tool')
ok(block.includes('(ue-shader-cache-trap.md)') && block.includes('(sound-creator.md)'), 'block lists the Global Memory entries')
ok(block.includes(`## Memory folder — ${teammate}`) && block.includes('[Build trick](build-trick.md)'), 'a linked folder is injected as its index')
ok(block.includes(`## Memory file — ${loose}`) && block.includes('A single linked note body.'), 'a linked single file is injected in full')
ok((block.match(/## Memory folder — /g) ?? []).length === 1 && !block.includes('nope'), 'duplicate and missing links are left out')
ok(block.includes('(truncated — Read') && !block.includes('x'.repeat(6500)), 'a huge linked file is truncated with a pointer to the rest')
const unreachable = m.buildSharedMemoryBlock({ version: 1, globalDir: join(root, 'Q:', 'offline'), linked: [] }, [])
ok(unreachable.includes('unreachable right now'), 'an unreachable Global Memory folder is called out instead of crashing')

// ---- MemorySources (settings + operations) --------------------------------------------
const userData = join(root, 'userData')
mkdirSync(userData)
const changes = []
const ms = new m.MemorySources({ userDataDir: userData, author: 'chad', onChange: (s) => changes.push(s) })
const noLoc = ms.save({ title: 't', description: 'd', body: 'b' })
ok(!noLoc.ok && /Choose location/.test(noLoc.error), 'saving with no location tells the user where to set one')
const fresh = join(root, 'Fresh Shared')
const st = ms.setGlobalDir(fresh)
ok(existsSync(join(fresh, 'MEMORY.md')) && st.global?.dir === fresh && st.global.entries.length === 0, 'choosing a new folder creates it with an index')
const saved = ms.save({ name: 'first', title: 'First shared memory', description: 'hello team', type: 'reference', body: 'Hello.' })
ok(saved.ok && ms.state().global.entries.some((e) => e.name === 'first' && e.author === 'chad'), 'save through MemorySources lands in the chosen folder')
ms.link(teammate)
ms.link(teammate + '\\')
ok(ms.state().linked.length === 1, 'linking the same place twice is ignored')
await wait(250)
ok(changes.length > 0 && changes.at(-1).linked.length === 1, 'changes are broadcast')
ms.dispose()
const ms2 = new m.MemorySources({ userDataDir: userData, author: 'chad' })
ok(ms2.globalDir() === fresh && ms2.settings().linked.length === 1, 'location and links persist across restarts')
ok(ms2.promptBlock().includes('First shared memory'), 'prompt block reflects the saved memory')
const linkId = ms2.settings().linked[0].id
ok(ms2.unlink(linkId).linked.length === 0, 'unlink removes the source')
ok(ms2.remove('first').ok && ms2.state().global.entries.length === 0, 'remove through MemorySources works')
ok(ms2.setGlobalDir(null).global === null && existsSync(join(fresh, 'MEMORY.md')), 'stop using keeps the folder and its files')
ms2.dispose()

rmSync(out, { force: true })
rmSync(root, { recursive: true, force: true })
rmSync(cfg, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
process.exit(process.exitCode ?? 0)
