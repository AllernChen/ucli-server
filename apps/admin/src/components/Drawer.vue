<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { createDialogFocusLifecycle, focusInitialDialogElement, trapDialogFocus } from './dialog-focus'

let dialogIndex = 0
const props = withDefaults(defineProps<{ open: boolean; title: string; description?: string; width?: string; closeDisabled?: boolean }>(), { closeDisabled: false })
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLElement | null>(null)
const titleId = `drawer-title-${++dialogIndex}`
const descriptionId = `drawer-description-${dialogIndex}`
let returnFocus: HTMLElement | null = null
const focusLifecycle = createDialogFocusLifecycle()

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
  focusLifecycle.restore()
  returnFocus = null
}

watch(() => props.open, async open => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    focusLifecycle.open(returnFocus)
    await nextTick()
    focusInitialDialogElement(dialog.value)
  } else if (focusLifecycle.shouldRestore) {
    await nextTick()
    if (props.open) return
    restoreFocus()
  }
}, { immediate: true })

onBeforeUnmount(() => { if (focusLifecycle.shouldRestore) restoreFocus() })
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-backdrop" @click.self="requestClose">
      <section ref="dialog" class="drawer" :style="{ width: width || '560px' }" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="description ? descriptionId : undefined" tabindex="-1" @keydown="onKeydown">
        <header><div><h2 :id="titleId">{{ title }}</h2><p v-if="description" :id="descriptionId" class="drawer-description muted">{{ description }}</p></div><button type="button" class="icon-button" aria-label="关闭" :disabled="closeDisabled" @click="requestClose">×</button></header>
        <div class="drawer-body"><slot /></div>
        <footer v-if="$slots.footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
