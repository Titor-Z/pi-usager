/**
 * Model Usage Extension (通用模型用量/计费)
 *
 * 在 pi 中查询模型服务商账户余额和 API 用量统计。
 * 支持 DeepSeek、GLM (智谱), 未来可扩展 Mimo 等 —— 定价与计费逻辑
 * 全部抽离到 ../src/ 公共模块, 按 current model 自动切换。
 *
 * 统一人民币 ¥ 计价; 免费模型显示 FREE; 支持限时折扣/峰谷价自动切换。
 * 余额采用双层台账 (src/ledger.ts): 服务端校准 (启动/定时/手动) + 本地估算扣减,
 * 启动即显示缓存值; 每轮对话翻页动画 (▼红 / ▲绿); 欠费检测后清零, 缴费后自动恢复。
 *
 * 命令:
 *   /usage            - 显示余额 + 当前会话用量
 *   /usage balance    - 仅查余额
 *   /usage session    - 仅查当前会话用量（含详细计费 + 最近一次回答费用）
 *   /usage status     - 切换状态栏余额显示
 *   /usage peak       - 当前生效的计价变体（峰谷/限时折扣）及切换时间
 *   /usage config     - 交互式配置（凭证/刷新间隔）
 *
 * 安装: 在 ~/.pi/agent/settings.json 的 packages 中添加 pi-usager 项目路径
 * 配置: ~/.pi/pi-usager.json (凭证/刷新间隔, 由 /usage config 写入)
 */

import type { ExtensionAPI, ExtensionContext, AssistantMessage } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveProvider, ADAPTERS } from "../src/index.ts";
import { isPeakHour } from "../src/deepseek.ts";
import { calculateCost, getSessionUsage, fmtCurrency, fmtTokens, hitRate } from "../src/cost.ts";
import { BALANCE_PROVIDERS, getBalanceProvider, queryBalanceFor } from "../src/balance.ts";
import {
	getDisplayedBalance, addSpend, calibrate, isDepleted, markDepleted, clearDepleted, needsCalibrate,
} from "../src/ledger.ts";
import {
	loadConfig, saveProviderConfig, clearProviderConfig,
	getRefreshMinutes, setRefreshMinutes, getFooterLayout, setFooterLayout,
	getBalanceColorThresholds, setBalanceColorThresholds,
	type BalanceProviderConfig,
} from "../src/config.ts";
import type { ProviderAdapter, ProviderBalance, BalanceResult } from "../src/types.ts";

// ═══════════════════════════════════════════
//  调试 (PI_USAGER_DEBUG=1 时输出到 stderr, 不影响正常运行)
// ═══════════════════════════════════════════

const DEBUG = !!process.env.PI_USAGER_DEBUG;
function debugLog(...args: unknown[]): void {
	if (DEBUG) console.error("[pi-usager]", ...args);
}

// ═══════════════════════════════════════════
//  余额展示
// ═══════════════════════════════════════════

function isBalance(r: BalanceResult): r is ProviderBalance {
	return "available" in r;
}

function formatBalanceText(adapter: ProviderAdapter, balance: ProviderBalance): string[] {
	const lines: string[] = [`━━━ ${adapter.name} 账户余额 ━━━`];
	if (!balance.available) {
		lines.push("⚠️  账户当前不可用");
		return lines;
	}
	const fmt = (n: string) => `¥${parseFloat(n).toFixed(2)}`;
	lines.push(`  💸 总余额:     ${fmt(balance.total)}`);
	if (balance.toppedUp) lines.push(`  💳 充值余额:   ${fmt(balance.toppedUp)}`);
	if (balance.granted) lines.push(`  🎁 赠送余额:   ${fmt(balance.granted)}`);
	return lines;
}

