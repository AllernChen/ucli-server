<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { toast } from '../toast'
import type { ChannelSummary, Page, PublicModel, PublishCheck } from '../types/catalog'
import StatusBadge from '../components/StatusBadge.vue'

const route = useRoute(); const router = useRouter(); const id = String(route.params.id)
const model = ref<PublicModel | null>(null); const channels = ref<ChannelSummary[]>([]); const check = ref<PublishCheck | null>(null)
const loading = ref(true); const error = ref('')
const blockers: Record<string, string> = { NO_HEALTHY_CHANNEL_MODEL: '没有健康的渠道模型', NO_CURRENT_COST: '没有当前有效的采购成本', LATEST_TEST_FAILED: '最近一次模型测试失败' }
const channelName = (channelId: string) => channels.value.find(channel => channel.id === channelId)?.name || channelId
const health = computed(() => model.value?.abilities.some(item => item.health === 'HEALTHY') ? 'HEALTHY' : model.value?.abilities.some(item => item.health === 'DEGRADED') ? 'DEGRADED' : 'UNHEALTHY')
async function load() { loading.value = true; error.value = ''; try { const [catalog, channelPage] = await Promise.all([api<PublicModel[]>('/api/v1/admin/models'), api<Page<ChannelSummary>>('/api/v1/admin/channels?limit=200&offset=0')]); model.value = catalog.find(item => item.id === id) || null; channels.value = channelPage.items; if (!model.value) throw new Error('模型不存在'); check.value = await api(`/api/v1/admin/models/${encodeURIComponent(id)}/publish-check`, { method: 'POST' }) } catch (value: any) { error.value = value.message } finally { loading.value = false } }
async function togglePublish() { if (!model.value) return; try { await api(`/api/v1/admin/models/${encodeURIComponent(id)}/${model.value.enabled ? 'unpublish' : 'publish'}`, { method: 'POST' }); toast(model.value.enabled ? '模型已下线' : '模型已发布'); await load() } catch (value: any) { error.value = value.message } }
onMounted(load)
</script>

<template><header class="page-header"><div><button class="back-link" @click="router.push('/models')">← 返回模型目录</button><p>MODEL DETAIL</p><h1>{{ model?.displayName || id }}</h1><span class="subtitle mono">{{ id }}</span></div><div v-if="model" class="actions"><StatusBadge :status="health" /><button :class="model.enabled ? 'danger-button' : 'primary'" :disabled="!model.enabled && !check?.ready" @click="togglePublish">{{ model.enabled ? '下线模型' : '发布模型' }}</button></div></header>
  <p v-if="loading" class="state">正在加载…</p><p v-else-if="error" class="state error">{{ error }}</p><template v-if="model && !loading"><section v-if="check && !check.ready" class="warning-panel"><strong>发布前需要处理</strong><span v-for="item in check.blockers" :key="item">{{ blockers[item] }}</span></section>
    <div class="detail-grid"><article class="panel metric-block"><span>发布状态</span><strong class="small-strong">{{ model.enabled ? '已发布' : '草稿' }}</strong></article><article class="panel metric-block"><span>健康渠道模型</span><strong>{{ check?.healthyChannelModels || 0 }}</strong></article><article class="panel metric-block"><span>成本可用</span><strong class="small-strong">{{ check?.hasCurrentCost ? '已配置' : '缺失' }}</strong></article><article class="panel metric-block"><span>上下文长度</span><strong>{{ model.contextSize?.toLocaleString() || '—' }}</strong></article></div>
    <section class="panel"><div class="section-header"><div><h2>渠道供应映射</h2><p class="muted">渠道模型从所属渠道详情维护。</p></div></div><table v-if="model.abilities.length"><thead><tr><th>渠道</th><th>上游模型</th><th>协议</th><th>健康</th><th>成本规则</th><th>操作</th></tr></thead><tbody><tr v-for="ability in model.abilities" :key="ability.id"><td>{{ channelName(ability.channelId) }}</td><td class="mono">{{ ability.upstreamModel }}</td><td>{{ ability.protocol }}</td><td><StatusBadge :status="ability.health" /></td><td>{{ ability.costRules?.length || 0 }}</td><td><button @click="router.push(`/channels/${ability.channelId}`)">打开渠道</button></td></tr></tbody></table><p v-else class="empty">尚无渠道供应映射，请前往渠道详情添加。</p></section>
    <section class="panel"><h2>公共模型兜底成本</h2><p class="muted">仅在渠道模型没有匹配成本规则时使用；金额均为公司采购成本。</p><table v-if="model.prices.length"><thead><tr><th>生效时间</th><th>输入 $/M</th><th>输出 $/M</th><th>缓存 $/M</th><th>推理 $/M</th></tr></thead><tbody><tr v-for="price in model.prices" :key="price.id"><td>{{ new Date(price.validFrom).toLocaleString() }}</td><td>{{ price.inputPerMillion }}</td><td>{{ price.outputPerMillion }}</td><td>{{ price.cachedPerMillion }}</td><td>{{ price.reasoningPerMillion }}</td></tr></tbody></table><p v-else class="empty">未配置兜底成本</p></section>
  </template></template>
