// 场景工具包（scene-packs）
//
// 做什么：给「当前这个 agent」继承来的全局工具加一层 deny 掩码，让工具表只留下本场景要用的。
// 为什么这么实现（2026-11-25 实测）：
//   · 宿主 ctx 上调 ctx.tools.restrict 会被拒：a context-global restriction would mask every agent
//   · 必须从 exec.agent.ctx.tools 调 —— 那样只影响这一个会话，撤销即恢复
//   · restrict 是叠加的（交集），所以切换前必须先 dispose 旧掩码，永远只留一个
//   · 只能屏蔽「全局继承」的工具名；preset 里的（fs/web/bash/office…）传进去会报 scope-local
//
// 不变量（代码里保证，不靠调用方）：
//   1. 每个 agent 最多一个掩码，切之前先撤
//   2. 永远不 deny 自己（scene_* 前缀）
//   3. 未知名字 / 作用域内名字 不进 deny 名单，只记警告
//   4. deny 语义：没归组 = 仍然可见 = 不会因为漏配砍掉必需品
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'scene-packs'
export const inject = ['tools']

const DEFAULT_DIR = path.join(os.homedir(), '.dsh', 'scene-packs')
const SELF_PREFIX = 'scene_'

// agent -> { scene, dispose(restriction) }
// 为什么挂在 globalThis 而不是模块内：插件重载会换一份模块实例，模块内的 Map 随之消失，
// 而掩码还挂在 agent 上 —— 句柄丢了就再也撤不掉（实测：重载后 cv_learn 一直是 unknown tool）。
// 挂在进程级 globalThis 上，重载后还能拿到同一批句柄，一次全撤。
const live = (globalThis.__dshScenePacks ||= new Map())

let dataDir = DEFAULT_DIR
let log = () => {}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------- 数据文件

function paths() {
  return {
    packs: path.join(dataDir, 'packs.json'),
    inventory: path.join(dataDir, 'inventory.json'),
  }
}

// 场景表：scenes[名字] = { allowed: [工具名或前缀*], note }
// 只写"允许什么"，deny 由「受管工具 − 允许」算出来。
const DEFAULT_PACKS = {
  version: 1,
  // 受管的工具名（只放全局继承的；preset 里的放进来会被跳过并警告）
  managed: [],
  // 前缀 → 场景：没登记的工具靠它猜归属
  prefixes: {
    'cv_': 'gaming',
    'audio_': 'media',
    'image_': 'media',
  },
  scenes: {
    chat: { allowed: [], note: '只聊天：第三方工具全关' },
    coding: { allowed: ['audio_probe', 'audio_status'], note: '写代码' },
    media: { allowed: ['audio_*', 'image_*'], note: '看视频/音频/画图' },
    gaming: { allowed: ['cv_*', 'independent_input'], note: '玩游戏' },
    full: { allowed: ['*'], note: '全开（排障/未知场景）' },
  },
  defaultScene: 'chat',
}

function loadPacks() {
  const { packs } = paths()
  const raw = readJson(packs, null)
  if (!raw) {
    writeJson(packs, DEFAULT_PACKS)
    return structuredClone(DEFAULT_PACKS)
  }
  // 字段缺了补默认，别让手改坏一个字段就整份失效
  return {
    version: raw.version || 1,
    managed: Array.isArray(raw.managed) ? raw.managed : [],
    prefixes: raw.prefixes && typeof raw.prefixes === 'object' ? raw.prefixes : {},
    scenes: raw.scenes && typeof raw.scenes === 'object' ? raw.scenes : structuredClone(DEFAULT_PACKS.scenes),
    defaultScene: raw.defaultScene || 'chat',
  }
}

function loadInventory() {
  return readJson(paths().inventory, { version: 1, tools: {} })
}

function saveInventory(inv) {
  writeJson(paths().inventory, inv)
}

// ---------------------------------------------------------------- 工具归属

function prefixScene(name, prefixes) {
  let best = null
  for (const [p, scene] of Object.entries(prefixes || {})) {
    if (name.startsWith(p) && (!best || p.length > best.p.length)) best = { p, scene }
  }
  return best ? best.scene : null
}

