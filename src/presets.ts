/**
 * 内置厂商预设 (数据, 非代码)
 *
 * 新增内置厂商 = 在此数组加一条 ProviderDescriptor; 定理由不写代码。
 * 价格不在这里 —— 单价统一由 pi-pricer 的共享价表 (~/.pi/model-pricing.json) 维护。
 */

import type { ProviderDescriptor } from "./provider-engine.ts";

export const PRESET_PROVIDERS: ProviderDescriptor[] = [
	{
		id: "deepseek",
		name: "DeepSeek",
		piProviderId: "deepseek",
		priceProvider: "deepseek",
		matchPatterns: ["deepseek"],
		billingNote: "按量实时计费，¥ 结算；价格与峰谷时段来自 pi-pricer 共享价表（~/.pi/model-pricing.json）",
		cacheNote: "隐式上下文缓存，命中部分按缓存命中价计费；pi 的 usage.cacheRead 对应其缓存命中 token 数",
		// 实测确认 (2026-09-09, 真实欠费账户): 欠费时 HTTP 402 + "Insufficient Balance"
		depletionStatuses: [402],
		balance: {
			endpoints: ["https://api.deepseek.com/user/balance"],
			auth: { type: "bearer" },
			balancePath: "balance_infos[0].total_balance",
			availablePath: "is_available",
			grantedPath: "balance_infos[0].granted_balance",
			toppedUpPath: "balance_infos[0].topped_up_balance",
			currency: "CNY",
		},
		builtin: true,
	},
	{
		id: "glm",
		name: "GLM",
		piProviderId: "zai",
		priceProvider: "zai",
		matchPatterns: ["glm"],
		billingNote:
			"按量实时计费，¥ 结算；价格来自 pi-pricer 共享价表（~/.pi/model-pricing.json）。" +
			"GLM Coding Plan 套餐按积分抵扣（高峰时段积分消耗系数不同），属套餐概念，不影响 API 按量价",
		cacheNote:
			"隐式上下文缓存，自动识别重复内容；缓存命中对应 usage.prompt_tokens_details.cached_tokens；缓存存储费当前限时免费",
		balance: {
			endpoints: [
				"https://open.bigmodel.cn/api/biz/account/query-customer-account-report",
				"https://open.bigmodel.cn/api/biz/account/getAccountBalanceEnough",
			],
			// bearer 实测可用; 失败且 key 为 id.secret 时自动用 jwt 签名重试
			auth: { type: "bearer" },
			authFallbacks: [{ type: "jwt-hs256" }],
			balancePath: ["data.availableBalance", "data.balance", "data"],
			toppedUpPath: "data.rechargeAmount",
			grantedPath: "data.giveAmount",
			currency: "CNY",
		},
		builtin: true,
	},
];
