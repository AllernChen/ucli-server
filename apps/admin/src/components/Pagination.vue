<script setup lang="ts">
const props = defineProps<{ total: number; limit: number; offset: number }>()
const emit = defineEmits<{ change: [offset: number] }>()
const previous = () => emit('change', Math.max(0, props.offset - props.limit))
const next = () => emit('change', props.offset + props.limit)
</script>

<template><div class="pagination"><span>第 {{ Math.floor(offset / limit) + 1 }} 页 · 共 {{ total }} 条</span>
  <button :disabled="offset === 0" @click="previous">上一页</button>
  <button :disabled="offset + limit >= total" @click="next">下一页</button>
</div></template>
