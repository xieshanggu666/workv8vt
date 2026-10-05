import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'
import { generateForStatement, deleteNotifyOfStatement } from './notify.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 常量与口径 =====
export const STMT_STATUS = {
  draft: '起草中', review: '待法务审核', approved: '审核通过',
  publishing: '发布中', partial: '部分渠道失败', degraded: '已降级发布',
  published: '已发布', cancelled: '已取消'
}
// 声明未完结口径（危机结案守卫/看板/复盘快照共用）：
// partial=全部渠道已登记但仍有失败渠道，发布未完成，必须重试成功、放弃（取消）或降级发布后才能结案。
// degraded（已降级发布）与 published 同为发布终态：失败渠道按策略降级终止（保留失败记录），不再阻塞结案。
const OPEN_STATUSES = ['draft', 'review', 'approved', 'publishing', 'partial']
export const isStatementOpen = (status) => OPEN_STATUSES.includes(status)
export const STMT_PRIORITY = { urgent: '紧急', high: '高', normal: '普通' }
// 拟发布渠道（分渠道执行登记）：与舆情渠道语义对应
export const STMT_CHANNELS = {
  weibo: '官方微博', wechat: '微信公众号', website: '官网新闻中心',
  news: '新闻通稿（媒体邮箱组）', video: '官方短视频账号', press: '新闻发布会'
}
export const CH_STATUS = { pending: '待执行', publishing: '执行中', success: '已发布', failed: '失败', cancelled: '已取消' }

// ===== 降级发布策略（可配置） =====
// 分渠道失败处理由「一律部分失败、阻断结案」升级为可配置的降级发布：
//   · block   阻断（原口径）：全部渠道登记完仍有失败 → partial，必须重试成功/放弃失败渠道，不允许降级收口
//   · manual  手动降级（默认）：partial 后经发布人员确认可降级收口（失败渠道终止但保留失败记录），不再阻塞结案
//   · auto    自动降级：全部渠道登记完且失败比例/成功数满足阈值时自动降级收口，无需人工确认
// 全局默认策略存 app_config（管理员配置），单份声明可覆盖（起草/发布阶段配置；空=沿用全局默认）。
export const DEGRADE_MODE_TEXT = { block: '阻断（不允许降级）', manual: '手动确认降级', auto: '满足阈值自动降级' }
export const DEFAULT_DEGRADE_POLICY = Object.freeze({ mode: 'manual', maxFailRatio: 0.5, minSuccess: 1 })
const DEGRADE_CONFIG_KEY = 'stmt_degrade_policy'

function normPolicy(p, dft) {
  const base = dft || DEFAULT_DEGRADE_POLICY
  if (!p || typeof p !== 'object') return { ...base }
  // 注意 Number(null)===0 为有限数：缺省（undefined/null/''）必须先判空再归一，否则会被误归为 0%
  const rawRatio = p.maxFailRatio === undefined || p.maxFailRatio === null || p.maxFailRatio === '' ? base.maxFailRatio : Number(p.maxFailRatio)
  const ratio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio)) : base.maxFailRatio
  const rawMin = p.minSuccess === undefined || p.minSuccess === null || p.minSuccess === '' ? base.minSuccess : Number(p.minSuccess)
  const minSuccess = Number.isFinite(rawMin) ? Math.min(99, Math.max(0, Math.floor(rawMin))) : base.minSuccess
  return {
    mode: DEGRADE_MODE_TEXT[p.mode] ? p.mode : base.mode,
    maxFailRatio: ratio,
    minSuccess
  }
}

// 全局默认降级策略（缺配置行时按内置默认值幂等回填，历史库同样可用）
export function getGlobalDegradePolicy() {
  const row = q1('SELECT config_value FROM app_config WHERE config_key=?', DEGRADE_CONFIG_KEY)
  if (!row) {
    const p = { ...DEFAULT_DEGRADE_POLICY }
    run('INSERT OR IGNORE INTO app_config (config_key,config_value,updated,updated_by) VALUES (?,?,?,?)',
      DEGRADE_CONFIG_KEY, JSON.stringify(p), now(), '系统')
    return p
  }
  try { return normPolicy(JSON.parse(row.config_value || '')) } catch { return { ...DEFAULT_DEGRADE_POLICY } }
}

export function updateGlobalDegradePolicy(policy, actor) {
  const p = normPolicy(policy)
  run('INSERT INTO app_config (config_key,config_value,updated,updated_by) VALUES (?,?,?,?) ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, updated=excluded.updated, updated_by=excluded.updated_by',
    DEGRADE_CONFIG_KEY, JSON.stringify(p), now(), actor?.user || '系统')
  return p
}

// 声明生效策略：声明覆盖字段缺省（null/undefined）时逐项回退全局默认（旧历史声明无覆盖=完全沿用默认）
function resolvePolicy(row) {
  const g = getGlobalDegradePolicy()
  const o = safeParse(row?.degrade_policy, null)
  if (!o || typeof o !== 'object') return { ...g, _source: 'global' }
  const has = (k) => o[k] !== null && o[k] !== undefined && o[k] !== ''
  const mode = has('mode') && DEGRADE_MODE_TEXT[o.mode] ? o.mode : g.mode
  let ratio = g.maxFailRatio
  if (has('maxFailRatio') && Number.isFinite(Number(o.maxFailRatio))) ratio = Math.min(1, Math.max(0, Number(o.maxFailRatio)))
  let minSuccess = g.minSuccess
  if (has('minSuccess') && Number.isFinite(Number(o.minSuccess))) minSuccess = Math.min(99, Math.max(0, Math.floor(Number(o.minSuccess))))
  return { mode, maxFailRatio: ratio, minSuccess, _source: row.degrade_policy ? 'statement' : 'global' }
}

// 降级门槛：至少一个渠道成功、无在途渠道、失败比例不超阈值、成功数不低于下限
function degradeEligibility(policy, { ok, failed, total }) {
  const failRatio = total ? failed / total : 0
  const reasons = []
  if (ok < 1) reasons.push('至少需要 1 个渠道发布成功')
  if (ok < policy.minSuccess) reasons.push(`成功渠道数未达到策略下限（${ok}/${policy.minSuccess}）`)
  if (failRatio > policy.maxFailRatio + 1e-9) reasons.push(`失败渠道占比 ${Math.round(failRatio * 100)}% 超过阈值 ${Math.round(policy.maxFailRatio * 100)}%`)
  return { eligible: reasons.length === 0, failRatio, reasons }
}

