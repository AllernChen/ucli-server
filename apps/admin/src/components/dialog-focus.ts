const focusableSelector = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function isUsableFocusTarget(target: HTMLElement | null | undefined) {
  return Boolean(target) && target!.isConnected !== false && !target!.hidden && !target!.hasAttribute?.('disabled') &&
    !('disabled' in target! && Boolean((target as HTMLButtonElement).disabled)) && target!.getAttribute?.('aria-hidden') !== 'true'
}

export function focusInitialDialogElement(dialog: HTMLElement | null) {
  const initial = dialog?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
  const targets = Array.from(dialog?.querySelectorAll?.<HTMLElement>(focusableSelector) || [])
  const target = (isUsableFocusTarget(initial) ? initial : undefined)
    || targets.find(isUsableFocusTarget)
    || dialog?.querySelector<HTMLElement>(focusableSelector)
    || dialog
  target?.focus()
}

export function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== 'Tab' || !dialog) return
  const targets = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(isUsableFocusTarget)
  if (!targets.length) {
    event.preventDefault()
    dialog.focus()
    return
  }
  const first = targets[0]
  const last = targets[targets.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

export function restoreDialogFocus(trigger: HTMLElement | null, fallback?: HTMLElement | null) {
  const pageFallback = typeof document === 'undefined' ? undefined
    : Array.from(document.querySelectorAll<HTMLElement>(focusableSelector)).find(isUsableFocusTarget)
  const target = isUsableFocusTarget(trigger) ? trigger : isUsableFocusTarget(fallback) ? fallback : pageFallback
  target?.focus()
}
