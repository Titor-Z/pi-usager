/**
 * GLM (智谱 BigModel) 适配器
 *
 * 定价不再由本插件维护: 价格全部来自 @foolsecret/pi-pricer 的共享价表
 * (~/.pi/model-pricing.json), 阶梯/折扣/时段由用户在该价表里配置。
 *
 * 缓存机制 (docs.bigmodel.cn/cn/guide/capabilities/cache.md):
 * - 隐式缓存, 自动识别重复上下文
 * - usage.prompt_tokens_details.cached_tokens 为缓存命中 token 数
 *   (pi 的 usage.cacheRead 已映射该字段)
 */

import type { ProviderAdapter } from "./types.ts";
import { queryBalanceFor } from "./balance.ts";

export const glmAdapter: ProviderAdapter = {
	id: "glm",
	name: "GLM",
	currency: "CNY",
	matchModel: (modelId) => !!modelId && modelId.toLowerCase().includes("glm"),

	billingNote:
		"按量实时计费，¥ 结算；价格来自 pi-pricer 共享价表（~/.pi/model-pricing.json）。" +
		"GLM Coding Plan 套餐按积分抵扣（高峰时段积分消耗系数不同），属套餐概念，不影响 API 按量价",
	cacheNote:
		"隐式上下文缓存，自动识别重复内容；缓存命中对应 usage.prompt_tokens_details.cached_tokens；缓存存储费当前限时免费",
	// 余额查询委托给 balance.ts (候选端点探测 + bearer/jwt 双模式)
	queryBalance: () => queryBalanceFor("glm"),
};