function addLog(stmtId, action, detail, operator = '系统') {
  run('INSERT INTO crisis_statement_logs (statement_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
    stmtId, action, detail || '', operator || '系统', now())
}

function safeParse(s, dft) { try { return JSON.parse(s || '') ?? dft } catch { return dft } }

// ===== 查询 =====
function decorate(s) {
  const channels = safeParse(s.channels, [])
  const rows = q('SELECT * FROM crisis_statement_channels WHERE statement_id=? ORDER BY id ASC', s.id)
  const counts = { pending: 0, publishing: 0, success: 0, failed: 0, cancelled: 0, total: rows.length }
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1
  const open = counts.pending + counts.publishing
  // 完成度口径：成功 / 已执行（成功+失败+取消，不含待执行/执行中）
  const finished = counts.success + counts.failed + counts.cancelled
  const policy = resolvePolicy(s)
  // 部分失败时按生效策略计算降级可用性（供前端降级按钮/阈值提示；其他状态仅回显策略）
  const degrade = s.status === 'partial'
    ? degradeEligibility(policy, { ok: counts.success, failed: counts.failed, total: rows.length })
    : { eligible: false, failRatio: rows.length ? counts.failed / rows.length : 0, reasons: [] }
  return {
    ...s,
    channels,
    statusText: STMT_STATUS[s.status] || s.status,
    priorityText: STMT_PRIORITY[s.priority] || s.priority,
    degradePolicy: policy,
    degradePolicyRaw: safeParse(s.degrade_policy, null),
    degradeModeText: s.degraded_mode ? (s.degraded_mode === 'auto' ? '自动降级' : '手动降级') : '',
    degrade: { ...degrade, modeText: DEGRADE_MODE_TEXT[policy.mode] || policy.mode },
    channelRows: rows.map((r) => ({ ...r, channelText: STMT_CHANNELS[r.channel] || r.channel_name || r.channel, statusText: CH_STATUS[r.status] || r.status })),
    channelCounts: counts,
    channelOpen: open,
    progress: { done: finished, ok: counts.success, fail: counts.failed, pct: rows.length ? Math.round((finished / rows.length) * 100) : 0 }
  }
}

export function listStatements({ status = '', crisisId = null, limit = 200 } = {}) {
  let sql = `SELECT s.*, c.title crisis_title, c.status crisis_status, c.level crisis_level,
      wo.title wo_title
    FROM crisis_statements s LEFT JOIN crisis c ON c.id=s.crisis_id
    LEFT JOIN work_orders wo ON wo.id=s.work_order_id WHERE 1=1`
  const args = []
  if (status) { sql += ' AND s.status=?'; args.push(status) }
  if (crisisId) { sql += ' AND s.crisis_id=?'; args.push(crisisId) }
  sql += ' ORDER BY s.id DESC LIMIT ?'
  args.push(limit)
  return q(sql, ...args).map(decorate)
}

export function getStatement(id) {
  const s = q1(`SELECT s.*, c.title crisis_title, c.status crisis_status, c.level crisis_level,
      wo.title wo_title, wo.status wo_status
    FROM crisis_statements s LEFT JOIN crisis c ON c.id=s.crisis_id
    LEFT JOIN work_orders wo ON wo.id=s.work_order_id WHERE s.id=?`, id)
  if (!s) return null
  const d = decorate(s)
  d.logs = q('SELECT * FROM crisis_statement_logs WHERE statement_id=? ORDER BY id ASC', id)
  return d
}

// 看板汇总
export function statementSummary() {
  const rows = q('SELECT status, COUNT(*) c FROM crisis_statements GROUP BY status')
  const counts = { draft: 0, review: 0, approved: 0, publishing: 0, partial: 0, degraded: 0, published: 0, cancelled: 0 }
  for (const r of rows) counts[r.status] = r.c
  const ch = q1(`SELECT
      (SELECT COUNT(*) FROM crisis_statement_channels WHERE status IN ('pending','publishing')) openCh,
      (SELECT COUNT(*) FROM crisis_statement_channels WHERE status='failed'
        AND statement_id IN (SELECT id FROM crisis_statements WHERE status='partial')) blockingCh`)
  return {
    counts,
    total: counts.draft + counts.review + counts.approved + counts.publishing + counts.partial + counts.degraded + counts.published + counts.cancelled,
    review: counts.review, publishing: counts.publishing + counts.partial,
    // 结案口径：仅 partial 声明下仍失败的渠道阻塞结案；degraded 声明的失败渠道为已降级终止，不再计入
    channelOpen: ch.openCh, channelFailed: ch.blockingCh
  }
}

// 危机卡片角标：该危机最新一份未完结声明
export function crisisStatementBrief(crisisId) {
  const s = q1('SELECT id,title,status,updated FROM crisis_statements WHERE crisis_id=? ORDER BY id DESC LIMIT 1', crisisId)
  return s ? { ...s, statusText: STMT_STATUS[s.status] || s.status } : null
}

// 危机下未完结（进行中）声明数（结案守卫/看板口径）：含部分渠道失败（partial，发布未完成）
export function crisisOpenStatementCount(crisisId) {
  return q1("SELECT COUNT(*) c FROM crisis_statements WHERE crisis_id=? AND status IN ('draft','review','approved','publishing','partial')", crisisId).c
}

// ===== 时间线/工单双写 =====
function syncProgress(stmtId, action, note, { woRole = '' } = {}) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', stmtId)
  if (!s) return
  const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
  if (c && c.status !== 'closed') addTimeline(s.crisis_id, action, note)
  if (s.work_order_id) {
    run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
      s.work_order_id, 'stmt', note, action === '声明审核通过' || action === '声明审核驳回' ? (s.reviewed_by || '法务') : '系统', woRole, now())
    run('UPDATE work_orders SET last_statement_id=? WHERE id=?', stmtId, s.work_order_id)
  }
}

