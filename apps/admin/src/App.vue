<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from './api'

const router = useRouter()
const route = useRoute()
const email = ref('')
const password = ref('')
const error = ref('')
const loggedIn = ref(Boolean(localStorage.getItem('ucli.accessToken')))
const navigation = [
  ['overview', '服务总览'], ['channels', '渠道与 Key'], ['models', '模型目录'],
  ['usage', '使用日志'], ['skills', '技能超市'], ['reports', '运营报告'], ['governance', '治理']
]

const showPasswordModal = ref(false)
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordError = ref('')
const passwordChanged = ref(false)

async function login() {
  try {
    const result = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: email.value, password: password.value }) })
    localStorage.setItem('ucli.accessToken', result.accessToken)
    loggedIn.value = true
  } catch (value: any) { error.value = value.message }
}
function logout() { localStorage.removeItem('ucli.accessToken'); loggedIn.value = false }
function openPasswordModal() {
  currentPassword.value = ''; newPassword.value = ''; confirmPassword.value = ''
  passwordError.value = ''
  showPasswordModal.value = true
}
async function changePassword() {
  passwordError.value = ''
  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) return passwordError.value = '请填写完整'
  if (newPassword.value !== confirmPassword.value) return passwordError.value = '两次新密码不一致'
  if (newPassword.value.length < 8) return passwordError.value = '新密码至少 8 位'
  try {
    await api('/api/v1/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value }) })
    localStorage.removeItem('ucli.accessToken')
    loggedIn.value = false
    showPasswordModal.value = false
    passwordChanged.value = true
  } catch (value: any) { passwordError.value = value.message }
}
</script>

<template>
  <main v-if="passwordChanged" class="login-shell">
    <div class="login-card">
      <div class="brand-mark">U</div><h1>密码修改成功</h1>
      <p>密码已更新，旧会话已失效，请使用新密码重新登录。</p>
      <button @click="passwordChanged = false">去登录</button>
    </div>
  </main>
  <main v-else-if="!loggedIn" class="login-shell">
    <form class="login-card" @submit.prevent="login">
      <div class="brand-mark">U</div><h1>UCLI Server</h1><p>私有模型服务与技能管理平台</p>
      <input v-model="email" type="email" placeholder="管理员邮箱" required>
      <input v-model="password" type="password" placeholder="密码" required>
      <button>登录</button><small v-if="error" class="error">{{ error }}</small>
    </form>
  </main>
  <div v-else class="shell">
    <aside><header><div class="brand-mark">U</div><div><strong>UCLI</strong><small>Server Console</small></div></header>
      <nav><button v-for="item in navigation" :key="item[0]" :class="{active: route.name === item[0]}" @click="router.push(item[0] === 'overview' ? '/' : `/${item[0]}`)">{{ item[1] }}</button></nav>
      <button class="logout" @click="openPasswordModal">修改密码</button>
      <button class="logout" @click="logout">退出登录</button>
    </aside>
    <section class="content"><RouterView /></section>

    <div v-if="showPasswordModal" class="modal-backdrop" @click.self="showPasswordModal = false">
      <div class="modal">
        <h2>修改密码</h2>
        <input v-model="currentPassword" type="password" placeholder="当前密码">
        <input v-model="newPassword" type="password" placeholder="新密码（至少 8 位）">
        <input v-model="confirmPassword" type="password" placeholder="确认新密码">
        <p v-if="passwordError" class="state error">{{ passwordError }}</p>
        <div class="modal-actions">
          <button class="primary" @click="changePassword">确认修改</button>
          <button @click="showPasswordModal = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>