/** 敏感字段打码 */
function maskValue(field: { secret?: boolean }, value: string): string {
	if (!field.secret || !value) return value;
	if (value.length <= 8) return "****";
	return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/**
	* 依已录入字段自动推荐选项 (分厂商可扩展)。
	* GLM: bearer 实测可用 (Bearer 原始 key 调 /api/biz/account/query-customer-account-report),
	*      jwt 为官方 SDK 同款备用方案。
	*/
function autoRecommend(field: { key: string; options?: string[] }, creds: BalanceProviderConfig): string | undefined {
	if (field.key === "authMode" && field.options) {
		return field.options[0]; // 声明序第一个为该厂商实测推荐项
	}
	return undefined;
}

function autoRecommendReason(
	field: { key: string },
	creds: BalanceProviderConfig,
	recommended: string,
): string {
	if (field.key === "authMode" && recommended === "bearer") {
		return "（实测 Bearer 直调控制台余额接口可用；jwt 为备用）";
	}
	return "";
}

// ═══════════════════════════════════════════
//  交互式配置 (/usage config)
// ═══════════════════════════════════════════

async function configFlow(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("当前环境无 TUI，无法交互式配置；请手动编辑 ~/.pi/pi-usager.json", "warning");
		return;
	}
	const action = await ctx.ui.select(
		"使用量配置",
		[
			"配置厂商凭证",
			"余额校准间隔",
			`HUD 状态栏: ${footerEnabled ? "开" : "关"}`,
			`HUD 布局: ${getFooterLayout() === "dual" ? "双行" : "单行"}`,
			`余额颜色: 提醒线 ¥${getBalanceColorThresholds().yellow.toFixed(2)} / 告急线 ¥${getBalanceColorThresholds().red.toFixed(2)}`,
			"清除厂商凭证",
			"查看当前配置",
		],
	);
	if (!action) return;

	// ── 配置厂商凭证 ──
	if (action === "配置厂商凭证") {
		const providerId = await ctx.ui.select("选择厂商", Object.keys(BALANCE_PROVIDERS));
		if (!providerId) return;
		const bp = getBalanceProvider(providerId)!;
		const creds: BalanceProviderConfig = {};
		for (const field of bp.fields) {
			if (field.help) ctx.ui.notify(`💡 ${field.label}: ${field.help}`, "info");
			let value: string | undefined;
			if (field.options) {
				// select 型字段: 推荐项加 ⭐ 标记; 若可依据已录入字段自动推荐, 则先提示
				const recommended = field.recommended ?? autoRecommend(field, creds);
				if (recommended) {
					ctx.ui.notify(`✨ 推荐: ${recommended}${autoRecommendReason(field, creds, recommended)}`, "info");
				}
				const labeled = field.options.map((opt) =>
					opt === recommended ? `${opt} ⭐推荐` : opt,
				);
				const choice = await ctx.ui.select(field.label, labeled);
				if (choice === undefined) return;
				value = choice.replace(/ ⭐推荐$/, "");
			} else {
				value = await ctx.ui.input(field.label, field.placeholder ?? "");
			}
			if (value === undefined) return; // 用户取消
			if (value.trim() === "" && !field.optional) {
				ctx.ui.notify(`已跳过 ${bp.name}（必填字段 ${field.label} 为空）`, "warning");
				return;
			}
			if (value.trim() !== "") creds[field.key] = value.trim();
		}
		const ok = await ctx.ui.confirm(
			"保存凭证?",
			`将明文保存到 ~/.pi/pi-usager.json（本地文件，勿分享/提交 git）`,
		);
		if (!ok) return;
		saveProviderConfig(providerId, creds);
		ctx.ui.notify(`${bp.name} 凭证已保存，试查余额中...`, "info");
		const result = await queryBalanceFor(providerId);
		if ("error" in result) {
			ctx.ui.notify(`⚠️ 试查失败: ${result.error}`, "warning");
		} else {
			ctx.ui.notify(`✅ 试查成功: ${bp.name} 余额 ¥${parseFloat(result.total).toFixed(2)}`, "info");
		}
		return;
	}

	// ── 校准间隔 ──
	if (action === "余额校准间隔") {
		const minutes = await ctx.ui.input("余额校准间隔（分钟，服务端同步纠偏；两次校准间为本地估算）", String(getRefreshMinutes()));
		const n = parseInt(minutes ?? "", 10);
		if (isNaN(n) || n < 1) {
			ctx.ui.notify("无效的分钟数", "warning");
			return;
		}
		setRefreshMinutes(n);
		ctx.ui.notify(`余额校准间隔已设为 ${n} 分钟（下次会话生效）`, "info");
		return;
	}

	// ── HUD 状态栏开关 ──
	if (action.startsWith("HUD 状态栏")) {
		footerEnabled = !footerEnabled;
		if (footerEnabled) enableFooter(ctx);
		else disableFooter(ctx);
		return;
	}

	// ── HUD 布局 ──
	if (action.startsWith("HUD 布局")) {
		const layoutChoice = await ctx.ui.select("HUD 布局", [
			"双行 ⭐推荐 (余额在首行右侧, 对齐原生)",
			"单行 (紧凑, 余额与统计同行)",
		]);
		if (!layoutChoice) return;
		const next = layoutChoice.startsWith("双行") ? "dual" : "single";
		if (next !== getFooterLayout()) {
			setFooterLayout(next);
			ctx.ui.notify(`HUD 布局已切换为${next === "dual" ? "双行" : "单行"}`, "info");
		}
		return;
	}

	// ── 余额颜色 (两个输入框: 提醒线/告急线, 回车跳过不改) ──
	if (action.startsWith("余额颜色")) {
		const cur = getBalanceColorThresholds();
		const yellowStr = await ctx.ui.input(`余额提醒线 (黄色, 当前 ¥${cur.yellow.toFixed(2)})`, cur.yellow.toFixed(2));
		const yellow = yellowStr === undefined || yellowStr === "" ? cur.yellow : parseFloat(yellowStr);
		if (Number.isNaN(yellow) || yellow < 0) {
			ctx.ui.notify("提醒线无效, 未保存", "warning");
			return;
		}
		const redStr = await ctx.ui.input(`余额告急线 (红色, 当前 ¥${cur.red.toFixed(2)})`, cur.red.toFixed(2));
		const red = redStr === undefined || redStr === "" ? cur.red : parseFloat(redStr);
		if (Number.isNaN(red) || red < 0) {
			ctx.ui.notify("告急线无效, 未保存", "warning");
			return;
		}
		// 红线应低于黄线: 倒置时交换并提示
		const [y, r] = yellow >= red ? [yellow, red] : [red, yellow];
		if (y !== yellow) ctx.ui.notify("两条线大小倒置, 已自动交换", "info");
		setBalanceColorThresholds(y, r);
		ctx.ui.notify(`余额颜色已更新: 提醒线 ¥${y.toFixed(2)} / 告急线 ¥${r.toFixed(2)}`, "info");
		requestFooterRender();
		return;
	}

	// ── 清除凭证 ──
	if (action === "清除厂商凭证") {
		const configured = Object.keys(loadConfig().providers ?? {});
		if (configured.length === 0) {
			ctx.ui.notify("当前没有已配置的厂商凭证", "info");
			return;
		}
		const providerId = await ctx.ui.select("清除哪个厂商的凭证?", configured);
		if (!providerId) return;
		if (await ctx.ui.confirm("确认清除?", `将删除 ${providerId} 的凭证配置`)) {
			clearProviderConfig(providerId);
			ctx.ui.notify(`已清除 ${providerId} 的凭证（将回退到环境变量/auth.json）`, "info");
		}
		return;
	}

	// ── 查看当前配置 ──
	if (action === "查看当前配置") {
		const config = loadConfig();
		const lines: string[] = ["━━━ 使用量配置 ━━━"];
		lines.push(`  余额校准间隔: ${getRefreshMinutes()} 分钟（两次校准间为本地估算扣减）`);
		lines.push(`  HUD 布局: ${getFooterLayout() === "dual" ? "双行" : "单行"}`);
		const bc = getBalanceColorThresholds();
		lines.push(`  余额颜色: 提醒线 ¥${bc.yellow.toFixed(2)} (黄) / 告急线 ¥${bc.red.toFixed(2)} (红) / 其余绿`);
		const providers = config.providers ?? {};
		if (Object.keys(providers).length === 0) {
			lines.push("  (未配置任何厂商凭证, 将回退环境变量/auth.json)");
		}
		for (const [pid, creds] of Object.entries(providers)) {
			lines.push(`  ${pid}:`);
			const bp = getBalanceProvider(pid);
			for (const field of bp?.fields ?? []) {
				const v = creds[field.key];
				if (v !== undefined) lines.push(`    ${field.label}: ${maskValue(field, v)}`);
			}
		}
		ctx.ui.notify(lines.join("\n"), "info");
	}
}

