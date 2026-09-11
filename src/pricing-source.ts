/**
 * 共享价表来源 (pi-pricer 集成)
 *
 * pi-usager 不再自己维护任何价格数据: 权威价格统一由 @foolsecret/pi-pricer
 * 提供 (~/.pi/model-pricing.json), 本模块只负责"加载解析器 + 暴露给调用方"。
 *
 * 三态 (供 /usage config 与启动提示用, 对齐 pi-prompt 的范式):
 * - "pi-pricer": 已加载共享价表 (权威)
 * - "missing":   未安装 pi-pricer -> 费用无法估算, 提示用户安装
 * - "failed":    已装但加载失败 -> 附原因, 提示检查 JSON
 *
 * 解析器闭包在构造时读一次 JSON, 之后逐次查询零磁盘 IO —— footer 每帧渲染
 * 都会调 calculateCost, 必须走这个同步闭包 (getPricingResolver)。
 */

/** ResolvedPrice 结构 (结构类型声明, 避免对 pi-pricer 的编译期强依赖) */
export interface ResolvedPrice {
	inputMiss: number;
	inputHit: number;
	output: number;
	/** 命中规则是否含时间窗 (weekdays/ranges) —— 用于峰谷图标 */
	isPeak: boolean;
}

/** 解析器签名 (等效 pi-pricer 的 PricingResolver) */
export type PricingResolver = (model: string, provider: string, timestamp?: Date | number) => ResolvedPrice;

/** 价格来源三态 */
export type PricingSource = "pi-pricer" | "missing" | "failed";

let resolver: PricingResolver | null = null;
let debugResolver: ((model: string, provider: string, timestamp?: Date) => ResolutionDebug) | null = null;
let source: PricingSource = "missing";
let lastFailure: string | undefined;
let loading: Promise<PricingResolver | null> | null = null;

/**
 * 默认加载器: 动态 import pi-pricer 的 /pricing 子路径。
 *
 * 用变量拼接模块名 —— 静态字面量 import() 会被 TS 在编译期解析, 未安装环境下
 * typecheck 直接报模块缺失 (pi-prompt 已验证的规避做法)。
 * 返回 null 表示未安装; 抛错表示已装但加载/解析失败。
 */
async function defaultLoader(): Promise<PricingResolver | null> {
	const moduleName = "@foolsecret/pi-pricer/pricing";
	let create: ((filePath?: string) => PricingResolver) | undefined;
	let debug: ((model: string, provider: string, timestamp?: Date) => ResolutionDebug) | undefined;
	try {
		const mod = (await import(moduleName)) as {
			createPricingResolver?: (filePath?: string) => PricingResolver;
			resolveDebug?: (model: string, provider: string, timestamp?: Date) => ResolutionDebug;
		};
		create = mod.createPricingResolver;
		debug = mod.resolveDebug;
	} catch {
		return null; // 未安装: 静默, 由调用方归为 missing
	}
	if (typeof create !== "function") return null;
	debugResolver = typeof debug === "function" ? debug : null;
	return create(); // 已装: 让读取/解析错误上抛, 供 failed 状态暴露原因
}

/**
 * 确保已加载共享价表解析器 (幂等, 并发防抖)。
 * 在扩展 mount 期调用一次预热; 失败不抛错, 只记录 source 供调用方提示。
 */
export async function ensurePricingSource(
	loader: () => Promise<PricingResolver | null> = defaultLoader,
): Promise<PricingResolver | null> {
	if (resolver) return resolver;
	if (!loading) {
		loading = (async () => {
			try {
				const loaded = await loader();
				if (loaded) {
					resolver = loaded;
					source = "pi-pricer";
					lastFailure = undefined;
				} else {
					source = "missing";
					lastFailure = undefined;
				}
			} catch (error) {
				source = "failed";
				lastFailure = error instanceof Error ? error.message : String(error);
			}
			return resolver;
		})().finally(() => {
			loading = null;
		});
	}
	return loading;
}

/**
 * 同步读取当前解析器 (footer 逐帧调用)。
 * 预热前返回 null, 调用方需处理"暂无价格"的降级展示。
 */
export function getPricingResolver(): PricingResolver | null {
	return resolver;
}

/** 当前价格来源 (含失败原因), /usage config 与启动提示用 */
export function getPricingSource(): { source: PricingSource; reason?: string } {
	return lastFailure === undefined ? { source } : { source, reason: lastFailure };
}

/** 调价: 拿不到解析器时返回 null (调用方降级为"价格未知") */
export function resolvePrice(model: string, provider: string, now: Date): ResolvedPrice | null {
	if (!resolver) return null;
	return resolver(model, provider, now);
}

/** 解析链里的一步 (供 /usage peak 展示) */
export interface ResolutionStep {
	planName: string;
	priceId: string;
	matched: boolean;
	reason: string;
}

/** 解析结果 + 命中链 */
export interface ResolutionDebug {
	price: ResolvedPrice;
	chain: ResolutionStep[];
	matched: boolean;
}

/** 调试解析: 返回价格 + 命中/未命中链 (/usage peak 展示用) */
export function resolveDebug(model: string, provider: string, now: Date): ResolutionDebug | null {
	const debug = debugResolver;
	if (!debug) return null;
	return debug(model, provider, now);
}

/** 测试专用: 复位回未加载态 */
export function resetPricingSource(): void {
	resolver = null;
	debugResolver = null;
	source = "missing";
	lastFailure = undefined;
	loading = null;
}