// 本场景允许哪些工具（展开通配）
function allowedFor(sceneName, packs) {
  const scene = packs.scenes[sceneName]
  if (!scene) return null
  const out = new Set()
  for (const entry of scene.allowed || []) {
    if (entry === '*') return new Set(['*'])
    if (entry.endsWith('*')) {
      const pre = entry.slice(0, -1)
      for (const tool of packs.managed) if (tool.startsWith(pre)) out.add(tool)
    } else {
      out.add(entry)
    }
  }
  return out
}

// 算出需要屏蔽的名字。返回 { deny, warn }
function computeDeny(sceneName, packs, agentTools) {
  const allowed = allowedFor(sceneName, packs)
  if (!allowed) throw new Error(`没有这个场景：${sceneName}（已有：${Object.keys(packs.scenes).join(', ')}）`)
  if (allowed.has('*')) return { deny: [], warn: [] }

  const warn = []
  const deny = []
  for (const tool of packs.managed) {
    if (tool.startsWith(SELF_PREFIX)) continue // 不变量 2：永不屏蔽自己
    if (allowed.has(tool)) continue
    // 前缀规则兜底：没登记的按前缀猜，猜不到就保留（deny 语义下最安全）
    if (!packs.managed.includes(tool)) continue
    // 只屏蔽真实存在的
    if (agentTools && typeof agentTools.get === 'function' && !agentTools.get(tool)) {
      warn.push(`${tool} 现在不存在，跳过`)
      continue
    }
    deny.push(tool)
  }
  return { deny, warn }
}

// ---------------------------------------------------------------- 清单维护

// 从 agent 作用域读当前「可见」的工具名。
// 注意：definitions() 返回的是已注册的（不扣掩码），schemas() 才是可见的。
// 2026-11-25 实测：用 definitions 回读会骗人——它报 cv_learn 还在，实际调用已经 unknown tool。
function visibleNames(agentTools) {
  const read = (fn) => {
    try {
      const defs = fn?.call(agentTools)
      if (!Array.isArray(defs) || !defs.length) return null
      const names = defs.map((d) => (typeof d === 'string' ? d : d?.name)).filter(Boolean)
      return names.length ? names : null
    } catch {
      return null
    }
  }
  return read(agentTools?.schemas) || read(agentTools?.definitions)
}

// 探测某个名字是不是「全局继承」的工具：能单独给它下掩码就是。
// 判断完立刻撤销，不留痕。
function isGlobalTool(agentTools, name) {
  if (!agentTools || typeof agentTools.restrict !== 'function') return null
  if (name.startsWith(SELF_PREFIX)) return true
  let dispose = null
  try {
    dispose = agentTools.restrict({ deny: [name] })
    return true
  } catch (err) {
    const msg = String(err?.message || err)
    if (/scope-local|unknown/i.test(msg)) return false
    return null
  } finally {
    try {
      dispose?.()
    } catch { /* ignore */ }
  }
}

// 全量对账：把看到的工具写进 inventory（新增的按前缀猜归属）
function reconcile(agentTools, packs) {
  const inv = loadInventory()
  const names = visibleNames(agentTools)
  const added = []
  const scanned = names || []
  for (const n of scanned) {
    if (n.startsWith(SELF_PREFIX)) continue
    const rec = inv.tools[n]
    if (!rec) {
      const guess = prefixScene(n, packs.prefixes)
      inv.tools[n] = {
        firstSeen: new Date().toISOString(),
        guess: guess || null,
        assigned: null,
        global: isGlobalTool(agentTools, n),
      }
      added.push(n)
      if (guess && !packs.managed.includes(n)) packs.managed.push(n)
    }
  }
  if (added.length) {
    writeJson(paths().packs, packs)
    saveInventory(inv)
  }
  return { added, count: scanned.length, scanned: scanned.length > 0 }
}

// ---------------------------------------------------------------- 插件入口