// 重算分渠道完成度：
//   · 全部渠道成功（或成功+取消，无失败、无在途）→ published 已发布（含降级后失败渠道重试补齐的恢复）
//   · 全部渠道到达终态但存在失败 → 按可配置降级策略收口：
//       block  → partial 部分渠道失败（发布未完成，阻塞结案，触发督办通知）
//       manual → partial（可手动降级；策略满足阈值时登记降级入口，不再自动阻断）
//       auto   → 满足阈值（失败占比/成功数下限）自动 degraded；不满足阈值仍 partial
//   · 全部渠道取消（无一成功/失败/在途）→ cancelled 整份声明取消
//   · 仍有待执行/执行中渠道 → 保持 publishing
function recomputePublishing(stmtId, operator = '系统') {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', stmtId)
  if (!s || !['publishing', 'published', 'partial', 'degraded'].includes(s.status)) return
  const rows = q('SELECT * FROM crisis_statement_channels WHERE statement_id=?', stmtId)
  if (!rows.length) return
  const open = rows.filter((r) => ['pending', 'publishing'].includes(r.status)).length
  if (open > 0 || s.status === 'published') return
  // 已降级发布为人工/策略确认的终态：降级后逐渠道放弃不重开 partial（失败渠道重试登记会经 registerChannel 显式重开 publishing）
  if (s.status === 'degraded') return
  const ok = rows.filter((r) => r.status === 'success').length
  const failed = rows.filter((r) => r.status === 'failed').length
  const cancelled = rows.filter((r) => r.status === 'cancelled').length
  const ts = now()
  const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)

  // 全部渠道取消（没有任何成功/失败结果）：整份声明按取消处理，不算发布
  if (ok === 0 && failed === 0 && cancelled === rows.length) {
    run("UPDATE crisis_statements SET status='cancelled', published_at=NULL, cancel_by=COALESCE(NULLIF(cancel_by,''),?), cancel_at=COALESCE(cancel_at,?), updated=? WHERE id=?",
      operator, ts, ts, stmtId)
    addLog(stmtId, 'cancel_all', `全部 ${rows.length} 个渠道均取消发布，声明不再发布`, operator)
    if (c && c.status !== 'closed') addTimeline(s.crisis_id, '声明取消', `声明「${s.title}」全部 ${rows.length} 个渠道取消发布，整份声明终止`, ts)
    return
  }

  if (failed > 0) {
    const policy = resolvePolicy(s)
    const eg = degradeEligibility(policy, { ok, failed, total: rows.length })
    // 自动降级：全部渠道到终态、策略允许且满足阈值 → 自动降级收口（失败渠道保留失败记录，不再阻塞结案）
    if (s.status !== 'degraded' && policy.mode === 'auto' && eg.eligible) {
      applyDegrade(stmtId, { mode: 'auto', operator: '系统', reason: '', policy, rows, ok, failed, cancelled, total: rows.length, failRatio: eg.failRatio, fromRecompute: true })
      return
    }
    // 部分失败：保持发布未完结（partial），阻断结案，等待重试成功/放弃（取消）失败渠道/手动降级
    run("UPDATE crisis_statements SET status='partial', published_at=NULL, updated=? WHERE id=?", ts, stmtId)
    const policyHint = policy.mode === 'manual'
      ? (eg.eligible
        ? '，可按手动降级策略降级发布（失败渠道终止并保留记录、不再阻塞结案）'
        : `，手动降级需满足：失败占比≤${Math.round(policy.maxFailRatio * 100)}%、至少 ${policy.minSuccess} 个渠道成功`)
      : policy.mode === 'auto'
        ? `，自动降级阈值未满足（失败占比≤${Math.round(policy.maxFailRatio * 100)}%、至少 ${policy.minSuccess} 个渠道成功），请重试或放弃失败渠道`
        : '，策略为阻断降级，须重试成功或放弃失败渠道'
    addLog(stmtId, 'partial',
      `全部 ${rows.length} 个渠道执行登记完成但存在失败：成功 ${ok}、失败 ${failed}` + (cancelled ? `、取消 ${cancelled}` : '') + '，发布未完成' + policyHint,
      operator)
    const note = `声明「${s.title}」分渠道发布未完成：${ok}/${rows.length} 个渠道已发布，${failed} 个渠道失败` +
      (cancelled ? `、${cancelled} 个取消` : '') + '；失败渠道须重试成功、放弃（取消）' +
      (policy.mode === 'manual' && eg.eligible ? '或确认降级发布' : policy.mode === 'auto' ? '或在满足阈值后降级' : '') + '后才能结案'
    if (c && c.status !== 'closed') addTimeline(s.crisis_id, '声明部分失败', note, ts)
    if (s.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        s.work_order_id, 'stmt', note, operator, '', ts)
    }
    // 通知升级：按「进入部分失败的轮次」幂等（重试恢复后再次失败可再次督办）
    const partialRound = q1("SELECT COUNT(*) c FROM crisis_statement_logs WHERE statement_id=? AND action='partial'", stmtId).c
    let notified = 0
    try { notified = generateForStatement(stmtId, 'partial', { ok, failed, cancelled, total: rows.length, partialRound }).length } catch (e) { console.error('[STMT] 部分失败通知生成失败：', e.message) }
    addLog(stmtId, 'notify_partial', `部分失败督办通知已按订阅生成 ${notified} 个任务（含需回执升级链）`, operator)
    return
  }

  // 无在途、无失败：全部成功（可能夹有取消）→ 发布完成
  // 失败渠道重试登记/重试接口会先把声明重开 publishing，故此处以 degraded_at 标记识别「降级后补齐恢复」
  const wasDegraded = s.status === 'degraded' || !!s.degraded_at
  run("UPDATE crisis_statements SET status='published', published_at=?, updated=? WHERE id=?", ts, ts, stmtId)
  if (wasDegraded) {
    // 降级后失败渠道经重试全部成功：补齐为完整发布（清降级标记，降级过程留痕保留可溯）
    run("UPDATE crisis_statements SET degraded_mode=NULL, degraded_at=NULL, degraded_by='', degrade_reason='' WHERE id=?", stmtId)
    addLog(stmtId, 'degrade_recovered', `降级保留的失败渠道已全部重试成功（成功 ${ok}${cancelled ? `、取消 ${cancelled}` : ''}），声明恢复为「已发布」完整口径`, operator)
    if (c && c.status !== 'closed') addTimeline(s.crisis_id, '声明补齐完成', `声明「${s.title}」原降级失败渠道已全部发布成功，恢复为完整发布：${ok}/${rows.length} 个渠道已发布`, ts)
    if (s.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        s.work_order_id, 'stmt', `声明「${s.title}」降级失败渠道重试补齐，恢复为完整发布（${ok}/${rows.length}）`, operator, '', ts)
    }
    return
  }
  addLog(stmtId, 'done', `全部 ${rows.length} 个渠道执行登记完成：成功 ${ok}` + (cancelled ? `、取消 ${cancelled}` : ''), operator)
  const note = `声明「${s.title}」分渠道发布完成：${ok}/${rows.length} 个渠道已发布` + (cancelled ? `（${cancelled} 个渠道取消）` : '')
  if (c && c.status !== 'closed') addTimeline(s.crisis_id, '声明发布完成', note, ts)
  if (s.work_order_id) {
    run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
      s.work_order_id, 'stmt', note, operator, '', ts)
  }
}

