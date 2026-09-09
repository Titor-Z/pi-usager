/**
 * 余额查询配置持久化
 *
 * 文件: ~/.pi/pi-usager.json
 * 注意: 该文件含厂商凭证 (API Key 等), 属敏感信息, 不要提交到 git。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CustomPricing } from "./types.ts";

export interface BalanceProviderConfig {
	/** 字段名 → 值 (凭证等) */
	[key: string]: string;
}

/** 余额台账的校准层快照 (服务端最后一次返回的权威值) */
export interface CachedBalance {
	available: boolean;
	currency: string;
	total: string;
	granted?: string;
	toppedUp?: string;
	/** 校准时间 (ms 时间戳) */
	syncedAt: number;
}

export interface BalanceConfig {
	/** providerId → 凭证字段 */
	providers: Record<string, BalanceProviderConfig>;
	/** 余额刷新间隔 (分钟), 默认 5 */
	refreshMinutes?: number;
	/** 本地余额台账 (校准层持久化): 启动时立即渲染, 再异步校准纠偏 */
	balanceCache?: Record<string, CachedBalance>;
	/** HUD footer 布局: dual = 双行 (原生风格, 余额在首行右侧); single = 单行紧凑; 默认 dual */
	footerLayout?: "dual" | "single";
	/** 余额分档色阈值: yellow = 提醒线 (低于变黄), red = 告急线 (低于变红); 默认 1.0 / 0.5 */
	balanceColors?: { yellow: number; red: number };
	/** 用户自定义计价规则 (优先级高于内置定价, 完全接管命中模型) */
	customPricing?: CustomPricing[];
}

export const CONFIG_PATH = join(homedir(), ".pi/pi-usager.json");

export function loadConfig(): BalanceConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		}
	} catch { /* 损坏时按空配置处理 */ }
	return { providers: {} };
}

export function saveConfig(config: BalanceConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const tmp = CONFIG_PATH + ".tmp";
	writeFileSync(tmp, JSON.stringify(config, null, "\t"));
	renameSync(tmp, CONFIG_PATH); // 原子替换
}

export function saveProviderConfig(providerId: string, creds: BalanceProviderConfig): void {
	const config = loadConfig();
	config.providers = config.providers ?? {};
	config.providers[providerId] = creds;
	saveConfig(config);
}

export function clearProviderConfig(providerId: string): void {
	const config = loadConfig();
	if (config.providers) delete config.providers[providerId];
	saveConfig(config);
}

export function saveBalanceEntry(providerId: string, entry: CachedBalance): void {
	const config = loadConfig();
	config.balanceCache = config.balanceCache ?? {};
	config.balanceCache[providerId] = entry;
	saveConfig(config);
}

export function getRefreshMinutes(): number {
	return loadConfig().refreshMinutes ?? 5;
}

export function setRefreshMinutes(minutes: number): void {
	const config = loadConfig();
	config.refreshMinutes = minutes;
	saveConfig(config);
}

export function getFooterLayout(): "dual" | "single" {
	return loadConfig().footerLayout ?? "dual";
}

export function setFooterLayout(layout: "dual" | "single"): void {
	const config = loadConfig();
	config.footerLayout = layout;
	saveConfig(config);
}

/**
 * 余额分档色阈值 (读取时规范化: 若用户填成 red ≥ yellow, 交换保证区间单调)。
 * 语义: 余额 < red 显示红 (告急), < yellow 显示黄 (提醒), 否则绿 (充裕)。
 */
export function getBalanceColorThresholds(): { yellow: number; red: number } {
	const c = loadConfig().balanceColors;
	let yellow = c?.yellow ?? 1.0;
	let red = c?.red ?? 0.5;
	if (red >= yellow) [yellow, red] = [red, yellow];
	return { yellow, red };
}

export function setBalanceColorThresholds(yellow: number, red: number): void {
	const config = loadConfig();
	config.balanceColors = { yellow, red };
	saveConfig(config);
}

export function getCustomPricing(providerId?: string): CustomPricing[] {
	const rules = loadConfig().customPricing ?? [];
	return providerId ? rules.filter((r) => r.providerId === providerId) : rules;
}

export function addCustomPricing(rule: CustomPricing): void {
	const config = loadConfig();
	config.customPricing = config.customPricing ?? [];
	config.customPricing.push(rule);
	saveConfig(config);
}

/** 按索引删除 (与 getCustomPricing 返回顺序一致); 返回是否删除成功 */
export function removeCustomPricing(providerId: string, index: number): boolean {
	const config = loadConfig();
	const rules = config.customPricing ?? [];
	const filtered = rules.filter((r) => r.providerId === providerId);
	const target = filtered[index];
	if (!target) return false;
	config.customPricing = rules.filter((r) => r !== target);
	saveConfig(config);
	return true;
}
