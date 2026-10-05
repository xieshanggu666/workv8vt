<template>
  <div class="stmt">
    <div class="toolbar">
      <button v-if="canOps" class="add" @click="openForm()">＋ 起草危机声明</button>
      <div class="chips">
        <button class="chip" :class="{on:!filter}" @click="setFilter('')">全部 {{ totalCount }}</button>
        <button v-for="(txt,k) in dict.status" :key="k" class="chip" :class="[k,{on:filter===k}]" @click="setFilter(k)">
          {{ txt }} {{ summary.counts?.[k] || 0 }}
        </button>
        <span v-if="summary.channelOpen" class="chip ch-open">📤 待执行渠道 {{ summary.channelOpen }}</span>
        <span v-if="summary.channelFailed" class="chip ch-fail">⚠️ 阻断结案失败渠道 {{ summary.channelFailed }}</span>
      </div>
      <button v-if="isAdmin" class="policy-btn" @click="openGlobalPolicy">⚙️ 降级策略（{{ modeShort(globalPolicy.mode) }}）</button>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>
    <p class="hint">
      🔗 公关起草危机声明 → 提交法务审核（通过/驳回可重编）→ 审核通过后发起分渠道发布，发布人员按渠道执行并逐条登记结果；
      起草/送审/审核/每个渠道的执行进度自动<b>回写处置工单日志与危机统一时间线</b>；全部渠道<b>成功</b>才发布完成。
      分渠道失败处理已升级为<b>可配置降级发布</b>：
      <b>{{ modeShort('block') }}=保持部分失败阻断结案</b>；
      <b>{{ modeShort('manual') }}=确认后降级发布</b>（失败渠道终止但保留失败记录，不再阻塞结案，事后可重试补齐）；
      <b>{{ modeShort('auto') }}=失败占比/成功数满足阈值自动降级</b>。全局策略管理员可配，单份声明可单独覆盖；历史部分失败记录按原口径保持阻断。
    </p>

    <!-- 起草表单 -->
    <form v-if="showForm" class="s-form" @submit.prevent="create">
      <div v-if="!openCrises.length" class="no-crisis">⚠️ 暂无未结案危机事件，无法起草声明（已结案事件需先回滚结案）</div>
      <template v-else>
        <div class="row">
          <select v-model.number="form.crisis_id" required @change="onCrisisChange">
            <option :value="null" disabled>选择所属危机事件（未结案）</option>
            <option v-for="c in openCrises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}（{{ stText(c.status) }}）</option>
          </select>
          <select v-model="form.priority" style="max-width:110px">
            <option v-for="(t,k) in dict.priority" :key="k" :value="k">{{ t }}</option>
          </select>
          <select v-model.number="form.work_order_id" style="max-width:240px">
            <option :value="null">关联处置工单（可选）</option>
            <option v-for="w in crisisWorkOrders" :key="w.id" :value="w.id">
              #{{ w.id }} {{ w.title }}（{{ w.statusText }}）
            </option>
          </select>
        </div>
        <input v-model="form.title" placeholder="声明标题，如 关于某事件的官方说明" required />
        <textarea v-model="form.content" class="content" placeholder="声明正文：事实说明、处置措施、致歉与承诺、后续安排…"></textarea>
        <div class="ch-pick">
          <span class="lbl">拟发布渠道：</span>
          <label v-for="(name,key) in dict.channels" :key="key" class="ch-opt" :class="{on:form.channels.includes(key)}">
            <input type="checkbox" :value="key" v-model="form.channels" /> {{ name }}
          </label>
        </div>
        <PolicyEditor :policy="form.degrade_policy" :global-policy="globalPolicy" @change="(p)=>form.degrade_policy=p" />
        <div class="row">
          <button class="save" type="submit">保存起草</button>
          <button type="button" class="ghost" @click="showForm=false">取消</button>
        </div>
      </template>
    </form>

    <div v-if="!items.length" class="none">暂无危机声明（在危机处置页或此处为未结案事件起草）</div>

    <div class="list">
      <div v-for="s in items" :key="s.id" class="s-card" :class="[s.status, {hl: highlightId===s.id}]">
        <div class="s-head">
          <span class="st" :class="s.status">{{ s.statusText }}</span>
          <span class="pri" :class="s.priority">{{ s.priorityText }}</span>
          <b class="s-title">{{ s.title }}</b>
          <span class="cid">危机 #{{ s.crisis_id }} {{ s.crisis_title }}</span>
          <span v-if="s.work_order_id" class="wo-link" @click="gotoWorkOrder(s)">📋 工单 #{{ s.work_order_id }}{{ s.wo_title ? ' '+s.wo_title : '' }}</span>
          <span class="upd">{{ s.updated }}</span>
        </div>

        <!-- 驳回原因 -->
        <div v-if="s.status==='draft' && s.review_note && s.reviewed_by" class="reject-box">
          ↩ 法务驳回意见（{{ s.reviewed_by }}）：{{ s.review_note }}——请修改后重新送审
        </div>

        <!-- 声明正文（起草中可直接编辑） -->
        <div class="s-body">
          <template v-if="editingId===s.id">
            <input v-model="editForm.title" placeholder="声明标题" />
            <textarea v-model="editForm.content" class="content" placeholder="声明正文"></textarea>
            <div class="ch-pick">
              <span class="lbl">拟发布渠道：</span>
              <label v-for="(name,key) in dict.channels" :key="key" class="ch-opt" :class="{on:editForm.channels.includes(key)}">
                <input type="checkbox" :value="key" v-model="editForm.channels" /> {{ name }}
              </label>
            </div>
            <PolicyEditor :policy="editForm.degrade_policy" :global-policy="globalPolicy" @change="(p)=>editForm.degrade_policy=p" />
            <div class="row">
              <button class="save sm" @click="saveEdit(s)">保存</button>
              <button class="ghost sm" @click="editingId=null">取消</button>
            </div>
          </template>
          <template v-else>
            <pre class="content-text">{{ s.content || '（正文为空）' }}</pre>
          </template>
        </div>

        <!-- 审核信息 -->
        <div class="s-meta">
          <span v-if="s.drafted_by">起草 <i>{{ s.drafted_by }} · {{ s.drafted_at }}</i></span>
          <span v-if="s.reviewed_by">
            {{ s.status === 'draft' ? '驳回人' : '法务' }}
            <i>{{ s.reviewed_by }} · {{ s.reviewed_at }}</i>
          </span>
          <span v-if="s.publish_by">发布执行 <i>{{ s.publish_by }} · {{ s.publish_at }}</i></span>
          <span v-if="s.published_at">发布收口 <i>{{ s.published_at }}</i></span>
          <span v-if="s.status==='degraded'" class="deg-meta">
            ⬇ {{ s.degradeModeText }} <i>{{ s.degraded_by }} · {{ s.degraded_at }}</i>
          </span>
        </div>
        <div v-if="s.review_note && ['approved','publishing','partial','degraded','published'].includes(s.status)" class="review-note">
          ⚖️ 法务审核意见（{{ s.reviewed_by }}）：{{ s.review_note }}
        </div>
        <!-- 降级发布说明（失败记录保留，可事后重试补齐） -->
        <div v-if="s.status==='degraded'" class="degrade-box">
          ⬇ 已按「{{ s.degradeModeText }}」降级发布：{{ s.progress.ok }}/{{ s.channelRows.length }} 渠道已发布、失败 {{ s.progress.fail }}
          （失败渠道<b>保留记录并降级终止</b>，不再阻塞危机结案；失败渠道可<b>重试补齐</b>为完整发布）
          <div v-if="s.degrade_reason" class="deg-reason">说明：{{ s.degrade_reason }}</div>
        </div>
        <!-- 生效降级策略（发布阶段可调整；终态后只读展示） -->
        <div v-if="['approved','publishing','partial'].includes(s.status)" class="policy-line">
          <span class="pl-lbl">降级策略：</span>
          <b>{{ modeShort(s.degradePolicy.mode) }}</b>
          <i v-if="s.degradePolicy._source==='global'" class="pl-src">（全局默认）</i>
          <i v-else class="pl-src own">（本声明覆盖）</i>
          <span class="pl-thr">失败占比≤{{ Math.round(s.degradePolicy.maxFailRatio*100) }}% · 至少 {{ s.degradePolicy.minSuccess }} 渠道成功</span>
          <button v-if="canOps" class="mini-link" @click="openStmtPolicy(s)">调整 →</button>
          <span v-if="s.status==='partial'" class="pl-elig" :class="{ok:s.degrade.eligible,no:!s.degrade.eligible}">
            当前：{{ s.progress.fail }}/{{ s.channelRows.length }} 失败（{{ Math.round(s.degrade.failRatio*100) }}%）
            <template v-if="s.degrade.eligible">→ 可降级</template>
            <template v-else>→ {{ s.degrade.reasons.join('；') }}</template>
          </span>
        </div>
        <div v-else-if="s.status==='degraded'" class="policy-line readonly">
          <span class="pl-lbl">降级策略：</span><b>{{ modeShort(s.degradePolicy.mode) }}</b>
          <span class="pl-thr">失败占比≤{{ Math.round(s.degradePolicy.maxFailRatio*100) }}% · 至少 {{ s.degradePolicy.minSuccess }} 渠道成功（已收口，策略冻结）</span>
        </div>

        <!-- 部分渠道失败：发布未完成、阻塞结案的强提示 -->
        <div v-if="s.status==='partial'" class="partial-box">
          ⚠️ 部分渠道发布失败：{{ s.progress.ok }}/{{ s.channelRows.length }} 已发布、失败 {{ s.progress.fail }}，
          声明<b>未完成发布并阻塞危机结案</b>，且已按订阅触发督办通知升级——可对失败渠道<b>重试</b>、<b>放弃该渠道</b>
          <template v-if="s.degradePolicy.mode==='block'">；当前策略为「阻断」，不允许降级（可调整降级策略）</template>
          <template v-else-if="s.degrade.eligible">，或确认
            <button class="op degrade-link" @click="degrade(s)">⬇ 降级发布</button>（失败渠道终止并保留记录、不再阻塞结案，可事后重试补齐）
          </template>
          <template v-else>；当前未达到降级门槛（{{ s.degrade.reasons.join('；') }}，可重试/放弃或调整降级策略）</template>
        </div>

        <!-- 分渠道发布进度 -->
        <div v-if="['publishing','partial','degraded','published','cancelled'].includes(s.status) && s.channelRows.length" class="ch-block" :class="{degraded:s.status==='degraded'}">
          <div class="ch-progress">
            <div class="bar"><i :style="{width: s.progress.pct+'%'}" :class="{partial:s.progress.fail&&s.progress.ok&&s.status!=='degraded',degraded:s.status==='degraded'}"></i></div>
            <b>{{ s.progress.ok }}/{{ s.channelRows.length }} 已发布</b>
            <span v-if="s.progress.fail" class="f" :class="{degraded:s.status==='degraded'}">{{ s.status==='degraded' ? '降级终止失败 ' : '失败 ' }}{{ s.progress.fail }}</span>
            <span v-if="s.channelOpen" class="o">待执行 {{ s.channelOpen }}</span>
          </div>
          <div class="ch-rows">
            <div v-for="ch in s.channelRows" :key="ch.id" class="ch-row" :class="[ch.status,{degraded:s.status==='degraded'&&ch.status==='failed'}]">
              <span class="ch-dot"></span>
              <span class="ch-name">{{ ch.channelText }}</span>
              <span class="ch-st" :class="ch.status">{{ ch.statusText }}</span>
              <span class="ch-as" v-if="ch.assignee">👤 {{ ch.assignee }}</span>
              <span class="ch-result" v-if="ch.result">{{ ch.result }}</span>
              <span class="ch-result fail" v-if="ch.fail_reason">⚠️ {{ ch.fail_reason }}</span>
              <a v-if="ch.published_url" class="ch-url" :href="ch.published_url" target="_blank" rel="noopener">🔗 发布链接</a>
              <span v-if="ch.attempts>1" class="ch-try">重试 {{ ch.attempts - 1 }} 次</span>
              <span class="ch-time">{{ ch.published_at || ch.registered_at || '' }}</span>
              <span class="ch-ops" v-if="canOps">
                <button v-if="['publishing','partial'].includes(s.status) && ['pending','publishing'].includes(ch.status)" class="op start" @click="openRegister(s,ch,'publishing')">▶ 执行中</button>
                <button v-if="['publishing','partial'].includes(s.status) && ['pending','publishing'].includes(ch.status)" class="op ok" @click="openRegister(s,ch,'success')">✔ 登记已发布</button>
                <button v-if="['publishing','partial'].includes(s.status) && ['pending','publishing'].includes(ch.status)" class="op fail" @click="openRegister(s,ch,'failed')">✕ 登记失败</button>
                <button v-if="ch.status==='failed'" class="op retry" @click="retry(s,ch)">↻ 重试</button>
                <button v-if="['partial','degraded'].includes(s.status) && ch.status==='failed'" class="op ok" @click="openRegister(s,ch,'success')">✔ 直接登记成功</button>
                <button v-if="s.status==='degraded' && ch.status==='failed'" class="op cancel" @click="cancelChannel(s,ch)">放弃</button>
                <button v-if="['publishing','partial'].includes(s.status) && (['pending','publishing'].includes(ch.status) || ch.status==='failed')" class="op cancel" @click="cancelChannel(s,ch)">{{ ch.status==='failed' ? '放弃' : '取消' }}</button>
              </span>
            </div>
          </div>
        </div>

        <!-- 操作区（状态机） -->
        <div class="s-actions" v-if="canOps || s.status==='review'">
          <template v-if="canOps">
            <button v-if="s.status==='draft'" class="op edit" @click="startEdit(s)">✏️ 修改</button>
            <button v-if="s.status==='draft'" class="op submit" @click="submit(s)">⚖️ 提交法务审核</button>
            <button v-if="s.status==='review' && isAdmin" class="op approve" @click="approve(s)">✔ 法务审核通过</button>
            <button v-if="s.status==='review' && isAdmin" class="op reject" @click="reject(s)">↩ 驳回</button>
            <button v-if="s.status==='approved'" class="op publish" @click="startPublish(s)">📢 发起分渠道发布</button>
            <button v-if="['draft','review','approved','publishing','partial'].includes(s.status)" class="op cancel-stmt" @click="cancelStmt(s)">✕ 取消声明</button>
          </template>
          <span v-else-if="s.status==='review'" class="readonly-tip">👁 观察员只读：待法务（管理员）审核</span>
        </div>
        <div v-if="s.status==='review' && !isAdmin && canOps" class="review-wait">⏳ 等待法务（管理员身份）审核</div>

        <button class="logbtn" @click="toggleLogs(s)">{{ openLogsId===s.id ? '收起留痕' : '📜 全程留痕' }}</button>
        <div v-if="openLogsId===s.id" class="s-logs">
          <div v-for="l in openLogs" :key="l.id" class="slog" :class="l.action">
            <span class="lg-act">{{ logText(l.action) }}</span>
            <span class="lg-detail">{{ l.detail }}</span>
            <em>{{ l.operator }} · {{ l.time }}</em>
          </div>
        </div>
      </div>
    </div>

    <!-- 渠道结果登记弹窗 -->
    <div v-if="reg.open" class="modal-mask" @click.self="reg.open=false">
      <div class="modal">
        <h4>{{ reg.status==='success' ? '✔ 登记发布结果' : reg.status==='failed' ? '✕ 登记发布失败' : '▶ 标记渠道执行中' }}</h4>
        <p class="m-sub">{{ reg.channel?.channelText }} · 声明「{{ reg.title }}」</p>
        <label class="m-field">执行人（发布人员）
          <input v-model="reg.assignee" placeholder="该渠道发布执行人" />
        </label>
        <template v-if="reg.status==='success'">
          <label class="m-field">发布结果 / 回执说明 *
            <textarea v-model="reg.result" placeholder="如：官方微博已发布并置顶，转发 1.2w"></textarea>
          </label>
          <label class="m-field">发布链接
            <input v-model="reg.url" placeholder="https://…（可留空）" />
          </label>
        </template>
        <template v-else-if="reg.status==='failed'">
          <label class="m-field">失败原因 *
            <textarea v-model="reg.failReason" placeholder="如：媒体对接人未及时回执，可稍后重试"></textarea>
          </label>
        </template>
        <div class="m-actions">
          <button class="save" @click="submitRegister">确认登记</button>
          <button class="ghost" @click="reg.open=false">取消</button>
        </div>
      </div>
    </div>

    <!-- 单份声明降级策略 -->
    <div v-if="spolicy.open" class="modal-mask" @click.self="spolicy.open=false">
      <div class="modal">
        <h4>⚙️ 声明降级发布策略</h4>
        <p class="m-sub">「{{ spolicy.title }}」单独配置（仅在该声明发布终态前有效）</p>
        <PolicyEditor :policy="spolicy.policy" :global-policy="globalPolicy" @change="(p)=>spolicy.policy=p" />
        <div class="m-actions">
          <button class="save" @click="saveStmtPolicy">保存策略</button>
          <button class="ghost" @click="spolicy.open=false">取消</button>
        </div>
      </div>
    </div>

    <!-- 全局默认降级策略（admin） -->
    <div v-if="gpolicy.open" class="modal-mask" @click.self="gpolicy.open=false">
      <div class="modal">
        <h4>⚙️ 全局声明降级发布策略</h4>
        <p class="m-sub">对所有未单独配置降级策略的声明生效（含历史部分失败声明）</p>
        <div class="g-pol">
          <label class="g-opt" :class="{on:gpolicy.mode==='block'}">
            <input type="radio" value="block" v-model="gpolicy.mode" /> 阻断：保持「部分渠道失败」并阻塞结案，仅可重试/逐渠道放弃
          </label>
          <label class="g-opt" :class="{on:gpolicy.mode==='manual'}">
            <input type="radio" value="manual" v-model="gpolicy.mode" /> 手动确认降级：满足门槛后由发布人员确认降级收口
          </label>
          <label class="g-opt" :class="{on:gpolicy.mode==='auto'}">
            <input type="radio" value="auto" v-model="gpolicy.mode" /> 自动降级：全部渠道登记完且满足门槛时自动降级收口
          </label>
          <div v-if="gpolicy.mode!=='block'" class="g-thr">
            <label>最大失败渠道占比 ≤ <input type="number" min="0" max="100" step="5" v-model.number="gpolicy.ratioPct" /> %</label>
            <label>至少成功渠道数 <input type="number" min="0" max="20" step="1" v-model.number="gpolicy.minSuccess" /> 个</label>
          </div>
          <p class="m-sub">降级发布与「逐渠道放弃」的区别：放弃会抹去失败事实（渠道变已取消）；降级发布在<b>保留失败记录</b>的前提下收口，失败渠道事后仍可重试，全部成功后自动恢复为「已发布」。</p>
        </div>
        <div class="m-actions">
          <button class="save" @click="saveGlobalPolicy">保存全局策略</button>
          <button class="ghost" @click="gpolicy.open=false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { usePubStore } from '@/store/pub'
