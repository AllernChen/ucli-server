import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { effectiveChannelCost, scheduledCostLabel } from '../../apps/admin/src/model-cost-alignment.js'

describe('public-model and channel cost alignment', () => {
  it('shows whether the channel uses its own schedule or the public-model fallback', () => {
    expect(effectiveChannelCost({
      source: 'CHANNEL_COST_RULE', inputPerMillion: '1', outputPerMillion: '2',
      cachedPerMillion: '0.02', reasoningPerMillion: '2', currency: 'CNY'
    })).toEqual({ sourceLabel: '渠道分时价格', priceLabel: '输入 ¥1 / 输出 ¥2 / M' })

    expect(effectiveChannelCost({
      source: 'PUBLIC_MODEL_FALLBACK', inputPerMillion: '3', outputPerMillion: '6',
      cachedPerMillion: '0.025', reasoningPerMillion: '6', currency: 'CNY'
    })).toEqual({ sourceLabel: '公共模型兜底价', priceLabel: '输入 ¥3 / 输出 ¥6 / M' })
  })

  it('presents channel price periods in the channel timezone', () => {
    expect(scheduledCostLabel({
      daysOfWeek: [1, 2, 3, 4, 5], startMinute: 1200, endMinute: 1380
    }, 'Asia/Shanghai')).toBe('周一至周五 · 20:00–23:00 · Asia/Shanghai')

    expect(scheduledCostLabel({
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 0
    }, 'UTC')).toBe('每天 · 全天 · UTC')
  })

  it('uses the same effective-price contract in channel and public-model pages', () => {
    const channelDetail = readFileSync(join(process.cwd(), 'apps/admin/src/views/ChannelDetail.vue'), 'utf8')
    const modelDetail = readFileSync(join(process.cwd(), 'apps/admin/src/views/ModelDetail.vue'), 'utf8')

    expect(channelDetail).toContain('effectiveChannelCost(model.currentCost)')
    expect(channelDetail).toContain('公共模型兜底价')
    expect(modelDetail).toContain('渠道实际采购价格')
    expect(modelDetail).toContain('scheduledCostLabel(rule, ability.costTimezone)')
  })
})