// ═══════════════════════════════════════════
//  用量展示
// ═══════════════════════════════════════════

function formatUsageText(
	adapter: ProviderAdapter,
	stats: ReturnType<typeof getSessionUsage>,
	modelId: string | undefined,
): string[] {
	const { total, lastTurn, messageCount } = stats;
	const cost = calculateCost(adapter, modelId, total);
	const lines: string[] = [`━━━ 当前会话 API 用量 (${adapter.name}) ━━━`];
	lines.push(`  模型:         ${modelId ?? "未知"}`);
	lines.push(`  消息轮次:     ${messageCount}`);
	lines.push(`  ⬆️ 输入 Token: ${fmtTokens(total.input)}`);
	lines.push(`  ⬇️ 输出 Token: ${fmtTokens(total.output)}`);
	lines.push(`  R 缓存命中:   ${fmtTokens(total.cacheRead)}`);
	lines.push(`  CH 缓存命中率: ${hitRate(total.input, total.cacheRead)}%`);

	if (lastTurn) {
		const turnCost = calculateCost(adapter, modelId, lastTurn);
		lines.push(`  ⚡ 最近一次回答: ${fmtCurrency(turnCost.totalCNY, turnCost.free)}`);
	}

	if (cost.variantLabel && cost.variantLabel !== "标准价" && cost.variantLabel !== "平时价") {
		lines.push(`  📊 当前计价:   ${cost.variantLabel}${cost.variantNote ? ` (${cost.variantNote})` : ""}`);
	}

	lines.push("");
	lines.push("  ── 费用明细 ──");
	lines.push(`  输入 (缓存未命中): ${fmtCurrency(cost.inputMissCost, cost.free)}`);
	lines.push(`  输入 (缓存命中):   ${fmtCurrency(cost.inputHitCost, cost.free)}`);
	lines.push(`  输出:             ${fmtCurrency(cost.outputCost, cost.free)}`);
	lines.push(`  ───────────────────`);
	lines.push(`  总计:             ${fmtCurrency(cost.totalCNY, cost.free)}`);

	if (adapter.cacheNote) {
		lines.push("");
		lines.push(`  ℹ️ 缓存: ${adapter.cacheNote}`);
	}
	if (adapter.billingNote) {
		lines.push(`  ℹ️ 计费: ${adapter.billingNote}`);
	}
	return lines;
}

// ═══════════════════════════════════════════
//  计价变体状态 (/usage peak)
// ═══════════════════════════════════════════

function formatVariantStatus(adapter: ProviderAdapter, modelId: string | undefined): string[] {
	const lines: string[] = [`━━━ ${adapter.name} 计价状态 ━━━`];
	const pricing = modelId
		? Object.entries(adapter.pricing).sort((a, b) => b[0].length - a[0].length).find(([k]) => modelId.toLowerCase().includes(k))?.[1]
		: adapter.fallbackPricing;
	if (!pricing) {
		lines.push("  当前模型不在定价表中");
		return lines;
	}
	if (pricing.free) {
		lines.push("  该模型为免费模型 (FREE)");
		return lines;
	}
	const now = new Date();
	const tier = pricing.tiers[0];
	if (!tier) return lines;
	lines.push(`  当前模型: ${modelId ?? "未知"}`);
	lines.push("");
	for (const v of tier.variants) {
		const active = v.active ? v.active(now) : !!v.default;
		const mark = active ? "● 生效中" : "○";
		lines.push(`  ${mark} ${v.label}: 命中 ¥${v.prices.inputCacheHit} / 未命中 ¥${v.prices.inputCacheMiss} / 输出 ¥${v.prices.output}`);
		if (v.note) lines.push(`      ${v.note}`);
	}
	if (!adapter.hasPeakPricing) {
		lines.push("");
		lines.push("  该服务商无峰谷计费");
	} else if (isPeakHour()) {
		lines.push("");
		lines.push("  高峰时段 (9:00~12:00, 14:00~18:00 北京时间), 价格 ×2");
	} else {
		lines.push("");
		lines.push("  当前为低谷时段 (平时价)");
	}
	return lines;
}

// ═══════════════════════════════════════════
//  余额校准 (统一入口: 所有服务端同步都走这里)
// ═══════════════════════════════════════════

function adapterById(providerId: string): ProviderAdapter | undefined {
	return ADAPTERS.find((a) => a.id === providerId);
}

