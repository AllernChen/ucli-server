// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KeyConnectionHelp from '../../apps/admin/src/components/KeyConnectionHelp.vue'

it('keeps connection examples free of actual API keys', () => {
  const w = mount(KeyConnectionHelp)
  expect(w.text()).toContain('OpenAI 兼容 Base URL')
  expect(w.get<HTMLTextAreaElement>('[aria-label="CLI 接入示例"]').element.value).toContain('UCLI_API_KEY')
  expect(w.html()).not.toContain('ucli_sk_')
})
