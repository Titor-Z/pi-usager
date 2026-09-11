/**
 * 共享价表来源 (pi-pricer 集成)
 *
 * pi-usager 不再自己维护任何价格数据: 权威价格统一由 @foolsecret/pi-pricer
 * 提供 (~/.pi/model-pricing.json), 本模块只负责"加载解析器 + 暴露给调用方"。
 *
 * 四态 (供 /usage config 与启动提示用, 对齐 pi-prompt 的范式):
 * - "pi-pricer": 已加载**用户自己的**价表 (权威)
 * - "defaults":  已加载, 但内容等于 pi-pricer 内置默认价
 *                (文件不存在/损坏时 pi-pricer 静默回退, 且 seedPricing 会写入
 *                 一份默认值 —— 必须显式区分, 否则用户以为用的是自己的价)
 * - "missing":   未安装 pi-pricer -> 费用无法估算, 提示用户安装
 * - "failed":    已装但加载失败 -> 附原因, 提示检查 JSON
 *
 * 解析器闭包在构造时读一次 JSON, 之后逐次查询零磁盘 IO —— footer 每帧渲染
 * 都会调 calculateCost, 必须走这个同步闭包 (getPricingResolver)。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** 价格来源四态 */
export type PricingSource = "pi-pricer" | "defaults" | "missing" | "failed";

/** 共享价表文件路径 (与 pi-pricer 的 DEFAULT_PATH 一致) */
export const PRICING_FILE = join(homedir(), ".pi", "model-pricing.json");

let resolver: PricingResolver | null = null;
let debugResolver: ((model: string, provider: string, timestamp?: Date) => ResolutionDebug) | null = null;
let source: PricingSource = "missing";
let lastFailure: string | undefined;
let loading: Promise<PricingResolver | null> | null = null;
/** 本次加载的价表是否为内置默认价 (由 defaultLoader 判定) */
let isDefaults = false;

/**
 * 判断当前生效价表是否就是 pi-pricer 的内置默认价。
 *
 * 为什么必须判: pi-pricer 的 readPricing() 在文件缺失/损坏时**静默回退**
 * DEFAULT_PRICING, 且 seedPricing() 首次启动就会把默认值写盘 —— "加载成功"
 * 完全不等于"用户的配置生效"。不区分会让用户以为在用自己配的价。
 *
 * 判定方式 (只用公开 API): 文件读不到 / 解不开 => 必然是回退默认值;
 * 文件能读且含内容 => 视为用户价表 (宁可少提示, 不误报)。
 * 不对内容做深度比对 —— pi-pricer 未导出 DEFAULT_PRICING 常量, 而"文件存在
 * 且非空且能解析"已足够区分"用户动过"与"从未动过"两种真实场景。
 */
function isBuiltinDefaults(filePath: string = PRICING_FILE): boolean {
	try {
		const raw = readFileSync(filePath, "utf8").trim();
		if (raw === "") return true; // 空文件 = 无配置
		JSON.parse(raw); // 解析失败兜到 catch
		return false; // 有内容且可解析: 用户价表
	} catch {
		return true; // 缺失 / 损坏: pi-pricer 会静默用内置默认价
	}
}

/**
 * 默认加载器: 动态 import pi-pricer 的 /pricing 子路径。
 *
 * 用变量拼接模块名 —— 静态字面量 import() 会被 TS 在编译期解析, 未安装环境下
 * typecheck 直接报模块缺失 (pi-prompt 已验证的规避做法)。
 * 返回 null 表示未安装; 抛错表示已装但加载/解析失败。
 */
async function defaultLoader(filePath: string = PRICING_FILE): Promise<PricingResolver | null> {
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
	isDefaults = isBuiltinDefaults(filePath);
	return create(filePath); // 已装: 让读取/解析错误上抛, 供 failed 状态暴露原因
}

/**
 * 确保已加载共享价表解析器 (幂等, 并发防抖)。
 * 在扩展 mount 期调用一次预热; 失败不抛错, 只记录 source 供调用方提示。
 * filePath 仅供测试注入 (生产走 pi-pricer 默认路径 ~/.pi/model-pricing.json)。
 */
export async function ensurePricingSource(
	loader?: () => Promise<PricingResolver | null>,
	filePath?: string,
): Promise<PricingResolver | null> {
	// 未注入 loader 时: 绑定 filePath 到默认加载器 (测试可传临时路径)
	const effective = loader ?? (() => defaultLoader(filePath));
	if (resolver) return resolver;
	if (!loading) {
		loading = (async () => {
			try {
				const loaded = await effective();
				if (loaded) {
					resolver = loaded;
					source = isDefaults ? "defaults" : "pi-pricer";
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
	isDefaults = false;
}
