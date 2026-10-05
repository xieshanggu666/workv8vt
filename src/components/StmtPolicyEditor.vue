<template>
  <div class="pol-edit">
    <span class="pe-lbl">分渠道失败处理（降级发布策略）：</span>
    <div class="pe-modes">
      <label class="pe-opt" :class="{on:effective==='block'}">
        <input type="radio" :name="name+'-mode'" value="block" v-model="mode" /> 阻断（保持部分失败，不降级）
      </label>
      <label class="pe-opt" :class="{on:effective==='manual'}">
        <input type="radio" :name="name+'-mode'" value="manual" v-model="mode" /> 手动确认降级
      </label>
      <label class="pe-opt" :class="{on:effective==='auto'}">
        <input type="radio" :name="name+'-mode'" value="auto" v-model="mode" /> 满足阈值自动降级
      </label>
    </div>
    <div class="pe-thr" v-if="mode!=='block'">
      <label>最大失败渠道占比 ≤
        <input type="number" min="0" max="100" step="5" v-model.number="ratioPct" :disabled="inheriting" /> %
      </label>
      <label>至少成功渠道数
        <input type="number" min="0" max="20" step="1" v-model.number="minSuccess" :disabled="inheriting" /> 个
      </label>
    </div>
    <label class="pe-inherit">
      <input type="checkbox" v-model="inheriting" /> 沿用全局默认
      <span class="pe-g">（{{ modeText(globalPolicy?.mode) }}：失败≤{{ Math.round((globalPolicy?.maxFailRatio ?? 0.5)*100) }}% · 至少 {{ globalPolicy?.minSuccess ?? 1 }} 个成功）</span>
    </label>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  policy: { type: Object, default: null },        // null/''=沿用全局默认；{mode,maxFailRatio,minSuccess}=本声明覆盖
  globalPolicy: { type: Object, default: () => ({ mode: 'manual', maxFailRatio: 0.5, minSuccess: 1 }) }
})
const emit = defineEmits(['change'])

const name = Math.random().toString(36).slice(2, 8)
const inheriting = ref(!props.policy)
const mode = ref(props.policy?.mode || props.globalPolicy.mode)
const ratioPct = ref(Math.round(((props.policy?.maxFailRatio ?? props.globalPolicy.maxFailRatio) ?? 0.5) * 100))
const minSuccess = ref(props.policy?.minSuccess ?? props.globalPolicy.minSuccess ?? 1)

const effective = computed(() => (inheriting.value ? props.globalPolicy.mode : mode.value))

function modeText(m) { return { block: '阻断', manual: '手动确认降级', auto: '自动降级' }[m] || m }

watch([inheriting, mode, ratioPct, minSuccess], () => {
  if (inheriting.value) { emit('change', null); return }
  const ratio = Math.min(1, Math.max(0, (Number(ratioPct.value) || 0) / 100))
  const min = Math.max(0, Math.floor(Number(minSuccess.value) || 0))
  emit('change', { mode: mode.value, maxFailRatio: ratio, minSuccess: min })
})
watch(() => props.policy, (p) => {
  inheriting.value = !p
  if (p) { mode.value = p.mode; ratioPct.value = Math.round(p.maxFailRatio * 100); minSuccess.value = p.minSuccess }
})
</script>

<style scoped>
.pol-edit{display:flex;flex-direction:column;gap:6px;background:#0d2137;border:1px solid rgba(120,160,220,0.18);border-radius:8px;padding:8px 10px;}
.pe-lbl{font-size:11px;color:#8ba2c8;}
.pe-modes{display:flex;gap:10px;flex-wrap:wrap;}
.pe-opt{font-size:11px;color:#aebadd;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:14px;padding:4px 11px;cursor:pointer;display:inline-flex;gap:4px;align-items:center;}
.pe-opt.on{color:#80cbc4;border-color:rgba(38,166,154,.55);background:#0d302c;}
.pe-opt input{accent-color:#26a69a;}
.pe-thr{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:#aebadd;}
.pe-thr input{width:64px;margin:0 4px;}
.pe-inherit{font-size:11px;color:#8ba2c8;display:flex;gap:5px;align-items:center;flex-wrap:wrap;}
.pe-g{color:#5b6f94;}
</style>
