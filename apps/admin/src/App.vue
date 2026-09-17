<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from './api'
import { toasts } from './toast'

const router = useRouter()
const route = useRoute()
const email = ref('')
const password = ref('')
const error = ref('')
const loggedIn = ref(Boolean(localStorage.getItem('ucli.accessToken')))
const principal = ref<{ id: string; displayName: string; email: string; status: string; organizationId: string; organizationName: string; role: string } | null>(null)
const checking = ref(loggedIn.value)
const allNavigation = [
  ['overview', '服务总览'], ['channels', '渠道管理'], ['models', '模型目录'], ['procurement-costs', '采购成本'], ['model-test', '模型测试'],
  ['usage', '使用日志'], ['skills', '技能超市'], ['reports', '运营报告'],
  ['analytics', '统计分析'],
  ['usage-groups', '用量组'], ['users', '用户管理'], ['device-grants', '授权令牌'],
  ['governance', '治理'], ['organizations', '组织']
]
const navigation = computed(() => principal.value?.role === 'PLATFORM_ADMIN' ? allNavigation : allNavigation.filter(([name]) =>
  (principal.value?.role === 'ORG_ADMIN' ? ['usage-groups', 'usage', 'analytics', 'users', 'device-grants'] : ['usage', 'analytics']).includes(name)))
const routeAllowed = computed(() => principal.value && (['profile', 'my-access'].includes(String(route.name)) || navigation.value.some(([name]) => route.name === name ||
  (name === 'usage-groups' && route.name === 'usage-group-detail') || (name === 'users' && route.name === 'user-detail') ||
  (name === 'channels' && route.name === 'channel-detail') || (name === 'models' && route.name === 'model-detail'))))
let sessionGeneration = 0
async function loadIdentity() {
  const current = ++sessionGeneration; checking.value = true; principal.value = null; error.value = ''
  try {
    const identity = await api('/api/v1/auth/me')
    if (current === sessionGeneration) {
      principal.value = identity
      if (identity.role !== 'PLATFORM_ADMIN' && route.name === 'overview') router.push('/profile')
    }
  } catch (value: any) { if (current === sessionGeneration) error.value = value.message }
  finally { if (current === sessionGeneration) checking.value = false }
}
onMounted(() => { if (loggedIn.value) loadIdentity() })

const passwordChanged = ref(false)

async function login() {
  try {
    const result = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: email.value, password: password.value }) })
    localStorage.setItem('ucli.accessToken', result.accessToken)
    loggedIn.value = true
    await loadIdentity()
  } catch (value: any) { error.value = value.message }
}
function logout() { sessionGeneration++; localStorage.removeItem('ucli.accessToken'); loggedIn.value = false; principal.value = null; checking.value = false; password.value = '' }
function onPasswordChanged() { logout(); passwordChanged.value = true }
</script>

<template>
  <main v-if="passwordChanged" class="login-shell">
    <div class="login-card">
      <div class="brand-mark">U</div><h1>密码修改成功</h1>
      <p>密码已更新，旧会话已失效，请使用新密码重新登录。</p>
      <button @click="passwordChanged = false">去登录</button>
    </div>
  </main>
  <main v-else-if="route.meta.public === true"><RouterView /></main>
  <main v-else-if="!loggedIn" class="login-shell">
    <form class="login-card" @submit.prevent="login">
      <div class="brand-mark">U</div><h1>UCLI Server</h1><p>私有模型服务与技能管理平台</p>
      <input v-model="email" type="email" placeholder="账号邮箱" required>
      <input v-model="password" type="password" placeholder="密码" required>
      <button>登录</button><small v-if="error" class="error">{{ error }}</small>
    </form>
  </main>
  <main v-else-if="checking || !principal" class="login-shell"><section class="login-card"><p>{{ checking ? '正在验证登录身份…' : error || '无法确认登录身份' }}</p><button v-if="!checking" @click="loadIdentity">重试</button><button @click="logout">退出登录</button></section></main>
  <div v-else class="shell">
    <aside><header><div class="brand-mark">U</div><div><strong>UCLI</strong><small>Server Console</small></div></header>
      <nav><button v-for="item in navigation" :key="item[0]" :class="{active: route.name === item[0] || (item[0] !== 'model-test' && String(route.name || '').startsWith(`${item[0].replace(/s$/, '')}-`))}" @click="router.push(item[0] === 'overview' ? '/' : `/${item[0]}`)">{{ item[1] }}</button></nav>
      <button class="logout" :aria-current="route.name === 'profile' ? 'page' : undefined" @click="router.push('/profile')">个人中心 · {{ principal.displayName }}</button>
      <button class="logout" @click="logout">退出登录</button>
    </aside>
    <section class="content"><RouterView v-if="routeAllowed" v-slot="{ Component }"><component :is="Component" v-if="route.name === 'profile'" :principal="principal" @profile-updated="loadIdentity" @password-changed="onPasswordChanged" @logout="logout" /><component :is="Component" v-else /></RouterView><section v-else class="panel"><h1>当前账号无权访问此页面</h1><button @click="router.push('/profile')">前往个人中心</button></section></section>
  </div>
  <div class="toasts" aria-live="polite"><div v-for="t in toasts" :key="t.id" class="toast">{{ t.message }}</div></div>
</template>

<style>
.toasts{position:fixed;bottom:24px;right:24px;display:grid;gap:10px;z-index:1000}
.toast{background:#133b35;border:1px solid #2d977f;color:#76e6c8;border-radius:8px;padding:12px 16px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
</style>
