#!/usr/bin/env node
/**
 * daily.mjs — 全自动日常主控脚本
 *
 * 职责：
 *   1. 判断本次开机时间是否落在凌晨 [03:00, 04:00) 窗口（不在窗口则静默退出）
 *   2. 挂载 30 分钟关机看门狗（防未知错误导致整夜开机）
 *   3. 启动 MAA.exe 与 MaaEnd.exe 并监听双方「全部任务完成」信号
 *   4. 双方均完成 → 立即关机；任何错误 → 执行预留的错误处理接口 → 依旧关机
 *
 * 用法：
 *   node daily.mjs                 正常运行（计划任务调用）
 *   node daily.mjs --force         跳过时间窗判定（调试用）
 *   node daily.mjs --dry-run       演练：不挂看门狗/不启动程序/不注入配置/不关机
 *   node daily.mjs --self-test     自检时间窗与完成判定逻辑
 *   node daily.mjs --window-test   打印本次开机时间与窗口判定
 *   node daily.mjs --maa-done      MAA「结束后脚本」回调入口（写完成标志后退出）
 *   node daily.mjs --help          帮助
 *
 * 错误处理接口（预留）：
 *   - 默认：写 ERROR 日志
 *   - 脚本同目录存在 errorHandler.mjs 且导出 handle(err, ctx) → 替换默认实现
 *   - config.json 的 onError.command 非空 → 以子进程执行（超时不阻塞关机）
 *   三层执行完毕后，无论结果如何都执行关机收尾。
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const LOG_DIR = path.join(__dirname, 'logs')
const STATE_DIR = path.join(__dirname, 'state')
const LOCK_FILE = path.join(STATE_DIR, 'lock.json')
const FLAG_FILE = path.join(STATE_DIR, 'maa_done.flag')

/* ============================== 默认配置 ============================== */

const DEFAULT_CONFIG = {
  window: {
    // 自定义多时间段：开机时间落入任一时间段（左闭右开）即触发；每段独立计算当前时刻上限
    slots: [
      { startHour: 3, endHour: 4 },
      { startHour: 7, endHour: 8 },
    ],
    nowGraceMin: 60,  // 每段的当前时刻上限宽限：now 必须 < 该段 endHour+此值（覆盖登录延迟；防晚登录/重登录时误执行）
  },
  paths: {
    maaExe: 'D:\\Program Files\\MAA\\MAA.exe',
    maaConfig: 'D:\\Program Files\\MAA\\config\\gui.new.json',
    maaLog: 'D:\\Program Files\\MAA\\debug\\gui.log',
    maaendExe: 'D:\\Program Files\\MaaEnd\\MaaEnd.exe',
  },
  watchdogSec: 1800,          // 判定通过后挂载的兜底关机（30 分钟）
  monitorTimeoutSec: 1500,    // 监测总时限；启动时会按预算链自动 clamp（ready+monitor+2×onError+60s < watchdogSec）
  readyTimeoutSec: 120,       // 两进程启动就绪上限
  maaReadyStableSec: 5,       // MAA 进程持续存活多久算启动成功
  shutdownGraceSec: 5,        // 关机前宽限（>0 时 shutdown 自动隐含 /f）
  pollIntervalMs: 2000,       // 信号轮询间隔
  heartbeatLogSec: 60,        // 监测心跳日志间隔
  maa: {
    injectPostRunScript: true, // 启动 MAA 前自动注入「结束后脚本」回调（仅当该配置为空）
  },
  maend: {
    portScan: [12701, 12702, 12703, 12704, 12705, 12706, 12707, 12708, 12709, 12710],
    wsEnabled: true,           // WebSocket tasks-completed 事件加速
  },
  onError: {
    command: '',               // 例如 "powershell" args: ["-File", "C:\\...\\my-alert.ps1"]
    args: [],
    timeoutSec: 60,
  },
}

function mergeDeep(base, over) {
  if (over === null || over === undefined) return base
  if (typeof base !== 'object' || Array.isArray(base)) return over
  if (typeof over !== 'object' || Array.isArray(over)) return over
  const out = { ...base }
  for (const k of Object.keys(over)) out[k] = mergeDeep(base?.[k], over[k])
  return out
}

let cfg = DEFAULT_CONFIG

/** 配置节类型规约：整节被写成标量/数组时回退默认对象（否则严格模式赋值抛 TypeError 会炸掉自诊断入口） */
function coerceSection(c, key, quiet = false) {
  const d = DEFAULT_CONFIG[key]
  if (!c[key] || typeof c[key] !== 'object' || Array.isArray(c[key])) {
    if (!quiet) log('WARN', 'config', `配置节 ${key}=${JSON.stringify(c[key])} 不是对象，整节回退默认值`)
    c[key] = structuredClone(d)
  }
}

/**
 * 数值字段校验 + 看门狗预算链收敛（防手改 config 笔误导致
 * 「关机命令失败→整夜开机」「预算为负→秒级误超时腰斩任务」「错误处理被看门狗抢断」）
 * quiet=true 供 --self-test 合成用例使用：合成 WARN 不写入当日生产日志，避免误导排障。
 */
function validateConfig(c, quiet = false) {
  const W = (msg) => { if (!quiet) log('WARN', 'config', msg) }
  const E = (msg) => { if (!quiet) log('ERROR', 'config', msg) }
  for (const k of ['window', 'paths', 'maa', 'maend', 'onError']) coerceSection(c, k, quiet)
  if (!Array.isArray(c.maend.portScan) || c.maend.portScan.length === 0 ||
      c.maend.portScan.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) {
    W(`maend.portScan=${JSON.stringify(c.maend.portScan)} 非法（须为非空端口数组），回退默认 12701-12710`)
    c.maend.portScan = [...DEFAULT_CONFIG.maend.portScan]
  }
  if (typeof c.onError.command !== 'string') { W('onError.command 不是字符串，置空'); c.onError.command = '' }
  if (!Array.isArray(c.onError.args)) { W(`onError.args=${JSON.stringify(c.onError.args)} 不是数组，置空`); c.onError.args = [] }

  const intOf = (v, dflt, min, max, key) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) {
      W(`配置 ${key}=${JSON.stringify(v)} 非法，回退默认值 ${dflt}`)
      return dflt
    }
    return v
  }
  c.watchdogSec = intOf(c.watchdogSec, DEFAULT_CONFIG.watchdogSec, 60, 86400, 'watchdogSec')
  c.readyTimeoutSec = intOf(c.readyTimeoutSec, DEFAULT_CONFIG.readyTimeoutSec, 10, 600, 'readyTimeoutSec')
  c.maaReadyStableSec = intOf(c.maaReadyStableSec, DEFAULT_CONFIG.maaReadyStableSec, 1, 60, 'maaReadyStableSec')
  c.shutdownGraceSec = intOf(c.shutdownGraceSec, DEFAULT_CONFIG.shutdownGraceSec, 0, 3600, 'shutdownGraceSec')
  c.pollIntervalMs = intOf(c.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 500, 10000, 'pollIntervalMs')
  c.heartbeatLogSec = intOf(c.heartbeatLogSec, DEFAULT_CONFIG.heartbeatLogSec, 10, 3600, 'heartbeatLogSec')
  c.onError.timeoutSec = intOf(c.onError.timeoutSec, DEFAULT_CONFIG.onError.timeoutSec, 1, 600, 'onError.timeoutSec')
  c.window.nowGraceMin = intOf(c.window.nowGraceMin, DEFAULT_CONFIG.window.nowGraceMin, 0, 720, 'window.nowGraceMin')
  const slotBad = s => !s || typeof s !== 'object' || Array.isArray(s) ||
    !Number.isInteger(s.startHour) || s.startHour < 0 || s.startHour > 23 ||
    !Number.isInteger(s.endHour) || s.endHour < 1 || s.endHour > 24 ||
    !(s.startHour < s.endHour)
  if (!Array.isArray(c.window.slots) || c.window.slots.length === 0 || c.window.slots.length > 6 ||
      c.window.slots.some(slotBad)) {
    W(`window.slots=${JSON.stringify(c.window.slots)} 非法（须为 1-6 个时间段对象 {startHour,endHour}，start<end），回退默认 [3-4, 7-8]`)
    c.window.slots = structuredClone(DEFAULT_CONFIG.window.slots)
  }
  delete c.window.startHour // 清理旧单窗口格式残留，避免误读
  delete c.window.endHour

  // 预算链逐级收敛：cap = watchdog - ready - 2×onError - 60s 余量，必须 ≥60。
  // 任一级不满足就按 watchdog → ready → onError 的顺序回退该项到默认（默认组合 1800-120-120-60=1500 恒有解），
  // 彻底杜绝 cap 为负导致 monitorTimeoutSec 被 clamp 成「过去的时间 → 首轮即超时腰斩任务」。
  const cap = () => c.watchdogSec - c.readyTimeoutSec - c.onError.timeoutSec * 2 - 60
  if (cap() < 60 && c.watchdogSec !== DEFAULT_CONFIG.watchdogSec) {
    W(`watchdogSec=${c.watchdogSec} 无法覆盖就绪+错误处理预算，回退默认 1800`); c.watchdogSec = DEFAULT_CONFIG.watchdogSec
  }
  if (cap() < 60 && c.readyTimeoutSec !== DEFAULT_CONFIG.readyTimeoutSec) {
    W(`readyTimeoutSec=${c.readyTimeoutSec} 挤占预算，回退默认 120`); c.readyTimeoutSec = DEFAULT_CONFIG.readyTimeoutSec
  }
  if (cap() < 60 && c.onError.timeoutSec !== DEFAULT_CONFIG.onError.timeoutSec) {
    W(`onError.timeoutSec=${c.onError.timeoutSec} 挤占预算，回退默认 60`); c.onError.timeoutSec = DEFAULT_CONFIG.onError.timeoutSec
  }
  if (cap() < 60) {
    // 默认组合仍有问题 → 配置已被深度改坏，整体回退默认
    E('配置组合无解（预算链），整体回退内置默认值')
    Object.assign(c, structuredClone(DEFAULT_CONFIG))
    for (const k of ['window', 'paths', 'maa', 'maend', 'onError']) coerceSection(c, k, quiet)
  }
  c.monitorTimeoutSec = intOf(c.monitorTimeoutSec, DEFAULT_CONFIG.monitorTimeoutSec, 60, 86400, 'monitorTimeoutSec')
  if (c.monitorTimeoutSec > cap()) {
    W(`monitorTimeoutSec=${c.monitorTimeoutSec} 越过看门狗预算上限 ${cap()}，已 clamp（保证错误处理先于看门狗完成）`)
    c.monitorTimeoutSec = cap()
  }
  // 终检：clamp 结果不得低于下界（防御任何未预见的组合）
  if (c.monitorTimeoutSec < 60) { c.monitorTimeoutSec = DEFAULT_CONFIG.monitorTimeoutSec; W('monitorTimeoutSec 收敛异常，回退默认 1500') }
}

