/**
 * 使用量/计费公共类型定义
 *
 * 设计要点:
 * - 统一人民币 ¥ 计价（所有 provider 的价格均为 元/百万 tokens）
 * - 支持 阶梯定价（按输入/输出长度分档）
 * - 支持 计价变体（同一模型的多个价格, 按时间自动切换, 如限时折扣/峰谷定价）
 * - 支持免费模型（显示 FREE）
 */

/** 一组单价 (元/百万 tokens) */
export interface UnitPrices {
	/** 输入 (缓存命中) */
	inputCacheHit: number;
	/** 输入 (缓存未命中) */
	inputCacheMiss: number;
	/** 输出 */
	output: number;
}

/** 阶梯匹配条件。未指定的维度表示不限。 */
export interface TierMatch {
	/** 输入长度下界 (含), 单位: 千 tokens, 如 32 表示输入 >= 32k */
	inputMinK?: number;
	/** 输入长度上界 (不含), 单位: 千 tokens, 如 32 表示输入 < 32k */
	inputMaxK?: number;
	/** 输出长度下界 (含), 单位: 百万 tokens, 如 0.2 表示输出 >= 0.2M */
	outputMinM?: number;
	/** 输出长度上界 (不含), 单位: 百万 tokens */
	outputMaxM?: number;
}

/**
 * 计价变体: 同一模型在不同时间/时段可能适用的价格。
 * 解析顺序: active(now) === true 的变体优先 → default 变体 → 第一个变体。
 */
export interface PriceVariant {
	/** 变体名称, 如 "限时5折" / "原价" / "高峰价" / "平时价" */
	label: string;
	/** 该变体下的单价 */
	prices: UnitPrices;
	/** 生效判断 (如限时折扣有效期、峰谷时段)。无则视为始终适用。 */
	active?: (now: Date) => boolean;
	/** 备注, 如 "截至 2026-09-09" */
	note?: string;
	/** 无任何 active 变体命中时的兜底变体 */
	default?: boolean;
}

/** 一个阶梯: 匹配条件 + 该阶梯下的计价变体列表 */
export interface PriceTier {
	/** 匹配条件, 不填则作为兜底阶梯 */
	match?: TierMatch;
	/** 该阶梯下的计价变体 */
	variants: PriceVariant[];
}

/** 单个模型的定价描述 */
export interface ModelPricing {
	/** 阶梯列表 (按声明顺序匹配, 第一个命中的生效; 无阶梯时用单阶梯) */
	tiers: PriceTier[];
	/** 免费模型 (费用显示 FREE) */
	free?: boolean;
	/** 缓存存储费 (元/百万tokens/小时); GLM 当前限时免费, 仅作备注展示 */
	cacheStorageNote?: string;
}

/** 账户余额 (统一结构) */
export interface ProviderBalance {
	available: boolean;
	currency: string;
	total: string;
	granted?: string;
	toppedUp?: string;
}

export type BalanceResult = ProviderBalance | { error: string };

/**
 * Provider 适配器: 一个模型服务商 (DeepSeek / GLM / 未来的 Mimo ...)
 */
export interface ProviderAdapter {
	id: string;
	name: string;
	/** 计价货币, 当前统一为 CNY */
	currency: "CNY";
	/** 当前选中的模型是否属于该 provider */
	matchModel(modelId: string | undefined): boolean;
	/** 定价表。查找时按 key 长度降序模糊匹配 modelId (避免 glm-5.3 误配到 glm-5.3-flash) */
	pricing: Record<string, ModelPricing>;
	/** 未在 pricing 中命中时的兜底定价 */
	fallbackPricing?: ModelPricing;
	/** 是否存在峰谷/时段计费 (决定 footer 是否显示峰谷图标) */
	hasPeakPricing: boolean;
	/** 查询账户余额 (provider 无公开 API 时不实现) */
	queryBalance?(): Promise<BalanceResult>;
	/** 计费口径说明 (按量计费 / 周期 / 套餐等) */
	billingNote?: string;
	/** 缓存统计口径说明 */
	cacheNote?: string;
}

// ═══════════════════════════════════════════
//  运行时计算结果
// ═══════════════════════════════════════════

/** 单次/累计 token 用量 */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CostBreakdown {
	/** 缓存未命中输入费用 (¥) */
	inputMissCost: number;
	/** 缓存命中输入费用 (¥) */
	inputHitCost: number;
	/** 输出费用 (¥) */
	outputCost: number;
	/** 总费用 (¥); 免费模型为 0 */
	totalCNY: number;
	/** 免费模型 */
	free: boolean;
	/** 当前生效的计价变体 label, 如 "限时5折" / "高峰价" */
	variantLabel?: string;
	/** 变体备注, 如 "截至 2026-09-09" */
	variantNote?: string;
}

/** 时区辅助: 北京时间小时数 */
export function beijingHour(now = new Date()): number {
	return (now.getUTCHours() + 8) % 24;
}

/** 构造未来时间判断 (限时优惠截止) */
export function until(isoDateTime: string): (now: Date) => boolean {
	const end = new Date(isoDateTime).getTime();
	return (now) => now.getTime() < end;
}
