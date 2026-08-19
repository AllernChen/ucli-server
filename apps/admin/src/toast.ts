import { reactive } from 'vue'

export const toasts = reactive<{ id: number; message: string }[]>([])
let seq = 0

export function toast(message: string) {
  const id = ++seq
  toasts.push({ id, message })
  setTimeout(() => {
    const index = toasts.findIndex(item => item.id === id)
    if (index >= 0) toasts.splice(index, 1)
  }, 3000)
}