// ===== 降级发布收口（manual 手动确认 / auto 自动；失败渠道保留失败记录并终止，声明→degraded 终态） =====
// 与「逐渠道放弃（取消）」的区别：放弃会抹去失败事实（渠道变 cancelled），降级发布在保留失败记录的前提下收口，
// 失败渠道事后仍可重试，重试全部成功后由 degraded 恢复为 published。
function applyDegrade(stmtId, opts = {}) {
  const s = opts.s || q1('SELECT * FROM crisis_statements WHERE id=?', stmtId)
  if (!s) return { error: 'not found' }
  const rows = opts.rows || q('SELECT * FROM crisis_statement_channels WHERE statement_id=?', stmtId)
  const total = opts.total ?? rows.length
  const ok = opts.ok ?? rows.filter((r) => r.status === 'success').length
  const failed = opts.failed ?? rows.filter((r) => r.status === 'failed').length
  const cancelled = opts.cancelled ?? rows.filter((r) => r.status === 'cancelled').length
  const policy = opts.policy || resolvePolicy(s)
  const mode = opts.mode === 'auto' ? 'auto' : 'manual'
  const operator = opts.operator || (mode === 'auto' ? '系统' : '系统')
  const reason = String(opts.reason || '').trim() ||
    (mode === 'auto'
      ? `失败占比未超阈值，系统按自动降级策略收口（成功 ${ok}/${total}）`
      : '经发布负责人确认，失败渠道降级终止，已发布渠道先行生效')
  const ts = now()
  const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
  let notified = 0

  db.exec('BEGIN')
  try {
    run(`UPDATE crisis_statements SET status='degraded', degraded_mode=?, degraded_at=?, degraded_by=?, degrade_reason=?,
      published_at=?, updated=? WHERE id=?`,
      mode, ts, operator, reason, ts, ts, stmtId)
    // 失败渠道保持 failed（失败事实不抹除）：仅声明级收口，渠道仍可事后重试补齐
    const detail = `按${mode === 'auto' ? '自动' : '手动确认'}降级策略降级发布：成功 ${ok}/${total}` +
      (failed ? `、失败 ${failed}（终止保留，可事后重试补齐）` : '') + (cancelled ? `、取消 ${cancelled}` : '') +
      `；失败占比阈值 ${Math.round(policy.maxFailRatio * 100)}%、成功下限 ${policy.minSuccess}` +
      (reason ? `；说明：${reason}` : '')
    addLog(stmtId, 'degraded', detail, operator)
    const note = `声明「${s.title}」降级发布：${ok}/${total} 个渠道已发布，${failed} 个失败渠道${mode === 'auto' ? '按自动策略终止' : '经确认降级终止'}` +
      (cancelled ? `、${cancelled} 个取消` : '') + '（失败记录保留，可事后重试补齐），声明不再阻塞危机结案'
    if (c && c.status !== 'closed') addTimeline(s.crisis_id, '声明降级发布', note, ts)
    if (s.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        s.work_order_id, 'stmt', note, operator, '', ts)
      run('UPDATE work_orders SET last_statement_id=? WHERE id=?', stmtId, s.work_order_id)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  // 降级发布知会通知（事务外；按声明+降级轮次幂等，自动/手动降级均触达）
  try {
    const degradeRound = q1("SELECT COUNT(*) c FROM crisis_statement_logs WHERE statement_id=? AND action='degraded'", stmtId).c
    notified = generateForStatement(stmtId, 'degraded', {
      mode, ok, failed, cancelled, total, degradeRound,
      failRatio: opts.failRatio ?? (total ? failed / total : 0)
    }).length
  } catch (e) { console.error('[STMT] 降级发布通知生成失败：', e.message) }
  addLog(stmtId, 'notify_degraded', `降级发布知会通知已按订阅生成 ${notified} 个任务`, operator)
  return { ok: true, mode, notified }
}

// 手动降级发布（仅 partial；按生效策略校验阈值与模式）
export function degradeStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
  if (c && c.status === 'closed') return { error: '所属危机事件已结案，不能再降级发布（如需继续处置请先回滚结案）' }
  if (s.status !== 'partial') return { error: `仅「部分渠道失败」的声明可降级发布（当前：${STMT_STATUS[s.status] || s.status}）` }
  const rows = q('SELECT * FROM crisis_statement_channels WHERE statement_id=?', id)
  const open = rows.filter((r) => ['pending', 'publishing'].includes(r.status)).length
  if (open > 0) return { error: '仍有渠道在执行中，需全部渠道登记完成后再降级发布' }
  const policy = resolvePolicy(s)
  if (policy.mode === 'block') return { error: '当前降级策略为「阻断」，不允许降级发布；请重试失败渠道、逐渠道放弃，或由管理员调整降级策略' }
  const ok = rows.filter((r) => r.status === 'success').length
  const failed = rows.filter((r) => r.status === 'failed').length
  const cancelled = rows.filter((r) => r.status === 'cancelled').length
  const eg = degradeEligibility(policy, { ok, failed, total: rows.length })
  if (!eg.eligible) return { error: '不满足降级发布门槛：' + eg.reasons.join('；') }
  return applyDegrade(id, { mode: 'manual', operator: actor?.user || '系统', reason: String(body?.reason || ''), policy, rows, ok, failed, cancelled, total: rows.length, failRatio: eg.failRatio })
}

