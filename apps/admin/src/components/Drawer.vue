<script setup lang="ts">
defineProps<{ open: boolean; title: string; width?: string }>()
defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-backdrop" @click.self="$emit('close')">
      <section class="drawer" :style="{ width: width || '560px' }">
        <header><h2>{{ title }}</h2><button class="icon-button" @click="$emit('close')">×</button></header>
        <div class="drawer-body"><slot /></div>
        <footer v-if="$slots.footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
