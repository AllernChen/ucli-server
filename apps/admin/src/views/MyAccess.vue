<script setup lang="ts">
import { useRouter } from 'vue-router'
import EmployeeKeysPanel from '../components/EmployeeKeysPanel.vue'
import KeyConnectionHelp from '../components/KeyConnectionHelp.vue'
const router = useRouter()
</script>
<template>
  <header class="page-header"><div><p>MY ACCESS</p><h1>我的模型接入</h1><span class="subtitle">使用平台地址和员工 Key 接入，无需安装 UCLI 客户端</span></div><button @click="router.push('/usage')">我的使用日志</button></header>
  <EmployeeKeysPanel />
  <section class="panel"><KeyConnectionHelp /></section>
</template>
