/**
 * 共享价表接入测试 (node:test + jiti 直载 TS)
 *
 * 运行: node --test
 * 覆盖: 四态 (pi-pricer / defaults / missing / failed)、v5 价表驱动费用、
 *       方案别名优先透传、旧版价表(v≠5)判为 defaults、解析链字段、方案结构展开、
 *       免费判定、价表不可用时不算出误导性金额、峰谷 isPeak 透传。
 * 真实 pi-pricer 集成用例在未安装时自动 skip (CI/他人机器友好)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const source = await jiti.import(`${SRC}/pricing-source.ts`);
const cost = await jiti.import(`${SRC}/cost.ts`);

/** 假适配器: 只需 id, 计价全交给共享价表 */
const adapter = { id: "deepseek", name: "DeepSeek", currency: "CNY", matchModel: () => true };

const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };

/** v5 价表夹具: 单价格 + 单规则 + 单方案(可带别名) + 单模型 (对齐 Schema v5 五集合) */
function v5Fixture({ inputMiss, inputHit, output, alias, planName = "我的方案", ruleName = "我的规则" }) {
	return {
		version: 5,
		rates: [{ _id: "0000000000000001", createdAt: "2026-01-01T00:00:00.000Z", name: "我的价", inputMiss, inputHit, output }],
		calendars: [],
		rules: [{
			_id: "0000000000000011", createdAt: "2026-01-01T00:00:01.000Z", name: ruleName,
			rateId: "0000000000000001", timezone: "Asia/Shanghai",
			weekdays: [], ranges: [], includeCalendars: [], excludeCalendars: [], includeDates: [], excludeDates: [],
		}],
		plans: [{
			_id: "0000000000000021", createdAt: "2026-01-01T00:00:02.000Z", name: planName,
			...(alias ? { alias } : {}), enabled: true, ruleIds: ["0000000000000011"],
		}],
		models: [{ _id: "0000000000000031", createdAt: "2026-01-01T00:00:03.000Z", provider: "deepseek", model: "deepseek-flash", planId: "0000000000000021" }],
	};
}

/** pi-pricer 是否可用 (不可用则 skip 真实集成用例) */
async function pricerAvailable() {
	try {
		await jiti.import("@foolsecret/pi-pricer/pricing");
		return true;
	} catch {
		return false;
	}
}

test("三态: 未安装 -> missing, 费用未知 (priceKnown=false)", async () => {
	source.resetPricingSource();
	await source.ensurePricingSource(async () => null);
	assert.equal(source.getPricingSource().source, "missing");
	const r = cost.calculateCost(adapter, "deepseek-flash", usage);
	assert.equal(r.priceKnown, false);
	assert.equal(r.totalCNY, 0, "不得算出误导性金额");
});

test("三态: 加载抛错 -> failed 并附原因", async () => {
	source.resetPricingSource();
	await source.ensurePricingSource(async () => {
		throw new Error("JSON 损坏");
	});
	const st = source.getPricingSource();
	assert.equal(st.source, "failed");
	assert.equal(st.reason, "JSON 损坏");
});

test("三态: 加载成功 -> pi-pricer, 按三价换算费用", async () => {
	source.resetPricingSource();
	await source.ensurePricingSource(async () => () => ({ inputMiss: 1, inputHit: 0.02, output: 4, isPeak: false }));
	assert.equal(source.getPricingSource().source, "pi-pricer");
	const r = cost.calculateCost(adapter, "deepseek-flash", usage);
	// 1M miss × 1 + 1M hit × 0.02 + 1M out × 4 = 5.02
	assert.ok(Math.abs(r.totalCNY - 5.02) < 1e-9, `期望 5.02, 实际 ${r.totalCNY}`);
	assert.equal(r.priceKnown, true);
	assert.equal(r.free, false);
});

test("方案别名优先: variantLabel = planAlias（无别名回退 planName）", async () => {
	source.resetPricingSource();
	await source.ensurePricingSource(async () => () => ({
		inputMiss: 1, inputHit: 0, output: 1, isPeak: false, planName: "方案全名", planAlias: "短名",
	}));
	assert.equal(cost.calculateCost(adapter, "deepseek-flash", usage).variantLabel, "短名");
	source.resetPricingSource();
	await source.ensurePricingSource(async () => () => ({
		inputMiss: 1, inputHit: 0, output: 1, isPeak: false, planName: "方案全名",
	}));
	assert.equal(cost.calculateCost(adapter, "deepseek-flash", usage).variantLabel, "方案全名");
});

test("免费判定: 三价全零 -> free 且金额为 0", async () => {
	source.resetPricingSource();
	await source.ensurePricingSource(async () => () => ({ inputMiss: 0, inputHit: 0, output: 0, isPeak: false }));
	const r = cost.calculateCost(adapter, "glm-4.7-flash", usage);
	assert.equal(r.free, true);
	assert.equal(r.totalCNY, 0);
});

test("峰谷: isPeak 从价表透传到 CostBreakdown", async () => {
	source.resetPricingSource();
	await source.ensurePricingSource(async () => () => ({ inputMiss: 2, inputHit: 0.04, output: 8, isPeak: true }));
	const r = cost.calculateCost(adapter, "deepseek-flash", usage);
	assert.equal(r.isPeak, true);
});

