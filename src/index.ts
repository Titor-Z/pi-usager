/**
 * Provider 注册表 (数据驱动)
 *
 * 适配器由"厂商描述"生成, 不再手写代码:
 *   - 内置厂商 = src/presets.ts 的数据
 *   - 用户自定义 = ~/.pi/pi-usager.json 的 customProviders (见 /usage config → 厂商管理)
 * 新增厂商无需写 .ts; 价格仍由 pi-pricer 共享价表负责。
 */

import type { ProviderAdapter } from "./types.ts";
import { getCustomProviders } from "./config.ts";
import { PRESET_PROVIDERS } from "./presets.ts";
import { descriptorToAdapter, type ProviderDescriptor } from "./provider-engine.ts";

/** 全部厂商描述: 内置预设 + 用户自定义 (自定义在后, 命中优先级更低) */
export function getDescriptors(): ProviderDescriptor[] {
	return [...PRESET_PROVIDERS, ...getCustomProviders()];
}

// 描述指纹 → 适配器缓存 (配置变更自动失效)
let cachedFingerprint = "";
let cachedAdapters: ProviderAdapter[] = [];

/** 全部适配器 (由描述生成, 内容变化时自动重建) */
export function getAdapters(): ProviderAdapter[] {
	const descriptors = getDescriptors();
	const fingerprint = JSON.stringify(descriptors);
	if (fingerprint !== cachedFingerprint) {
		cachedAdapters = descriptors.map(descriptorToAdapter);
		cachedFingerprint = fingerprint;
	}
	return cachedAdapters;
}

/** 通用兜底适配器: 未识别的模型不计费 (费用显示为 0), 但用量统计照常 */
export const genericAdapter: ProviderAdapter = {
	id: "generic",
	priceProvider: "generic",
	name: "通用",
	currency: "CNY",
	matchModel: () => false,
	billingNote: "未识别的模型/服务商, 无法估算费用 (仅统计 token 用量)",
	cacheNote: "以 pi 上报的 usage.cacheRead 作为缓存命中统计",
};

/** 按当前模型自动选择 provider 适配器 */
export function resolveProvider(modelId: string | undefined): ProviderAdapter {
	for (const adapter of getAdapters()) {
		if (adapter.matchModel(modelId)) return adapter;
	}
	return genericAdapter;
}

export { PRESET_PROVIDERS };
