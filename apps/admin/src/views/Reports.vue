<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const loading = ref(true)
const error = ref('')
const reports = ref<any[]>([])
async function load() {
  loading.value = true; error.value = ''
  try { reports.value = await api('/api/v1/reports') }
  catch (value: any) { error.value = value.message } finally { loading.value = false }
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>运营报告</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <section class="panel">
      <h2>报告列表</h2>
      <table v-if="reports.length">
        <thead><tr><th>周期</th><th>范围</th><th>时间范围</th><th>请求数</th><th>费用</th><th>创建时间</th></tr></thead>
        <tbody><tr v-for="report in reports" :key="report.id"><td>{{ report.period }}</td><td>{{ report.scope }}</td><td>{{ report.rangeStart?.slice(0, 10) }} ~ {{ report.rangeEnd?.slice(0, 10) }}</td><td>{{ report.metrics?.requests }}</td><td>${{ report.metrics?.costUsd }}</td><td>{{ report.createdAt }}</td></tr></tbody>
      </table>
      <p v-else class="empty">暂无报告</p>
    </section>
  </template>
</template>
