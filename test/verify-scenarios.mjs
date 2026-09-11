/**
 * 三场景端到端验证 (复用真实扩展代码, 非重写逻辑)
 *
 * 驱动 extensions/index.ts 的 default export, 断言用户实际看到的东西:
 * 首次对话的提示文案 + 费用计算结果。
 *
 * 每个场景在**独立子进程**里跑: jiti 的模块缓存是全局的, 同进程内跨场景会
 * 复用第一次加载的 pricing-source 状态 (其 PRICING_FILE 已按首次 HOME 定型),
 * 导致后续场景判定错位。子进程隔离是唯一可靠的做法。
 *
 * 场景:
 *   A. 未装 pi-pricer     -> 首次对话提示安装 + 费用未知
 *   B. 装了但无价表文件   -> 提示"内置默认价", 不误报安装
 *   C. 装了且有自定义价表 -> 无提示 + 费用按自定义价
 *
 * 运行: node test/verify-scenarios.mjs
 */

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);

// ── 子进程模式: 只跑一个场景, 输出 JSON ─────────────────────────────
if (process.env.VERIFY_SCENARIO) {
	const { createJiti } = await import("jiti");
	const scenario = process.env.VERIFY_SCENARIO;
	// 子进程启动时才设 HOME, 保证 PRICING_FILE 按它定型
	process.env.HOME = process.env.VERIFY_HOME;

	const jiti = createJiti(import.meta.url);
	const ext = (await jiti.import(`${ROOT}/extensions/index.ts`)).default;
	const cost = await jiti.import(`${ROOT}/src/cost.ts`);

	const notifications = [];
	const handlers = new Map();
	const pi = {
		on: (n, fn) => handlers.set(n, fn),
		registerCommand: () => {},
		exec: async () => ({ code: 0, stdout: "" }),
	};
	const ctx = {
		hasUI: true, cwd: process.cwd(),
		model: { id: "deepseek-flash", provider: "deepseek", contextWindow: 128000 },
		thinkingLevel: "off",
		sessionManager: { getBranch: () => [] },
		getSessionName: () => "verify",
		getContextUsage: () => ({ tokens: 0 }),
		ui: {
			notify: (msg, level) => notifications.push({ msg, level }),
			setStatus: () => {}, setFooter: () => {},
			select: async () => undefined, input: async () => undefined, confirm: async () => false,
		},
	};

	ext(pi);
	await handlers.get("session_start")({ type: "session_start" }, ctx);
	handlers.get("turn_start")({ type: "turn_start" }, ctx);

	const adapter = { id: "deepseek", name: "DeepSeek", currency: "CNY", matchModel: () => true };
	const priced = cost.calculateCost(adapter, "deepseek-flash",
		{ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 });

	// 同时探一下解析器是否真的可用 (区分 missing/failed)
	const ps = await jiti.import(`${ROOT}/src/pricing-source.ts`);
	process.stdout.write(JSON.stringify({
		scenario,
		notifications,
		total: priced.totalCNY,
		known: priced.priceKnown,
		source: ps.getPricingSource().source,
	}));
	process.exit(0);
}

// ── 主进程: 造环境、拉起子进程、断言 ────────────────────────────────

/** 造临时 HOME; withPricing 为价表内容 (null = 不建文件) */
function tempHome(withPricing) {
	const home = mkdtempSync(join(tmpdir(), "pi-usager-verify-"));
	if (withPricing) {
		mkdirSync(join(home, ".pi"), { recursive: true });
		writeFileSync(join(home, ".pi", "model-pricing.json"), JSON.stringify(withPricing), "utf8");
	}
	return home;
}

function runScenario(scenario, home, extraEnv = {}) {
	const r = spawnSync(process.execPath, [SELF], {
		encoding: "utf8",
		env: { ...process.env, VERIFY_SCENARIO: scenario, VERIFY_HOME: home, ...extraEnv },
	});
	if (r.status !== 0) {
		console.error(`子进程失败 (${scenario}):\n${r.stderr}`);
		process.exit(1);
	}
	return JSON.parse(r.stdout);
}

/** 临时隐藏 pi-pricer 以模拟未安装 */
function withPricerHidden(fn) {
	const { renameSync } = require("node:fs");
	const secret = join(ROOT, "node_modules", "@foolsecret");
	const bak = join(tmpdir(), `_hidden_${Date.now()}`);
	let hidden = false;
	try { renameSync(secret, bak); hidden = true; } catch { /* 本就不存在 */ }
	try { return fn(); } finally { if (hidden) renameSync(bak, secret); }
}

function report(name, ok, detail) {
	console.log(`${ok ? "✔ PASS" : "✖ FAIL"}  ${name}`);
	for (const line of detail) console.log(`         ${line}`);
	if (!ok) process.exitCode = 1;
}

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

console.log("=== pi-usager v2.1.0 三场景验证 ===\n");

// A. 未装 pi-pricer
{
	const home = tempHome(null);
	try {
		const r = withPricerHidden(() => runScenario("A", home));
		const hint = r.notifications.find((n) => n.msg.includes("pi extension add"));
		report("场景 A · 未装 pi-pricer → 首次对话提示安装", !!hint && r.known === false, [
			`来源态: ${r.source} (期望 missing)`,
			`通知: ${hint ? hint.msg : "(无)"}`,
			`费用可知: ${r.known} (期望 false)`,
		]);
	} finally { rmSync(home, { recursive: true, force: true }); }
}

// B. 装了但价表文件缺失
{
	const home = tempHome(null);
	try {
		const r = runScenario("B", home);
		const defaultsHint = r.notifications.find((n) => n.msg.includes("内置默认价"));
		const installHint = r.notifications.find((n) => n.msg.includes("pi extension add"));
		report("场景 B · 装了但无价表文件 → 提示内置默认价, 不误报安装", !!defaultsHint && !installHint, [
			`来源态: ${r.source} (期望 defaults)`,
			`默认价提示: ${defaultsHint ? defaultsHint.msg : "(无)"}`,
			`误报安装提示: ${installHint ? "有 (BUG)" : "无 (正确)"}`,
		]);
	} finally { rmSync(home, { recursive: true, force: true }); }
}

// C. 装了且有自定义价表
{
	const home = tempHome({
		version: 2, calendars: {},
		prices: { mine: { name: "我的价", input: { miss: 42, hit: 4 }, output: 84 } },
		plans: { mine: { name: "我的方案", rules: [{ schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] }, price: "mine" }] } },
		providers: { deepseek: { models: { "deepseek-flash": { plans: [{ plan: "mine", enabled: true }] } } } },
	});
	try {
		const r = runScenario("C", home);
		const anyHint = r.notifications.filter((n) => /pi-pricer|内置默认价/.test(n.msg));
		report("场景 C · 有自定义价表 → 无提示且费用按自定义价",
			anyHint.length === 0 && Math.abs(r.total - 130) < 1e-6, [
			`来源态: ${r.source} (期望 pi-pricer)`,
			`多余提示: ${anyHint.length === 0 ? "无 (正确)" : anyHint.map((n) => n.msg.slice(0, 40)).join(" | ")}`,
			`1M miss+hit+out 费用: ¥${r.total} (期望 130)`,
		]);
	} finally { rmSync(home, { recursive: true, force: true }); }
}

console.log(process.exitCode ? "\n有失败项" : "\n全部通过");
