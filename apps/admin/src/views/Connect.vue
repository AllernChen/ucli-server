<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { publicApi } from '../api'
import { buildUcliConnectUrl, connectionStateForGrantStatus, createExclusiveGrantActionGate, createGrantActionLifecycle, readGrantToken, revalidateGrantAction } from '../device-grant-connect'

type GrantPreview = {
  account: { displayName: string }
  organization: { name: string }
  status: string
  authorization: { expiresAt: string | null }
}

const loading = ref(true)
const error = ref('')
const notice = ref('')
const preview = ref<GrantPreview | null>(null)
const serverOrigin = ref('')
const connectionState = ref(connectionStateForGrantStatus(''))
const actionPending = ref(false)
const actionGate = createExclusiveGrantActionGate()
const lifecycle = createGrantActionLifecycle()
let grantToken = ''

function connectionUrl() {
  return buildUcliConnectUrl(serverOrigin.value, grantToken)
}

function previewGrant(token: string) {
  return publicApi<GrantPreview>('/api/v1/auth/device-grants/preview', {
    method: 'POST', body: JSON.stringify({ token })
  })
}

function updatePreview(latest: GrantPreview) {
  preview.value = latest
  connectionState.value = connectionStateForGrantStatus(latest.status)
}

function setActionPending(value: boolean) {
  lifecycle.apply(() => { actionPending.value = value })
}

async function revalidateAction() {
  if (!grantToken || lifecycle.disposed) return false
  const latest = await revalidateGrantAction(grantToken, previewGrant)
  if (lifecycle.disposed) return false
  connectionState.value = latest.state
  if (latest.preview) preview.value = latest.preview
  return latest.state.canConnect
}

async function runAction(action: () => Promise<boolean>) {
  return actionGate.run(async () => {
    if (!grantToken || lifecycle.disposed) return false
    setActionPending(true)
    try {
      return await action()
    } finally {
      setActionPending(false)
    }
  })
}

async function connect() {
  await runAction(async () => {
    if (!(await revalidateAction()) || lifecycle.disposed) return false
    window.location.href = connectionUrl()
    return true
  })
}

async function copyConnectionLink() {
  await runAction(async () => {
    if (!(await revalidateAction()) || lifecycle.disposed) return false
    try {
      await navigator.clipboard.writeText(connectionUrl())
      if (lifecycle.disposed) return false
      notice.value = '连接链接已复制，可在安装 UCLI 后打开。'
      return true
    } catch {
      if (lifecycle.disposed) return false
      notice.value = '无法自动复制连接链接，请在安装 UCLI 后重新打开此授权页。'
      return false
    }
  })
}

function expiryLabel(expiresAt: string | null) {
  return expiresAt ? new Date(expiresAt).toLocaleString() : '永久有效'
}

onMounted(async () => {
  grantToken = readGrantToken(window.location.hash)
  const address = new URL(window.location.href)
  address.hash = ''
  window.history.replaceState(window.history.state, '', `${address.pathname}${address.search}`)
  serverOrigin.value = window.location.origin
  if (!grantToken) {
    loading.value = false
    error.value = '授权链接无效或已过期。'
    return
  }
  try {
    const initialPreview = await previewGrant(grantToken)
    if (lifecycle.disposed) return
    updatePreview(initialPreview)
  } catch {
    if (lifecycle.disposed) return
    error.value = '无法加载授权预览，请检查链接是否有效。'
  } finally {
    lifecycle.apply(() => { loading.value = false })
  }
})

onUnmounted(() => { lifecycle.dispose() })
</script>

<template>
  <main class="connect-shell">
    <section class="connect-card">
      <div class="brand-mark">U</div>
      <template v-if="loading"><h1>正在确认授权</h1><p>请稍候…</p></template>
      <template v-else-if="error"><h1>无法连接 UCLI</h1><p class="error">{{ error }}</p></template>
      <template v-else-if="preview">
        <h1>连接 UCLI</h1>
        <p>确认以下授权信息后，将在 UCLI 中完成设备注册。</p>
        <dl>
          <div><dt>服务端</dt><dd>{{ serverOrigin }}</dd></div>
          <div><dt>组织</dt><dd>{{ preview.organization.name }}</dd></div>
          <div><dt>用户</dt><dd>{{ preview.account.displayName }}</dd></div>
          <div><dt>授权状态</dt><dd>{{ connectionState.label }}</dd></div>
          <div><dt>有效期</dt><dd>{{ expiryLabel(preview.authorization.expiresAt) }}</dd></div>
        </dl>
        <p class="state">{{ connectionState.message }}</p>
        <template v-if="connectionState.canConnect">
          <button class="primary" :disabled="actionPending" @click="connect">连接 UCLI</button>
          <p v-if="notice" class="state">{{ notice }}</p>
          <details><summary>未安装 UCLI？</summary><p>安装 UCLI 后重新打开此页面，或复制连接链接后在 UCLI 中打开。</p><button :disabled="actionPending" @click="copyConnectionLink">复制连接链接</button></details>
        </template>
      </template>
    </section>
  </main>
</template>

<style scoped>
.connect-shell{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 20%,#15384a,#08101b 45%)}
.connect-card{width:min(100%,480px);padding:34px;background:#0e1927;border:1px solid #28405a;border-radius:16px;display:grid;gap:16px;text-align:center}
.brand-mark{margin:auto}.connect-card h1{margin:4px 0}.connect-card p{color:#8293aa;margin:0}.connect-card dl{margin:4px 0;text-align:left;display:grid;gap:9px}.connect-card dl div{display:grid;grid-template-columns:92px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid #223046}.connect-card dt{color:#728199}.connect-card dd{margin:0;overflow-wrap:anywhere}.connect-card details{text-align:left;color:#8293aa}.connect-card summary{cursor:pointer;color:#aebbd0}.connect-card details p{margin:12px 0}.connect-card details button{border:1px solid #223046;background:transparent;color:#8fa1b8;border-radius:8px;padding:9px 13px;cursor:pointer}.error{color:#fb7185!important}.state{color:#8fa1b8!important}
</style>