export async function apply(ctx, config = {}) {
  dataDir = (config && config.dataDir) || DEFAULT_DIR
  fs.mkdirSync(dataDir, { recursive: true })

  // 每次装载先全撤：宁可"多出工具"，也不能留下撤不掉的掩码。
  for (const [, rec] of live) {
    try { rec?.dispose?.() } catch { /* ignore */ }
  }
  live.clear()
  log = (m) => {
    try {
      ctx.logger?.info?.(`[scene-packs] ${m}`)
    } catch { /* ignore */ }
  }

  const defineTool = async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-tools')
      if (mod?.defineTool) return mod.defineTool
    } catch { /* fall through */ }
    return (d) => d
  }

  // 工具表变化时自动对账（装新插件、升级加工具都在这里被发现）
  // 工具表变化（装新插件 / 包升级加工具）时记一笔，等下一次 scene_scan 对账。
  // 这里拿不到 agent 上下文，所以只记「什么时候变过」，不猜归属。
  try {
    let pending = 0
    ctx.on('tools/change', () => {
      pending += 1
      log(`tools/change x${pending}`)
    })
  } catch { /* 事件订阅失败不影响工具本身 */ }

  const dT = await defineTool()

  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
    render: (_a, v) => [{ type: 'text', text: v.text }],
  }

  const base = {
    parameters: {},
    output,
    timeoutMs: 20000,
  }

  // ---- scene_list
  ctx.tools.register(dT({
    ...base,
    name: 'scene_list',
    description: '列出所有场景、每个场景允许的工具、受管工具清单，以及本会话当前是哪个场景。',
    async execute(_args, exec = {}) {
      const packs = loadPacks()
      const inv = loadInventory()
      const cur = live.get(exec?.agent)?.scene || '(未设)'
      const lines = [`当前场景：${cur}`]
      for (const [name, scene] of Object.entries(packs.scenes)) {
        lines.push(`· ${name}: ${(scene.allowed || []).join(', ') || '（全关）'}${scene.note ? `  — ${scene.note}` : ''}`)
      }
      // 清单里还没归组的（前缀猜不出、也没手动指定过）
      const unassigned = Object.entries(inv.tools)
        .filter(([, rec]) => !rec.guess && !rec.assigned)
        .map(([name]) => name)
      lines.push(`受管工具 ${packs.managed.length} 个；清单里未归组 ${unassigned.length} 个`)
      if (unassigned.length) lines.push(`未归组：${unassigned.join(', ')}（用 scene_assign 归类）`)

      return { text: lines.join('\n') }
    },
  }))

  // ---- scene_now
  ctx.tools.register(dT({
    ...base,
    name: 'scene_now',
    description: '回读确认：本会话现在实际可见的工具（不是我以为的）。切换后用它对账。',
    async execute(_args, exec = {}) {
      const agent = exec?.agent
      const agentTools = agent?.ctx?.tools
      const cur = live.get(agent)?.scene || '(未设)'
      if (!agentTools) return { text: `场景：${cur}\n拿不到 agent 作用域，这次没证据。` }

      // 2026-11-25 实测：definitions() 和 schemas() 都会把被掩掉的工具报成"还在"，
      // 只有 get(name, scope) 会读成不存在（文档原话：a restricted-away global reads as absent）。
      const packs = loadPacks()
      const rows = []
      for (const t of packs.managed.slice(0, 40)) {
        let visible = '?'
        try {
          visible = agentTools.get(t, agent) ? '在' : '被掩'
        } catch (err) {
          visible = `查不了(${String(err?.message || err).slice(0, 40)})`
        }
        rows.push(`${t}=${visible}`)
      }
      const hidden = rows.filter((r) => r.endsWith('=被掩')).length
      return {
        text: [
          `场景：${cur}`,
          `受管 ${rows.length} 个，其中被掩 ${hidden} 个`,
          rows.join('  '),
          '（这条是 get(name,scope) 读的；我实际能看到什么，最终以"调用会不会 unknown tool"为准）',
        ].join('\n'),
      }
    },
  }))

  // ---- scene_switch
  ctx.tools.register(dT({
    ...base,
    name: 'scene_switch',
    description: '切换场景：先撤掉本会话上一个掩码，再按「受管工具 − 本场景允许」下新的 deny 掩码。只影响当前会话。',
    parameters: {
      scene: { type: 'string', required: true, description: '场景名（见 scene_list）' },
    },
    async execute(args = {}, exec = {}) {
      const sceneName = String(args.scene || '')
      const agent = exec?.agent
      const agentTools = agent?.ctx?.tools
      if (!agentTools) return { text: '拿不到 agent 作用域，没动。' }

      const packs = loadPacks()
      // 不变量 1：先撤旧的
      const prev = live.get(agent)
      let prevText = ''
      if (prev?.dispose) {
        try {
          prev.dispose()
          prevText = `（已撤掉上一个场景 ${prev.scene} 的掩码）`
        } catch (err) {
          return { text: `撤销旧掩码失败，没继续：${err?.message || err}` }
        }
      }

      let deny = []
      let warn = []
      try {
        const r = computeDeny(sceneName, packs, agentTools)
        deny = r.deny
        warn = r.warn
      } catch (err) {
        return { text: String(err?.message || err) }
      }

      let dispose = null
      if (deny.length) {
        try {
          dispose = agentTools.restrict({ deny })
        } catch (err) {
          // 有名字不合法就逐个筛掉再试一次（不变量 3）
          const ok = []
          for (const n of deny) {
            const g = isGlobalTool(agentTools, n)
            if (g) ok.push(n)
            else warn.push(`${n} 不是全局工具，跳过`)
          }
          try {
            dispose = ok.length ? agentTools.restrict({ deny: ok }) : null
            deny = ok
          } catch (err2) {
            return { text: `下掩码失败：${err2?.message || err2}` }
          }
        }
      }

      live.set(agent, { scene: sceneName, dispose })
      const names = visibleNames(agentTools)
      return {
        text: [
          `切到 ${sceneName}${prevText}`,
          `掩码：deny ${deny.length} 个${deny.length ? `（${deny.join(', ')}）` : '（空，全可见）'}`,
          warn.length ? `警告：${warn.join('；')}` : '',
          names ? `回读：现在可见 ${names.length} 个工具` : '回读：读不到工具表',
        ].filter(Boolean).join('\n'),
      }
    },
  }))

  // ---- scene_scan
  ctx.tools.register(dT({
    ...base,
    name: 'scene_scan',
    description: '全量对账一次：读当前可见工具，新增的按前缀猜归属并写进清单，返回新增了哪些。装完新插件后跑一次。',
    async execute(_args, exec = {}) {
      const agentTools = exec?.agent?.ctx?.tools
      if (!agentTools) return { text: '拿不到 agent 作用域，没扫。' }
      const packs = loadPacks()
      const { added, count, scanned } = reconcile(agentTools, packs)
      if (!scanned) return { text: '读不到工具表，这次没扫到东西。' }
      return {
        text: [
          `扫到 ${count} 个工具；新增 ${added.length} 个${added.length ? `：${added.join(', ')}` : ''}`,
          added.length ? '已按前缀写进 managed（猜不到的留空，等你归类）' : '',
          `清单文件：${paths().inventory}`,
        ].filter(Boolean).join('\n'),
      }
    },
  }))

  // ---- scene_assign
  ctx.tools.register(dT({
    ...base,
    name: 'scene_assign',
    description: '把某个工具归到某场景（或从受管里移除）。写回 packs.json，手改也一样生效。',
    parameters: {
      tool: { type: 'string', required: true, description: '工具名' },
      scene: { type: 'string', description: '归到这个场景；给 none 表示从受管清单移除（永不被屏蔽）' },
    },
    async execute(args = {}) {
      const tool = String(args.tool || '')
      const scene = String(args.scene || '')
      if (!tool) return { text: '要给 tool。' }
      const packs = loadPacks()
      if (scene === 'none') {
        packs.managed = packs.managed.filter((t) => t !== tool)
        writeJson(paths().packs, packs)
        return { text: `${tool} 已从受管清单移除（以后不会被任何场景屏蔽）。` }
      }
      if (!packs.scenes[scene]) return { text: `没有这个场景：${scene}` }
      if (!packs.managed.includes(tool)) packs.managed.push(tool)
      const allowed = new Set(packs.scenes[scene].allowed || [])
      allowed.add(tool)
      packs.scenes[scene].allowed = [...allowed]
      writeJson(paths().packs, packs)
      return { text: `${tool} 已归到 ${scene}。下次 scene_switch 生效。` }
    },
  }))

  log(`ready, dataDir=${dataDir}`)
}