/**
 * 校准指定厂商的余额: 真实查询服务端并写入台账 (覆盖缓存 + 清零估算层 + 欠费判定)。
 * 返回 BalanceResult 供调用方展示; 该厂商不支持余额查询时返回 null。
 * opts.flash: 校准后发现余额比显示值增加时, 触发 ▲ 回充翻页动画 (如两会话间充了值)。
 */
async function calibrateProvider(providerId: string, opts?: { flash?: boolean }): Promise<BalanceResult | null> {
	const adapter = adapterById(providerId);
	if (!adapter?.queryBalance) return null;
	const before = getDisplayedBalance(providerId);
	const beforeTotal = before && before.available ? parseFloat(before.total) : undefined;
	const result = await adapter.queryBalance();
	if (result && isBalance(result)) {
		calibrate(providerId, result);
		debugLog(`calibrate ${providerId}: total=${result.total} available=${result.available} before=${beforeTotal}`);
		// 最小翻页阈值: 过滤本地估算与服务端真实扣费之间的微误差 (实测 ~0.00002 级),
		// 否则每次启动校准都会闪一下无意义的伪动画
		const MIN_FLASH_DELTA = 0.01;
		if (opts?.flash && !isDepleted(providerId) && beforeTotal !== undefined) {
		const after = parseFloat(result.total);
			if (after > beforeTotal + MIN_FLASH_DELTA) {
				// gain 起点钳零: 欠费期间 turn_end 仍累计 sessionSpent, before 可能为微小负数,
				// 动画起点帧会显示 ¥-0.00, 观感差且无意义
				startFlip(providerId, after - beforeTotal, "gain", { from: Math.max(0, beforeTotal), to: after });
			} else if (after < beforeTotal - MIN_FLASH_DELTA) {
				// 校准发现下跌 (免费模型/多会话的真实扣减只在校准时可见): 同样翻页, 不再静默跳变
				startFlip(providerId, beforeTotal - after, "spend", { from: beforeTotal, to: after });
			}
		}
	}
	requestFooterRender();
	return result;
}

// ═══════════════════════════════════════════
//  余额翻页动画 (翻卡式)
// ═══════════════════════════════════════════

/** 扣款 ▼ 红色; 回充 ▲ 绿色; 帧序列: 旧值静置 → 金额帧 → 新值高亮 → 落定 */
interface FlipAnim {
	providerId: string;
	delta: number;                    // 本次变动金额 (绝对值, ¥)
	kind: "spend" | "gain";
	frame: number;                    // 0 旧余额 / 1 金额帧 / 2 新余额高亮
	from?: number;                    // 旧余额 (无则跳过帧 0)
	to?: number;                      // 新余额 (无则帧 2 落回常态)
	timers: ReturnType<typeof setTimeout>[];
}

let flipAnim: FlipAnim | null = null;
let footerTui: { requestRender(): void } | null = null;
let footerEnabled = false; // HUD 状态栏开关 (configFlow 与 handler 共享)

// ── Git 工作区状态 (第 1 行 branch 后的 +3-5 分色段) ──
let piRef: ExtensionAPI;
let gitStaged = 0;        // 已暂存变更文件数 (porcelain X 列)
let gitUnstaged = 0;      // 未暂存变更文件数 (Y 列, ?? untracked 归入此侧)
let gitCacheAt = 0;       // 上次成功解析时间戳
let gitInFlight = false;  // 在途防抖
let gitDisabled = false;  // 非 git 仓库哨兵, onBranchChange 时重置重新探测
const GIT_REFRESH_MS = 3000;

function requestFooterRender(): void {
	footerTui?.requestRender();
}

/** 帧时长 (ms): 旧值静置 → 金额帧 → 新值高亮, 总计 ~3s
 *  对齐 CSS transition 的从容节奏: 每阶段 1s, 让"要变了→变了多少→变成什么"都可读 */
const FLIP_FRAME_MS = [1000, 1000, 1000];

function startFlip(
	providerId: string,
	delta: number,
	kind: "spend" | "gain",
	opts?: { from?: number; to?: number },
): void {
	stopFlip();
	const hasFrom = typeof opts?.from === "number";
	flipAnim = {
		providerId, delta, kind,
		frame: hasFrom ? 0 : 1,
		from: opts?.from, to: opts?.to,
		timers: [],
	};
	debugLog(`startFlip ${providerId} ${kind} delta=${delta} from=${opts?.from} to=${opts?.to}`);
	let elapsed = 0;
	FLIP_FRAME_MS.forEach((ms, i) => {
		elapsed += ms;
		flipAnim!.timers.push(setTimeout(() => {
			if (!flipAnim) return;
			if (i === FLIP_FRAME_MS.length - 1) {
				flipAnim = null; // 落定, render 恢复常态余额显示
			} else {
				flipAnim.frame = i + 1;
			}
			requestFooterRender();
		}, elapsed));
	});
}

function stopFlip(): void {
	if (!flipAnim) return;
	flipAnim.timers.forEach(clearTimeout);
	flipAnim = null;
}