// 单份声明降级策略覆盖（起草/待审/已通过/发布中/部分失败均可配置；发布终态/取消后冻结）
export function updateStatementPolicy(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (!['draft', 'review', 'approved', 'publishing', 'partial'].includes(s.status)) {
    return { error: `声明当前为「${STMT_STATUS[s.status]}」，降级策略已冻结` }
  }
  const b = body || {}
  let value = ''
  if (b.reset) {
    value = '' // 清空覆盖，沿用全局默认
  } else {
    const g = getGlobalDegradePolicy()
    const merged = normPolicy({
      mode: b.mode ?? null,
      maxFailRatio: b.maxFailRatio ?? b.max_fail_ratio ?? null,
      minSuccess: b.minSuccess ?? b.min_success ?? null
    }, g)
    value = JSON.stringify(merged)
  }
  run('UPDATE crisis_statements SET degrade_policy=?, updated=? WHERE id=?', value, now(), id)
  addLog(id, 'degrade_policy', value ? `降级发布策略调整为：${policyText(safeParse(value, null))}` : '降级发布策略改回沿用全局默认', actor?.user || '系统')
  // 策略（覆盖或重置回全局）可能在 partial 时放宽为 auto 且已满足阈值：按生效策略立即重算一次（auto 自动降级）
  if (s.status === 'partial') recomputePublishing(id, actor?.user || '系统')
  return { ok: true, policy: value ? safeParse(value, null) : getGlobalDegradePolicy() }
}

function policyText(p) {
  if (!p) return '沿用全局默认'
  return `模式 ${DEGRADE_MODE_TEXT[p.mode] || p.mode} · 失败占比≤${Math.round((p.maxFailRatio ?? 0) * 100)}% · 至少 ${p.minSuccess ?? 0} 个渠道成功`
}

// ===== 创建（公关起草） =====
export function createStatement(body, actor) {
  const b = body || {}
  const crisisId = +b.crisis_id
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return { error: '所属危机事件不存在' }
  if (c.status === 'closed') return { error: '事件已结案，不能再起草危机声明（如需发布请先回滚结案）' }
  const title = String(b.title || '').trim()
  if (!title) return { error: '声明标题必填' }
  const channels = normChannels(b.channels)
  const priority = STMT_PRIORITY[b.priority] ? b.priority : 'high'
  const policyErr = validateDegradePolicyInput(b.degrade_policy)
  if (policyErr) return { error: policyErr }
  // 关联处置工单（可选）：须属于该危机且未取消
  let woId = null
  if (b.work_order_id) {
    const wo = q1('SELECT * FROM work_orders WHERE id=?', +b.work_order_id)
    if (!wo || wo.crisis_id !== crisisId) return { error: '关联工单不存在或不属于该危机事件' }
    if (wo.status === 'cancelled') return { error: '关联工单已取消，不能关联' }
    woId = wo.id
  }
  const ts = now()
  const policyJson = normDegradePolicyInput(b.degrade_policy)
  const r = run(`INSERT INTO crisis_statements
    (crisis_id,work_order_id,title,content,channels,priority,status,degrade_policy,drafted_by,drafted_at,created,updated)
    VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?)`,
    crisisId, woId, title, String(b.content || '').trim(), JSON.stringify(channels), priority, policyJson, actor.user, ts, ts, ts)
  const id = Number(r.lastInsertRowid)
  if (woId) run('UPDATE work_orders SET last_statement_id=? WHERE id=?', id, woId)
  addLog(id, 'create', `公关起草危机声明（${STMT_PRIORITY[priority]}）` + (channels.length ? `，拟定发布渠道：${channels.map((k) => STMT_CHANNELS[k]).join('、')}` : '，暂未指定发布渠道'), actor.user)
  if (policyJson) addLog(id, 'degrade_policy', `降级发布策略：${policyText(safeParse(policyJson, null))}`, actor.user)
  addTimeline(crisisId, '声明起草', `公关 ${actor.user} 起草危机声明「${title}」`, ts)
  if (woId) {
    run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
      woId, 'stmt', `公关 ${actor.user} 起草关联危机声明「${title}」`, actor.user, actor.assigneeRole || actor.role || '', ts)
  }
  return { ok: true, id }
}

function normChannels(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map((x) => String(x || '').trim()).filter((x) => STMT_CHANNELS[x]))]
}

// 请求体中的声明级降级策略 → 落库 JSON（''=沿用全局默认；字段缺省以全局默认补齐；非法模式抛回错误文案）
function normDegradePolicyInput(input) {
  if (input === undefined || input === null || input === '') return ''
  if (input === false) return ''
  const g = getGlobalDegradePolicy()
  const p = normPolicy(input, g)
  return JSON.stringify(p)
}

export function validateDegradePolicyInput(input) {
  if (input === undefined || input === null || input === '' || input === false) return null
  if (typeof input !== 'object') return '降级策略格式非法'
  if (input.mode !== undefined && !DEGRADE_MODE_TEXT[input.mode]) return '降级模式无效（block/manual/auto）'
  if (input.maxFailRatio !== undefined && input.maxFailRatio !== null && input.maxFailRatio !== '') {
    const v = Number(input.maxFailRatio)
    if (!Number.isFinite(v) || v < 0 || v > 1) return '最大失败占比需为 0~1 之间（如 0.5）'
  }
  if (input.minSuccess !== undefined && input.minSuccess !== null && input.minSuccess !== '') {
    const v = Number(input.minSuccess)
    if (!Number.isInteger(v) || v < 0) return '成功渠道数下限需为非负整数'
  }
  return null
}

