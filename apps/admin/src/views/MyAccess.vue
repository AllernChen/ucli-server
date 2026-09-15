<script setup lang="ts">
import { useRouter } from 'vue-router'
import EmployeeKeysPanel from '../components/EmployeeKeysPanel.vue'
const router = useRouter()
const base = window.location.origin
const example = `# 将管理员交付的 Key 保存到当前环境的 UCLI_API_KEY，不要写入共享文件\n# PowerShell：查询有权使用的模型\n$headers = @{ Authorization = "Bearer $env:UCLI_API_KEY" }\nInvoke-RestMethod -Uri "${base}/gateway/v1/models" -Headers $headers`
</script>
<template>
  <header class="page-header"><div><p>MY ACCESS</p><h1>我的模型接入</h1><span class="subtitle">使用平台地址和员工 Key 接入，无需安装 UCLI 客户端</span></div><button @click="router.push('/usage')">我的使用日志</button></header>
  <EmployeeKeysPanel />
  <section class="panel"><h2>客户端配置</h2><p>OpenAI 兼容 Base URL：<code>{{ base }}/gateway/v1</code></p><p>Anthropic Base URL：<code>{{ base }}/gateway/anthropic</code></p><p class="muted">支持 Chat Completions、Responses、Anthropic Messages；具体协议取决于所选模型的渠道配置，不能任意互转。模型目录不产生上游对话费用。</p><label>可复制的 PowerShell 示例（仅引用环境变量）<textarea :value="example" readonly rows="5" aria-label="CLI 接入示例" /></label><p class="muted">Key 只能调用模型网关，不能登录管理端。默认无密码员工由管理员管理 Key，无需开通网页登录。</p></section>
</template>
