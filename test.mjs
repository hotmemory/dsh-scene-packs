// 不依赖 DSH 的单元测试：用一个假的 ctx / agent 作用域跑一遍核心逻辑。
// 跑法：node test.mjs
//
// 验的是四条最容易错的地方：
//   1. deny = 受管 − 本场景允许（含通配展开）
//   2. 永不屏蔽 scene_*（不变量 2）
//   3. 切换时先撤旧掩码，且只撤一次（不变量 1）
//   4. 不存在 / 作用域内的工具名被跳过并给警告，不让整次切换失败（不变量 3）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-packs-test-'))
process.env.HOME = process.env.USERPROFILE = tmp // 让默认数据目录落在临时目录

const mod = await import('./index.js')

// ---------------------------------------------------------------- 假宿主

function makeCtx() {
  const registered = new Map()
  return {
    registered,
    logger: { info() {} },
    on() {},
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
  }
}

// 假 agent 作用域：记下 restrict 收到的 filter，以及 dispose 被调了几次
function makeAgent(toolNames, opts = {}) {
  const calls = []
  const scopeLocal = new Set(opts.scopeLocal || [])
  let live = null
  const tools = {
    restrict(filter) {
      for (const name of [...(filter.allow || []), ...(filter.deny || [])]) {
        if (!toolNames.includes(name)) throw new Error(`unknown tool ${name}`)
        if (scopeLocal.has(name)) throw new Error(`scope-local names fail: ${name}`)
      }
      const rec = { filter, disposed: 0 }
      calls.push(rec)
      live = rec
      return () => { rec.disposed += 1 }
    },
    get(name) {
      return toolNames.includes(name) ? { name } : undefined
    },
    schemas() { return toolNames.map((name) => ({ name })) },
    definitions() { return toolNames.map((name) => ({ name })) },
  }
  return { agent: { ctx: { tools } }, calls, get live() { return live } }
}

// ---------------------------------------------------------------- 跑

const ctx = makeCtx()
await mod.apply(ctx, { dataDir: path.join(tmp, 'data') })

const call = async (name, args, agent) => {
  const def = ctx.registered.get(name)
  assert.ok(def, `工具 ${name} 没注册`)
  const exec = agent ? { agent: agent.agent } : {}
  const out = await def.execute(args || {}, exec)
  return out.text
}

const TOOLS = ['cv_learn', 'cv_recall', 'cv_act', 'audio_probe', 'audio_speech',
  'image_generate', 'independent_input', 'read_file']

// 1) scan 应该发现工具、按前缀归组
const a1 = makeAgent(TOOLS)
const scanText = await call('scene_scan', {}, a1)
assert.match(scanText, /新增 \d+ 个/, 'scan 应报新增')
const packs = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'packs.json'), 'utf8'))
for (const t of ['cv_learn', 'cv_recall', 'cv_act', 'audio_probe', 'audio_speech', 'image_generate']) {
  assert.ok(packs.managed.includes(t), `${t} 应进受管清单`)
}
assert.ok(!packs.managed.includes('read_file'), '普通工具不该被自动纳入受管')

// 2) gaming：cv 留、audio/image 掩
const switchText = await call('scene_switch', { scene: 'gaming' }, a1)
const gaming = a1.calls.at(-1).filter.deny
assert.ok(gaming.includes('audio_probe'), 'gaming 应掩 audio_probe')
assert.ok(gaming.includes('audio_speech'), 'gaming 应掩 audio_speech')
assert.ok(gaming.includes('image_generate'), 'gaming 应掩 image_generate')
assert.ok(!gaming.includes('cv_recall'), 'gaming 不该掩 cv_recall')
assert.ok(!gaming.some((n) => n.startsWith('scene_')), '永不屏蔽 scene_*')
assert.match(switchText, /deny \d+ 个/)

// 3) chat：cv 也掩
await call('scene_switch', { scene: 'chat' }, a1)
const chat = a1.calls.at(-1).filter.deny
assert.ok(chat.includes('cv_recall'), 'chat 应掩 cv_recall')
assert.ok(chat.includes('cv_learn'), 'chat 应掩 cv_learn')

// 4) 切回来时，旧掩码要被撤销且只撤一次
const before = a1.calls.length
await call('scene_switch', { scene: 'gaming' }, a1)
const prev = a1.calls[before - 1]
assert.equal(prev.disposed, 1, '上一次的掩码应被撤销且只撤一次')

// 5) full：什么都不掩（不发新掩码，但旧的必须撤掉）
const beforeFull = a1.calls.length
const prevGaming = a1.calls.at(-1)
await call('scene_switch', { scene: 'full' }, a1)
assert.equal(a1.calls.length, beforeFull, 'full 不该发新掩码')
assert.equal(prevGaming.disposed, 1, '切到 full 时上一个掩码要被撤销')

// 6) 作用域内的工具名：跳过 + 警告，不整体失败
const a2 = makeAgent([...TOOLS, 'office_doc'], { scopeLocal: ['office_doc'] })
await call('scene_scan', {}, a2)
let p2 = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'packs.json'), 'utf8'))
if (!p2.managed.includes('office_doc')) p2.managed.push('office_doc')
fs.writeFileSync(path.join(tmp, 'data', 'packs.json'), JSON.stringify(p2, null, 2))
const t6 = await call('scene_switch', { scene: 'chat' }, a2)
assert.match(t6, /警告/, '作用域内工具应给警告')
assert.ok(!a2.calls.at(-1).filter.deny.includes('office_doc'), '作用域内工具不该进 deny')

// 7) 未知场景要报错，而不是默默什么都不做
const t7 = await call('scene_switch', { scene: '不存在的场景' }, a1)
assert.match(t7, /没有这个场景/, '未知场景应明确报错')

// 8) scene_assign：归组并写回；none 表示移除
await call('scene_assign', { tool: 'independent_input', scene: 'gaming' })
packs.managed.length = 0
Object.assign(packs, JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'packs.json'), 'utf8')))
assert.ok(packs.managed.includes('independent_input'), 'assign 应写进受管')
assert.ok(packs.scenes.gaming.allowed.includes('independent_input'), 'assign 应写进场景允许')
await call('scene_assign', { tool: 'independent_input', scene: 'none' })
const p3 = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'packs.json'), 'utf8'))
assert.ok(!p3.managed.includes('independent_input'), 'scene=none 应从受管移除')

console.log('✓ 8 组断言全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
