/**
 * 共享价表来源 (pi-pricer 集成)
 *
 * pi-usager 不再自己维护任何价格数据: 权威价格统一由 @foolsecret/pi-pricer
 * 提供 (~/.pi/model-pricing.json), 本模块只负责"加载解析器 + 暴露给调用方"。
 *
 * 四态 (供 /usage config 与启动提示用, 对齐 pi-prompt 的范式):
 * - "pi-pricer": 已加载**用户自己的**价表 (权威)
 * - "defaults":  已加载, 但内容等于 pi-pricer 内置默认价
 *                (v5 起: 文件缺失/损坏/version≠5 一律静默回退内置种子, 且
 *                 seedPricing 会写入一份默认值 —— 必须显式区分, 否则用户
 *                 以为用的是自己的价; 旧版价表也落此态并附原因)
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
	/** 当前命中规则的所属方案显示名; 未命中 (兜底价) 时为空 */
	planName?: string;
	/** 方案别名 (HUD 短名, 优先于 planName 展示); 未填/未命中时为空 */
	planAlias?: string;
	/** 命中方案 _id */
	planId?: string;
	/** 命中价格 _id */
	rateId?: string;
	/** 命中规则 _id */
	ruleId?: string;
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
/** 本次加载的价表为内置默认价时的原因 (undefined = 用户的 v5 价表) */
let defaultsReason: string | undefined;
/** pi-pricer /db 的 Database.open (动态加载; 供 /usage 渲染真实方案结构) */
let openDatabase: ((filePath?: string) => DatabaseLike) | null = null;
/** 本次加载的价表路径 (测试注入时非默认路径; getPlanDetail 复用它) */
let loadedFilePath: string = PRICING_FILE;

/**
 * 判定当前价表是否为 pi-pricer 的内置默认价, 返回原因 (null = 用户的 v5 价表)。
 *
 * 为什么必须判: pi-pricer v5 的 readPricing() 对 文件缺失/损坏/version≠5
 * **一律静默回退** DEFAULT_PRICING, 且 seedPricing() 首次启动就会写一份默认值
 * —— "加载成功"完全不等于"用户的配置生效"。不区分会让用户以为在用自己配的价。
 *
 * 判定方式: 与 pi-pricer 的 isV5 同构 —— 只有 version===5 且五集合齐备才视为
 * 用户的价表; 其余(含旧版价表)均判为默认价, 并给出可读原因。
 */
function detectDefaults(filePath: string = PRICING_FILE): string | null {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8").trim();
	} catch {
		return "价表文件缺失";
	}
	if (raw === "") return "价表文件为空";
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return "价表文件 JSON 损坏";
	}
	if (typeof data !== "object" || data === null) return "价表文件结构异常";
	const obj = data as Record<string, unknown>;
	if (obj.version !== 5) {
		return `检测到旧版价表（version=${String(obj.version)}），pi-pricer v5 不读取`;
	}
	for (const key of ["rates", "calendars", "rules", "plans", "models"]) {
		if (!Array.isArray(obj[key])) return "价表文件不是 v5 结构";
	}
	return null; // v5 结构: 用户价表
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
	let debug: ((model: string, provider: string, timestamp?: Date, filePath?: string) => ResolutionDebug) | undefined;
	try {
		const mod = (await import(moduleName)) as {
			createPricingResolver?: (filePath?: string) => PricingResolver;
			resolveDebug?: (model: string, provider: string, timestamp?: Date, filePath?: string) => ResolutionDebug;
		};
		create = mod.createPricingResolver;
		debug = mod.resolveDebug;
	} catch {
		return null; // 未安装: 静默, 由调用方归为 missing
	}
	if (typeof create !== "function") return null;
	// debug 绑定 filePath: 否则注入自定义价表(测试)时 resolveDebug 会走默认路径
	debugResolver = typeof debug === "function" ? (model, provider, timestamp) => debug(model, provider, timestamp, filePath) : null;
	loadedFilePath = filePath;
	defaultsReason = detectDefaults(filePath) ?? undefined;
	// /db 的 Database.open: 供 /usage 展开方案真实结构; 加载失败不影响计价
	const dbModuleName = "@foolsecret/pi-pricer/db";
	try {
		const dbMod = (await import(dbModuleName)) as {
			Database?: { open?: (filePath?: string) => DatabaseLike };
		};
		openDatabase = typeof dbMod.Database?.open === "function" ? dbMod.Database.open.bind(dbMod.Database) : null;
	} catch {
		openDatabase = null;
	}
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
					source = defaultsReason === undefined ? "pi-pricer" : "defaults";
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

