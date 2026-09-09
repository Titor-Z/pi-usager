/**
 * 本地余额台账 (双层模型)
 *
 * - 校准层 (权威): 服务端返回的余额快照, 统一经 calibrate() 写入并持久化到
 *   ~/.pi/pi-usager.json 的 balanceCache。校准触发点: 会话启动 / 定时器 (默认 5
 *   分钟) / 手动 /usage balance / 欠费确认查询 / 缴费恢复后的同步。
 * - 估算层 (过渡): turn_end 每轮对话的本地扣减 (addSpend), 仅存内存, 在两次
 *   校准之间让数字"活着"; 因阶梯档位/峰谷切换/多会话并发必然漂移, 由校准纠偏。
 *
 * 显示余额 = lastSynced.total - sessionSpent, 不钳零:
 * - GLM 归 0 即拒 (服务端永不为负), 本地负数是估算透支预警 (红色显示)
 * - DeepSeek 实测欠费前服务端可短暂透支, 负数反而贴近真实
 *
 * 欠费态 (depleted) 是服务端信号判定, 与本地负数显示互不干扰:
 * - 判定: 校准结果 available === false 或 total <= 0, 或无歧义欠费状态码
 *   (adapter.depletionStatuses, 如 DeepSeek 402)
 * - 解除: 任何一次校准返回有余额即自动解除 (缴费后下次对话/查询即恢复)
 */

import type { ProviderBalance } from "./types.ts";
import { loadConfig, saveBalanceEntry, type CachedBalance } from "./config.ts";

// ═══════════════════════════════════════════
//  内存状态
// ═══════════════════════════════════════════

/** 校准层: providerId → 服务端最后快照 */
const lastSynced = new Map<string, CachedBalance>();
/** 估算层: providerId → 本会话累计本地扣减 (¥) */
const sessionSpent = new Map<string, number>();
/** 欠费态: 服务端信号判定, 仅影响显示与恢复逻辑 */
const depleted = new Set<string>();

// 启动时加载上一会话的持久化快照 (先显示后纠偏)
for (const [pid, entry] of Object.entries(loadConfig().balanceCache ?? {})) {
	lastSynced.set(pid, entry);
}

// ═══════════════════════════════════════════
//  读取
// ═══════════════════════════════════════════

/** 当前应显示的余额 = 校准值 - 本会话估算扣减 (不钳零, 负数为透支预警) */
export function getDisplayedBalance(providerId: string): ProviderBalance | undefined {
	const entry = lastSynced.get(providerId);
	if (!entry) return undefined;
	const total = parseFloat(entry.total) - (sessionSpent.get(providerId) ?? 0);
	// 规避浮点尾差产生的 -0.00
	const normalized = Math.abs(total) < 0.005 ? 0 : total;
	return {
		available: entry.available,
		currency: entry.currency,
		total: String(Math.round(normalized * 10000) / 10000),
		granted: entry.granted,
		toppedUp: entry.toppedUp,
	};
}

export function isDepleted(providerId: string): boolean {
	return depleted.has(providerId);
}

/** 台账中是否有该厂商的校准值 (含启动时从磁盘加载的) */
export function hasSynced(providerId: string): boolean {
	return lastSynced.has(providerId);
}

/** 上次校准时间 (ms 时间戳), 未校准过返回 undefined */
export function lastSyncedAt(providerId: string): number | undefined {
	return lastSynced.get(providerId)?.syncedAt;
}

/** 是否需要校准: 从未校准过, 或距上次校准已超过 intervalMs */
export function needsCalibrate(providerId: string, intervalMs: number): boolean {
	const at = lastSyncedAt(providerId);
	return at === undefined || Date.now() - at >= intervalMs;
}

// ═══════════════════════════════════════════
//  写入
// ═══════════════════════════════════════════

/** 估算层: 每轮对话扣减 (turn_end 调用, cost 为本轮预估费用 ¥) */
export function addSpend(providerId: string, cny: number): void {
	sessionSpent.set(providerId, (sessionSpent.get(providerId) ?? 0) + cny);
}

/** 本会话累计本地扣减 (¥) */
export function getSessionSpend(providerId: string): number {
	return sessionSpent.get(providerId) ?? 0;
}

/**
 * 校准 (权威): 用服务端返回值覆盖本地, 清零估算层, 并做欠费判定 (权威结论)。
 * 返回校准后是否处于欠费态。查询失败 (error) 不调用本函数, 保留旧值继续显示。
 */
export function calibrate(providerId: string, balance: ProviderBalance): boolean {
	const total = parseFloat(balance.total);
	const entry: CachedBalance = { ...balance, syncedAt: Date.now() };
	lastSynced.set(providerId, entry);
	sessionSpent.set(providerId, 0);
	const outOfFunds = !balance.available || !(total > 0);
	if (outOfFunds) depleted.add(providerId);
	else depleted.delete(providerId);
	try {
		saveBalanceEntry(providerId, entry);
	} catch { /* 持久化失败不影响内存态, 下次校准重试 */ }
	return outOfFunds;
}

/** 立即置欠费态 (无歧义欠费状态码时调用, 显示层随即清零为 ⚠️欠费) */
export function markDepleted(providerId: string): void {
	depleted.add(providerId);
}

/** 立即解除欠费态 (请求成功 = 账户可用; 随后应由校准带回真实数值) */
export function clearDepleted(providerId: string): void {
	depleted.delete(providerId);
}