/** 金额显示: <1分钱显示 4 位小数, 其余 2 位 */
function flipAmount(n: number): string {
	return n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

/**
 * 渲染 footer 右侧余额段 (返回已着色字符串):
 * 欠费 ⚠️欠费 > 翻页动画帧 > 常态 💰¥x.xx (负数红色透支预警)。
 */
function balanceSegment(
	theme: { fg(color: string, text: string): string },
	providerId: string,
): string | undefined {
	if (isDepleted(providerId)) {
		return theme.fg("error", "⚠️欠费");
	}
	if (flipAnim && flipAnim.providerId === providerId) {
		if (flipAnim.frame === 0 && flipAnim.from !== undefined) {
			// 帧 0: 旧余额静置 (翻页起点)
			return theme.fg("dim", `💰¥${flipAnim.from.toFixed(2)}`);
		}
		if (flipAnim.frame === 1) {
			// 帧 1: 红色扣款 ▼ / 绿色回充 ▲
			const arrow = flipAnim.kind === "spend" ? "▼" : "▲";
			const sign = flipAnim.kind === "spend" ? "-" : "+";
			return theme.fg(flipAnim.kind === "spend" ? "error" : "success", `${arrow}¥${sign}${flipAmount(flipAnim.delta)}`);
		}
		// 帧 2: 新余额短暂高亮 (翻页落点), 随后回落常态 dim
		if (flipAnim.to !== undefined) {
			return theme.fg("accent", `💰¥${flipAnim.to.toFixed(2)}`);
		}
	}
	const b = getDisplayedBalance(providerId);
	if (!b) return undefined;
	if (!b.available) return theme.fg("error", "⚠️欠费"); // 缓存中的欠费判定 (校准 available=false), 重启后不丢失
	const total = parseFloat(b.total);
	const text = `💰¥${total.toFixed(2)}`;
	// 透支预警不变红; 分档色: < 告急线红 (告急) → < 提醒线黄 (提醒) → 否则绿 (充裕)
	if (total < 0) return theme.fg("error", text);
	const { yellow, red } = getBalanceColorThresholds();
	const color = total < red ? "error" : total < yellow ? "warning" : "accent";
	return theme.fg(color, text);
}

// ═════════════════════════════════════════
//  Footer (双行, 对齐 pi 0.85.1 原生布局:
//  第 1 行 workdir (branch) • session 名 …… 余额段; 第 2 行 token 统计 …… 模型名)
// ═══════════════════════════════════════════

/** 与原生 footer 同款: HOME 下的路径缩写为 ~ 前缀 */
function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * 开启专属状态栏。费用显示 "此次回答预估价/会话累计预估价"。
 */
function enableFooter(ctx: ExtensionContext, opts?: { silent?: boolean }) {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => {
			// 切分支: 重置非仓库哨兵并重新探测 git 状态
			gitDisabled = false;
			gitCacheAt = 0;
			refreshGitStatus(ctx.cwd);
			tui.requestRender();
		});
		footerTui = tui;

		// 定时全量校准 (默认 5 分钟): 纠偏本地台账漂移; 发现回充时闪 ▲
		const balTimer = setInterval(() => {
			const adapter = resolveProvider(ctx.model?.id);
			if (adapter.queryBalance) void calibrateProvider(adapter.id, { flash: true });
		}, getRefreshMinutes() * 60 * 1000);

		return {
			dispose: () => {
				unsub();
				clearInterval(balTimer);
				stopFlip();
				if (footerTui === tui) footerTui = null;
			},
			invalidate() {},
			render(width: number): string[] {
				const adapter = resolveProvider(ctx.model?.id);
				const modelId = ctx.model?.id;
				const usage = getSessionUsage(ctx);
				const { total, lastTurn } = usage;
				const cost = calculateCost(adapter, modelId, total);
				const balSeg = balanceSegment(theme, adapter.id);
				const peakSeg = adapter.hasPeakPricing ? theme.fg("dim", isPeakHour() ? "🕸️" : "🦦") : undefined;

				// ── 第 1 行: workdir (branch) [+3-5] • session 名 …… 余额段 (右对齐) ──
				// 余额/翻页动画/欠费态放这行右侧, 可见性最高; git 分色段紧随 branch 之后
				maybeRefreshGitStatus(ctx.cwd);
				let pwdLeft = formatCwdForFooter(ctx.cwd, process.env.HOME ?? process.env.USERPROFILE);
				const branch = footerData.getGitBranch();
				if (branch) pwdLeft += ` (${branch})`;
				const pwdBase = pwdLeft; // 降级链回退基线 (仅路径+branch)
				const gitSeg = branch ? formatGitSegment(theme) : null;
				if (gitSeg) pwdLeft += ` ${gitSeg}`;
				const sessionName = ctx.getSessionName?.();
				if (sessionName) pwdLeft += ` • ${sessionName}`;

				// 第 1 行右侧降级链: 峰谷图标先丢, 余额段最后才可能被截
				let r1parts = [balSeg, peakSeg].filter((p): p is string => p !== undefined);
				if (peakSeg && visibleWidth(r1parts.join(" ")) > width) {
					r1parts = r1parts.filter((p) => p !== peakSeg);
				}
				const right1 = r1parts.join(" ");
				const budget1 = Math.max(0, width - visibleWidth(right1) - 2);
				// 降级链: 先去 session 名 (诊断价值最低), 再去 git 分色段, 仍不足才截路径
				if (visibleWidth(pwdLeft) > budget1 && sessionName) {
					pwdLeft = pwdBase + (gitSeg ? ` ${gitSeg}` : "");
				}
				if (visibleWidth(pwdLeft) > budget1 && gitSeg) {
					pwdLeft = pwdBase;
				}
				const left1 = theme.fg("dim", visibleWidth(pwdLeft) > budget1 ? truncateToWidth(pwdLeft, budget1) : pwdLeft);
				const pad1 = " ".repeat(Math.max(2, width - visibleWidth(left1) - visibleWidth(right1)));
				const line1 = left1 + pad1 + right1;

				// ── 第 2 行: [ PLAN ] token 统计 + 费用 + 上下文 …… 模型名 (右对齐) ──
				let left2 = "";
				// 可选集成: 若安装了 plan-mode 类扩展, 显示其状态 (软检测, 无硬依赖)
				const planStatus = footerData.getExtensionStatuses().get("plan-mode");
				if (planStatus) {
					left2 += planStatus + " ";
				}
				let costText = fmtCurrency(cost.totalCNY, cost.free);
				if (lastTurn) {
					const turnCost = calculateCost(adapter, modelId, lastTurn);
					const turnText = fmtCurrency(turnCost.totalCNY, turnCost.free);
					costText = `${turnText}/${costText}`;
				}
				// 限时折扣等非默认变体标记
				if (cost.variantLabel && cost.variantLabel !== "标准价" && cost.variantLabel !== "平时价" && !cost.free) {
					costText += `·${cost.variantLabel}`;
				}
				// CH 缓存命中率分色: <90% dim (常态) / 90~95% accent 主题蓝 (良好) / ≥95% 紫 (优秀, ANSI 绕过主题)
				const chRate = parseFloat(hitRate(total.input, total.cacheRead));
				const CH_GREEN = 90;
				const CH_PURPLE = 95;
				const PURPLE_ANSI = "\x1b[38;5;141m";
				const chText = `CH${chRate}%`;
				const chStyled = chRate >= CH_PURPLE
					? `${PURPLE_ANSI}${chText}\x1b[0m`
					: chRate >= CH_GREEN ? theme.fg("accent", chText) : null;
				if (chStyled) {
					left2 += theme.fg(
						"dim",
						`↑${fmtTokens(total.input)} ↓${fmtTokens(total.output)} R${fmtTokens(total.cacheRead)} `,
					) + `${chStyled} ` + theme.fg("dim", costText);
				} else {
					left2 += theme.fg(
						"dim",
						`↑${fmtTokens(total.input)} ↓${fmtTokens(total.output)} R${fmtTokens(total.cacheRead)} ${chText} ${costText}`,
					);
				}

				// 上下文使用率
				try {
					const cu = ctx.getContextUsage();
					if (cu && ctx.model?.contextWindow) {
						const pct = ((cu.tokens / ctx.model.contextWindow) * 100).toFixed(1);
						left2 += ` ${theme.fg("dim", `${pct}%/${fmtTokens(ctx.model.contextWindow)}`)}`;
					}
				} catch { /* ignore */ }

				// 思考深度: 不再左侧重复显示 —— 右侧模型名已带 `• level` (与原生 footer 一致)

				// 第 2 行右侧: 模型名 (多 provider 时带 provider 前缀, 与原生一致; 空间不足回退裸名)
				const modelName = modelId ?? "no-model";
				let right2 = modelName;
				if (ctx.model?.reasoning) {
					right2 = `${modelName} • ${ctx.thinkingLevel ?? "off"}`;
				}
				if (footerData.getAvailableProviderCount() > 1 && ctx.model?.provider) {
					const withProvider = `(${ctx.model.provider}) ${right2}`;
					if (visibleWidth(left2) + 2 + visibleWidth(withProvider) <= width) {
						right2 = withProvider;
					}
				}
				const right2W = visibleWidth(right2);
				// 右对齐优先: 空间不足先截左半 (token/费用是诊断信息, 可截), 模型名保住
				const budget2 = Math.max(0, width - right2W - 2);
				const left2Shown = visibleWidth(left2) > budget2 ? truncateToWidth(left2, budget2) : left2;
				const pad2 = " ".repeat(Math.max(2, width - visibleWidth(left2Shown) - right2W));
				const line2 = left2Shown + pad2 + theme.fg("dim", right2);

				// 单行紧凑布局: 统计 (左) …… 模型名 + 余额 + 峰谷 (右)
				// 降级链: 丢峰谷图标 → 丢模型名 → 余额段最后才截; 左侧统计先截
				if (getFooterLayout() === "single") {
					const modelSeg3 = theme.fg("dim", modelName);
					let parts3 = [modelSeg3, balSeg, peakSeg].filter((p): p is string => p !== undefined);
					if (peakSeg && visibleWidth(parts3.join(" ")) > width) {
						parts3 = parts3.filter((p) => p !== peakSeg);
					}
					if (modelSeg3 && visibleWidth(parts3.join(" ")) > width) {
						parts3 = parts3.filter((p) => p !== modelSeg3);
					}
					const right3 = parts3.join(" ");
					const budget3 = Math.max(0, width - visibleWidth(right3) - 2);
					const left3 = visibleWidth(left2) > budget3 ? truncateToWidth(left2, budget3) : left2;
					const pad3 = " ".repeat(Math.max(2, width - visibleWidth(left3) - visibleWidth(right3)));
					return [left3 + pad3 + right3];
				}

				return [line1, line2];
			},
		};
	});

	if (!opts?.silent) {
		ctx.ui.notify("专属状态栏已开启 ✅", "info");
	}
}

