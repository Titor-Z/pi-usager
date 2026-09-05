/**
 * 余额查询配置持久化
 *
 * 文件: ~/.pi/pi-usager.json
 * 注意: 该文件含厂商凭证 (API Key 等), 属敏感信息, 不要提交到 git。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BalanceProviderConfig {
	/** 字段名 → 值 (凭证等) */
	[key: string]: string;
}

export interface BalanceConfig {
	/** providerId → 凭证字段 */
	providers: Record<string, BalanceProviderConfig>;
	/** 余额刷新间隔 (分钟), 默认 5 */
	refreshMinutes?: number;
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

export function getRefreshMinutes(): number {
	return loadConfig().refreshMinutes ?? 5;
}

export function setRefreshMinutes(minutes: number): void {
	const config = loadConfig();
	config.refreshMinutes = minutes;
	saveConfig(config);
}
