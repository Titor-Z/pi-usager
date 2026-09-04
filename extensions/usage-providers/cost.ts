/**
 * 通用计价核心: 阶梯解析 → 变体选择 → 费用计算
 * 所有费用单位为人民币 ¥
 */

import type { ProviderAdapter, ModelPricing, PriceVariant, UnitPrices, Usage, CostBreakdown, PriceTier } from "./types.ts";

// ═══════════════════════════════════════════
//  定价解析
// ═══════════════════════════════════════════

/** 在 provider 定价表中按 key 长度降序模糊匹配模型 (glm-5.3 不会误配到 glm-5.3-flash) */
export function lookupPricing(adapter: ProviderAdapter, modelId: string | undefined): ModelPricing | undefined {
	if (!modelId) return adapter.fallbackPricing;
	const keys = Object.keys(adapter.pricing).sort((a, b) => b.length - a.length);
	for (const key of keys) {
		if (modelId.toLowerCase().includes(key)) return adapter.pricing[key];
	}
	return adapter.fallbackPricing;
}

function tierMatches(tier: PriceTier, input: number, output: number): boolean {
	const m = tier.match;
	if (!m) return true; // 兜底阶梯
	if (m.inputMinK !== undefined && input < m.inputMinK * 1000) return false;
	if (m.inputMaxK !== undefined && input >= m.inputMaxK * 1000) return false;
	if (m.outputMinM !== undefined && output < m.outputMinM * 1_000_000) return false;
	if (m.outputMaxM !== undefined && output >= m.outputMaxM * 1_000_000) return false;
	return true;
}

/** 选择当前时间生效的计价变体: active 命中 → default → 第一个 */
export function resolveVariant(tier: PriceTier, now: Date): PriceVariant {
	const actives = tier.variants.filter((v) => v.active?.(now));
	if (actives.length > 0) return actives[0];
	const fallback = tier.variants.find((v) => v.default);
	return fallback ?? tier.variants[0];
}

export interface ResolvedPricing {
	prices: UnitPrices;
	free: boolean;
	variantLabel?: string;
	variantNote?: string;
	/** 是否命中了非兜底阶梯 (跨档提示用) */
	tierMatched: boolean;
}

/** 完整解析: 免费模型 → 阶梯匹配 → 变体选择 */
export function resolvePricing(
	pricing: ModelPricing,
	input: number,
	output: number,
	now: Date,
): ResolvedPricing {
	if (pricing.free) {
		return {
			prices: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
			free: true,
			variantLabel: "FREE",
			tierMatched: true,
		};
	}
	const tiers = pricing.tiers?.length ? pricing.tiers : [{ variants: [] as PriceVariant[] }];
	let tier = tiers.find((t) => tierMatches(t, input, output));
	const tierMatched = tier !== undefined && tier.match !== undefined;
	if (!tier) tier = tiers[tiers.length - 1]; // 最后一个阶梯兜底
	const variant = resolveVariant(tier, now);
	return {
		prices: variant.prices,
		free: false,
		variantLabel: variant.label,
		variantNote: variant.note,
		tierMatched,
	};
}

// ═══════════════════════════════════════════
//  费用计算
// ═══════════════════════════════════════════

/**
 * 计算费用。usage.input 为不含缓存命中的纯输入 (cache miss),
 * usage.cacheRead 为缓存命中 token 数。
 */
export function calculateCost(
	adapter: ProviderAdapter,
	modelId: string | undefined,
	usage: Usage,
	now = new Date(),
): CostBreakdown {
	const pricing = lookupPricing(adapter, modelId);
	if (!pricing) {
		return { inputMissCost: 0, inputHitCost: 0, outputCost: 0, totalCNY: 0, free: false };
	}
	const r = resolvePricing(pricing, usage.input, usage.output, now);
	const p = r.prices;
	const inputMissCost = (usage.input / 1_000_000) * p.inputCacheMiss;
	const inputHitCost = (usage.cacheRead / 1_000_000) * p.inputCacheHit;
	const outputCost = (usage.output / 1_000_000) * p.output;
	return {
		inputMissCost: r.free ? 0 : inputMissCost,
		inputHitCost: r.free ? 0 : inputHitCost,
		outputCost: r.free ? 0 : outputCost,
		totalCNY: r.free ? 0 : inputMissCost + inputHitCost + outputCost,
		free: r.free,
		variantLabel: r.variantLabel,
		variantNote: r.variantNote,
	};
}

// ═══════════════════════════════════════════
//  会话用量统计
// ═══════════════════════════════════════════

export interface SessionUsageStats {
	/** 分支累计 (所有 assistant 消息之和) */
	total: Usage;
	/** 最近一条 assistant 消息的用量 (此次回答) */
	lastTurn: Usage | undefined;
	messageCount: number;
}

/** 从会话分支中汇总 token 用量 (含最近一次回答) */
export function getSessionUsage(ctx: any, AssistantMessageCtor?: unknown): SessionUsageStats {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let lastTurn: Usage | undefined;
	let messageCount = 0;
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as any;
				if (m.usage) {
					total.input += m.usage.input ?? 0;
					total.output += m.usage.output ?? 0;
					total.cacheRead += m.usage.cacheRead ?? 0;
					total.cacheWrite += m.usage.cacheWrite ?? 0;
					lastTurn = {
						input: m.usage.input ?? 0,
						output: m.usage.output ?? 0,
						cacheRead: m.usage.cacheRead ?? 0,
						cacheWrite: m.usage.cacheWrite ?? 0,
					};
				}
				messageCount++;
			}
		}
	} catch { /* ignore */ }
	return { total, lastTurn, messageCount };
}

// ═══════════════════════════════════════════
//  格式化
// ═══════════════════════════════════════════

export function fmtCurrency(cny: number, free = false): string {
	if (free) return "FREE";
	if (cny < 0.01 && cny > 0) return `¥${cny.toFixed(4)}`;
	return `¥${cny.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function hitRate(input: number, cacheRead: number): string {
	const denom = input + cacheRead;
	if (denom <= 0) return "0.0";
	return ((cacheRead / denom) * 100).toFixed(1);
}