function disableFooter(ctx: ExtensionContext, opts?: { silent?: boolean }) {
	ctx.ui.setFooter(undefined);
	if (!opts?.silent) {
		ctx.ui.notify("已恢复默认状态栏", "info");
	}
}

// ═══════════════════════════════════════════
//  Git 工作区状态 (第 1 行 branch 后的 +3-5 分色段)
// ═══════════════════════════════════════════

/** 解析 porcelain 输出: X 列 (已暂存) 与 Y 列 (未暂存) 分别计数, ?? untracked 归未暂存侧 */
function refreshGitStatus(cwd: string): void {
	if (gitInFlight) return;
	gitInFlight = true;
	void piRef.exec("git", ["-C", cwd, "status", "--porcelain=v1", "--branch"])
		.then((r) => {
			if (r.code !== 0) {
				// 非 git 仓库: 空哨兵, 不再反复探测 (切分支时重置)
				gitDisabled = true;
			} else {
				let staged = 0;
				let unstaged = 0;
				for (const line of r.stdout.split("\n")) {
					if (!line || line.startsWith("##")) continue; // branch/ahead-behind 行
					if (line.startsWith("??")) { unstaged++; continue; }
					if (line[0] !== " ") staged++;
					if (line[1] !== " ") unstaged++;
				}
				gitStaged = staged;
				gitUnstaged = unstaged;
				gitCacheAt = Date.now();
				debugLog(`git status: +${staged}-${unstaged}`);
			}
			requestFooterRender();
		})
		.catch(() => {
			gitDisabled = true;
		})
		.finally(() => {
			gitInFlight = false;
		});
}

