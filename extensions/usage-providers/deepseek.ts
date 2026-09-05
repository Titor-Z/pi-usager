/**
 * DeepSeek 适配器
 *
 * 定价来源: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 峰谷定价 (2025年7月起): 高峰 9:00~12:00 及 14:00~18:00 (北京时间) = 基础价 × 2
 * 通过计价变体实现自动切换, 无需手动开关。
 *
 * 余额 API: GET https://api.deepseek.com/user/balance
 */

import type { ProviderAdapter, ModelPricing, UnitPrices } from "./types.ts";
import { beijingHour } from "./types.ts";
import { queryBalanceFor } from "./balance.ts";

function isPeakHour(now = new Date()): boolean {
	const h = beijingHour(now);
	return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 由基础价构造 平时/高峰 两个计价变体 (高峰 ×2, 自动切换) */
function peakVariants(base: UnitPrices): ModelPricing["tiers"] {
	const peak: UnitPrices = {
		inputCacheHit: base.inputCacheHit * 2,
		inputCacheMiss: base.inputCacheMiss * 2,
		output: base.output * 2,
	};
	return [{
		variants: [
			{
				label: "高峰价",
				prices: peak,
				active: (now) => isPeakHour(now),
				note: "每日 9:00~12:00, 14:00~18:00（北京时间）, 高峰 = 平时 × 2",
			},
			{ label: "平时价", prices: base, default: true },
		],
	}];
}

export const deepseekAdapter: ProviderAdapter = {
	id: "deepseek",
	name: "DeepSeek",
	currency: "CNY",
	matchModel: (modelId) => !!modelId && modelId.toLowerCase().includes("deepseek"),
	hasPeakPricing: true,

	pricing: {
		"deepseek-v4-flash": { tiers: peakVariants({ inputCacheHit: 0.02, inputCacheMiss: 1, output: 2 }) },
		"deepseek-v4-pro": { tiers: peakVariants({ inputCacheHit: 0.025, inputCacheMiss: 3, output: 6 }) },
		// 向下兼容 (旧模型名 → v4-flash 价)
		"deepseek-chat": { tiers: peakVariants({ inputCacheHit: 0.02, inputCacheMiss: 1, output: 2 }) },
		"deepseek-reasoner": { tiers: peakVariants({ inputCacheHit: 0.02, inputCacheMiss: 1, output: 2 }) },
	},
	fallbackPricing: { tiers: peakVariants({ inputCacheHit: 0.025, inputCacheMiss: 3, output: 6 }) },

	billingNote: "按量实时计费，¥ 结算；高峰时段（9:00~12:00, 14:00~18:00 北京时间）价格为平时的 2 倍",
	cacheNote: "隐式上下文缓存，命中部分按缓存命中价计费；pi 的 usage.cacheRead 对应其缓存命中 token 数",

	// 余额查询委托给 balance.ts (凭证: ~/.pi/pi-usager.json → 环境变量 → auth.json)
	queryBalance: () => queryBalanceFor("deepseek"),
};

export { isPeakHour };
