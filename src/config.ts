/**
 * pi-usager 本地配置持久化
 *
 * 文件: ~/.pi/pi-usager.json
 * 不含厂商凭证 (密钥由 pi 凭证层管理), 仅存余额台账与 HUD 偏好。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderDescriptor } from "./provider-engine.ts";

/**
 * 余额台账的校准层快照 (服务端最后一次返回的权威值)
 */
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
	/** 余额刷新间隔 (分钟), 默认 5 */
	refreshMinutes?: number;
	/** 本地余额台账 (校准层持久化): 启动时立即渲染, 再异步校准纠偏 */
	balanceCache?: Record<string, CachedBalance>;
	/** HUD footer 布局: dual = 双行 (原生风格, 余额在首行右侧); single = 单行紧凑; 默认 dual */
	footerLayout?: "dual" | "single";
	/** 余额分档色阈值: yellow = 提醒线 (低于变黄), red = 告急线 (低于变红); 默认 1.0 / 0.5 */
	balanceColors?: { yellow: number; red: number };
	/** 用户自定义厂商 (数据驱动, 见 /usage config → 厂商管理); 不含凭证 */
	customProviders?: ProviderDescriptor[];
}

export const CONFIG_PATH = join(homedir(), ".pi/pi-usager.json");

export function loadConfig(): BalanceConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as BalanceConfig & Record<string, unknown>;
			// 迁移: 旧版曾在本文件存厂商凭证 (providers) 与自定义计价 (customPricing), 均已废弃。
			// 读取时剥离, 下一次保存即从磁盘移除。
			delete parsed.providers;
			delete parsed.customPricing;
			return parsed;
		}
	} catch { /* 损坏时按空配置处理 */ }
	return {};
}

export function saveConfig(config: BalanceConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const tmp = CONFIG_PATH + ".tmp";
	writeFileSync(tmp, JSON.stringify(config, null, "\t"));
	renameSync(tmp, CONFIG_PATH); // 原子替换
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

/** 用户自定义厂商列表 (空数组表示未添加) */
export function getCustomProviders(): ProviderDescriptor[] {
	return loadConfig().customProviders ?? [];
}

/** 全量写回用户自定义厂商列表 */
export function setCustomProviders(list: ProviderDescriptor[]): void {
	const config = loadConfig();
	config.customProviders = list;
	saveConfig(config);
}