import PolicyEditor from './StmtPolicyEditor.vue'

const store = usePubStore()
const items = ref([])
const summary = ref({ counts: {} })
const dict = ref({ status: {}, priority: {}, channels: {}, channelStatus: {}, degradeMode: {} })
const globalPolicy = ref({ mode: 'manual', maxFailRatio: 0.5, minSuccess: 1 })
const filter = ref('')
const showForm = ref(false)
const openLogsId = ref(null)
const openLogs = ref([])
const editingId = ref(null)
const highlightId = ref(null)
const editForm = ref({ title: '', content: '', channels: [], degrade_policy: null })

const form = ref(emptyForm())
function emptyForm() {
  return { crisis_id: null, work_order_id: null, title: '', content: '', priority: 'high', channels: ['weibo', 'wechat'], degrade_policy: null }
}

// 全局降级策略弹窗（admin）
const gpolicy = ref({ open: false, mode: 'manual', ratioPct: 50, minSuccess: 1 })
// 单份声明降级策略弹窗
const spolicy = ref({ open: false, id: null, title: '', policy: null })

function modeShort(m) { return { block: '阻断', manual: '手动降级', auto: '自动降级' }[m] || m }

const reg = ref({ open: false, chId: null, status: 'success', assignee: '', result: '', url: '', failReason: '', channel: null, title: '' })