// ===== 编辑（起草中；驳回退回后可修改重新送审） =====
export function editStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'draft') return { error: `仅起草中的声明可编辑（当前：${STMT_STATUS[s.status]}；审核驳回后会退回起草）` }
  const b = body || {}
  const title = b.title !== undefined ? String(b.title).trim() : s.title
  if (!title) return { error: '声明标题必填' }
  const content = b.content !== undefined ? String(b.content) : s.content
  const channels = b.channels !== undefined ? normChannels(b.channels) : safeParse(s.channels, [])
  const priority = b.priority !== undefined ? (STMT_PRIORITY[b.priority] ? b.priority : s.priority) : s.priority
  let policyJson
  let policyChanged = false
  if (b.degrade_policy !== undefined) {
    const policyErr = validateDegradePolicyInput(b.degrade_policy)
    if (policyErr) return { error: policyErr }
    policyJson = normDegradePolicyInput(b.degrade_policy)
    policyChanged = policyJson !== (s.degrade_policy || '')
  } else {
    policyJson = s.degrade_policy || ''
  }
  const ts = now()
  run('UPDATE crisis_statements SET title=?, content=?, channels=?, priority=?, degrade_policy=?, updated=? WHERE id=?',
    title, content, JSON.stringify(channels), priority, policyJson, ts, id)
  const parts = []
  if (title !== s.title) parts.push(`标题改为「${title}」`)
  if (content !== s.content) parts.push(content.trim() ? '更新声明正文' : '清空声明正文')
  if (JSON.stringify(channels) !== s.channels) parts.push(`发布渠道调整为：${channels.length ? channels.map((k) => STMT_CHANNELS[k]).join('、') : '（未指定）'}`)
  if (priority !== s.priority) parts.push(`优先级调整为${STMT_PRIORITY[priority]}`)
  if (policyChanged) parts.push(`降级发布策略调整为：${policyJson ? policyText(safeParse(policyJson, null)) : '沿用全局默认'}`)
  addLog(id, 'edit', parts.length ? parts.join('；') : '保存（无内容变化）', actor.user)
  return { ok: true }
}

// ===== 提交法务审核（draft → review） =====
export function submitStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'draft') return { error: `仅起草中的声明可提交审核（当前：${STMT_STATUS[s.status]}）` }
  if (!(s.content || '').trim() && !(body?.content || '').trim()) return { error: '声明正文为空，请先完成起草再送审' }
  const channels = s.channels ? safeParse(s.channels, []) : []
  if (!channels.length) return { error: '请至少选择一个拟发布渠道后再送审' }
  const ts = now()
  const content = body?.content !== undefined ? String(body.content) : s.content
  run("UPDATE crisis_statements SET status='review', content=COALESCE(NULLIF(?, ''), content), submitted_by=?, submitted_at=?, review_note='', updated=? WHERE id=?",
    content, actor.user, ts, ts, id)
  addLog(id, 'submit', '提交法务审核，等待法务意见', actor.user)
  syncProgress(id, '声明送审', `声明「${s.title}」提交法务审核（提交人：${actor.user}），拟定渠道：${channels.map((k) => STMT_CHANNELS[k]).join('、')}`)
  return { ok: true }
}

// ===== 法务审核通过（review → approved，法务/管理员） =====
export function approveStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'review') return { error: `仅待审核的声明可审核（当前：${STMT_STATUS[s.status]}）` }
  const note = String(body?.note || '').trim() || '口径与证据材料一致，同意按审核稿发布。'
  const ts = now()
  run("UPDATE crisis_statements SET status='approved', reviewed_by=?, reviewed_at=?, review_note=?, updated=? WHERE id=?",
    actor.user, ts, note, ts, id)
  addLog(id, 'approve', `法务审核通过：${note}`, actor.user)
  syncProgress(id, '声明审核通过', `法务 ${actor.user} 审核通过声明「${s.title}」：${note}`, { woRole: 'legal' })
  return { ok: true }
}

// ===== 法务审核驳回（review → draft，法务/管理员） =====
export function rejectStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'review') return { error: `仅待审核的声明可驳回（当前：${STMT_STATUS[s.status]}）` }
  const note = String(body?.note || '').trim() || '审核未通过，请按法务意见修改后重新提交'
  const ts = now()
  run("UPDATE crisis_statements SET status='draft', reviewed_by=?, reviewed_at=?, review_note=?, updated=? WHERE id=?",
    actor.user, ts, note, ts, id)
  addLog(id, 'reject', `法务审核驳回，退回起草：${note}`, actor.user)
  syncProgress(id, '声明审核驳回', `法务 ${actor.user} 驳回声明「${s.title}」：${note}（退回公关修改）`, { woRole: 'legal' })
  return { ok: true }
}

// ===== 发起分渠道发布（approved → publishing；落渠道执行行，可在此最终确认渠道清单） =====
export function startPublishing(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (s.status !== 'approved') return { error: `仅审核通过的声明可发起发布（当前：${STMT_STATUS[s.status]}）` }
  // 发起前可最终确认渠道清单（缺省沿用起草时选择）
  const channels = body?.channels ? normChannels(body.channels) : safeParse(s.channels, [])
  if (!channels.length) return { error: '至少需要一个发布渠道' }
  // 发起发布时可最终确认降级策略（缺省沿用起草配置/全局默认）
  let policyJson = s.degrade_policy || ''
  if (body && body.degrade_policy !== undefined) {
    const policyErr = validateDegradePolicyInput(body.degrade_policy)
    if (policyErr) return { error: policyErr }
    policyJson = normDegradePolicyInput(body.degrade_policy)
  }
  const ts = now()
  db.exec('BEGIN')
  try {
    run("UPDATE crisis_statements SET status='publishing', channels=?, degrade_policy=?, publish_by=?, publish_at=?, updated=? WHERE id=?",
      JSON.stringify(channels), policyJson, actor.user, ts, ts, id)
    for (const key of channels) {
      const exists = q1('SELECT 1 FROM crisis_statement_channels WHERE statement_id=? AND channel=?', id, key)
      if (!exists) {
        run(`INSERT INTO crisis_statement_channels (statement_id,channel,channel_name,status,assignee,created,updated)
          VALUES (?,?,?,'pending',?,?,?)`, id, key, STMT_CHANNELS[key], String(body?.assignee || actor.user || ''), ts, ts)
      }
    }
    addLog(id, 'publish', `发起分渠道发布，${channels.length} 个渠道待执行（执行人：${body?.assignee || actor.user}）` +
      (policyJson ? `；降级策略：${policyText(safeParse(policyJson, null))}` : '；降级策略沿用全局默认'), actor.user)
    const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
    if (c && c.status !== 'closed') {
      addTimeline(s.crisis_id, '声明发布',
        `声明「${s.title}」发起分渠道发布：${channels.map((k) => STMT_CHANNELS[k]).join('、')}（发起人：${actor.user}）`, ts)
    }
    if (s.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        s.work_order_id, 'stmt', `关联声明「${s.title}」发起分渠道发布（${channels.length} 个渠道）`, actor.user, actor.assigneeRole || actor.role || '', ts)
      run('UPDATE work_orders SET last_statement_id=? WHERE id=?', id, s.work_order_id)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true }
}

