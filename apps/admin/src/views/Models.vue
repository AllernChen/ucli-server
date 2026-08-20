<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { toast } from '../toast'
import type { PublicModel } from '../types/catalog'
import Drawer from '../components/Drawer.vue'
import StatusBadge from '../components/StatusBadge.vue'

const router = useRouter(); const loading = ref(true); const error = ref(''); const models = ref<PublicModel[]>([])
const q = ref(''); const createOpen = ref(false); const form = reactive({ id: '', displayName: '', contextSize: '' })
const visible = computed(() => models.value.filter(model => !q.value || `${model.id} ${model.displayName}`.toLowerCase().includes(q.value.toLowerCase())))
async function load() { loading.value = true; error.value = ''; try { models.value = await api('/api/v1/admin/models') } catch (value: any) { error.value = value.message } finally { loading.value = false } }
async function create() { try { await api('/api/v1/admin/models', { method: 'POST', body: JSON.stringify({ id: form.id, displayName: form.displayName, contextSize: Number(form.contextSize) || null }) }); createOpen.value = false; toast('公共模型已创建'); await load() } catch (value: any) { error.value = value.message } }
const health = (model: PublicModel) => model.abilities.some(item => item.enabled && item.health === 'HEALTHY') ? 'HEALTHY' : model.abilities.some(item => item.enabled && item.health === 'DEGRADED') ? 'DEGRADED' : model.abilities.length ? 'UNHEALTHY' : 'UNKNOWN'
const costRange = (model: PublicModel) => {
  const values = model.abilities.flatMap(item => item.costRules || []).map(rule => Number(rule.inputPerMillion)).filter(Number.isFinite)
  if (!values.length) return '未配置'
  return `$${Math.min(...values)}–$${Math.max(...values)} / M 输入`
}
onMounted(load)
</script>

<template><header class="page-header"><div><p>PUBLIC CATALOG</p><h1>公共模型目录</h1><span class="subtitle">面向员工客户端的稳定模型 ID，以及背后的渠道供应情况</span></div><div class="actions"><button @click="load">刷新</button><button class="primary" @click="createOpen = true">创建公共模型</button></div></header>
  <section class="panel toolbar"><input v-model="q" placeholder="搜索模型 ID 或名称"></section><p v-if="loading" class="state">正在加载…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <section v-else class="panel table-panel"><table v-if="visible.length"><thead><tr><th>公共模型</th><th>发布状态</th><th>渠道供应</th><th>健康</th><th>采购成本范围</th><th>上下文</th></tr></thead><tbody><tr v-for="model in visible" :key="model.id" class="clickable-row" @click="router.push(`/models/${encodeURIComponent(model.id)}`)"><td><strong>{{ model.displayName }}</strong><small class="mono">{{ model.id }}</small></td><td><span class="chip" :class="{ success: model.enabled }">{{ model.enabled ? '已发布' : '草稿' }}</span></td><td><strong>{{ model.abilities.filter(item => item.enabled).length }}</strong><small>共 {{ model.abilities.length }} 个渠道模型</small></td><td><StatusBadge :status="health(model)" /></td><td>{{ costRange(model) }}</td><td>{{ model.contextSize?.toLocaleString() || '—' }}</td></tr></tbody></table><p v-else class="empty">没有公共模型</p></section>
  <Drawer :open="createOpen" title="创建公共模型" @close="createOpen = false"><div class="stack-form"><label>模型 ID<input v-model="form.id" placeholder="例如 gpt-4o"></label><label>显示名称<input v-model="form.displayName"></label><label>上下文长度<input v-model="form.contextSize" type="number"></label></div><template #footer><button @click="createOpen = false">取消</button><button class="primary" @click="create">创建</button></template></Drawer>
</template>