const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const isAdmin = computed(() => store.user.role === 'admin')
const openCrises = computed(() => store.crises.filter((c) => c.status !== 'closed'))
const totalCount = computed(() => Object.values(summary.value.counts || {}).reduce((a, b) => a + b, 0))
const crisisWorkOrders = computed(() => {
  if (!form.value.crisis_id) return []
  // 危机卡片工单行内统计无明细：从工单页数据拉取缓存代价大，这里直接用已加载的声明无关——改为接口拉取
  return woCache.value.filter((w) => w.crisis_id === form.value.crisis_id && w.status !== 'cancelled')
})
const woCache = ref([])

function roleText(r) { return { admin: '管理员（法务审核）', ops: '值班员（公关/发布）', viewer: '观察员' }[r] || r }
function stText(s) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[s] || s }
function logText(a) {
  return {
    create: '起草', edit: '修改', submit: '送审', approve: '审核通过', reject: '驳回',
    publish: '发起发布', channel_result: '渠道登记', channel_retry: '渠道重试',
    channel_cancel: '渠道取消/放弃', done: '发布完成', partial: '部分失败',
    degraded: '降级发布', degrade_recovered: '降级补齐恢复', notify_degraded: '降级知会通知',
    degrade_policy: '降级策略调整',
    notify_partial: '失败督办通知', cancel_all: '全部取消', migrate_status: '状态修复', cancel: '取消'
  }[a] || a
}

