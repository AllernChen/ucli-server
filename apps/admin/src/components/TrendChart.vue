<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { use, init, type ECharts, type EChartsOption } from 'echarts/core'
import { LineChart, BarChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])
const props = defineProps<{ data: Array<any>; metric: 'requests' | 'tokens' | 'cost' }>()
const root = ref<HTMLDivElement>(); let chart: ECharts | null = null; let observer: ResizeObserver | null = null
function render() {
  if (!chart) return
  const labels = props.data.map(item => new Date(item.bucket).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit' }))
  const values = props.data.map(item => props.metric === 'requests' ? item.requests : props.metric === 'tokens'
    ? Number(item.inputTokens) + Number(item.outputTokens) : Number(item.costUsd))
  const names = { requests: '请求数', tokens: 'Token', cost: '采购成本 USD' }
  const option: EChartsOption = {
    animationDuration: 300, backgroundColor: 'transparent', tooltip: { trigger: 'axis' }, legend: { textStyle: { color: '#8fa1b8' } },
    grid: { left: 52, right: 52, top: 42, bottom: 34 }, xAxis: { type: 'category', data: labels, axisLabel: { color: '#728199' }, axisLine: { lineStyle: { color: '#26384e' } } },
    yAxis: [{ type: 'value', axisLabel: { color: '#728199' }, splitLine: { lineStyle: { color: '#17263a' } } },
      { type: 'value', min: 0, max: 100, axisLabel: { color: '#728199', formatter: '{value}%' }, splitLine: { show: false } }],
    series: [{ name: names[props.metric], type: props.metric === 'cost' ? 'bar' : 'line', smooth: true, data: values,
      itemStyle: { color: '#52d6b3' }, lineStyle: { width: 2 }, areaStyle: props.metric === 'cost' ? undefined : { opacity: .12 } },
    { name: '成功率', type: 'line', yAxisIndex: 1, smooth: true, data: props.data.map(item => Number(item.successRate) * 100),
      itemStyle: { color: '#f8c66a' }, lineStyle: { width: 1.5 } }]
  }
  chart.setOption(option, true)
}
onMounted(() => { if (!root.value) return; chart = init(root.value); render(); observer = new ResizeObserver(() => chart?.resize()); observer.observe(root.value) })
watch(() => [props.data, props.metric], render, { deep: true })
onBeforeUnmount(() => { observer?.disconnect(); chart?.dispose(); chart = null })
</script>
<template><div v-if="data.length" ref="root" class="trend-chart"></div><p v-else class="empty chart-empty">当前筛选范围没有使用数据</p></template>
