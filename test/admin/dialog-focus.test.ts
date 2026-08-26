import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDialogFocusLifecycle, focusInitialDialogElement, restoreDialogFocus, trapDialogFocus } from '../../apps/admin/src/components/dialog-focus.js'

function focusTarget(overrides: Record<string, unknown> = {}) {
  return { disabled: false, hidden: false, isConnected: true, focus: vi.fn(), ...overrides }
}

describe('dialog focus helpers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('skips a disabled initial target and focuses the next available dialog control', () => {
    const disabledInitial = focusTarget({ disabled: true })
    const fallback = focusTarget()
    const dialog = {
      focus: vi.fn(),
      querySelector: vi.fn((selector: string) => selector === '[data-dialog-initial-focus]' ? disabledInitial : fallback)
    } as unknown as HTMLElement

    focusInitialDialogElement(dialog)

    expect(disabledInitial.focus).not.toHaveBeenCalled()
    expect(fallback.focus).toHaveBeenCalledOnce()
  })

  it('wraps Tab to the first focusable control', () => {
    const first = focusTarget()
    const last = focusTarget()
    vi.stubGlobal('document', { activeElement: last })
    const dialog = { querySelectorAll: () => [first, last], focus: vi.fn() } as unknown as HTMLElement
    const event = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent

    trapDialogFocus(event, dialog)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(first.focus).toHaveBeenCalledOnce()
  })

  it('restores cancel focus to its active trigger and falls back when a confirmed action disabled it', () => {
    const trigger = focusTarget()
    const disabledTrigger = focusTarget({ disabled: true })
    const fallback = focusTarget()
    vi.stubGlobal('document', { querySelectorAll: () => [fallback] })

    restoreDialogFocus(trigger as unknown as HTMLElement)
    restoreDialogFocus(disabledTrigger as unknown as HTMLElement)

    expect(trigger.focus).toHaveBeenCalledOnce()
    expect(disabledTrigger.focus).not.toHaveBeenCalled()
    expect(fallback.focus).toHaveBeenCalledOnce()
  })

  it('restores focus only once after a real open, including unmount while open', () => {
    const trigger = focusTarget()
    const lifecycle = createDialogFocusLifecycle()

    lifecycle.restore()
    expect(trigger.focus).not.toHaveBeenCalled()

    lifecycle.open(trigger as unknown as HTMLElement)
    lifecycle.restore()
    lifecycle.restore()
    expect(trigger.focus).toHaveBeenCalledOnce()

    lifecycle.open(trigger as unknown as HTMLElement)
    lifecycle.restore()
    expect(trigger.focus).toHaveBeenCalledTimes(2)
  })
})
