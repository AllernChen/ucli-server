<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const loading = ref(true)
const error = ref('')
const skills = ref<any[]>([])
async function load() {
  loading.value = true; error.value = ''
  try { skills.value = await api('/api/v1/skills/catalog') }
  catch (value: any) { error.value = value.message } finally { loading.value = false }
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>技能超市</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <section class="panel">
      <h2>已发布技能</h2>
      <table v-if="skills.length">
        <thead><tr><th>名称</th><th>slug</th><th>版本</th><th>可见性</th><th>SHA256</th><th>发布时间</th></tr></thead>
        <tbody><tr v-for="item in skills" :key="item.id"><td>{{ item.skill.name }}</td><td class="mono">{{ item.skill.slug }}</td><td>{{ item.version }}</td><td>{{ item.visibility }}</td><td class="mono">{{ (item.sha256 || '').slice(0, 12) }}…</td><td>{{ item.publishedAt }}</td></tr></tbody>
      </table>
      <p v-else class="empty">暂无已发布技能</p>
    </section>
  </template>
</template>