/** 当前价格来源 (含失败/默认价原因), /usage config 与启动提示用 */
export function getPricingSource(): { source: PricingSource; reason?: string } {
	const reason = source === "failed" ? lastFailure : source === "defaults" ? defaultsReason : undefined;
	return reason === undefined ? { source } : { source, reason };
}

/** 调价: 拿不到解析器时返回 null (调用方降级为"价格未知") */
export function resolvePrice(model: string, provider: string, now: Date): ResolvedPrice | null {
	if (!resolver) return null;
	return resolver(model, provider, now);
}

/** 解析链里的一步 (pi-pricer v5: ruleName + rateId + reason; 供 /usage peak 展示) */
export interface ResolutionStep {
	ruleId: string;
	ruleName: string;
	rateId: string;
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

// ── 方案结构展开 (供 /usage 渲染真实方案, 走 pi-pricer /db) ──────────────

/** pi-pricer Database 的结构子集 (避免编译期强依赖) */
interface RawModelDoc {
	planId?: string;
}
interface RawRuleDoc {
	name: string;
	timezone: string;
	weekdays: number[];
	ranges: [string, string][];
}
interface RawRateDoc {
	name: string;
	inputMiss: number;
	inputHit: number;
	output: number;
}
interface RawCalendarDoc {
	name: string;
}
interface RawExplanation {
	plan: { name: string; alias?: string; enabled: boolean };
	rules: Array<{
		rule: RawRuleDoc;
		rate?: RawRateDoc;
		includeCalendars: RawCalendarDoc[];
		excludeCalendars: RawCalendarDoc[];
	}>;
}
interface DatabaseLike {
	findModel(provider: string, model: string): RawModelDoc | undefined;
	explainPlan(planId: string): RawExplanation | undefined;
}

/** 方案里的一条规则 (含价格与生效条件), 供 /usage 展示 */
export interface PlanRuleDetail {
	ruleName: string;
	rateName?: string;
	inputMiss?: number;
	inputHit?: number;
	output?: number;
	timezone?: string;
	weekdays: number[];
	ranges: [string, string][];
	includeCalendars: string[];
	excludeCalendars: string[];
}

/** 当前模型的完整方案结构 */
export interface PlanDetail {
	planName: string;
	planAlias?: string;
	enabled: boolean;
	rules: PlanRuleDetail[];
}

/** 展开当前模型的方案结构 (方案 → 规则 → 价格/日历); 不可用返回 null */
export function getPlanDetail(provider: string, model: string): PlanDetail | null {
	if (!openDatabase) return null;
	try {
		const db = openDatabase(loadedFilePath);
		const modelDoc = db.findModel(provider, model);
		if (!modelDoc?.planId) return null;
		const explanation = db.explainPlan(modelDoc.planId);
		if (!explanation) return null;
		return {
			planName: explanation.plan.name,
			planAlias: explanation.plan.alias,
			enabled: explanation.plan.enabled,
			rules: explanation.rules.map((entry) => ({
				ruleName: entry.rule.name,
				rateName: entry.rate?.name,
				inputMiss: entry.rate?.inputMiss,
				inputHit: entry.rate?.inputHit,
				output: entry.rate?.output,
				timezone: entry.rule.timezone,
				weekdays: entry.rule.weekdays ?? [],
				ranges: entry.rule.ranges ?? [],
				includeCalendars: entry.includeCalendars.map((c) => c.name),
				excludeCalendars: entry.excludeCalendars.map((c) => c.name),
			})),
		};
	} catch {
		return null;
	}
}

/** 测试专用: 复位回未加载态 */
export function resetPricingSource(): void {
	resolver = null;
	debugResolver = null;
	source = "missing";
	lastFailure = undefined;
	loading = null;
	defaultsReason = undefined;
	openDatabase = null;
	loadedFilePath = PRICING_FILE;
}
