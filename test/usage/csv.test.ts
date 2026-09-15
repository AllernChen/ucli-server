import { expect, it } from 'vitest'
import { csvDocument } from '../../packages/usage/src/csv.js'

it('quotes UTF-8 CSV and neutralizes spreadsheet formulas in every cell without changing precision', () => {
  expect(csvDocument([['中文', 'a,"b"\nc', ' =1+1', '\uFEFF@SUM(A1)', '\ttext', '-0.12345678', 'plain']]))
    .toBe('\uFEFF"中文","a,""b""\nc","\' =1+1","\'\uFEFF@SUM(A1)","\'\ttext","\'-0.12345678","plain"\r\n')
})
