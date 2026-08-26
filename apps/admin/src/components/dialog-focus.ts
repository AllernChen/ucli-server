const focusableSelector = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function focusInitialDialogElement(dialog: HTMLElement | null) {
  const target = dialog?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
    || dialog?.querySelector<HTMLElement>(focusableSelector)
    || dialog
  target?.focus()
}

export function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== 'Tab' || !dialog) return
  const targets = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
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

export function restoreDialogFocus(trigger: HTMLElement | null) {
  trigger?.focus()
}
