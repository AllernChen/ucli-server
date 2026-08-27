<script setup lang="ts">
import { onBeforeUnmount, reactive, ref } from 'vue'
import { api } from '../api'
import {
  canRegenerateGrantLink,
  canViewGrantLink,
  createExclusiveAsyncRequestGate,
  createRequestLifecycle,
  linkExpiryPayload,
  type LinkExpiryForm,
  type DeviceGrantSummary
} from '../device-grants'
import Drawer from './Drawer.vue'
import LinkExpiryFields from './LinkExpiryFields.vue'

const props = defineProps<{ grant: DeviceGrantSummary }>()
const emit = defineEmits<{ changed: [] }>()

const connectionUrl = ref<string | null>(null)
const viewError = ref('')
const regenerationError = ref('')
const copyNotice = ref('')
const copyError = ref('')
const regenerationOpen = ref(false)
const viewPending = ref(false)
const regenerationPending = ref(false)
let expiryForm = reactive<LinkExpiryForm>({ mode: '7d', customExpiresAt: '' })
const requestLifecycle = createRequestLifecycle()
const copyLifecycle = createRequestLifecycle()
const viewGate = createExclusiveAsyncRequestGate(pending => { viewPending.value = pending })
const regenerationGate = createExclusiveAsyncRequestGate(pending => { regenerationPending.value = pending })

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error && value.message ? value.message : fallback
}

function clearConnectionUrl() {
  copyLifecycle.next()
  connectionUrl.value = null
  copyNotice.value = ''
  copyError.value = ''
}

async function viewConnectionUrl() {
  if (!canViewGrantLink(props.grant) || viewPending.value) return
  const requestGeneration = requestLifecycle.next()
  let operation = 0
  viewError.value = ''
  try {
    const result = await viewGate.run(async requestOperation => {
      operation = requestOperation
      return api<{ connectionUrl: string }>(`/api/v1/admin/device-grants/${props.grant.id}/link`)
    })
    if (!result || !viewGate.isCurrent(operation) || !requestLifecycle.isCurrent(requestGeneration)) return
    clearConnectionUrl()
    connectionUrl.value = result.connectionUrl
  } catch (value: unknown) {
    if (!viewGate.isCurrent(operation) || !requestLifecycle.isCurrent(requestGeneration)) return
    viewError.value = errorMessage(value, '获取 URL 失败')
  }
}

function openRegeneration() {
  if (!canRegenerateGrantLink(props.grant) || regenerationPending.value) return
  clearConnectionUrl()
  regenerationError.value = ''
  expiryForm.mode = '7d'
  expiryForm.customExpiresAt = ''
  regenerationOpen.value = true
}

function closeRegeneration() {
  if (regenerationPending.value) return
  regenerationOpen.value = false
  regenerationError.value = ''
}

async function regenerateConnectionUrl() {
  if (!canRegenerateGrantLink(props.grant) || regenerationPending.value) return
  const requestGeneration = requestLifecycle.next()
  let operation = 0
  regenerationError.value = ''
  try {
    const payload = linkExpiryPayload(expiryForm)
    const result = await regenerationGate.run(async requestOperation => {
      operation = requestOperation
      return api<{ connectionUrl: string }>(`/api/v1/admin/device-grants/${props.grant.id}/links`, {
        method: 'POST', body: JSON.stringify(payload)
      })
    })
    if (!result || !regenerationGate.isCurrent(operation) || !requestLifecycle.isCurrent(requestGeneration)) return
    regenerationOpen.value = false
    clearConnectionUrl()
    connectionUrl.value = result.connectionUrl
    emit('changed')
  } catch (value: unknown) {
    if (!regenerationGate.isCurrent(operation) || !requestLifecycle.isCurrent(requestGeneration)) return
    regenerationError.value = errorMessage(value, '重新生成 URL 失败')
  }
}

async function copyConnectionUrl() {
  const url = connectionUrl.value
  if (!url) return
  const requestGeneration = copyLifecycle.next()
  copyNotice.value = ''
  copyError.value = ''
  try {
    await navigator.clipboard.writeText(url)
    if (!copyLifecycle.isCurrent(requestGeneration) || connectionUrl.value !== url) return
    copyNotice.value = 'URL 已复制'
  } catch (value: unknown) {
    if (!copyLifecycle.isCurrent(requestGeneration) || connectionUrl.value !== url) return
    copyError.value = errorMessage(value, '复制失败，请手动复制 URL')
  }
}

onBeforeUnmount(() => {
  viewGate.dispose()
  regenerationGate.dispose()
  requestLifecycle.dispose()
  copyLifecycle.dispose()
  clearConnectionUrl()
})
</script>

<template>
  <div v-if="canViewGrantLink(grant) || canRegenerateGrantLink(grant)" class="device-grant-link-actions">
    <button v-if="canViewGrantLink(grant)" type="button" :disabled="viewPending" @click="viewConnectionUrl">查看 URL</button>
    <button v-if="canRegenerateGrantLink(grant)" type="button" :disabled="regenerationPending" @click="openRegeneration">重新生成 URL</button>
    <p v-if="viewError" class="state error">{{ viewError }}</p>
    <p v-if="regenerationError && !regenerationOpen" class="state error">{{ regenerationError }}</p>
  </div>

  <Drawer :open="regenerationOpen" title="重新生成 URL" description="重新生成后，当前 URL 将立即失效。请选择新 URL 的有效期。" :close-disabled="regenerationPending" @close="closeRegeneration">
    <form id="regenerate-grant-link-form" class="stack-form" @submit.prevent="regenerateConnectionUrl">
      <LinkExpiryFields v-model="expiryForm" />
      <p v-if="regenerationError" class="state error">{{ regenerationError }}</p>
    </form>
    <template #footer>
      <button type="button" :disabled="regenerationPending" @click="closeRegeneration">取消</button>
      <button type="submit" form="regenerate-grant-link-form" class="primary" :disabled="regenerationPending">{{ regenerationPending ? '正在重新生成…' : '确认重新生成' }}</button>
    </template>
  </Drawer>

  <Drawer :open="Boolean(connectionUrl)" title="URL" description="关闭后无法再次查看完整 URL" @close="clearConnectionUrl">
    <label>完整 URL<textarea readonly :value="connectionUrl || ''" aria-label="完整 URL"></textarea></label>
    <p v-if="copyNotice" class="state">{{ copyNotice }}</p>
    <p v-if="copyError" class="state error">{{ copyError }}</p>
    <template #footer>
      <button type="button" data-copy-url @click="copyConnectionUrl">复制 URL</button>
      <button type="button" class="primary" @click="clearConnectionUrl">关闭</button>
    </template>
  </Drawer>
</template>