function loadConfig() {
  const p = path.join(__dirname, 'config.json')
  let parsed = null
  try {
    const raw = fs.readFileSync(p, 'utf8')
    parsed = JSON.parse(raw)
  } catch (e) {
    if (e.code === 'ENOENT') log('WARN', 'config', 'config.json 不存在，使用内置默认值')
    else log('ERROR', 'config', `config.json 无法解析，回退内置默认值：${e.message}`)
  }
  try {
    cfg = mergeDeep(structuredClone(DEFAULT_CONFIG), parsed || {})
    validateConfig(cfg)
  } catch (e) {
    // validateConfig 自身异常（未预见的类型组合）→ 整体回退默认，绝不让配置问题炸掉主流程/自诊断
    log('ERROR', 'config', `配置校验异常，整体回退内置默认值：${e.message}`)
    cfg = structuredClone(DEFAULT_CONFIG)
  }
}

/* ============================== 基础工具 ============================== */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function ts() {
  const d = new Date(); const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
function logFileFor() {
  const d = new Date(); const p = n => String(n).padStart(2, '0')
  return path.join(LOG_DIR, `daily-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`)
}
let logQueue = Promise.resolve()
function log(level, stage, msg) {
  const line = `${ts()} [${level}] [${stage}] ${msg}`
  try { console.log(line) } catch { /* 无控制台时忽略 */ }
  logQueue = logQueue
    .then(() => fsp.mkdir(LOG_DIR, { recursive: true }))
    .then(() => fsp.appendFile(logFileFor(), line + '\n', 'utf8'))
    .catch(() => {})
}
async function flushLog() { try { await logQueue } catch { /* ignore */ } }

function parseIsoStrict(s) {
  if (!s || s === 'NA') return null
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/)
  if (!m) return null
  const frac = (m[2] || '0').slice(0, 3).padEnd(3, '0')
  const d = new Date(`${m[1]}.${frac}${m[3]}`)
  return isNaN(d) ? null : d
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function isProcessRunning(name) {
  try {
    const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { encoding: 'utf8', timeout: 10000 })
    if (!r.error) {
      const out = ((r.stdout || '') + (r.stderr || '')).toLowerCase()
      if (out.includes(name.toLowerCase())) return true
      if (out.trim()) return false // tasklist 正常给出了「无匹配」类输出
    }
  } catch { /* fallthrough */ }
  // tasklist 失败/结果不明 → PowerShell Get-Process 兜底一次
  try {
    const base = name.replace(/\.exe$/i, '')
    const r2 = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process -Name '${base}' -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`],
      { encoding: 'utf8', timeout: 10000 })
    if (!r2.error && r2.status === 0) {
      const t = String(r2.stdout || '').trim()
      if (t.includes('YES')) return true
      if (t.includes('NO')) return false
    }
  } catch { /* ignore */ }
  return null // 仍未知
}

function withTimeout(promise, ms, tag) {
  let timer
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${tag} 超时 ${ms}ms`)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/* ============================== 单实例锁 ============================== */

/** 当日已执行标志：每个自然日至多完整执行一轮（防同日多次登录/手动重跑重复挂看门狗并关机） */
function ranFlagPath() {
  const d = new Date(); const p = n => String(n).padStart(2, '0')
  return path.join(STATE_DIR, `ran-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`)
}
function checkRanToday() {
  try {
    const old = JSON.parse(fs.readFileSync(ranFlagPath(), 'utf8'))
    return old || null
  } catch { return null }
}
function markRanToday(boot) {
  try {
    const p = ranFlagPath()
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ boot: boot ? boot.toISOString() : null, at: ts(), pid: process.pid }, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    return true
  } catch (e) { log('WARN', 'lock', `写入当日执行标志失败: ${e.message}`); return false }
}

async function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  let old = null
  try { old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) } catch { old = null }
  if (old && old.pid && old.pid !== process.pid) {
    // 时效校验：合法存活上限 = 任务强杀45min + 看门狗30min + 余量 ≈ 90min；超时的锁一律视为陈旧
    const startedMs = old.startedAt ? Date.parse(old.startedAt) : NaN
    const staleByAge = !Number.isFinite(startedMs) || (Date.now() - startedMs) > 90 * 60000
    if (!staleByAge && pidAlive(old.pid)) {
      log('INFO', 'lock', `检测到活动实例 pid=${old.pid}（${old.startedAt || '?'}），本实例退出，不重复执行`)
      await flushLog(); process.exit(0)
    }
    log('WARN', 'lock', `清除陈旧锁 pid=${old.pid} startedAt=${old.startedAt || '?'}${staleByAge ? '（超90min时效）' : '（PID已不存在）'}`)
  }
  // O_EXCL 原子创建；EEXIST 时二次校验（内容不可解析可能是对方「已创建未写入」的亚毫秒窗口 → 退避重读，不盲删）
  const readLock = () => { try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) } catch { return null } }
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx')
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: ts() }, null, 2))
      fs.closeSync(fd)
      return
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let now = readLock()
      if (!now) { await sleep(100); now = readLock() } // 空文件窗口：退避后重读
      if (!now) { try { fs.rmSync(LOCK_FILE, { force: true }) } catch { /* ignore */ }; continue }
      if (now.pid === process.pid) return // 自己刚写入（异常路径）
      if (pidAlive(now.pid)) { log('INFO', 'lock', `并发实例已持锁 pid=${now.pid}，本实例退出`); await flushLog(); process.exit(0) }
      try { fs.rmSync(LOCK_FILE, { force: true }) } catch { /* ignore */ }
    }
  }
  throw new Error('无法获取单实例锁')
}
function releaseLock() { try { fs.rmSync(LOCK_FILE, { force: true }) } catch { /* ignore */ } }

