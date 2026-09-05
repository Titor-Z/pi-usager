/**
 * Provider 注册表
 *
 * 新增 provider (如未来的 Mimo):
 *   1. 在本目录新建 xxx.ts, 实现 ProviderAdapter
 *   2. 加入 ADAPTERS 数组即可
 */

import type { ProviderAdapter } from "./types.ts";
import { deepseekAdapter } from "./deepseek.ts";
import { glmAdapter } from "./glm.ts";

export const ADAPTERS: ProviderAdapter[] = [deepseekAdapter, glmAdapter];

/** 通用兜底适配器: 未识别的模型不计费 (费用显示为 0), 但用量统计照常 */
export const genericAdapter: ProviderAdapter = {
	id: "generic",
	name: "通用",
	currency: "CNY",
	matchModel: () => false,
	hasPeakPricing: false,
	pricing: {},
	billingNote: "未识别的模型/服务商, 无法估算费用 (仅统计 token 用量)",
	cacheNote: "以 pi 上报的 usage.cacheRead 作为缓存命中统计",
};

// TODO(可选增强): 定价表目前为手动维护 + 变体自动切换。
// bigmodel.cn/pricing 为 JS 渲染且无稳定 JSON 端点, 若未来提供官方价格 API,
// 可在此增加远端拉取/校验逻辑, 定期刷新各 adapter 的 pricing。

/** 按当前模型自动选择 provider 适配器 */
export function resolveProvider(modelId: string | undefined): ProviderAdapter {
	for (const adapter of ADAPTERS) {
		if (adapter.matchModel(modelId)) return adapter;
	}
	return genericAdapter;
}

export { deepseekAdapter, glmAdapter };
