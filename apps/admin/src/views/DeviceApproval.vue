<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../api'

const userCode = ref('')
const notice = ref('')
const error = ref('')

async function approve() {
  const code = userCode.value.trim().toUpperCase()
  if (!code) return error.value = '请输入设备码'
  error.value = ''; notice.value = ''
  try {
    const result = await api('/api/v1/auth/device/approve', { method: 'POST', body: JSON.stringify({ userCode: code }) })
    notice.value = result.approved ? '已批准，请在桌面端继续完成登录' : '已处理'
    userCode.value = ''
  } catch (value: any) { error.value = value.message }
}
</script>

<template>
  <header class="page-header"><div><p>UCLI DEVICE</p><h1>设备授权</h1></div></header>
  <section class="panel form-panel">
    <h2>批准桌面端登录</h2>
    <p class="state">桌面端会显示一个 8 位设备码，请将其输入下方并点击「批准」。</p>
    <div class="form-row">
      <input v-model="userCode" placeholder="设备码（如 ABCD-EFGH）" maxlength="9">
      <button class="primary" @click="approve">批准</button>
    </div>
    <p v-if="notice" class="state">{{ notice }}</p>
    <p v-if="error" class="state error">{{ error }}</p>
  </section>
</template>