/** render 内懒触发: 缓存过期且无在途时刷新, 完成后 requestRender 重绘一次 */
function maybeRefreshGitStatus(cwd: string): void {
	if (gitDisabled || gitInFlight) return;
	if (Date.now() - gitCacheAt > GIT_REFRESH_MS) refreshGitStatus(cwd);
}

/** +3-5 分色: +N 绿 (已暂存), -M 红 (未暂存/untracked); 零值段省略, 全零不显示 */
function formatGitSegment(theme: Parameters<typeof balanceSegment>[0]): string | null {
	if (gitDisabled) return null;
	const parts: string[] = [];
	if (gitStaged > 0) parts.push(theme.fg("success", `+${gitStaged}`));
	if (gitUnstaged > 0) parts.push(theme.fg("error", `-${gitUnstaged}`));
	return parts.length ? parts.join("") : null;
}

// ═══════════════════════════════════════════
//  Extension 入口
// ═══════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	piRef = pi;
	let statusEnabled = false;
	let footerEnabled = false;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	const handler = async (args: string, ctx: ExtensionContext) => {
		const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const cmd = parts[0] ?? "";
		const adapter = resolveProvider(ctx.model?.id);
		const modelId = ctx.model?.id;

		// ── /usage peak ── 当前计价变体状态
		if (cmd === "peak") {
			ctx.ui.notify(formatVariantStatus(adapter, modelId).join("\n"), "info");
			return;
		}

		// ── /usage status ──
		if (cmd === "status") {
			statusEnabled = !statusEnabled;
			const setStatusFor = (pid: string, b: BalanceResult | null | undefined) => {
				const current = adapterById(pid);
				if (!current) return;
				if (b && isBalance(b) && isDepleted(pid)) {
					ctx.ui.setStatus(pid, `${current.name} ⚠️欠费`);
				} else if (b && isBalance(b) && b.available) {
					const total = parseFloat(b.total);
					const peak = current.hasPeakPricing ? (isPeakHour() ? " 🕸️" : " 🦦") : "";
					const text = `💰¥${total.toFixed(2)}`;
					ctx.ui.setStatus(pid, total < 0 ? `${current.name} ${text}（透支预警）${peak}` : `${current.name} ${text}${peak}`);
				} else if (b && "error" in b) {
					ctx.ui.setStatus(pid, `${current.name}: ${b.error}`);
				}
			};
			if (statusEnabled) {
				if (!adapter.queryBalance) {
					ctx.ui.notify(`${adapter.name} 不支持余额查询`, "warning");
					statusEnabled = false;
					return;
				}
				setStatusFor(adapter.id, await calibrateProvider(adapter.id));
				ctx.ui.notify(`${adapter.name} 余额已显示在状态栏（每 ${getRefreshMinutes()} 分钟自动校准，对话间为本地估算）`, "info");
				if (!refreshTimer) {
					refreshTimer = setInterval(async () => {
						if (!statusEnabled) return;
						// 动态解析: 切换模型后状态栏跟随当前 provider
						const current = resolveProvider(ctx.model?.id);
						if (!current.queryBalance) return;
						setStatusFor(current.id, await calibrateProvider(current.id));
					}, getRefreshMinutes() * 60 * 1000);
				}
			} else {
				ctx.ui.setStatus(adapter.id, undefined);
				if (refreshTimer) {
					clearInterval(refreshTimer);
					refreshTimer = null;
				}
				ctx.ui.notify("状态栏余额已关闭", "info");
			}
			return;
		}

		// ── /usage balance ── 手动校准 (同步台账 + 回充时闪 ▲)
		if (cmd === "balance") {
			if (!adapter.queryBalance) {
				ctx.ui.notify(`${adapter.name} 暂无公开余额查询 API`, "warning");
				return;
			}
			const balance = await calibrateProvider(adapter.id, { flash: true });
			if (balance && "error" in balance) {
				ctx.ui.notify(balance.error, "error");
				return;
			}
			if (balance && isBalance(balance)) {
				ctx.ui.notify(formatBalanceText(adapter, balance).join("\n"), "info");
			}
			return;
		}

		// ── /usage config ── 交互式配置
		if (cmd === "config") {
			await configFlow(ctx);
			return;
		}

		// ── /usage session ──
		if (cmd === "session") {
			const stats = getSessionUsage(ctx);
			ctx.ui.notify(formatUsageText(adapter, stats, modelId).join("\n"), "info");
			return;
		}

		// ── /usage (无参数) ──
		if (cmd === "") {
			const stats = getSessionUsage(ctx);
			const balance = adapter.queryBalance ? await calibrateProvider(adapter.id) : null;
			const lines: string[] = [];
			if (balance && "error" in balance) {
				lines.push(`⚠️  ${balance.error}`);
			} else if (balance && isBalance(balance)) {
				lines.push(...formatBalanceText(adapter, balance));
			}
			lines.push("");
			lines.push(...formatUsageText(adapter, stats, modelId));
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		ctx.ui.notify(`未知子命令: /usage ${cmd}\n支持: balance, session, status, peak, config\n配置相关 (HUD 开关/布局/余额颜色等) 已统一收进 /usage config`, "warning");
	};

	pi.registerCommand("usage", {
		description: "余额与用量监控",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "balance", description: "立即校准余额并显示" },
				{ value: "session", description: "本次会话用量统计" },
				{ value: "status", description: "开关状态栏余额显示" },
				{ value: "peak", description: "当前计价档位 (峰谷/限时折扣)" },
				{ value: "config", description: "配置菜单 (凭证/校准/HUD/颜色)" },
			];
			return items.filter((i) => i.value.startsWith(prefix)).map((i) => ({ value: i.value, label: i.value, description: i.description }));
		},
		handler,
	});

	// （无向后兼容别名：pi-usager 是独立新包，统一使用 /usage）

	// ── 每轮对话完成: 本地估算扣减 + 翻页动画 ──
	pi.on("turn_end", (event, ctx) => {
		maybeRefreshGitStatus(ctx.cwd); // 编辑类工具改文件后必然经过 turn_end, 顺手刷新 git 状态
		const adapter = resolveProvider(ctx.model?.id);
		if (!adapter.queryBalance) return; // 无余额查询能力的 provider 不记台账
		const u = (event.message as any)?.usage;
		if (!u) return;
		const cost = calculateCost(adapter, ctx.model?.id, {
			input: u.input ?? 0,
			output: u.output ?? 0,
			cacheRead: u.cacheRead ?? 0,
			cacheWrite: u.cacheWrite ?? 0,
		});
		if (cost.free || cost.totalCNY <= 0) {
			debugLog(`turn_end ${adapter.id}: FREE/零费用, 不扣减不翻页`);
			return; // FREE 模型不扣减不翻页
		}
		const before = getDisplayedBalance(adapter.id);
		addSpend(adapter.id, cost.totalCNY);
		const after = getDisplayedBalance(adapter.id);
		debugLog(`turn_end ${adapter.id}: cost=${cost.totalCNY.toFixed(4)}, before=${before?.total}, after=${after?.total}`);
		if (ctx.hasUI && footerEnabled) {
			startFlip(adapter.id, cost.totalCNY, "spend", {
				from: before && before.available ? parseFloat(before.total) : undefined,
				to: after && after.available ? parseFloat(after.total) : undefined,
			});
		}
		requestFooterRender();
	});

	// ── 欠费检测与恢复 ──
	let confirmSyncTimer: ReturnType<typeof setTimeout> | null = null;
	/** 错误响应后延迟确认余额 (防抖; calibrate 的判定是欠费态的权威结论) */
	const scheduleConfirmSync = (providerId: string) => {
		if (confirmSyncTimer) clearTimeout(confirmSyncTimer);
		confirmSyncTimer = setTimeout(() => {
			confirmSyncTimer = null;
			// 恢复路径: 充值后下次对话成功即校准, 差额触发 ▲ 回充翻页动画
			void calibrateProvider(providerId, { flash: true });
		}, 3000);
	};

	pi.on("after_provider_response", (event, ctx) => {
		const adapter = resolveProvider(ctx.model?.id);
		if (!adapter.queryBalance || event.status === undefined) return;
		debugLog(`after_provider_response ${adapter.id}: status=${event.status} depleted=${isDepleted(adapter.id)}`);
		if (event.status < 400) {
			// 请求成功 = 账户可用: 若此前置了欠费态, 立即解除并校准带回真实数值
			// (这就是缴费后的恢复路径: 用户充值后下一次对话即恢复)
			if (isDepleted(adapter.id)) {
				clearDepleted(adapter.id);
				scheduleConfirmSync(adapter.id);
				requestFooterRender();
			}
			return;
		}
		// 请求失败: 无歧义欠费码 (如 DeepSeek 402) 立即清零; 歧义码 (如 GLM 429)
		// 不直接判定, 由延迟的余额确认查询经 calibrate() 给出权威结论
		if (adapter.depletionStatuses?.includes(event.status)) {
			markDepleted(adapter.id);
			requestFooterRender();
		}
		scheduleConfirmSync(adapter.id);
	});

	// ── 选中支持余额查询的模型时: 台账过期/欠费态则校准, 否则直接用缓存显示 ──
	pi.on("model_select", async (event, ctx) => {
		const adapter = resolveProvider(event.model?.id);
		if (!adapter.queryBalance) return;
		const intervalMs = getRefreshMinutes() * 60 * 1000;
		let result: BalanceResult | null = null;
		if (needsCalibrate(adapter.id, intervalMs) || isDepleted(adapter.id)) {
			result = await calibrateProvider(adapter.id, { flash: true });
		} else {
			requestFooterRender();
		}
		if (footerEnabled) return;
		// 未开 footer 时走原状态栏路径
		const b = result && isBalance(result) ? result : getDisplayedBalance(adapter.id);
		if (b && isBalance(b)) {
			if (isDepleted(adapter.id)) {
				ctx.ui.setStatus(adapter.id, `${adapter.name} ⚠️欠费`);
			} else if (b.available) {
				const peak = adapter.hasPeakPricing ? (isPeakHour() ? " 🕸️" : " 🦦") : "";
				ctx.ui.setStatus(adapter.id, `${adapter.name} 💰¥${parseFloat(b.total).toFixed(2)}${peak}`);
			}
		}
	});

	// ── 默认启动时自动开启 footer ──
	pi.on("session_start", (_event, ctx) => {
		footerEnabled = true;
		enableFooter(ctx, { silent: true });
		// 启动即显示持久化缓存; 异步校准纠偏 (两会话间充了值会闪 ▲)
		const adapter = resolveProvider(ctx.model?.id);
		if (adapter.queryBalance) void calibrateProvider(adapter.id, { flash: true });
	});

	// ── 清理 ──
	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
		stopFlip();
	});
}