/* ============================== 时间窗判定 ============================== */

/** 读取开机时间：CIM.LastBootUpTime + 系统事件 6005（两者交叉校验，防快速启动/过期值） */
function getBootTimes() {
  const script =
    "try{$b=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime;Write-Output ('CIM='+$b.ToString('o'))}catch{Write-Output 'CIM=NA'};" +
    "try{$e=(Get-WinEvent -FilterHashtable @{LogName='System';Id=6005} -MaxEvents 1).TimeCreated;Write-Output ('EVT='+$e.ToString('o'))}catch{Write-Output 'EVT=NA'}"
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 20000 })
  const out = { cim: null, evt: null }
  if (r.error || r.status !== 0) return out
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('CIM=')) out.cim = parseIsoStrict(line.slice(4).trim())
    if (line.startsWith('EVT=')) out.evt = parseIsoStrict(line.slice(4).trim())
  }
  return out
}

/**
 * 多时间段窗口判定（纯函数，便于自检）。
 * 规则一：boot 落入任一时间段 [startHour:00, endHour:00)（左闭右开）且距今 ≤24h（下界允许 2h 内时钟回拨）。
 * 规则二：now < 命中段的 endHour:00 + nowGraceMin —— 防「开机后晚登录/白天重登录/手动重跑」
 *        时 boot 仍在段内而误执行全流程（会强制关掉用户正在使用的机器）。
 * CIM 与事件6005 差 ≤10 分钟 → 取较早者；差更大 → 信事件6005（CIM 可能过期）；
 * 全部不可用 → 回退用当前时间（≈开机时间，仅当此刻在窗口内才执行）。
 */
function decideWindow({ bootCim, bootEvt, now, slots = DEFAULT_CONFIG.window.slots, nowGraceMin = 60 }) {
  let boot = null, src = null
  const ok = d => d instanceof Date && !isNaN(d)
  if (ok(bootCim) && ok(bootEvt)) {
    if (Math.abs(bootEvt - bootCim) <= 10 * 60000) { boot = bootCim <= bootEvt ? bootCim : bootEvt; src = 'cim+evt' }
    else { boot = bootEvt; src = 'evt(stale-cim)' }
  } else if (ok(bootCim)) { boot = bootCim; src = 'cim' }
  else if (ok(bootEvt)) { boot = bootEvt; src = 'evt' }
  else { boot = now; src = 'now-fallback' }

  const age = now - boot
  const ageOk = age >= -2 * 3600 * 1000 && age <= 24 * 3600 * 1000 // 允许 2h 内时钟回拨
  const pad = h => String(h).padStart(2, '0')

  let hitSlot = null     // 完整命中（bootOk 且 nowOk）的时间段
  let bootSlot = null    // boot 落入但 now 超限的时间段（用于诊断日志）
  let bootSlotLimit = null
  if (ageOk) {
    for (const s of slots) {
      const w0 = new Date(now); w0.setHours(s.startHour, 0, 0, 0)
      const w1 = new Date(now); w1.setHours(s.endHour, 0, 0, 0)
      const nowLimit = new Date(w1); nowLimit.setMinutes(nowLimit.getMinutes() + nowGraceMin)
      if (boot >= w0 && boot < w1) {
        if (now < nowLimit) { hitSlot = s; break }
        if (!bootSlot) { bootSlot = s; bootSlotLimit = nowLimit }
      }
    }
  }
  const matchedBoot = !!(hitSlot || bootSlot)
  return {
    boot, bootSource: src, age,
    inWin: !!hitSlot,
    hitSlot, hitLabel: hitSlot ? `[${pad(hitSlot.startHour)}:00, ${pad(hitSlot.endHour)}:00)` : null,
    bootSlot, bootSlotLimit, matchedBoot,
    ageOk, slots,
  }
}

/* ============================== MAA 完成回调命令 ============================== */

function maaCallbackCmd() {
  // MAA ExecuteScript：以双引号开头的串被拆为 fileName + 其余参数；-noWindow 为 MAA 专用开关（无窗口执行）
  return `"${process.execPath}" "${__filename}" --maa-done -noWindow`
}

/* ============================== 进程启动 ============================== */

const exitInfo = { maa: null, maend: null }
let maaChild = null, maendChild = null
let maaSpawnAt = 0
/** 进程被复用或为「启动器交接」时无可靠 exit 事件可挂 → 记标志，监测循环里周期性 tasklist 探活 */
const reused = { maa: false, maend: false }

function spawnApp(name, exe) {
  if (!fs.existsSync(exe)) throw new Error(`${name} 可执行文件不存在: ${exe}`)
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(exe),
    windowsHide: false,
  })
  child.on('error', e => {
    exitInfo[name] = { code: -1, error: e.message, at: ts() }
    log('ERROR', 'launch', `${name} 启动异常: ${e.message}`)
  })
  child.on('exit', async (code, sig) => {
    // MaaEnd 是「启动器 stub」应用：spawn 出的进程拉起真实 GUI 进程（新 PID，父进程为
    // stub）后立即以 code=0 退出（实测 0.3~0.4s，2026-10-15 生产事故 + 独立复现双重确认）。
    // 故其 exit 事件本身不代表应用死亡——以「是否仍有 MaaEnd.exe 进程存活」为真相：
    //   存活/未知 → 视同交接成功，转周期探活（同复用路径，真实应用崩溃由探活兜底）
    //   三次复核（间隔 1s）均确认不存在 → 才记为真实退出（启动失败仍能快速进错误路径）
    if (name === 'maend') {
      for (let i = 0; i < 3; i++) {
        if (isProcessRunning('MaaEnd.exe') !== false) {
          log('INFO', 'proc', `MaaEnd 启动器进程已退出(code=${code})，真实应用仍在运行——转为周期探活`)
          reused.maend = true
          maendChild = null // stub PID 已无效，不再挂 exit 事件判定
          return
        }
        if (i < 2) await sleep(1000)
      }
      exitInfo[name] = { code, sig, at: ts() }
      log('WARN', 'proc', `${name} 进程退出 code=${code} sig=${sig || ''}（未检测到存活的 MaaEnd 进程）`)
      return
    }
    exitInfo[name] = { code, sig, at: ts() }
    log('WARN', 'proc', `${name} 进程退出 code=${code} sig=${sig || ''}`)
  })
  child.unref()
  return child
}

/* ============================== MaaEnd 端口与状态判定 ============================== */

