<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'

const route = useRoute()
const token = ref(String(route.query.token || ''))
const displayName = ref('')
const password = ref('')
const confirm = ref('')
const hasAccount = ref(false)
const currentPassword = ref('')
const error = ref('')
const done = ref(false)

async function submit() {
  error.value = ''
  if (!token.value.trim()) return error.value = '缺少邀请令牌'
  if (!displayName.value.trim()) return error.value = '请填写显示名'
  if (hasAccount.value) {
    if (!currentPassword.value) return error.value = '请填写当前密码'
  } else {
    if (!password.value || password.value.length < 8) return error.value = '新密码至少 8 位'
    if (password.value !== confirm.value) return error.value = '两次密码不一致'
  }
  try {
    await api('/api/v1/auth/invitations/accept', { method: 'POST', body: JSON.stringify(
      hasAccount.value
        ? { token: token.value.trim(), displayName: displayName.value.trim(), currentPassword: currentPassword.value }
        : { token: token.value.trim(), displayName: displayName.value.trim(), password: password.value }
    ) })
    done.value = true
  } catch (value: any) { error.value = value.message }
}
</script>

<template>
  <form v-if="!done" class="login-card" @submit.prevent="submit">
    <div class="brand-mark">U</div><h1>加入组织</h1><p>输入邀请令牌与账号信息完成入职</p>
    <input v-model="token" placeholder="邀请令牌">
    <input v-model="displayName" placeholder="显示名">
    <label class="inline"><input type="checkbox" v-model="hasAccount"> 我已有账号（用当前密码验证）</label>
    <input v-if="hasAccount" v-model="currentPassword" type="password" placeholder="当前密码">
    <template v-else>
      <input v-model="password" type="password" placeholder="新密码（至少 8 位）">
      <input v-model="confirm" type="password" placeholder="确认新密码">
    </template>
    <button>加入</button><small v-if="error" class="error">{{ error }}</small>
  </form>
  <div v-else class="login-card">
    <div class="brand-mark">U</div><h1>加入成功</h1>
    <p>你已加入组织，请返回登录页用邮箱登录。</p>
    <a href="/">去登录</a>
  </div>
</template>
