<script setup lang="ts">
defineProps<{ open: boolean; title: string; message: string; confirmLabel?: string; danger?: boolean }>()
defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <Teleport to="body"><div v-if="open" class="modal-backdrop" @click.self="$emit('cancel')">
    <div class="modal"><h2>{{ title }}</h2><p class="muted">{{ message }}</p><div class="modal-actions">
      <button :class="danger ? 'danger-button' : 'primary'" @click="$emit('confirm')">{{ confirmLabel || '确认' }}</button>
      <button @click="$emit('cancel')">取消</button>
    </div></div>
  </div></Teleport>
</template>