async function probeMaaEndPort() {
  for (const p of cfg.maend.portScan) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/interface`, { signal: AbortSignal.timeout(800) })
      const t = await r.text()
      if (t.includes('backendOS')) return p
    } catch { /* 该端口未就绪，试下一个 */ }
  }
  return null
}

async function getJson(url, timeoutMs = 3000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/**
 * MaaEnd 完成判定（纯函数，便于自检）。
 * - 任一实例 running → 未完成
 * - 本轮见过 running 且全部实例终态（Succeeded/Failed）→ 完成
 * - overall_status 会保留上一轮结果，因此「没见过 running」时终态不算数（防启动即误判完成）
 */
function judgeMaaEnd(state, sawRunning) {
  const insts = state && state.instances ? Object.values(state.instances) : []
  if (!insts.length) return { kind: 'no-instances' }
  const running = insts.some(i => i && (i.is_running === true || i.task_run_state?.overall_status === 'Running'))
  if (running) return { kind: 'running' }
  const statuses = insts.map(i => i?.task_run_state?.overall_status ?? null)
  const allTerminal = statuses.length > 0 && statuses.every(s => s === 'Succeeded' || s === 'Failed')
  if (sawRunning && allTerminal) return { kind: 'done', failed: statuses.includes('Failed') }
  return { kind: 'waiting' }
}

/* ============================== 监测状态（模块级） ============================== */

const maa = { done: false, failed: false, via: null }          // MAA 完成态
const maaEnd = { done: false, failed: false, port: null, sawRunning: false }
let maaLogPos = 0
let maaLogDecoder = new StringDecoder('utf8')
let maaLogPending = ''
let wsObj = null
let wsRetryMs = 1000
let finalized = false

/* ---------- MAA 通道 A：flag 文件（PostRunScript 回调） ---------- */
function checkFlag() {
  if (!maa.done && fs.existsSync(FLAG_FILE)) {
    let detail = ''
    try { detail = fs.readFileSync(FLAG_FILE, 'utf8').trim() } catch { /* ignore */ }
    maa.done = true; maa.via = 'post-run-script'
    log('INFO', 'maa', `收到结束回调（PostRunScript 标志）${detail ? ' ' + detail : ''}`)
  }
}

/* ---------- MAA 通道 B：gui.log 增量尾随 ---------- */
function tailMaaLog() {
  const file = cfg.paths.maaLog
  try {
    const st = fs.statSync(file)
    if (maaLogPos < 0) { maaLogPos = st.size; return } // 基线恢复：以当前文件尾为基线，跳过已有历史内容（绝不全量匹配）
    if (st.size < maaLogPos) { // 文件被滚动/清空 → 以新文件尾为基线，只读此后的新内容
      maaLogPos = st.size
      maaLogPending = ''
      maaLogDecoder = new StringDecoder('utf8') // 丢弃旧文件的半截多字节残留
    }
    if (st.size > maaLogPos) {
      const fd = fs.openSync(file, 'r')
      try {
        const len = st.size - maaLogPos
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, maaLogPos)
        maaLogPos = st.size
        maaLogPending = (maaLogPending + maaLogDecoder.write(buf)).slice(-400)
        if (maaLogPending.includes('任务已全部完成')) {
          if (!maa.done) { maa.done = true; maa.via = 'gui.log'; log('INFO', 'maa', 'gui.log 出现「任务已全部完成」') }
        } else if (maaLogPending.includes('任务已结束，以下任务出现错误')) {
          if (!maa.done) { log('WARN', 'maa', 'gui.log 出现错误收尾「以下任务出现错误」') }
          maa.done = true; maa.failed = true; maa.via = 'gui.log-error'
        }
      } finally { fs.closeSync(fd) }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log('WARN', 'maa-log', `读取 gui.log 失败: ${e.message}`)
  }
}

/* ---------- MaaEnd 通道：state 轮询 ---------- */
async function pollMaaEnd(trigger) {
  if (maaEnd.done) return
  try {
    if (!maaEnd.port) {
      maaEnd.port = await probeMaaEndPort()
      if (!maaEnd.port) return
      log('INFO', 'maaend', `发现 web 端口 ${maaEnd.port}（触发: ${trigger}）`)
      startWs()
    }
    const st = await getJson(`http://127.0.0.1:${maaEnd.port}/api/maa/state`)
    const j = judgeMaaEnd(st, maaEnd.sawRunning)
    if (j.kind === 'running') {
      if (!maaEnd.sawRunning) { maaEnd.sawRunning = true; log('INFO', 'maaend', '观测到任务运行中（is_running=true）') }
    } else if (j.kind === 'done') {
      maaEnd.done = true
      maaEnd.failed = !!j.failed
      log(j.failed ? 'WARN' : 'INFO', 'maaend',
        `全部任务已结束，overall_status 终态=${j.failed ? 'Failed（含失败/被停止）' : 'Succeeded'}`)
    }
  } catch (e) {
    if (trigger !== 'poll') log('WARN', 'maaend', `state 查询失败(${trigger}): ${e.message}`)
  }
}

/* ---------- MaaEnd WebSocket 加速通道 ---------- */
function startWs() {
  if (!cfg.maend.wsEnabled || !maaEnd.port || finalized || wsObj) return
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${maaEnd.port}/api/ws`)
    wsObj = ws
    ws.addEventListener('message', async ev => {
      try {
        const m = JSON.parse(String(ev.data))
        if (m.type === 'state-changed' && m.payload && m.payload.kind === 'tasks-completed') {
          if (!maaEnd.done) { log('INFO', 'maaend-ws', '收到 tasks-completed 事件，立即复核 state'); await pollMaaEnd('ws') }
        }
      } catch { /* 非 JSON 或无关消息，忽略 */ }
    })
    ws.addEventListener('open', () => { wsRetryMs = 1000; log('INFO', 'maaend-ws', 'WebSocket 已连接') })
    ws.addEventListener('close', () => {
      wsObj = null
      if (finalized || maaEnd.done) return
      log('WARN', 'maaend-ws', `连接关闭，${wsRetryMs}ms 后重连`)
      setTimeout(() => { if (!finalized) startWs() }, wsRetryMs)
      wsRetryMs = Math.min(wsRetryMs * 2, 30000)
    })
    ws.addEventListener('error', () => { /* close 事件会随后触发 */ })
  } catch (e) {
    wsObj = null
    log('WARN', 'maaend-ws', `WebSocket 创建失败: ${e.message}`)
  }
}
function closeWs() { try { if (wsObj) wsObj.close() } catch { /* ignore */ } }

/* ============================== MAA 配置注入 ============================== */

function injectPostRunScript() {
  if (!cfg.maa.injectPostRunScript) { log('INFO', 'inject', '已禁用 PostRunScript 自动注入'); return }
  if (flags.dryRun) { log('DRY ', 'inject', `[dry-run] 若 PostRunScript 为空则注入: ${maaCallbackCmd()}`); return }
  try {
    const raw = fs.readFileSync(cfg.paths.maaConfig, 'utf8')
    const j = JSON.parse(raw)
    const rs = j?.Configurations?.Default?.Gui?.RuntimeSettings
    if (!rs || !Object.prototype.hasOwnProperty.call(rs, 'PostRunScript')) {
      throw new Error('未找到 Configurations.Default.Gui.RuntimeSettings.PostRunScript')
    }
    const cur = String(rs.PostRunScript || '')
    if (cur.includes('--maa-done')) { log('INFO', 'inject', 'PostRunScript 已含本脚本回调，无需修改'); return }
    if (cur.trim() !== '') {
      log('WARN', 'inject', `PostRunScript 已有用户配置，不覆盖：${cur.slice(0, 100)}；将依赖 gui.log 通道`)
      return
    }
    const bak = cfg.paths.maaConfig + '.bak-dailyauto'
    if (!fs.existsSync(bak)) {
      // 备份也走 tmp+rename：防止 copy 中途崩溃留下半份 JSON 恢复出损坏配置
      const btmp = bak + '.tmp'
      fs.copyFileSync(cfg.paths.maaConfig, btmp)
      fs.renameSync(btmp, bak)
    }
    rs.PostRunScript = maaCallbackCmd()
    const tmp = cfg.paths.maaConfig + '.tmp-dailyauto'
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8')
    fs.renameSync(tmp, cfg.paths.maaConfig)
    log('INFO', 'inject', `已注入结束后脚本回调（原配置已备份为 ${path.basename(bak)}）: ${maaCallbackCmd()}`)
  } catch (e) {
    log('WARN', 'inject', `PostRunScript 注入失败（${e.message}）；将依赖 gui.log 通道兜底`)
  }
}

/* ============================== 看门狗与关机 ============================== */

/** 本实例是否挂起过关机计划（看门狗或最终关机）——Ctrl+C 是否执行 /a 的唯一依据 */
let watchdogArmed = false

function armWatchdog() {
  const args = ['/s', '/t', String(cfg.watchdogSec), '/f']
  if (flags.dryRun) { log('DRY ', 'watchdog', `[dry-run] 将先 shutdown /a 清除残留计划，再执行: shutdown ${args.join(' ')}`); return }
  // 先清残留：上一轮被硬杀遗留的看门狗 / 用户手动排程会导致本次 /s 返回 1115（若该语义存在），
  // 直接进错误路径会把「还剩30分钟的倒计时」变成「5秒后关机」——必须先 /a 再挂。
  spawnSync('shutdown', ['/a'], { encoding: 'utf8', timeout: 15000 })
  const r = spawnSync('shutdown', args, { encoding: 'utf8', timeout: 15000 })
  if (r.error) throw new Error(`无法执行 shutdown: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`看门狗挂载失败 status=${r.status} stderr=${String(r.stderr || '').trim()}`)
  watchdogArmed = true
  log('INFO', 'watchdog', `已挂载兜底看门狗：${cfg.watchdogSec}s 后自动关机`)
}

