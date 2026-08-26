<script setup lang="ts">
import { computed } from 'vue'
import type { HealthStatus } from '../types/catalog'
const props = defineProps<{ status: HealthStatus | string }>()
const labels: Record<string, string> = {
  UNKNOWN: '待检测', HEALTHY: '健康', DEGRADED: '降级', UNHEALTHY: '异常',
  ENABLED: '已启用', ACTIVE: '正常', AVAILABLE: '待绑定', BOUND: '已绑定',
  DISABLED: '已停用', EXPIRED: '已过期', DELETED: '已删除', ARCHIVED: '已归档'
}
const colorStatus = computed(() => props.status === 'ENABLED' ? 'HEALTHY'
  : props.status === 'ARCHIVED' ? 'DISABLED' : props.status)
</script>

<template><span class="status-badge" :class="`status-${colorStatus.toLowerCase()}`"><i></i>{{ labels[status] || status }}</span></template>
