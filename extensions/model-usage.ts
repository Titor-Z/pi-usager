/**
 * Model Usage Extension (通用模型用量/计费)
 *
 * 在 pi 中查询模型服务商账户余额和 API 用量统计。
 * 支持 DeepSeek、GLM (智谱), 未来可扩展 Mimo 等 —— 定价与计费逻辑
 * 全部抽离到 ./usage-providers/ 公共模块, 按 current model 自动切换。
 *
 * 统一人民币 ¥ 计价; 免费模型显示 FREE; 支持限时折扣/峰谷价自动切换。
 *
 * 命令 (deepseek 为向后兼容别名):
 *   /usage            - 显示余额 + 当前会话用量
 *   /usage balance    - 仅查余额
 *   /usage session    - 仅查当前会话用量（含详细计费 + 最近一次回答费用）
 *   /usage footer     - 切换专属状态栏
 *   /usage status     - 切换状态栏余额显示
 *   /usage peak       - 当前生效的计价变体（峰谷/限时折扣）及切换时间
 *
 * 安装: 复制到 ~/.pi/agent/extensions/ 后 /reload 即可
 */

import type { ExtensionAPI, ExtensionContext, AssistantMessage } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { resolveProvider } from "./usage-providers/index.ts";
import { isPeakHour } from "./usage-providers/deepseek.ts";
import { calculateCost, getSessionUsage, fmtCurrency, fmtTokens, hitRate } from "./usage-providers/cost.ts";
import { BALANCE_PROVIDERS, getBalanceProvider, queryBalanceFor } from "./usage-providers/balance.ts";
import {
	loadConfig, saveProviderConfig, clearProviderConfig,
	getRefreshMinutes, setRefreshMinutes,
	type BalanceProviderConfig,
} from "./usage-providers/config.ts";
import type { ProviderAdapter, ProviderBalance, BalanceResult } from "./usage-providers/types.ts";

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