function doShutdown() {
  const common = ['/s', '/t', String(cfg.shutdownGraceSec), '/d', 'p:4:1', '/f']
  // 先 /a：在「重复 /s 可覆盖」与「重复 /s 返回 1115 拒绝」两种未知语义下都正确；
  // /a 返回 1116（无挂起计划）属正常，忽略。
  spawnSync('shutdown', ['/a'], { encoding: 'utf8', timeout: 15000 })
  let r = spawnSync('shutdown', common, { encoding: 'utf8', timeout: 15000 })
  let retried = false
  if (r.status !== 0) {
    retried = true
    sleepSync(1000)
    spawnSync('shutdown', ['/a'], { encoding: 'utf8', timeout: 15000 })
    r = spawnSync('shutdown', common, { encoding: 'utf8', timeout: 15000 })
  }
  // 兜底不变量：/a 已摧毁看门狗，若 /s 两次都没排上 → 重新挂看门狗，保证「要么已排程关机、要么看门狗仍在」
  let rearm = false
  if (r.status !== 0) {
    const w = spawnSync('shutdown', ['/s', '/t', String(cfg.watchdogSec), '/f'], { encoding: 'utf8', timeout: 15000 })
    rearm = w.status === 0
    watchdogArmed = watchdogArmed || rearm
  }
  return { status: r.status, retried, rearm, stderr: String(r.stderr || '').trim() }
}

/* ============================== 错误处理接口（预留） ============================== */

async function runErrorHandlers(outcome) {
  const ctx = { stage: outcome.stage || 'ERROR', config: cfg, log, startedAt: outcome.startedAt || null }
  // 第 1 层：默认实现 = ERROR 日志（上面已记）
  // 第 2 层：可替换模块 errorHandler.mjs
  try {
    const modPath = path.join(__dirname, 'errorHandler.mjs')
    if (fs.existsSync(modPath)) {
      const m = await import(pathToFileURL(modPath).href)
      if (typeof m.handle === 'function') {
        await withTimeout(Promise.resolve(m.handle(outcome.err || new Error(outcome.stage), ctx)),
          cfg.onError.timeoutSec * 1000, 'errorHandler.mjs')
        log('INFO', 'onError', '已执行自定义 errorHandler.mjs')
      } else {
        log('WARN', 'onError', 'errorHandler.mjs 未导出 handle(err, ctx) 函数，已忽略')
      }
    }
  } catch (e) {
    log('WARN', 'onError', `errorHandler.mjs 执行异常（不阻塞关机）: ${e.message}`)
  }
  // 第 3 层：config.onError.command
  if (cfg.onError.command) {
    try {
      const r = spawnSync(cfg.onError.command, cfg.onError.args || [], {
        cwd: __dirname, encoding: 'utf8', shell: true,
        timeout: cfg.onError.timeoutSec * 1000,
      })
      log('INFO', 'onError', `onError.command 退出码=${r.status}${r.error ? ` (${r.error.message})` : ''}`)
    } catch (e) {
      log('WARN', 'onError', `onError.command 执行失败（不阻塞关机）: ${e.message}`)
    }
  }
}

/* ============================== 收尾（幂等） ============================== */

async function finalize(outcome) {
  if (finalized) return
  finalized = true
  closeWs()
  const isError = !!outcome.isError

  // dry-run 最先短路：不执行错误处理、不碰 shutdown，仅打印计划
  if (flags.dryRun) {
    log('DRY ', 'finalize', isError
      ? `[dry-run] 演练错误路径 stage=${outcome.stage}：将执行三层错误处理，再执行 shutdown /a && shutdown /s /t ${cfg.shutdownGraceSec} /d p:4:1 /f（均不真实执行）`
      : `[dry-run] 演练正常路径：将执行 shutdown /a && shutdown /s /t ${cfg.shutdownGraceSec} /d p:4:1 /f（不真实执行）`)
    await flushLog()
    releaseLock()
    return
  }

  if (isError) {
    log('ERROR', outcome.stage || 'ERROR', `进入错误路径：${outcome.err?.message || outcome.err || '(无详情)'}`)
    await runErrorHandlers(outcome)
    log('INFO', 'shutdown', '错误处理执行完毕，按需求依旧关机')
  } else {
    log('INFO', outcome.stage || 'done', 'MAA 与 MaaEnd 双方任务均已完成')
    log('INFO', 'shutdown', '正常完成，准备关机')
  }

  const res = doShutdown()
  if (res.status === 0 && !res.rearm) {
    watchdogArmed = false // 最终关机已排程：此后 Ctrl+C 不再 /a（防止毫秒窗口内误触撤销「全天无人值守的最后一环」）
  } else {
    watchdogArmed = watchdogArmed || res.rearm
  }
  log('INFO', 'shutdown', `关机命令已发出 status=${res.status}${res.retried ? '（首轮失败，已重试）' : ''}${res.rearm ? '（严重: /s 两次失败，已重挂看门狗兜底）' : ''}${res.stderr ? ' stderr=' + res.stderr : ''}`)
  if (res.status !== 0 && !res.rearm) {
    log('ERROR', 'shutdown', '关机命令与看门狗重挂均失败！机器可能不会自动关机，需人工检查')
  }
  await flushLog()
  releaseLock()
  process.exit(isError ? 1 : 0)
}

/* ============================== 启动与就绪 ============================== */

async function launchAndReady() {
  // exe 预检（路径不存在 → 错误路径）
  for (const [name, p] of [['MAA', cfg.paths.maaExe], ['MaaEnd', cfg.paths.maaendExe]]) {
    if (!fs.existsSync(p)) throw new Error(`${name} 可执行文件不存在: ${p}`)
  }

  // gui.log 读取基线：必须在启动/复用 MAA 之前记录（否则 ready 等待期内写入的完成行会被跳过）
  try { maaLogPos = fs.statSync(cfg.paths.maaLog).size } catch { maaLogPos = -1 } // -1=暂不可基线化，稍后恢复时以当时文件尾为基线

  const maaRunning = isProcessRunning('MAA.exe')
  const endRunning = isProcessRunning('MaaEnd.exe')
  log('INFO', 'launch', `启动前进程检查：MAA=${maaRunning === null ? '未知' : maaRunning} MaaEnd=${endRunning === null ? '未知' : endRunning}`)

  // MAA 配置注入（仅当 MAA 未在运行）
  if (maaRunning === true) log('WARN', 'inject', 'MAA 已在运行，跳过配置注入（内存态配置不受文件影响），依赖 gui.log 通道')
  else injectPostRunScript()

  // 清理上一轮残留的完成标志
  fs.rmSync(FLAG_FILE, { force: true })

  // 仅在「确认未运行」时才启动；检测结果未知(null)时按复用处理——重复 spawn 双开被单机制弹出会误判错误路径，宁可走超时兜底
  if (maaRunning === false) {
    maaChild = spawnApp('maa', cfg.paths.maaExe)
    maaSpawnAt = Date.now()
    log('INFO', 'launch', `已启动 MAA pid=${maaChild.pid}`)
  } else {
    reused.maa = true
    log(maaRunning === null ? 'WARN' : 'INFO', 'launch', maaRunning === null
      ? 'MAA 进程状态检测失败（未知），不重复启动（防双开误判）；未确认存活，将走就绪超时错误路径快速失败'
      : '复用已在运行的 MAA 进程（将以周期性进程探活替代退出事件）')
  }

  if (endRunning === false) {
    maendChild = spawnApp('maend', cfg.paths.maaendExe)
    log('INFO', 'launch', `已启动 MaaEnd pid=${maendChild.pid}`)
  } else {
    reused.maend = true
    log(endRunning === null ? 'WARN' : 'INFO', 'launch', endRunning === null
      ? 'MaaEnd 进程状态检测失败（未知），不重复启动（防双开误判）；将以 web 端口探测判定真实状态'
      : '复用已在运行的 MaaEnd 进程（将以周期性进程探活替代退出事件）')
  }

  // 就绪等待
  const deadline = Date.now() + cfg.readyTimeoutSec * 1000
  let maaStable = maaRunning === true // 复用进程视为已就绪
  while (Date.now() < deadline) {
    if (exitInfo.maa && maaChild) throw new Error(`MAA 启动后退出（code=${exitInfo.maa.code}）`)
    if (exitInfo.maend && maendChild) throw new Error(`MaaEnd 启动后退出（code=${exitInfo.maend.code}）`)
    if (!maaStable && maaChild && Date.now() - maaSpawnAt >= cfg.maaReadyStableSec * 1000) {
      maaStable = true
      log('INFO', 'ready', `MAA 进程存活 ${cfg.maaReadyStableSec}s，启动就绪`)
    }
    if (!maaEnd.port) maaEnd.port = await probeMaaEndPort()
    if (maaStable && maaEnd.port) {
      log('INFO', 'ready', `MaaEnd web 端口就绪: ${maaEnd.port}`)
      // 信号通道就绪确认（AC-10）
      const post = (() => { try { const j = JSON.parse(fs.readFileSync(cfg.paths.maaConfig, 'utf8')); return String(j?.Configurations?.Default?.Gui?.RuntimeSettings?.PostRunScript || '') } catch { return '(读取失败)' } })()
      log('INFO', 'ready', `MAA 信号通道：PostRunScript=${post.includes('--maa-done') ? '已注入回调' : post ? '用户自有配置(将依赖gui.log)' : '空(注入失败或禁用,依赖gui.log)'} gui.log=${maaLogPos >= 0 ? `基线${maaLogPos}B` : '暂不可读(后续恢复基线)'}`)
      return
    }
    await sleep(1000)
  }
  throw new Error(`就绪超时(${cfg.readyTimeoutSec}s)：MAA=${maaStable ? 'ok' : '未就绪'} MaaEnd端口=${maaEnd.port || '未探测到'}`)
}

