<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { focusInitialDialogElement, restoreDialogFocus, trapDialogFocus } from './dialog-focus'

let dialogIndex = 0
const props = withDefaults(defineProps<{ open: boolean; title: string; message: string; confirmLabel?: string; danger?: boolean; closeDisabled?: boolean }>(), { closeDisabled: false })
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const dialog = ref<HTMLElement | null>(null)
const titleId = `confirm-dialog-title-${++dialogIndex}`
const messageId = `confirm-dialog-message-${dialogIndex}`
let returnFocus: HTMLElement | null = null

function requestCancel() {
  if (!props.closeDisabled) emit('cancel')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestCancel()
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
  <Teleport to="body"><div v-if="open" class="modal-backdrop" @click.self="requestCancel">
    <section ref="dialog" class="modal" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="messageId" tabindex="-1" @keydown="onKeydown"><h2 :id="titleId">{{ title }}</h2><p :id="messageId" class="muted">{{ message }}</p><div class="modal-actions">
      <button type="button" :class="danger ? 'danger-button' : 'primary'" :disabled="closeDisabled" @click="$emit('confirm')">{{ confirmLabel || '确认' }}</button>
      <button type="button" data-dialog-initial-focus :disabled="closeDisabled" @click="requestCancel">取消</button>
    </div></section>
  </div></Teleport>
</template>