// 渠道行（调用方已校验声明存在）
function getChannel(rowId) {
  return q1(`SELECT sc.*, s.title s_title, s.crisis_id, s.work_order_id, s.status s_status, c.status crisis_status
    FROM crisis_statement_channels sc JOIN crisis_statements s ON s.id=sc.statement_id
    JOIN crisis c ON c.id=s.crisis_id WHERE sc.id=?`, rowId)
}

// 结案守卫联动：已结案事件的发布档案保持稳定，渠道执行登记/重试/放弃需先回滚结案
function assertCrisisOpen(row, action) {
  if (row.crisis_status === 'closed') return { error: `所属危机事件已结案，不能${action}（如需继续处置请先回滚结案）` }
  return null
}

// ===== 登记渠道执行结果（发布人员分渠道执行并登记：执行中/成功/失败） =====
export function registerChannel(rowId, body, actor) {
  const row = getChannel(rowId)
  if (!row) return null
  const closedErr = assertCrisisOpen(row, '登记渠道执行结果')
  if (closedErr) return closedErr
  if (!['publishing', 'partial', 'published', 'degraded'].includes(row.s_status)) return { error: `声明当前为「${STMT_STATUS[row.s_status]}」，不可登记渠道结果` }
  const next = String(body?.status || '')
  if (!['publishing', 'success', 'failed'].includes(next)) return { error: '登记状态非法（执行中/已发布/失败）' }
  // 待执行/执行中可登记；失败渠道可在不重置的情况下再次登记（失败→成功的即时补救）；降级发布保留的失败渠道同样可登记补救
  if (!['pending', 'publishing', 'failed'].includes(row.status)) return { error: `该渠道当前为「${CH_STATUS[row.status]}」，不能重复登记` }
  if (next === 'failed' && !String(body?.fail_reason || '').trim()) return { error: '登记失败时请填写失败原因' }
  if (next === 'success' && !String(body?.result || '').trim()) return { error: '登记发布成功时请填写发布结果/回执说明' }
  const ts = now()
  const result = String(body?.result || '').trim()
  const url = String(body?.published_url || '').trim()
  const failReason = String(body?.fail_reason || '').trim()
  const assignee = String(body?.assignee || '').trim() || row.assignee || actor.user
  db.exec('BEGIN')
  try {
    // 失败后重试成功/补救：声明从已发布（部分失败）、部分失败或已降级发布重新打开发布中
    if (['published', 'partial', 'degraded'].includes(row.s_status)) run("UPDATE crisis_statements SET status='publishing', published_at=NULL, updated=? WHERE id=?", ts, row.statement_id)
    run(`UPDATE crisis_statement_channels SET status=?, result=?, published_url=?, fail_reason=?, assignee=?,
      attempts=attempts+1, registered_by=?, registered_at=?, published_at=COALESCE(published_at,CASE WHEN ?='success' THEN ? ELSE published_at END), updated=?
      WHERE id=?`,
      next, result, url, failReason, assignee, actor.user, ts, next, ts, ts, rowId)
    const chText = STMT_CHANNELS[row.channel] || row.channel_name
    const detail = next === 'success'
      ? `【${chText}】发布成功：${result}${url ? `（链接：${url}）` : ''}`
      : next === 'failed'
        ? `【${chText}】发布失败：${failReason}`
        : `【${chText}】开始执行（执行人：${assignee}）`
    addLog(row.statement_id, 'channel_result', detail, actor.user)
    const c = q1('SELECT status FROM crisis WHERE id=?', row.crisis_id)
    if (c && c.status !== 'closed') addTimeline(row.crisis_id, '声明渠道', detail, ts)
    if (row.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        row.work_order_id, 'stmt', `声明发布进度回写：${detail}`, actor.user, actor.assigneeRole || actor.role || '', ts)
      run('UPDATE work_orders SET last_statement_id=? WHERE id=?', row.statement_id, row.work_order_id)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  // 单渠道失败即时通知升级（按渠道行+尝试次数幂等：重试后再次失败可再次通知）
  if (next === 'failed') {
    const fresh = q1('SELECT attempts FROM crisis_statement_channels WHERE id=?', rowId)
    const allRows = q('SELECT status FROM crisis_statement_channels WHERE statement_id=?', row.statement_id)
    const ok = allRows.filter((r) => r.status === 'success').length
    const failed = allRows.filter((r) => r.status === 'failed').length
    try {
      generateForStatement(row.statement_id, 'chfail', {
        channelRow: rowId, channelName: chTextOf(row), failReason, ok, failed, total: allRows.length,
        attempt: fresh ? fresh.attempts : 1
      })
    } catch (e) { console.error('[STMT] 渠道失败通知生成失败：', e.message) }
  }
  recomputePublishing(row.statement_id, actor.user)
  return { ok: true }
}

function chTextOf(row) {
  return STMT_CHANNELS[row.channel] || row.channel_name || row.channel
}

// ===== 失败渠道重试（failed → pending，声明重回发布中） =====
export function retryChannel(rowId, body, actor) {
  const row = getChannel(rowId)
  if (!row) return null
  const closedErr = assertCrisisOpen(row, '重试渠道')
  if (closedErr) return closedErr
  if (!['publishing', 'partial', 'published', 'degraded'].includes(row.s_status)) return { error: '声明未在发布阶段，不能重试渠道' }
  if (row.status !== 'failed') return { error: `仅失败渠道可重试（当前：${CH_STATUS[row.status]}）` }
  const ts = now()
  const assignee = String(body?.assignee || '').trim() || row.assignee || actor.user
  db.exec('BEGIN')
  try {
    run("UPDATE crisis_statement_channels SET status='pending', fail_reason='', assignee=?, updated=? WHERE id=?", assignee, ts, rowId)
    run("UPDATE crisis_statements SET status='publishing', published_at=NULL, updated=? WHERE id=?", ts, row.statement_id)
    const chText = STMT_CHANNELS[row.channel] || row.channel_name
    addLog(row.statement_id, 'channel_retry', `【${chText}】重试发布（执行人：${assignee}），上次失败原因：${row.fail_reason || '—'}`, actor.user)
    const c = q1('SELECT status FROM crisis WHERE id=?', row.crisis_id)
    if (c && c.status !== 'closed') addTimeline(row.crisis_id, '声明渠道', `【${chText}】发布失败后重试（执行人：${assignee}）`, ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true }
}

// ===== 取消/放弃单个渠道 =====
// 待执行/执行中渠道：仅发布中可取消；失败渠道：发布中或部分失败时可「放弃」（放弃后重算声明状态）
export function cancelChannel(rowId, body, actor) {
  const row = getChannel(rowId)
  if (!row) return null
  const closedErr = assertCrisisOpen(row, row.status === 'failed' ? '放弃失败渠道' : '取消渠道')
  if (closedErr) return closedErr
  const isFailed = row.status === 'failed'
  if (isFailed) {
    // 部分失败可放弃；已降级发布时也允许逐渠道放弃（终态保持，不重算，与降级留痕一致）
    if (!['publishing', 'partial', 'degraded'].includes(row.s_status)) return { error: '声明当前状态不能放弃失败渠道' }
  } else if (row.s_status !== 'publishing') {
    return { error: '仅发布中的声明可取消待执行/执行中渠道' }
  }
  if (!isFailed && !['pending', 'publishing'].includes(row.status)) return { error: `渠道当前为「${CH_STATUS[row.status]}」，不能取消` }
  const reason = String(body?.reason || '').trim() || (isFailed ? '放弃该失败渠道' : '该渠道不再发布')
  const ts = now()
  run("UPDATE crisis_statement_channels SET status='cancelled', fail_reason=?, registered_by=?, registered_at=?, updated=? WHERE id=?",
    reason, actor.user, ts, ts, rowId)
  const chText = STMT_CHANNELS[row.channel] || row.channel_name
  addLog(row.statement_id, 'channel_cancel', `【${chText}】${isFailed ? '放弃发布（该渠道失败终止）' : '取消发布'}：${reason}`, actor.user)
  const c = q1('SELECT status FROM crisis WHERE id=?', row.crisis_id)
  if (c && c.status !== 'closed') addTimeline(row.crisis_id, '声明渠道', `【${chText}】${isFailed ? '放弃发布' : '取消发布'}：${reason}`, ts)
  if (row.work_order_id) {
    run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
      row.work_order_id, 'stmt', `声明发布进度回写：【${chText}】${isFailed ? '放弃发布' : '取消发布'}：${reason}`, actor.user, '', ts)
  }
  recomputePublishing(row.statement_id, actor.user)
  return { ok: true }
}

// ===== 取消整份声明（draft/approved/publishing/partial → cancelled；发布中/部分失败的在途与失败渠道一并取消） =====
// degraded/published 为已对外发布的终态，不可取消（如需终止须经危机处置另行说明）。
export function cancelStatement(id, body, actor) {
  const s = q1('SELECT * FROM crisis_statements WHERE id=?', id)
  if (!s) return null
  if (!['draft', 'review', 'approved', 'publishing', 'partial'].includes(s.status)) {
    return { error: `当前状态（${STMT_STATUS[s.status]}）不能取消` }
  }
  const reason = String(body?.reason || '').trim()
  const ts = now()
  db.exec('BEGIN')
  try {
    run("UPDATE crisis_statements SET status='cancelled', published_at=NULL, cancel_by=?, cancel_at=?, cancel_reason=?, updated=? WHERE id=?",
      actor.user, ts, reason, ts, id)
    const cr = run("UPDATE crisis_statement_channels SET status='cancelled', updated=? WHERE statement_id=? AND status IN ('pending','publishing','failed')", ts, id)
    addLog(id, 'cancel', (['publishing', 'partial'].includes(s.status) ? `取消声明发布，${Number(cr.changes)} 个在途/失败渠道一并取消` : '取消危机声明') + (reason ? `：${reason}` : ''), actor.user)
    const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
    if (c && c.status !== 'closed') {
      addTimeline(s.crisis_id, '声明取消', `声明「${s.title}」已取消${reason ? `：${reason}` : ''}` +
        (['publishing', 'partial'].includes(s.status) ? `（${Number(cr.changes)} 个在途/失败渠道一并取消）` : ''), ts)
    }
    if (s.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        s.work_order_id, 'stmt', `关联危机声明「${s.title}」已取消${reason ? `：${reason}` : ''}`, actor.user, '', ts)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true }
}

// 删除危机时级联清理（由 index.js 危机删除链路调用）
export function deleteStatementsOfCrisis(crisisId) {
  const ids = q('SELECT id FROM crisis_statements WHERE crisis_id=?', crisisId).map((r) => r.id)
  for (const id of ids) {
    run('DELETE FROM crisis_statement_channels WHERE statement_id=?', id)
    run('DELETE FROM crisis_statement_logs WHERE statement_id=?', id)
    try { deleteNotifyOfStatement(id) } catch (e) { console.error('[STMT] 通知任务级联清理失败：', e.message) }
  }
  run('DELETE FROM crisis_statements WHERE crisis_id=?', crisisId)
  run('UPDATE work_orders SET last_statement_id=NULL WHERE crisis_id=?', crisisId)
  return ids.length
}
