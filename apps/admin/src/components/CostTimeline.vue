<script setup lang="ts">
import { computed, ref } from 'vue'
import { buildWeeklyCostTimeline, type CostTimelineSlot } from '../procurement-costs'
import type { CostRule, ProcurementFallbackCost } from '../types/catalog'

const props = defineProps<{
  rules: CostRule[]
  fallback: ProcurementFallbackCost | null
  timezone: string
  selectedAt: string
}>()
const emit = defineEmits<{ select: [slot: CostTimelineSlot] }>()
const inspected = ref<CostTimelineSlot | null>(null)
const slots = computed(() => buildWeeklyCostTimeline(props.rules, props.fallback, new Date(props.selectedAt), props.timezone))
const days = computed(() => Array.from({ length: 7 }, (_, index) => ({
  weekday: index + 1, label: `周${'一二三四五六日'[index]}`,
  slots: slots.value.filter(slot => slot.weekday === index + 1)
})))
function clock(minute: number) { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}` }
function inspect(slot: CostTimelineSlot) { inspected.value = slot; emit('select', slot) }
</script>

<template>
  <div class="cost-timeline-legend"><span class="channel-base">渠道基础价</span><span class="channel-override">分时覆盖价</span><span class="public-fallback">公共兜底价</span><span class="uncovered">无可用成本</span></div>
  <div class="cost-timeline-scroll">
    <div class="cost-timeline-header"><span></span><small v-for="hour in 24" :key="hour">{{ String(hour - 1).padStart(2, '0') }}</small></div>
    <div v-for="day in days" :key="day.weekday" class="cost-timeline-row"><strong>{{ day.label }}</strong><button v-for="slot in day.slots" :key="slot.startMinute" :class="[slot.kind.toLowerCase().replace('_', '-'), { selected: slot.selected, inspected: inspected === slot }]" :title="`${day.label} ${clock(slot.startMinute)}–${clock(slot.endMinute)} · ${slot.label}`" :aria-label="`${day.label} ${clock(slot.startMinute)} ${slot.label}`" @click="inspect(slot)"></button></div>
  </div>
  <p v-if="inspected" class="timeline-inspection"><strong>{{ inspected.label }}</strong><span>周{{ '一二三四五六日'[inspected.weekday - 1] }} {{ clock(inspected.startMinute) }}–{{ clock(inspected.endMinute) }} · {{ timezone }}</span></p>
</template>
