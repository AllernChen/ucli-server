<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from './api'
import { formatCny } from './currency'

const route = useRoute()
const loading = ref(true)
const error = ref('')
const summary = ref<any>(null)
const rows = ref<any[]>([])
const isUsage = () => route.name === 'usage'
async function load() {
  loading.value = true; error.value = ''
  try {
    summary.value = await api('/api/v1/usage/summary')
    rows.value = isUsage() ? await api('/api/v1/usage/logs?limit=50') : await api('/api/v1/admin/channels')
  } catch (value: any) { error.value = value.message } finally { loading.value = false }
}
onMounted(load); watch(() => route.name, load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>{{ isUsage() ? '使用日志与分析' : '模型服务总览' }}</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <div class="cards">
      <article><span>模型请求</span><strong>{{ summary.requests }}</strong></article>
      <article><span>活跃账号</span><strong>{{ summary.activeAccounts }}</strong></article>
      <article><span>Token 消耗</span><strong>{{ Number(summary.totalTokens).toLocaleString() }}</strong></article>
      <article><span>成功率</span><strong>{{ (summary.successRate * 100).toFixed(1) }}%</strong></article>
      <article><span>估算活跃时长</span><strong>{{ summary.estimatedActiveMinutes }}m</strong></article>
      <article><span>累计费用</span><strong>{{ formatCny(summary.costUsd) }}</strong></article>
    </div>
    <section class="panel">
      <h2>{{ isUsage() ? '最近使用日志' : '渠道状态' }}</h2>
      <table v-if="rows.length">
        <thead><tr><th>名称 / 请求</th><th>模型 / 供应商</th><th>状态</th><th>延迟</th></tr></thead>
        <tbody><tr v-for="row in rows" :key="row.id"><td>{{ row.requestId || row.name }}</td><td>{{ row.publicModelId || row.provider }}</td><td><i :class="row.statusCode < 400 || row.health === 'HEALTHY' ? 'ok' : 'bad'"></i>{{ row.statusCode || row.health }}</td><td>{{ row.durationMs || row.timeoutMs }} ms</td></tr></tbody>
      </table>
      <p v-else class="empty">暂无数据</p>
    </section>
  </template>
</template>