async function load() {
  const d = await store.fetchStatements(filter.value ? { status: filter.value } : null)
  items.value = d.items
  summary.value = d.summary
  dict.value = d.dict
  globalPolicy.value = d.degradePolicy || globalPolicy.value
}
function setFilter(k) { filter.value = k; load() }

async function loadWorkOrders() {
  try {
    const d = await store.fetchWorkOrders({ limit: 300 })
    woCache.value = d.items
  } catch { /* 非关键 */ }
}

function openForm() {
  showForm.value = true
  if (store.stmtDraftCrisis) {
    form.value = { ...emptyForm(), crisis_id: store.stmtDraftCrisis, work_order_id: store.stmtWorkOrderId || null }
    store.stmtDraftCrisis = null
    store.stmtWorkOrderId = null
  }
}
watch(() => store.stmtDraftCrisis, (id) => {
  if (id) {
    form.value = { ...emptyForm(), crisis_id: id, work_order_id: store.stmtWorkOrderId || null }
    showForm.value = true
    store.stmtDraftCrisis = null
    store.stmtWorkOrderId = null
  }
})
watch(() => store.stmtOpenId, (id) => {
  if (id) {
    openLogsId.value = id
    highlightId.value = id
    store.stmtOpenId = null
    load().then(() => refreshLogs(id)).finally(() => { setTimeout(() => { highlightId.value = null }, 4000) })
  }
})
function onCrisisChange() { form.value.work_order_id = null }

