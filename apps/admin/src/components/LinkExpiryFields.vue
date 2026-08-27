<script setup lang="ts">
import type { LinkExpiryForm, LinkExpiryMode } from '../device-grants'

const props = defineProps<{ modelValue: LinkExpiryForm }>()
const emit = defineEmits<{ 'update:modelValue': [value: LinkExpiryForm] }>()

const options: Array<{ value: LinkExpiryMode; label: string }> = [
  { value: '1d', label: '1 天' },
  { value: '7d', label: '7 天（默认）' },
  { value: '30d', label: '30 天' },
  { value: 'permanent', label: '永久' },
  { value: 'custom', label: '自定义' }
]

function updateMode(event: Event) {
  const mode = (event.target as HTMLSelectElement).value as LinkExpiryMode
  emit('update:modelValue', { ...props.modelValue, mode })
}

function updateCustomExpiresAt(event: Event) {
  const customExpiresAt = (event.target as HTMLInputElement).value
  emit('update:modelValue', { ...props.modelValue, customExpiresAt })
}
</script>

<template>
  <div class="link-expiry-fields">
    <label>URL 有效期
      <select :value="modelValue.mode" @change="updateMode">
        <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    <label>自定义截止时间
      <input
        type="datetime-local"
        :value="modelValue.customExpiresAt"
        :disabled="modelValue.mode !== 'custom'"
        :required="modelValue.mode === 'custom'"
        @input="updateCustomExpiresAt"
      >
    </label>
  </div>
</template>