test("并发防抖: 幂等, 只加载一次", async () => {
	source.resetPricingSource();
	let calls = 0;
	const loader = async () => {
		calls++;
		return () => ({ inputMiss: 1, inputHit: 0, output: 1, isPeak: false });
	};
	await Promise.all([source.ensurePricingSource(loader), source.ensurePricingSource(loader)]);
	await source.ensurePricingSource(loader);
	assert.equal(calls, 1);
});

test("未选模型: 不报错, 返回未知价", () => {
	source.resetPricingSource();
	const r = cost.calculateCost(adapter, undefined, usage);
	assert.equal(r.priceKnown, false);
	assert.equal(r.totalCNY, 0);
	source.resetPricingSource();
});

test("真实 pi-pricer: v5 价表驱动费用 + 别名 + 解析链 + 方案结构 (未安装则 skip)", async (t) => {
	if (!(await pricerAvailable())) {
		t.skip("pi-pricer 不可用，跳过真实集成用例");
		return;
	}
	const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "pi-usager-pricer-"));
	try {
		const pricingPath = join(dir, "model-pricing.json");
		writeFileSync(pricingPath, JSON.stringify(v5Fixture({
			inputMiss: 10, inputHit: 1, output: 20, alias: "我的别名", planName: "我的方案", ruleName: "我的规则",
		})), "utf8");

		source.resetPricingSource();
		await source.ensurePricingSource(undefined, pricingPath);
		if (source.getPricingSource().source === "missing") {
			t.skip("pi-pricer 不可用，跳过真实集成用例");
			return;
		}
		assert.equal(source.getPricingSource().source, "pi-pricer");
		const r = cost.calculateCost(adapter, "deepseek-flash", usage);
		assert.ok(Math.abs(r.totalCNY - 31) < 1e-9, `期望 31 (10+1+20), 实际 ${r.totalCNY}`);
		assert.equal(r.variantLabel, "我的别名", "别名优先透传到 variantLabel");

		// 解析链 (v5: ruleName + rateId)
		const debug = source.resolveDebug("deepseek-flash", "deepseek", new Date("2026-01-01T00:00:00.000Z"));
		assert.ok(debug, "resolveDebug 应可用");
		assert.equal(debug.matched, true);
		assert.equal(debug.chain.length, 1);
		assert.equal(debug.chain[0].ruleName, "我的规则");
		assert.equal(debug.chain[0].rateId, "0000000000000001");

		// 方案结构展开 (/db explainPlan)
		const plan = source.getPlanDetail("deepseek", "deepseek-flash");
		assert.ok(plan, "getPlanDetail 应可用");
		assert.equal(plan.planAlias, "我的别名");
		assert.equal(plan.rules.length, 1);
		assert.equal(plan.rules[0].inputMiss, 10);
		assert.equal(plan.rules[0].inputHit, 1);
		assert.equal(plan.rules[0].output, 20);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		source.resetPricingSource();
	}
});

// ── 内置默认价 vs 用户价表（本次事故核心） ───────────────────────────

test("defaults 态: 价表文件缺失 -> defaults（pi-pricer 静默回退内置默认价）", async (t) => {
	if (!(await pricerAvailable())) {
		t.skip("pi-pricer 不可用，跳过 defaults 用例");
		return;
	}
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	// 临时目录下不存在 model-pricing.json —— 即"从未配置过"
	const dir = mkdtempSync(join(tmpdir(), "pi-usager-defaults-"));
	try {
		source.resetPricingSource();
		await source.ensurePricingSource(undefined, join(dir, "model-pricing.json"));
		assert.equal(source.getPricingSource().source, "defaults");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		source.resetPricingSource();
	}
});

test("defaults 态: 用户 v5 价表 -> pi-pricer（不误判为 defaults）", async (t) => {
	if (!(await pricerAvailable())) {
		t.skip("pi-pricer 不可用，跳过用例");
		return;
	}
	const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "pi-usager-custom-"));
	const pricingPath = join(dir, "model-pricing.json");
	writeFileSync(pricingPath, JSON.stringify(v5Fixture({
		inputMiss: 42, inputHit: 4, output: 84, alias: "自配短名", planName: "我的方案",
	})), "utf8");
	try {
		source.resetPricingSource();
		await source.ensurePricingSource(undefined, pricingPath);
		assert.equal(source.getPricingSource().source, "pi-pricer");
		const r = cost.calculateCost(adapter, "deepseek-flash", usage);
		assert.ok(Math.abs(r.totalCNY - 130) < 1e-9, `期望 130 (42+4+84), 实际 ${r.totalCNY}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		source.resetPricingSource();
	}
});

test("defaults 态: 旧版价表 (version≠5) -> defaults 并附原因", async (t) => {
	if (!(await pricerAvailable())) {
		t.skip("pi-pricer 不可用，跳过用例");
		return;
	}
	const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "pi-usager-oldver-"));
	const pricingPath = join(dir, "model-pricing.json");
	// v2 旧结构: pi-pricer v5 不读取 -> 回退内置种子, usager 必须据此判 defaults
	writeFileSync(pricingPath, JSON.stringify({
		version: 2, calendars: {},
		prices: { old: { name: "旧价", input: { miss: 1, hit: 0 }, output: 1 } },
		plans: {}, providers: {},
	}), "utf8");
	try {
		source.resetPricingSource();
		await source.ensurePricingSource(undefined, pricingPath);
		const st = source.getPricingSource();
		assert.equal(st.source, "defaults", "旧版价表必须判为 defaults");
		assert.match(st.reason ?? "", /旧版价表/, "应附旧版价表原因");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		source.resetPricingSource();
	}
});