async function create() {
  const f = form.value
  if (!f.crisis_id) { store.msg('请先选择所属危机事件', 'warn'); return }
  if (!f.content.trim()) { store.msg('请填写声明正文', 'warn'); return }
  if (!f.channels.length) { store.msg('请至少选择一个拟发布渠道', 'warn'); return }
  try {
    await store.createStatement({
      crisis_id: f.crisis_id, work_order_id: f.work_order_id || null,
      title: f.title, content: f.content, priority: f.priority, channels: f.channels,
      degrade_policy: f.degrade_policy || null
    })
    form.value = emptyForm()
    showForm.value = false
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}

function startEdit(s) {
  editingId.value = s.id
  editForm.value = { title: s.title, content: s.content, channels: [...s.channels], degrade_policy: s.degradePolicyRaw || null }
}
async function saveEdit(s) {
  try {
    await store.editStatement(s.id, {
      title: editForm.value.title, content: editForm.value.content, channels: editForm.value.channels,
      priority: s.priority, degrade_policy: editForm.value.degrade_policy === null ? '' : editForm.value.degrade_policy
    })
    editingId.value = null
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}

async function submit(s) {
  if (!s.content || !s.content.trim()) { store.msg('声明正文为空，请先填写', 'warn'); return }
  try { await store.submitStatement(s.id); await load() } catch (e) { store.msg(e.message, 'warn') }
}
async function approve(s) {
  const note = prompt(`法务审核通过「${s.title}」：\n审核意见（将写入留痕与危机时间线）：`, '口径与证据材料一致，同意按审核稿发布。')
  if (note == null) return
  try { await store.approveStatement(s.id, note.trim()); await load() } catch (e) { store.msg(e.message, 'warn') }
}
async function reject(s) {
  const note = prompt(`法务驳回「${s.title}」：\n驳回原因/修改意见（退回公关起草）：`, '请补充事实依据并调整责任表述')
  if (note == null || !note.trim()) return
  try { await store.rejectStatement(s.id, note.trim()); await load() } catch (e) { store.msg(e.message, 'warn') }
}
async function startPublish(s) {
  if (!confirm(`确认对「${s.title}」发起分渠道发布？\n将按起草时选定的 ${s.channels.length} 个渠道生成执行任务，由发布人员逐渠道登记结果。`)) return
  try { await store.startStatementPublish(s.id, {}); await load() } catch (e) { store.msg(e.message, 'warn') }
}
async function cancelStmt(s) {
  const reason = prompt(`取消声明「${s.title}」？\n${['publishing', 'partial'].includes(s.status) ? '在途/失败渠道将一并取消。\n' : ''}取消原因（可留空）：`)
  if (reason == null) return
  try { await store.cancelStatement(s.id, reason.trim()); await load() } catch (e) { store.msg(e.message, 'warn') }
}

function openRegister(s, ch, status) {
  reg.value = {
    open: true, chId: ch.id, status,
    assignee: ch.assignee || store.user.name,
    result: '', url: '', failReason: '', channel: ch, title: s.title
  }
}
async function submitRegister() {
  const r = reg.value
  if (r.status === 'success' && !r.result.trim()) { store.msg('请填写发布结果/回执说明', 'warn'); return }
  if (r.status === 'failed' && !r.failReason.trim()) { store.msg('请填写失败原因', 'warn'); return }
  try {
    await store.registerStmtChannel(r.chId, {
      status: r.status, assignee: r.assignee, result: r.result, published_url: r.url, fail_reason: r.failReason
    })
    r.open = false
    await load()
    if (openLogsId.value) await refreshLogs(openLogsId.value)
  } catch (e) { store.msg(e.message, 'warn') }
}
async function retry(s, ch) {
  const assignee = prompt(`重试渠道「${ch.channelText}」：\n执行人：`, ch.assignee || store.user.name)
  if (assignee == null) return
  try { await store.retryStmtChannel(ch.id, { assignee: assignee.trim() }); await load() } catch (e) { store.msg(e.message, 'warn') }
}
async function cancelChannel(s, ch) {
  const isFail = ch.status === 'failed'
  const reason = prompt(`${isFail ? '放弃失败渠道' : '取消渠道'}「${ch.channelText}」的发布：\n${isFail ? '放弃后按该渠道终止处理，声明可继续完成发布。\n' : ''}原因：`, isFail ? '放弃该失败渠道' : '该渠道不再发布')
  if (reason == null) return
  try { await store.cancelStmtChannel(ch.id, reason.trim()); await load() } catch (e) { store.msg(e.message, 'warn') }
}

async function degrade(s) {
  const thr = `失败占比≤${Math.round(s.degradePolicy.maxFailRatio * 100)}%、至少 ${s.degradePolicy.minSuccess} 个渠道成功`
  const reason = prompt(`对「${s.title}」确认降级发布？\n当前 ${s.progress.ok}/${s.channelRows.length} 渠道已发布、${s.progress.fail} 个失败（满足${thr}）。\n失败渠道将保留失败记录并终止，声明不再阻塞危机结案，事后仍可重试补齐为完整发布。\n降级说明/审批理由：`, '失败渠道短期无法恢复，已发布渠道先行生效，失败渠道事后补发')
  if (reason == null) return
  try { await store.degradeStatement(s.id, reason.trim()); await load() } catch (e) { store.msg(e.message, 'warn') }
}

function openStmtPolicy(s) {
  spolicy.value = { open: true, id: s.id, title: s.title, policy: s.degradePolicyRaw ? { ...s.degradePolicyRaw } : null }
}
async function saveStmtPolicy() {
  const p = spolicy.value
  try {
    await store.saveStatementDegradePolicy(p.id, p.policy === null ? { reset: true } : p.policy)
    p.open = false
    await load()
    if (openLogsId.value) await refreshLogs(openLogsId.value)
  } catch (e) { store.msg(e.message, 'warn') }
}

function openGlobalPolicy() {
  gpolicy.value = {
    open: true,
    mode: globalPolicy.value.mode,
    ratioPct: Math.round(globalPolicy.value.maxFailRatio * 100),
    minSuccess: globalPolicy.value.minSuccess
  }
}
async function saveGlobalPolicy() {
  const g = gpolicy.value
  try {
    await store.saveGlobalDegradePolicy({ mode: g.mode, maxFailRatio: (Number(g.ratioPct) || 0) / 100, minSuccess: Number(g.minSuccess) || 0 })
    g.open = false
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}

async function refreshLogs(id) {
  const d = await store.fetchStatement(id)
  openLogs.value = d.logs
}
async function toggleLogs(s) {
  if (openLogsId.value === s.id) { openLogsId.value = null; openLogs.value = []; return }
  await refreshLogs(s.id)
  openLogsId.value = s.id
}
function gotoWorkOrder(s) {
  store.tab = 'work'
}

let timer = null
onMounted(async () => {
  await Promise.all([load(), loadWorkOrders()])
  if (store.stmtDraftCrisis) openForm()
  if (store.stmtOpenId) {
    const id = store.stmtOpenId
    store.stmtOpenId = null
    openLogsId.value = id
    highlightId.value = id
    await refreshLogs(id)
    setTimeout(() => { highlightId.value = null }, 4000)
  }
  timer = setInterval(load, 4000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.stmt{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.add{background:linear-gradient(135deg,#00897b,#00695c);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.chip{background:#0f1b38;border:1px solid rgba(120,160,220,0.18);color:#8ba2c8;border-radius:14px;padding:4px 12px;font-size:11px;cursor:pointer;font-family:inherit;}
.chip.on{border-color:#26a69a;color:#fff;background:#0d302c;}
.chip.review.on{border-color:#ffb300;background:#33270e;color:#ffe082;}
.chip.publishing.on{border-color:#42a5f5;background:#0d2137;color:#90caf9;}
.chip.partial.on{border-color:#ff7043;background:#33180f;color:#ffab91;}
.chip.degraded.on{border-color:#7e57c2;background:#201636;color:#b39ddb;}
.chip.published.on{border-color:#66bb6a;background:#14261a;color:#a5d6a7;}
.chip.ch-open{border-color:rgba(66,165,245,.5);color:#90caf9;background:#0d2137;cursor:default;}
.chip.ch-fail{border-color:rgba(239,83,80,.5);color:#ef9a9a;background:#2c1418;cursor:default;}
.policy-btn{background:#1a2748;border:1px solid rgba(126,87,194,.45);color:#b39ddb;border-radius:8px;padding:6px 12px;font-size:11px;cursor:pointer;font-family:inherit;}
.me{margin-left:auto;font-size:11px;color:#8ba2c8;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 12px;}
.hint{margin:0;font-size:11px;color:#5b6f94;line-height:1.6;}
.hint b{color:#80cbc4;font-weight:600;}
.s-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.no-crisis{font-size:12px;color:#ffab91;background:#3e2723;border:1px solid rgba(255,138,101,.3);border-radius:8px;padding:8px 10px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.row select,.row input{flex:1;min-width:120px;}
input,select,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea{resize:vertical;min-height:52px;}
textarea.content{min-height:120px;line-height:1.7;}
.save{background:#00897b;border:none;color:#fff;font-weight:600;cursor:pointer;}
.save.sm{padding:6px 14px;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.ghost.sm{padding:6px 14px;}
.ch-pick{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.lbl{font-size:11px;color:#8ba2c8;}
.ch-opt{font-size:11px;color:#8ba2c8;background:#0d2137;border:1px solid rgba(120,160,220,0.2);border-radius:14px;padding:4px 11px;cursor:pointer;display:inline-flex;gap:4px;align-items:center;}
.ch-opt.on{color:#80cbc4;border-color:rgba(38,166,154,.55);background:#0d302c;}
.ch-opt input{width:auto;accent-color:#26a69a;}
.none{color:#5b6f94;text-align:center;padding:32px;}
.list{display:flex;flex-direction:column;gap:12px;}
.s-card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-left:4px solid #546e7a;border-radius:10px;padding:14px 16px;position:relative;}
.s-card.draft{border-left-color:#78909c;}
.s-card.review{border-left-color:#ffb300;box-shadow:0 0 0 1px rgba(255,179,0,.12);}
.s-card.approved{border-left-color:#42a5f5;}
.s-card.publishing{border-left-color:#26c6da;}
.s-card.partial{border-left-color:#ff7043;box-shadow:0 0 0 1px rgba(255,112,67,.18);}
.s-card.degraded{border-left-color:#7e57c2;box-shadow:0 0 0 1px rgba(126,87,194,.2);}
.s-card.published{border-left-color:#66bb6a;}
.s-card.cancelled{opacity:.55;border-left-color:#616161;}
.s-card.hl{animation:hlflash 1.2s ease-in-out 3;}
@keyframes hlflash{0%,100%{box-shadow:0 0 0 0 rgba(38,166,154,0);}50%{box-shadow:0 0 0 2px rgba(38,166,154,.65);}}
.s-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.st{font-size:10px;padding:2px 9px;border-radius:6px;flex:none;}
.st.draft{background:#263238;color:#b0bec5;}
.st.review{background:#33270e;color:#ffe082;}
.st.approved{background:#0d2137;color:#90caf9;}
.st.publishing{background:#08303a;color:#80deea;}
.st.partial{background:#4e2310;color:#ffab91;}
.st.degraded{background:#251640;color:#b39ddb;}
.st.published{background:#1b5e20;color:#a5d6a7;}
.st.cancelled{background:#21262c;color:#78909c;}
.pri{font-size:10px;padding:2px 8px;border-radius:6px;background:#16263f;color:#8ba2c8;}
.pri.urgent{background:#4a1518;color:#ef9a9a;}
.pri.high{background:#33230e;color:#ffcc80;}
.s-title{color:#fff;font-size:14px;flex:1;min-width:160px;}
.cid{font-size:10px;color:#8ba2c8;}
.wo-link{font-size:10px;color:#80cbc4;background:#0d2b28;border:1px solid rgba(0,150,136,.3);border-radius:5px;padding:2px 8px;cursor:pointer;}
.upd{font-size:10px;color:#5b6f94;}
.reject-box{margin-top:8px;font-size:11px;color:#ffab91;background:#3e2723;border:1px solid rgba(255,138,101,.3);border-radius:8px;padding:7px 10px;}
.partial-box{margin-top:8px;font-size:11px;color:#ffccbc;background:#3a1c12;border:1px solid rgba(255,112,67,.45);border-radius:8px;padding:8px 11px;line-height:1.7;}
.partial-box b{color:#ff8a65;}
.degrade-box{margin-top:8px;font-size:11px;color:#d1c4e9;background:#221738;border:1px solid rgba(126,87,194,.5);border-radius:8px;padding:8px 11px;line-height:1.7;}
.degrade-box b{color:#b39ddb;}
.deg-reason{color:#aebadd;margin-top:3px;}
.deg-meta{color:#b39ddb;}
.deg-meta i{color:#b39ddb;}
.policy-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:7px;font-size:10px;color:#8ba2c8;background:#0c1a30;border:1px solid rgba(126,87,194,.22);border-radius:7px;padding:5px 9px;}
.policy-line.readonly{opacity:.85;}
.pl-lbl{color:#aebadd;}
.pl-src{color:#5b6f94;font-style:normal;}
.pl-src.own{color:#b39ddb;}
.pl-thr{color:#7187ad;}
.pl-elig{font-style:normal;padding:1px 7px;border-radius:5px;}
.pl-elig.ok{color:#a5d6a7;background:#14261a;}
.pl-elig.no{color:#ffab91;background:#3a1c12;}
.mini-link{background:none;border:none;color:#80cbc4;cursor:pointer;font-size:10px;padding:0;font-family:inherit;text-decoration:underline;}
.op.degrade-link{display:inline-block;padding:1px 9px;margin:0 2px;}
.ch-block.degraded{border-color:rgba(126,87,194,.4);}
.bar i.degraded{background:linear-gradient(90deg,#7e57c2,#26a69a);}
.ch-progress .f.degraded{color:#b39ddb;}
.ch-row.degraded{border-left-color:#7e57c2;opacity:.95;}
.ch-row.degraded .ch-dot{background:#7e57c2;}
.g-pol{display:flex;flex-direction:column;gap:9px;}
.g-opt{display:flex;gap:7px;align-items:flex-start;font-size:12px;color:#aebadd;background:#13233f;border:1px solid rgba(120,160,220,.2);border-radius:8px;padding:8px 10px;cursor:pointer;}
.g-opt.on{border-color:rgba(126,87,194,.55);background:#1d1636;color:#d1c4e9;}
.g-thr{display:flex;gap:18px;font-size:12px;color:#aebadd;flex-wrap:wrap;}
.g-thr input{width:70px;margin:0 4px;}
.s-body{margin-top:8px;display:flex;flex-direction:column;gap:8px;}
.content-text{white-space:pre-wrap;margin:0;color:#c6d2e8;font-size:12px;line-height:1.75;background:#0c1730;border:1px solid rgba(120,160,220,0.1);border-radius:8px;padding:10px 12px;max-height:220px;overflow-y:auto;}
.s-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:10px;color:#5b6f94;margin-top:8px;}
.s-meta i{color:#90caf9;font-style:normal;}
.review-note{margin-top:6px;font-size:10px;color:#ce93d8;background:#1d1440;border:1px solid rgba(149,117,205,.3);border-radius:6px;padding:5px 9px;}
.ch-block{margin-top:10px;background:#0c1a30;border:1px solid rgba(38,166,154,.18);border-radius:10px;padding:10px 12px;}
.ch-progress{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:11px;color:#dbe4f3;}
.bar{flex:1;max-width:260px;height:7px;background:#13233f;border-radius:4px;overflow:hidden;}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#26a69a,#66bb6a);border-radius:4px;transition:width .4s;}
.bar i.partial{background:linear-gradient(90deg,#ef5350,#ffb300,#66bb6a);}
.ch-progress .f{color:#ef9a9a;}
.ch-progress .o{color:#90caf9;}
.ch-rows{display:flex;flex-direction:column;gap:6px;}
.ch-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px;background:#13233f;border-radius:7px;padding:6px 10px;border-left:3px solid #546e7a;}
.ch-row.pending{border-left-color:#78909c;}
.ch-row.publishing{border-left-color:#42a5f5;}
.ch-row.success{border-left-color:#66bb6a;}
.ch-row.failed{border-left-color:#ef5350;}
.ch-row.cancelled{border-left-color:#616161;opacity:.75;}
.ch-dot{width:8px;height:8px;border-radius:50%;background:#546e7a;flex:none;}
.ch-row.success .ch-dot{background:#66bb6a;}
.ch-row.failed .ch-dot{background:#ef5350;}
.ch-row.publishing .ch-dot{background:#42a5f5;}
.ch-name{color:#dbe4f3;font-weight:600;min-width:130px;}
.ch-st{font-size:9px;padding:1px 7px;border-radius:5px;background:#0d2137;color:#b0bec5;flex:none;}
.ch-st.success{background:#1b5e20;color:#a5d6a7;}
.ch-st.failed{background:#4a1518;color:#ef9a9a;}
.ch-st.publishing{background:#0d2a4a;color:#90caf9;}
.ch-st.cancelled{background:#21262c;color:#78909c;}
.ch-as{font-size:10px;color:#8ba2c8;}
.ch-result{font-size:10px;color:#aebadd;flex:1;min-width:180px;}
.ch-result.fail{color:#ef9a9a;}
.ch-url{font-size:10px;color:#80cbc4;}
.ch-try{font-size:9px;color:#ffcc80;background:#33270e;border-radius:4px;padding:1px 6px;}
.ch-time{font-size:9px;color:#5b6f94;}
.ch-ops{display:flex;gap:5px;flex-wrap:wrap;}
.s-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}
.readonly-tip{font-size:11px;color:#5b6f94;}
.review-wait{font-size:10px;color:#ffcc80;}
.op{background:none;border:1px solid rgba(120,160,220,.4);color:#aebadd;cursor:pointer;border-radius:7px;padding:5px 11px;font-size:11px;font-family:inherit;}
.op.edit{border-color:rgba(144,202,249,.45);color:#90caf9;}
.op.submit{border-color:rgba(255,179,0,.55);color:#ffe082;}
.op.approve{border-color:rgba(102,187,106,.6);color:#a5d6a7;background:rgba(27,94,32,.25);font-weight:600;}
.op.reject{border-color:rgba(239,83,80,.5);color:#ef9a9a;}
.op.publish{border-color:rgba(38,166,154,.6);color:#80cbc4;background:rgba(0,105,92,.25);font-weight:600;}
.op.ok{border-color:rgba(102,187,106,.5);color:#a5d6a7;}
.op.start{border-color:rgba(66,165,245,.5);color:#90caf9;}
.op.fail{border-color:rgba(239,83,80,.5);color:#ef9a9a;}
.op.retry{border-color:rgba(255,179,0,.5);color:#ffe082;}
.op.cancel,.op.cancel-stmt{border-color:rgba(183,28,28,.45);color:#ef9a9a;}
.logbtn{margin-top:10px;background:none;border:1px solid rgba(120,160,220,0.25);color:#8ba2c8;border-radius:7px;padding:4px 11px;font-size:10px;cursor:pointer;font-family:inherit;}
.s-logs{margin-top:8px;border-top:1px dashed rgba(120,160,220,0.15);padding-top:8px;display:flex;flex-direction:column;gap:5px;max-height:220px;overflow-y:auto;}
.slog{display:flex;align-items:baseline;gap:8px;font-size:10px;color:#8ba2c8;}
.slog em{margin-left:auto;color:#5b6f94;font-style:normal;white-space:nowrap;}
.lg-act{flex:none;font-size:9px;padding:1px 7px;border-radius:5px;background:#16263f;color:#90caf9;border:1px solid rgba(144,202,249,.25);}
.slog.approve .lg-act,.slog.done .lg-act{color:#a5d6a7;border-color:rgba(102,187,106,.4);}
.slog.partial .lg-act,.slog.notify_partial .lg-act{color:#ffab91;border-color:rgba(255,112,67,.5);background:#33180f;}
.slog.degraded .lg-act,.slog.notify_degraded .lg-act,.slog.degrade_recovered .lg-act,.slog.degrade_policy .lg-act{color:#b39ddb;border-color:rgba(126,87,194,.5);background:#221738;}
.slog.reject .lg-act{color:#ef9a9a;border-color:rgba(239,83,80,.4);}
.slog.channel_result .lg-act{color:#80deea;}
.modal-mask{position:fixed;inset:0;background:rgba(5,10,20,.65);z-index:60;display:grid;place-items:center;padding:20px;}
.modal{background:#0f1b38;border:1px solid rgba(120,160,220,0.25);border-radius:14px;padding:18px 20px;width:min(560px,100%);max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px;}
.modal h4{margin:0;color:#fff;font-size:15px;}
.m-sub{margin:0;font-size:11px;color:#8ba2c8;}
.m-field{display:flex;flex-direction:column;gap:5px;font-size:11px;color:#aebadd;}
.m-field textarea{min-height:80px;}
.m-actions{display:flex;gap:10px;justify-content:flex-end;}
</style>
