import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modelsView = readFileSync('apps/admin/src/views/Models.vue', 'utf8')
const detailView = readFileSync('apps/admin/src/views/ModelDetail.vue', 'utf8')

describe('public model drawer errors', () => {
  it('keeps create and edit failures inside the Models drawer', () => {
    expect(modelsView).toContain("const formError = ref('')")
    expect(modelsView).toContain('formError.value = value.message')
    expect(modelsView).toContain('<p v-if="formError" class="state error">{{ formError }}</p>')
    expect(modelsView.indexOf('v-if="formError"')).toBeGreaterThan(modelsView.indexOf('<Drawer'))
  })

  it('keeps edit failures inside the ModelDetail drawer', () => {
    expect(detailView).toContain("const modelFormError = ref('')")
    expect(detailView).toContain('modelFormError.value = value.message')
    expect(detailView).toContain('<p v-if="modelFormError" class="state error">{{ modelFormError }}</p>')
    expect(detailView.indexOf('v-if="modelFormError"')).toBeGreaterThan(detailView.indexOf('<Drawer'))
  })
})
