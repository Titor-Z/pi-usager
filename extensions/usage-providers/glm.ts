/**
 * GLM (智谱 BigModel) 适配器
 *
 * 定价来源: bigmodel.cn/pricing + ~/Desktop/GLM_定价表.md (核验至 2026-09 初)
 * 单位: 人民币 元/百万 tokens
 *
 * 缓存机制 (docs.bigmodel.cn/cn/guide/capabilities/cache.md):
 * - 隐式缓存, 自动识别重复上下文
 * - usage.prompt_tokens_details.cached_tokens 为缓存命中 token 数
 *   (pi 的 usage.cacheRead 已映射该字段)
 * - 缓存存储费当前限时免费
 *
 * GLM 按量计费无峰谷定价; Coding Plan 积分制的时段系数为套餐概念, 仅在 billingNote 说明。
 */

import type { ProviderAdapter, ModelPricing, UnitPrices } from "./types.ts";
import { until } from "./types.ts";
import { queryBalanceFor } from "./balance.ts";

function tier(base: UnitPrices): ModelPricing {
	return { tiers: [{ variants: [{ label: "标准价", prices: base, default: true }] }] };
}

/** 输入长度阶梯 (< 32k / >= 32k) */
function inputTiered(short: UnitPrices, long: UnitPrices): ModelPricing {
	return {
		tiers: [
			{ match: { inputMaxK: 32 }, variants: [{ label: "标准价", prices: short, default: true }] },
			{ match: { inputMinK: 32 }, variants: [{ label: "标准价", prices: long, default: true }] },
		],
	};
}

/** GLM-4.7 / 4.5-Air 式三档阶梯 (含输出 0.2M 分界) */
function tiered47(shortShort: UnitPrices, shortLong: UnitPrices, long: UnitPrices): ModelPricing {
	return {
		tiers: [
			{ match: { inputMaxK: 32, outputMaxM: 0.2 }, variants: [{ label: "标准价", prices: shortShort, default: true }] },
			{ match: { inputMaxK: 32, outputMinM: 0.2 }, variants: [{ label: "标准价", prices: shortLong, default: true }] },
			{ match: { inputMinK: 32 }, variants: [{ label: "标准价", prices: long, default: true }] },
		],
	};
}

const FREE: ModelPricing = { tiers: [], free: true };

/** GLM-5.3-Flash 限时 5 折 (优惠截止 2026-09-09 24:00 UTC+8, 到期自动恢复原价) */
const glm53Flash: ModelPricing = {
	tiers: [{
		variants: [
			{
				label: "限时5折",
				prices: { inputCacheHit: 0.115, inputCacheMiss: 0.4, output: 1.4 },
				active: until("2026-09-09T16:00:00Z"), // 2026-09-09 24:00 UTC+8
				note: "5折优惠, 截至 2026-09-09 24:00",
			},
			{
				label: "原价",
				prices: { inputCacheHit: 0.23, inputCacheMiss: 0.8, output: 2.8 },
				default: true,
			},
		],
	}],
};

export const glmAdapter: ProviderAdapter = {
	id: "glm",
	name: "GLM",
	currency: "CNY",
	matchModel: (modelId) => !!modelId && modelId.toLowerCase().includes("glm"),
	hasPeakPricing: false,

	pricing: {
		// ── GLM-5.x ──
		"glm-5.3-flash": glm53Flash,
		"glm-5.3": tier({ inputCacheHit: 2, inputCacheMiss: 8, output: 28 }),
		"glm-5.2": tier({ inputCacheHit: 2, inputCacheMiss: 8, output: 28 }),
		"glm-5.1": inputTiered(
			{ inputCacheHit: 1.3, inputCacheMiss: 6, output: 24 },
			{ inputCacheHit: 2, inputCacheMiss: 8, output: 28 },
		),
		"glm-5v-turbo": inputTiered(
			{ inputCacheHit: 1.2, inputCacheMiss: 5, output: 22 },
			{ inputCacheHit: 1.8, inputCacheMiss: 7, output: 26 },
		),
		"glm-5-turbo": inputTiered(
			{ inputCacheHit: 1.2, inputCacheMiss: 5, output: 22 },
			{ inputCacheHit: 1.8, inputCacheMiss: 7, output: 26 },
		),
		"glm-5": inputTiered(
			{ inputCacheHit: 1, inputCacheMiss: 4, output: 18 },
			{ inputCacheHit: 1.5, inputCacheMiss: 6, output: 22 },
		),

		// ── GLM-4.x ──
		"glm-4.7-flashx": tier({ inputCacheHit: 0.1, inputCacheMiss: 0.5, output: 3 }),
		"glm-4.7-flash": FREE,
		"glm-4.7": tiered47(
			{ inputCacheHit: 0.4, inputCacheMiss: 2, output: 8 },   // <32k, <0.2M
			{ inputCacheHit: 0.6, inputCacheMiss: 3, output: 14 },  // <32k, >=0.2M
			{ inputCacheHit: 0.8, inputCacheMiss: 4, output: 16 },  // >=32k
		),
		"glm-4.5-air": tiered47(
			{ inputCacheHit: 0.16, inputCacheMiss: 0.8, output: 2 },
			{ inputCacheHit: 0.16, inputCacheMiss: 0.8, output: 6 },
			{ inputCacheHit: 0.24, inputCacheMiss: 1.2, output: 8 },
		),
		// GLM-4.6 / GLM-4.5 未在 CNY 价目表列出, 按 GLM-4.7 同档估算
		"glm-4.6": tier({ inputCacheHit: 0.8, inputCacheMiss: 4, output: 16 }),
		"glm-4.5": tier({ inputCacheHit: 0.8, inputCacheMiss: 4, output: 16 }),

		// ── GLM-4.xV (视觉) ──
		"glm-4.6v-flashx": inputTiered(
			{ inputCacheHit: 0.03, inputCacheMiss: 0.15, output: 1.5 },
			{ inputCacheHit: 0.03, inputCacheMiss: 0.3, output: 3 },
		),
		"glm-4.6v-flash": FREE,
		"glm-4.6v": inputTiered(
			{ inputCacheHit: 0.2, inputCacheMiss: 1, output: 3 },
			{ inputCacheHit: 0.4, inputCacheMiss: 2, output: 6 },
		),
		"glm-4.5v": inputTiered(
			{ inputCacheHit: 0.4, inputCacheMiss: 2, output: 6 },
			{ inputCacheHit: 0.8, inputCacheMiss: 4, output: 12 },
		),
	},
	fallbackPricing: tier({ inputCacheHit: 2, inputCacheMiss: 8, output: 28 }),

	billingNote:
		"按量实时计费，¥ 结算，无峰谷定价。" +
		"GLM Coding Plan 套餐按积分抵扣（高峰时段周一至周五 14:00~18:00 积分消耗系数不同），属套餐概念，不影响 API 按量价",
	cacheNote:
		"隐式上下文缓存，自动识别重复内容；缓存命中对应 usage.prompt_tokens_details.cached_tokens；缓存存储费当前限时免费",
	// 余额查询委托给 balance.ts (候选端点探测 + bearer/jwt 双模式)
	queryBalance: () => queryBalanceFor("glm"),
};