/** 统一入口: 按 providerId 查余额 (adapter.queryBalance 已委托 balance.ts) */
async function queryBalanceSafe(adapter: ProviderAdapter): Promise<BalanceResult | null> {
	if (!adapter.queryBalance) return null;
	return adapter.queryBalance();
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
		ctx.ui.notify("当前环境无 TUI，无法交互式配置；请手动编辑 usage-providers/balance-config.json", "warning");
		return;
	}
	const action = await ctx.ui.select(
		"使用量配置 (仿 /settings)",
		["配置厂商凭证", "余额刷新间隔", "清除厂商凭证", "查看当前配置"],
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
			`将明文保存到 ${"usage-providers/balance-config.json"}（本地文件，勿提交 git）`,
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

	// ── 刷新间隔 ──
	if (action === "余额刷新间隔") {
		const minutes = await ctx.ui.input("余额刷新间隔（分钟）", String(getRefreshMinutes()));
		const n = parseInt(minutes ?? "", 10);
		if (isNaN(n) || n < 1) {
			ctx.ui.notify("无效的分钟数", "warning");
			return;
		}
		setRefreshMinutes(n);
		ctx.ui.notify(`余额刷新间隔已设为 ${n} 分钟（下次会话生效）`, "info");
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
		lines.push(`  余额刷新间隔: ${getRefreshMinutes()} 分钟`);
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
//  Footer
// ═══════════════════════════════════════════

/**
 * 开启专属状态栏。费用显示 "此次回答预估价/会话累计预估价"。
 */
function enableFooter(ctx: ExtensionContext, opts?: { silent?: boolean }) {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		// 余额按 provider 分别缓存 (切模型后无需重新拉取)
		const balances = new Map<string, string>();
		const refreshMinutes = getRefreshMinutes();
		const doRefreshBalance = async () => {
			// 每次 tick 动态解析 provider, 修复 session_start 时模型未选中导致余额不显示的 bug
			const adapter = resolveProvider(ctx.model?.id);
			const b = await queryBalanceSafe(adapter);
			if (b && isBalance(b) && b.available) {
				balances.set(adapter.id, `💰¥${parseFloat(b.total).toFixed(2)}`);
				tui.requestRender();
			} else if (b && "error" in b) {
				balances.delete(adapter.id);
			}
		};
		doRefreshBalance();
		const balTimer = setInterval(doRefreshBalance, refreshMinutes * 60 * 1000);

		return {
			dispose: () => {
				unsub();
				clearInterval(balTimer);
			},
			invalidate() {},
			render(width: number): string[] {
				const adapter = resolveProvider(ctx.model?.id);
				const modelId = ctx.model?.id;
				const usage = getSessionUsage(ctx);
				const { total, lastTurn } = usage;
				const cost = calculateCost(adapter, modelId, total);

				// 左半: [ PLAN ] ↑42k ↓11k R661k CH99.1% ¥0.02/¥0.08
				let left = "";
				// 可选集成: 若安装了 plan-mode 类扩展, 显示其状态 (软检测, 无硬依赖)
				const planStatus = footerData.getExtensionStatuses().get("plan-mode");
				if (planStatus) {
					left += planStatus + " ";
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
				left += theme.fg(
					"dim",
					`↑${fmtTokens(total.input)} ↓${fmtTokens(total.output)} R${fmtTokens(total.cacheRead)} CH${hitRate(total.input, total.cacheRead)}% ${costText}`,
				);

				// 上下文使用率
				try {
					const cu = ctx.getContextUsage();
					if (cu && ctx.model?.contextWindow) {
						const pct = ((cu.tokens / ctx.model.contextWindow) * 100).toFixed(1);
						left += ` ${theme.fg("dim", `${pct}%/${fmtTokens(ctx.model.contextWindow)}`)}`;
					}
				} catch { /* ignore */ }

				// 思考深度
				const tl = ctx.thinkingLevel;
				if (tl) {
					left += ` ${theme.fg("dim", `· ${tl}`)}`;
				}

				// 右半: 模型名 + 余额 (+ 峰谷标记, 仅峰谷计费的 provider)
				const rightParts: string[] = [];
				if (modelId) rightParts.push(modelId);
				const currentBalance = balances.get(adapter.id);
				if (currentBalance) rightParts.push(currentBalance);
				if (adapter.hasPeakPricing) {
					rightParts.push(isPeakHour() ? "🕸️" : "🦦");
				}
				let right = theme.fg("dim", rightParts.join(" "));

				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
				return [truncateToWidth(left + pad + right, width)];
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
//  Extension 入口
// ═══════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	let statusEnabled = false;
	let footerEnabled = false;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	const handler = async (args: string, ctx: ExtensionContext) => {
		const cmd = args.trim().toLowerCase();
		const adapter = resolveProvider(ctx.model?.id);
		const modelId = ctx.model?.id;

		// ── /usage peak ── 当前计价变体状态
		if (cmd === "peak") {
			ctx.ui.notify(formatVariantStatus(adapter, modelId).join("\n"), "info");
			return;
		}

		// ── /usage footer ──
		if (cmd === "footer") {
			footerEnabled = !footerEnabled;
			if (footerEnabled) {
				enableFooter(ctx);
			} else {
				disableFooter(ctx);
			}
			return;
		}

		// ── /usage status ──
		if (cmd === "status") {
			statusEnabled = !statusEnabled;
			const setStatus = (b: BalanceResult | null) => {
				if (b && isBalance(b) && b.available) {
					const peak = adapter.hasPeakPricing ? (isPeakHour() ? " 🕸️" : " 🦦") : "";
					ctx.ui.setStatus(adapter.id, `${adapter.name} ¥${parseFloat(b.total).toFixed(2)}${peak}`);
				} else if (b && "error" in b) {
					ctx.ui.setStatus(adapter.id, `${adapter.name}: ${b.error}`);
				}
			};
			if (statusEnabled) {
				if (!adapter.queryBalance) {
					ctx.ui.notify(`${adapter.name} 不支持余额查询`, "warning");
					statusEnabled = false;
					return;
				}
				setStatus(await adapter.queryBalance());
				ctx.ui.notify(`${adapter.name} 余额已显示在状态栏（每5分钟自动刷新）`, "info");
				if (!refreshTimer) {
					refreshTimer = setInterval(async () => {
						if (!statusEnabled) return;
						// 动态解析: 切换模型后状态栏跟随当前 provider
						const current = resolveProvider(ctx.model?.id);
						if (!current.queryBalance) return;
						const b = await current.queryBalance();
						if (b && isBalance(b) && b.available) {
							const peak = current.hasPeakPricing ? (isPeakHour() ? " 🕸️" : " 🦦") : "";
							ctx.ui.setStatus(current.id, `${current.name} ¥${parseFloat(b.total).toFixed(2)}${peak}`);
						}
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

		// ── /usage balance ──
		if (cmd === "balance") {
			if (!adapter.queryBalance) {
				ctx.ui.notify(`${adapter.name} 暂无公开余额查询 API`, "warning");
				return;
			}
			const balance = await adapter.queryBalance();
			if ("error" in balance) {
				ctx.ui.notify(balance.error, "error");
				return;
			}
			ctx.ui.notify(formatBalanceText(adapter, balance).join("\n"), "info");
			return;
		}

		// ── /usage config ── 交互式配置 (仿 /settings)
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
			const balance = adapter.queryBalance ? await adapter.queryBalance() : null;
			const lines: string[] = [];
			if (balance && "error" in balance) {
				lines.push(`⚠️  ${balance.error}`);
			} else if (balance) {
				lines.push(...formatBalanceText(adapter, balance));
			}
			lines.push("");
			lines.push(...formatUsageText(adapter, stats, modelId));
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		ctx.ui.notify(`未知子命令: /usage ${cmd}\n支持: balance, session, footer, status, peak`, "warning");
	};

	pi.registerCommand("usage", {
		description: "模型余额和用量查询。子命令: balance, session, footer, status, peak, config",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["balance", "session", "footer", "status", "peak", "config"];
			return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
		},
		handler,
	});

	// 向后兼容别名
	pi.registerCommand("deepseek", {
		description: "（别名）同 /usage，现自动支持 DeepSeek/GLM 等多模型",
		handler,
	});

	// ── 选中支持余额查询的模型时自动显示余额 ──
	pi.on("model_select", async (event, ctx) => {
		const adapter = resolveProvider(event.model?.id);
		if (adapter.queryBalance && !footerEnabled && !statusEnabled) {
			const balance = await adapter.queryBalance();
			if (isBalance(balance) && balance.available) {
				const peak = adapter.hasPeakPricing ? (isPeakHour() ? " 🕸️" : " 🦦") : "";
				ctx.ui.setStatus(adapter.id, `${adapter.name} ¥${parseFloat(balance.total).toFixed(2)}${peak}`);
			}
		}
	});

	// ── 默认启动时自动开启 footer ──
	pi.on("session_start", (_event, ctx) => {
		footerEnabled = true;
		enableFooter(ctx, { silent: true });
	});

	// ── 清理 ──
	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	});
}