/* ============================== 监测主循环 ============================== */

async function monitorLoop() {
  const startedAt = Date.now()
  const deadline = startedAt + cfg.monitorTimeoutSec * 1000
  let nextHb = startedAt + cfg.heartbeatLogSec * 1000
  let nextProcCheck = startedAt + 10000

  while (true) {
    // 1) 信号收集（永远先于超时判定：避免最后 sleep 窗口内的完成信号被误报成超时）
    checkFlag()
    tailMaaLog() // 不因 maa.done 停止：flag 之后到达的错误收尾行仍要能置 failed
    if (!maaEnd.done) await pollMaaEnd('poll')

    // 2) 复用进程的周期性探活（每 ~10s；复用时无 exit 事件）
    if (Date.now() >= nextProcCheck) {
      nextProcCheck = Date.now() + 10000
      if (reused.maa && !maa.done && isProcessRunning('MAA.exe') === false) {
        return { isError: true, stage: 'MAA_EXIT', startedAt, err: new Error('复用的 MAA 进程已消失（崩溃或被手动关闭，未收到完成信号）') }
      }
      if (reused.maend && !maaEnd.done && isProcessRunning('MaaEnd.exe') === false) {
        return { isError: true, stage: 'MAAEND_EXIT', startedAt, err: new Error('复用的 MaaEnd 进程已消失（崩溃或被手动关闭，未收到完成信号）') }
      }
    }

    // 3) 新启动进程的退出事件
    // 注：MAA 的 ExecuteScript 同步 WaitForExit 且 flag 为同步 rename 后才退出回调进程，
    //     故 MAA exit 事件必晚于 flag 落盘——同轮 step1 已查 flag，不存在「exit 先于 flag」竞态。
    if (exitInfo.maa && maaChild && !maa.done) {
      return { isError: true, stage: 'MAA_EXIT', startedAt, err: new Error(`MAA 进程意外退出 code=${exitInfo.maa.code}（未收到完成信号）`) }
    }
    if (exitInfo.maend && maendChild && !maaEnd.done) {
      return { isError: true, stage: 'MAAEND_EXIT', startedAt, err: new Error(`MaaEnd 进程意外退出 code=${exitInfo.maend.code}（未收到完成信号）`) }
    }

    // 4) 双完成（含错误收尾定性）
    if (maa.done && maaEnd.done) {
      const failed = maa.failed || maaEnd.failed
      return { isError: failed, startedAt,
        stage: failed ? 'TASK_ERROR' : 'ALL_DONE',
        err: failed ? new Error(`任务以错误状态收尾：MAA${maa.failed ? '(错误收尾)' : ''} MaaEnd${maaEnd.failed ? '(Failed)' : ''}`) : null }
    }

    // 5) 超时（放在信号之后：本轮刚到的完成信号优先于超时）
    if (Date.now() >= deadline) {
      return { isError: true, stage: 'MONITOR_TIMEOUT', startedAt,
        err: new Error(`监测超时 ${cfg.monitorTimeoutSec}s：maa=${maa.done ? 'done' : 'wait'} maend=${maaEnd.done ? 'done' : 'wait'}`) }
    }

    if (Date.now() >= nextHb) {
      log('INFO', 'monitor', `心跳 maa=${maa.done ? 'done' : 'wait'}/${maa.via || '-'} maend=${maaEnd.done ? 'done' : 'wait'} port=${maaEnd.port || '-'} sawRunning=${maaEnd.sawRunning}`)
      nextHb = Date.now() + cfg.heartbeatLogSec * 1000
    }
    await sleep(cfg.pollIntervalMs)
  }
}

/* ============================== CLI 分叉 ============================== */

const argv = process.argv.slice(2)

// 手动中止（Ctrl+C / 计划任务停止）：只要本实例挂起过关机计划就先 /a 取消，再干净退出，
// 避免「测试中止/错误处理期间中止 → 30 分钟后莫名关机」。未挂过计划（测试入口/窗口外）则不碰
// 用户自己排程的关机。注意：计划任务 ExecutionTimeLimit 到点是强杀（不发信号），由看门狗系统级兜底。
let exiting = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (exiting) { flushLog().catch(() => {}).finally(() => process.exit(130)); return } // 二次信号：flush 后尽快强制退出
    exiting = true
    if (watchdogArmed) {
      log('WARN', 'signal', `收到 ${sig}，手动中止：shutdown /a 取消本实例挂起的关机计划并退出`)
      try { spawnSync('shutdown', ['/a'], { encoding: 'utf8', timeout: 15000 }) } catch { /* ignore */ }
    } else {
      log('WARN', 'signal', `收到 ${sig}，手动中止退出（本实例未挂过关机计划，不执行 /a）`)
    }
    closeWs()
    flushLog().finally(() => { releaseLock(); process.exit(130) })
  })
}

const flags = {
  force: argv.includes('--force'),
  dryRun: argv.includes('--dry-run'),
  help: argv.includes('--help') || argv.includes('-h'),
  selfTest: argv.includes('--self-test'),
}
const wtIdx = argv.indexOf('--window-test')
const windowTestArg = wtIdx >= 0 ? (argv[wtIdx + 1] || null) : null

function printHelp() {
  console.log(`全自动日常主控脚本 (daily.mjs)

用法:
  node daily.mjs                正常运行（由开机计划任务调用）
  node daily.mjs --force        跳过时间窗判定（调试；看门狗等安全语义不变）
  node daily.mjs --dry-run      演练模式：只打印将执行的动作，不挂看门狗/不启动/不注入/不关机
  node daily.mjs --window-test [ISO时间]  打印开机时间与窗口判定（只读）
  node daily.mjs --self-test    自检时间窗与完成判定逻辑
  node daily.mjs --maa-done     MAA「结束后脚本」回调入口（内部使用）
  node daily.mjs --help         显示本帮助

错误处理接口: 见同目录 errorHandler.example.mjs（复制为 errorHandler.mjs 生效）
配置: config.json（缺失/损坏时回退内置默认值）`)
}

