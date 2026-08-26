<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { focusInitialDialogElement, restoreDialogFocus, trapDialogFocus } from './dialog-focus'

let dialogIndex = 0
const props = withDefaults(defineProps<{ open: boolean; title: string; width?: string; closeDisabled?: boolean }>(), { closeDisabled: false })
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLElement | null>(null)
const titleId = `drawer-title-${++dialogIndex}`
let returnFocus: HTMLElement | null = null

function requestClose() {
  if (!props.closeDisabled) emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }
  trapDialogFocus(event, dialog.value)
}

function restoreFocus() {
  restoreDialogFocus(returnFocus)
  returnFocus = null
}

watch(() => props.open, async open => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    focusInitialDialogElement(dialog.value)
  } else {
    restoreFocus()
  }
}, { immediate: true })

onBeforeUnmount(restoreFocus)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-backdrop" @click.self="requestClose">
      <section ref="dialog" class="drawer" :style="{ width: width || '560px' }" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1" @keydown="onKeydown">
        <header><h2 :id="titleId">{{ title }}</h2><button type="button" class="icon-button" aria-label="关闭" :disabled="closeDisabled" @click="requestClose">×</button></header>
        <div class="drawer-body"><slot /></div>
        <footer v-if="$slots.footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
