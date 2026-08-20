<script setup lang="ts">
import type { HealthStatus } from '../types/catalog'
defineProps<{ status: HealthStatus | string }>()
const labels: Record<string, string> = {
  UNKNOWN: '待检测', HEALTHY: '健康', DEGRADED: '降级', UNHEALTHY: '异常', DISABLED: '已停用'
}
</script>

<template><span class="status-badge" :class="`status-${status.toLowerCase()}`"><i></i>{{ labels[status] || status }}</span></template>
