/**
 * 使用量/计费公共类型定义
 *
 * 设计要点:
 * - 价格数据不再由本插件维护: 全部来自 @foolsecret/pi-pricer 的共享价表
 * - 统一人民币 ¥ 计价（所有 provider 的价格均为 元/百万 tokens）
 * - 免费判定: 共享价表返回三价全零
 */

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
	/** 查询账户余额 (provider 无公开 API 时不实现) */
	queryBalance?(): Promise<BalanceResult>;
	/** 无歧义的欠费 HTTP 状态码 (如 DeepSeek 402, 实测确认)。有歧义的码 (如 GLM 429,
	 *  兼具欠费/限速/过载等 11 种业务码) 不在此声明, 由余额查询二次确认判定 */
	depletionStatuses?: number[];
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
	/** 命中规则是否含时间窗 (峰谷/促销时段) —— 供峰谷图标显示 */
	isPeak?: boolean;
	/** 价表是否可用 (false = 未装 pi-pricer / 解析失败, 费用为未知) */
	priceKnown?: boolean;
	/** 当前生效的计价方案 label (来自 pi-pricer 解析链) */
	variantLabel?: string;
	/** 方案备注 */
	variantNote?: string;
}

/** 北京时间 (UTC+8) 的星期与小时 (供厂商适配器判断时段展示) */
export function beijingParts(now = new Date()): { day: number; hour: number } {
	const shifted = new Date(now.getTime() + 8 * 3_600_000);
	return { day: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}
