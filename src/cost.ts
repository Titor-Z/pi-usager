/**
 * 通用计价核心: 取共享价表 → 计算费用
 *
 * 价格不再由本插件维护 —— 全部来自 @foolsecret/pi-pricer 的共享价表
 * (~/.pi/model-pricing.json), 见 pricing-source.ts。
 * 所有费用单位为人民币 ¥。
 */

import type { ProviderAdapter, Usage, CostBreakdown } from "./types.ts";
import { getPricingResolver, resolvePrice } from "./pricing-source.ts";

// ═══════════════════════════════════════════
//  费用计算
// ═══════════════════════════════════════════

/**
 * 计算费用。usage.input 为不含缓存命中的纯输入 (cache miss),
 * usage.cacheRead 为缓存命中 token 数。
 *
 * 价格来自 pi-pricer 的 resolvePricing(model, provider, now) —— 峰谷/节假日/
 * 促销等规则由其 first-match-wins 解析链决定, 本插件不做任何价格判断。
 * 未装 pi-pricer 或解析失败时返回 free=false 且 totalCNY=0, 由调用方
 * 展示"价格未知"而非误导性数字。
 */
export function calculateCost(
	adapter: ProviderAdapter,
	modelId: string | undefined,
	usage: Usage,
	now = new Date(),
): CostBreakdown {
	if (!modelId) {
		return { inputMissCost: 0, inputHitCost: 0, outputCost: 0, totalCNY: 0, free: false, priceKnown: false };
	}
	const price = resolvePrice(modelId, adapter.id, now);
	if (!price) {
		// 共享价表不可用: 不估算, 交由调用方按 getPricingSource() 提示
		return { inputMissCost: 0, inputHitCost: 0, outputCost: 0, totalCNY: 0, free: false, priceKnown: false };
	}
	// 三价全零 = 该模型配置为免费
	const free = price.inputMiss === 0 && price.inputHit === 0 && price.output === 0;
	const inputMissCost = (usage.input / 1_000_000) * price.inputMiss;
	const inputHitCost = (usage.cacheRead / 1_000_000) * price.inputHit;
	const outputCost = (usage.output / 1_000_000) * price.output;
	return {
		inputMissCost: free ? 0 : inputMissCost,
		inputHitCost: free ? 0 : inputHitCost,
		outputCost: free ? 0 : outputCost,
		totalCNY: free ? 0 : inputMissCost + inputHitCost + outputCost,
		free,
		isPeak: price.isPeak,
		priceKnown: true,
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

/** 价表可用性 (footer 展示"价格未知"与峰谷图标判定用) */
export function isPriceKnown(): boolean {
	return getPricingResolver() !== null;
}