async function selfTest() {
  const cases = []
  const T = (name, cond) => cases.push({ name, ok: !!cond })
  const D = s => new Date(s)
  const W = (bootCim, bootEvt, now, slots = DEFAULT_CONFIG.window.slots) =>
    decideWindow({ bootCim, bootEvt, now, slots, nowGraceMin: 60 })

  // 时间窗边界（默认时段 [3,4) 与 [7,8)）
  T('03:00:00 含边界', W(D('2026-10-15T03:00:00'), D('2026-10-15T03:00:05'), D('2026-10-15T03:05:00')).inWin === true)
  T('04:00:00 不含边界', W(D('2026-10-15T04:00:00'), D('2026-10-15T04:00:05'), D('2026-10-15T04:10:00')).inWin === false)
  T('02:59 开机不在窗口', W(D('2026-10-15T02:59:00'), D('2026-10-15T02:59:05'), D('2026-10-15T03:05:00')).inWin === false)
  T('03:59 开机、04:02 脚本启动 → 执行', W(D('2026-10-15T03:59:00'), D('2026-10-15T03:59:05'), D('2026-10-15T04:02:00')).inWin === true)
  T('白天 15:00 运行 → 静默', W(D('2026-10-15T15:00:00'), D('2026-10-15T15:00:05'), D('2026-10-15T15:01:00')).inWin === false)
  T('昨日开机（>24h）不误触发', W(D('2026-10-14T03:30:00'), D('2026-10-14T03:30:05'), D('2026-10-15T03:35:00')).inWin === false)
  T('CIM 过期(>10min)时信事件6005', (() => {
    const r = W(D('2026-10-15T01:00:00'), D('2026-10-15T03:10:00'), D('2026-10-15T03:20:00'))
    return r.bootSource === 'evt(stale-cim)' && r.inWin === true
  })())
  T('双源接近时取较早者', (() => {
    const r = W(D('2026-10-15T03:01:00'), D('2026-10-15T03:01:15'), D('2026-10-15T03:10:00'))
    return r.bootSource === 'cim+evt' && r.boot.getTime() === D('2026-10-15T03:01:00').getTime()
  })())
  T('双源全失败 + 此刻在窗口内 → 按窗口内处理', W(null, null, D('2026-10-15T03:30:00')).inWin === true)
  T('双源全失败 + 此刻在白天 → 静默', W(null, null, D('2026-10-15T15:00:00')).inWin === false)

  // 当前时刻上限（nowGraceMin=60）：防「开机后晚登录/同日重跑」误执行
  T('boot 03:40、now 04:30 → 执行（登录延迟宽限内）', W(D('2026-10-15T03:40:00'), D('2026-10-15T03:40:05'), D('2026-10-15T04:30:00')).inWin === true)
  T('boot 03:40、now 15:00 → 静默（同日白天重跑被拦）', (() => { const r = W(D('2026-10-15T03:40:00'), D('2026-10-15T03:40:05'), D('2026-10-15T15:00:00')); return r.matchedBoot === true && r.inWin === false })())
  T('boot 03:40、now 05:30 → 静默（超该段 nowLimit 05:00）', (() => { const r = W(D('2026-10-15T03:40:00'), D('2026-10-15T03:40:05'), D('2026-10-15T05:30:00')); return r.matchedBoot === true && !!r.bootSlot && r.inWin === false })())
  T('boot 03:40、now 07:50 → 静默（在第二段时刻但 boot 不属第二段，跨段重跑被拦）', W(D('2026-10-15T03:40:00'), D('2026-10-15T03:40:05'), D('2026-10-15T07:50:00')).inWin === false)
  T('时钟回拨30s（now<boot）仍执行，不误判陈旧', W(D('2026-10-15T03:00:30'), D('2026-10-15T03:00:35'), D('2026-10-15T03:00:00')).inWin === true)
  T('回拨超2h 仍拦（boot 03:30、now 回拨至 01:00）', W(D('2026-10-15T03:30:00'), D('2026-10-15T03:30:05'), D('2026-10-15T01:00:00')).inWin === false)

  // 第二时段 [7,8)
  T('07:00:00 含边界', W(D('2026-10-15T07:00:00'), D('2026-10-15T07:00:05'), D('2026-10-15T07:10:00')).inWin === true)
  T('08:00:00 不含边界', W(D('2026-10-15T08:00:00'), D('2026-10-15T08:00:05'), D('2026-10-15T08:10:00')).inWin === false)
  T('boot 06:59 不在任何段', W(D('2026-10-15T06:59:00'), D('2026-10-15T06:59:05'), D('2026-10-15T07:05:00')).inWin === false)
  T('boot 07:30、now 07:50 → 执行（第二段命中）', (() => { const r = W(D('2026-10-15T07:30:00'), D('2026-10-15T07:30:05'), D('2026-10-15T07:50:00')); return r.inWin === true && r.hitSlot && r.hitSlot.startHour === 7 })())
  T('boot 07:59、now 08:02 → 执行（第二段宽限内）', W(D('2026-10-15T07:59:00'), D('2026-10-15T07:59:05'), D('2026-10-15T08:02:00')).inWin === true)
  T('boot 07:30、now 09:30 → 静默（超第二段上限 09:00）', (() => { const r = W(D('2026-10-15T07:30:00'), D('2026-10-15T07:30:05'), D('2026-10-15T09:30:00')); return r.matchedBoot === true && r.inWin === false })())

  // 配置校验与看门狗预算链 clamp
  T('非法 watchdogSec 回退默认 1800', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { watchdogSec: 'abc' }); validateConfig(c, true); return c.watchdogSec === 1800
  })())
  T('预算链 clamp: watchdog=600 时 monitor 压到 300', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { watchdogSec: 600, monitorTimeoutSec: 1500 }); validateConfig(c, true)
    return c.monitorTimeoutSec === 600 - 120 - 120 - 60
  })())
  T('非法 shutdownGraceSec 回退默认 5', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { shutdownGraceSec: -3 }); validateConfig(c, true); return c.shutdownGraceSec === 5
  })())
  T('配置节被写成标量 → 整节回退默认对象（不崩溃）', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { window: 5, onError: 'powershell x.ps1' })
    try { validateConfig(c, true) } catch { return false }
    return c.window && typeof c.window === 'object' && Array.isArray(c.window.slots) &&
      c.window.slots.length === 2 && c.window.slots[0].startHour === 3 && typeof c.onError === 'object'
  })())
  T('预算链负cap场景（ready=2000）→ 逐级回退，monitor 不为负', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { readyTimeoutSec: 2000 })
    validateConfig(c, true)
    return c.readyTimeoutSec === 120 && c.monitorTimeoutSec >= 60 && c.monitorTimeoutSec <= 1500
  })())
  T('slots 内 start>end → 整体回退默认双时段', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { window: { slots: [{ startHour: 5, endHour: 4 }] } })
    validateConfig(c, true)
    return c.window.slots.length === 2 && c.window.slots[0].startHour === 3 && c.window.slots[1].startHour === 7
  })())
  T('slots 元素越界(25) → 整体回退默认双时段', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { window: { slots: [{ startHour: 25, endHour: 26 }] } })
    validateConfig(c, true); return c.window.slots.length === 2 && c.window.slots[0].startHour === 3
  })())
  T('slots 被写成字符串 → 整体回退默认双时段', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { window: { slots: '3-4' } })
    validateConfig(c, true); return Array.isArray(c.window.slots) && c.window.slots.length === 2
  })())
  T('自定义三时段通过校验（不动默认结构）', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { window: { slots: [{ startHour: 1, endHour: 2 }, { startHour: 3, endHour: 4 }, { startHour: 22, endHour: 23 }] } })
    validateConfig(c, true); return c.window.slots.length === 3 && c.window.slots[2].startHour === 22
  })())
  T('portScan 被写成字符串 → 回退默认数组', (() => {
    const c = mergeDeep(structuredClone(DEFAULT_CONFIG), { maend: { portScan: '12701' } })
    validateConfig(c, true); return Array.isArray(c.maend.portScan) && c.maend.portScan.length === 10
  })())

  // MaaEnd 完成判定
  const stateOf = (running, overall) => ({ instances: { x: { is_running: running, task_run_state: { overall_status: overall } } } })
  T('MaaEnd: 空实例 → no-instances', judgeMaaEnd({}, false).kind === 'no-instances')
  T('MaaEnd: running → 未完成', judgeMaaEnd(stateOf(true, 'Running'), false).kind === 'running')
  T('MaaEnd: 未见过 running 的 Succeeded 残留不算完成', judgeMaaEnd(stateOf(false, 'Succeeded'), false).kind === 'waiting')
  T('MaaEnd: 见过 running + Succeeded → 完成', (() => { const j = judgeMaaEnd(stateOf(false, 'Succeeded'), true); return j.kind === 'done' && j.failed === false })())
  T('MaaEnd: 见过 running + Failed → 完成但标错', (() => { const j = judgeMaaEnd(stateOf(false, 'Failed'), true); return j.kind === 'done' && j.failed === true })())
  T('MaaEnd: null 终态不算完成', judgeMaaEnd(stateOf(false, null), true).kind === 'waiting')

  // 回调命令格式（MAA ExecuteScript 要求以双引号开头）
  const cmd = maaCallbackCmd()
  T('回调命令以引号开头', cmd.startsWith('"'))
  T('回调命令含 --maa-done 标记', cmd.includes('--maa-done'))
  T('回调命令含 -noWindow 开关', cmd.includes('-noWindow'))

  // 配置合并
  T('配置深合并保留默认值', mergeDeep({ a: { b: 1, c: 2 } }, { a: { b: 9 } }).a.c === 2 && mergeDeep({ a: { b: 1 } }, { a: { b: 9 } }).a.b === 9)

  // ISO 解析
  T("ISO 'o' 格式解析", parseIsoStrict('2026-10-15T10:25:48.1234567+08:00') instanceof Date)
  T('NA 解析为 null', parseIsoStrict('NA') === null)

  let bad = 0
  for (const c of cases) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`); if (!c.ok) bad++ }
  console.log(`\n${cases.length - bad}/${cases.length} 通过`)
  await flushLog() // flush 后再退出，保证校验类 WARN 完整落盘
  process.exit(bad ? 1 : 0)
}

async function windowTest() {
  const now = windowTestArg ? new Date(windowTestArg) : new Date()
  if (isNaN(now)) { console.error('时间格式无效，示例: 2026-10-15T03:30:00'); await flushLog(); process.exit(2) }
  const { cim, evt } = getBootTimes()
  const r = decideWindow({
    bootCim: cim, bootEvt: evt, now,
    slots: cfg.window.slots, nowGraceMin: cfg.window.nowGraceMin,
  })
  const pad = h => String(h).padStart(2, '0')
  console.log(JSON.stringify({
    now: now.toISOString(),
    lastBootUpTime_CIM: cim ? cim.toISOString() : null,
    event6005_EVT: evt ? evt.toISOString() : null,
    bootUsed: r.boot ? r.boot.toISOString() : null,
    bootSource: r.bootSource,
    slots: cfg.window.slots.map(s => `[${pad(s.startHour)}:00, ${pad(s.endHour)}:00)`),
    matchedSlot: r.matchedBoot ? `[${pad(r.bootSlot.startHour)}:00, ${pad(r.bootSlot.endHour)}:00)` : null,
    matchedSlotNowLimit: r.bootSlot ? r.bootSlotLimit.toISOString() : null,
    hitSlot: r.hitLabel,
    ageOk: r.ageOk,
    ranToday: !!checkRanToday(),
    inWindow: r.inWin,
  }, null, 2))
  await flushLog()
  process.exit(r.inWin ? 0 : 3)
}

/* ============================== 主流程 ============================== */

/**
 * runPhase：关机权限状态机。
 *  - 'init'    尚未进入主流程（时间窗判定前/测试入口）——此阶段的异常只记日志退出，绝不关机
 *  - 'armed'   时间窗判定通过、即将挂看门狗——此阶段起的异常才有权进入 finalize（错误处理→关机）
 * 堵住的洞：锁写失败、窗口判定中 powershell 异常等发生在「关机授权」之前的错误，
 *          曾会经 main().catch 走完整关机流程（白天误关机）。
 */
let runPhase = 'init'

async function main() {
  if (flags.help) { printHelp(); return }

  // MAA 回调入口：不取锁、不做窗口判定、永不触达 finalize——写完标志即退出，失败也只记日志
  if (argv.includes('--maa-done')) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      const tmp = FLAG_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ at: ts(), pid: process.pid }, null, 2), 'utf8')
      fs.renameSync(tmp, FLAG_FILE)
      log('INFO', 'maa-done', '已写入 MAA 完成标志')
      await flushLog()
      process.exit(0)
    } catch (e) {
      log('ERROR', 'maa-done', `写入 MAA 完成标志失败（不影响主实例，主实例将由超时兜底）: ${e.message}`)
      await flushLog()
      process.exit(1)
    }
  }

  loadConfig()

  if (flags.selfTest) { await selfTest(); return }
  if (wtIdx >= 0) { await windowTest(); return }

  await acquireLock()
  log('INFO', 'start', `脚本启动 pid=${process.pid} 参数=[${argv.join(' ') || '无'}] node=${process.version}`)

  // ---- 时间窗判定（多时段） ----
  const { cim, evt } = getBootTimes()
  const win = decideWindow({
    bootCim: cim, bootEvt: evt, now: new Date(),
    slots: cfg.window.slots, nowGraceMin: cfg.window.nowGraceMin,
  })
  const pad2 = h => String(h).padStart(2, '0')
  const slotsLabel = cfg.window.slots.map(s => `[${pad2(s.startHour)}:00,${pad2(s.endHour)}:00)`).join(' ')
  log('INFO', 'window',
    `开机时间来源=${win.bootSource} boot=${win.boot ? win.boot.toLocaleString('zh-CN') : '未知'} ` +
    `CIM=${cim ? cim.toLocaleString('zh-CN') : 'NA'} EVT=${evt ? evt.toLocaleString('zh-CN') : 'NA'} ` +
    `时段集=${slotsLabel} ` +
    (win.hitSlot ? `命中=${win.hitLabel} `
      : win.bootSlot ? `boot属=[${pad2(win.bootSlot.startHour)}:00,${pad2(win.bootSlot.endHour)}:00)但超上限=${win.bootSlotLimit.toLocaleString('zh-CN')} ` : '') +
    `ageOk=${win.ageOk} → ${win.inWin ? '可执行' : '不可执行'}`)

  if (!win.inWin && !flags.force) {
    log('INFO', 'window', win.bootSlot
      ? `开机时间在时段 [${pad2(win.bootSlot.startHour)}:00,${pad2(win.bootSlot.endHour)}:00) 内但当前时刻已超上限（${win.bootSlotLimit.toLocaleString('zh-CN')}），视为非本轮执行时段，静默退出（不启动程序、不设看门狗；调试可用 --force）`
      : `开机时间不在任何配置时段（${slotsLabel}），静默退出（不启动程序、不设看门狗）`)
    await flushLog(); releaseLock(); return
  }
  if (!win.inWin && flags.force) log('WARN', 'window', flags.dryRun
    ? '--force 跳过时间窗判定（dry-run 演练，不实际挂看门狗）'
    : '--force 跳过时间窗判定（安全语义不变，仍会挂看门狗）')

  // ---- 当日执行配额（非 force、非 dry-run）：每个自然日至多完整执行一轮 ----
  if (!flags.force && !flags.dryRun) {
    const ran = checkRanToday()
    if (ran) {
      log('WARN', 'window', `今日已于 ${ran.at || '?'} 完整执行过一轮（boot=${ran.boot || '?'}），静默退出；如需重跑请删除 state/ran-*.json 或使用 --force`)
      await flushLog(); releaseLock(); return
    }
    markRanToday(win.boot)
  }

  // ---- 主流程（自此获得关机权限） ----
  runPhase = 'armed'
  let outcome = { isError: false, stage: 'ALL_DONE', startedAt: Date.now() }
  try {
    // 1) 先挂看门狗（在启动任何外部程序之前；挂载失败 → 错误路径）
    armWatchdog()

    if (flags.dryRun) {
      injectPostRunScript()
      log('DRY ', 'launch', `[dry-run] 将启动: ${cfg.paths.maaExe}`)
      log('DRY ', 'launch', `[dry-run] 将启动: ${cfg.paths.maaendExe}`)
      log('DRY ', 'monitor', `[dry-run] 将轮询: MAA(flag+gui.log) / MaaEnd(12701-12710/api/maa/state + ws)，超时 ${cfg.monitorTimeoutSec}s`)
      outcome = { isError: false, stage: 'DRY_PLAN', startedAt: Date.now() }
    } else {
      // 2) 启动并就绪
      await launchAndReady()
      startWs()
      // 3) 监测至双完成 / 错误 / 超时
      outcome = await monitorLoop()
    }
  } catch (e) {
    outcome = { isError: true, stage: 'SETUP_ERROR', err: e, startedAt: Date.now() }
  }

  await finalize(outcome)
}

main().catch(async e => {
  if (runPhase !== 'armed') {
    // 关机授权之前发生异常：只记日志退出，绝不执行错误处理/关机
    log('ERROR', 'FATAL', `初始化阶段异常（不触发关机，runPhase=${runPhase}）: ${e?.stack || e}`)
    await flushLog(); releaseLock()
    process.exit(2)
    return
  }
  try { await finalize({ isError: true, stage: 'FATAL', err: e }) }
  catch { await flushLog().catch(() => {}); process.exit(2) }
})
