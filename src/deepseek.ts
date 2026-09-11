/**
 * DeepSeek 适配器
 *
 * 定价不再由本插件维护: 价格全部来自 @foolsecret/pi-pricer 的共享价表
 * (~/.pi/model-pricing.json), 峰谷/时段由用户在该价表的 schedule 里配置。
 *
 * 余额 API: GET https://api.deepseek.com/user/balance
 */

import type { ProviderAdapter } from "./types.ts";
import { queryBalanceFor } from "./balance.ts";

export const deepseekAdapter: ProviderAdapter = {
	id: "deepseek",
	name: "DeepSeek",
	currency: "CNY",
	matchModel: (modelId) => !!modelId && modelId.toLowerCase().includes("deepseek"),

	billingNote: "按量实时计费，¥ 结算；价格与峰谷时段来自 pi-pricer 共享价表（~/.pi/model-pricing.json）",
	cacheNote: "隐式上下文缓存，命中部分按缓存命中价计费；pi 的 usage.cacheRead 对应其缓存命中 token 数",

	// 余额查询委托给 balance.ts (凭证: ~/.pi/pi-usager.json → 环境变量 → auth.json)
	queryBalance: () => queryBalanceFor("deepseek"),

	// 实测确认 (2026-09-09, 真实欠费账户): 欠费时 HTTP 402 + "Insufficient Balance",
	// 无歧义, 可立即置欠费态; 余额接口同时返回 is_available: false 作二次印证
	depletionStatuses: [402],
};
