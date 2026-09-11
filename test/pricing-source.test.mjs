/**
 * 共享价表接入测试 (node:test + jiti 直载 TS)
 *
 * 运行: node --test
 * 覆盖: 三态 (pi-pricer / missing / failed)、ResolvedPrice → 费用换算、
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

test("真实 pi-pricer: 临时价表驱动费用 (未安装则 skip)", async (t) => {
	// 用 jiti 加载 —— pi 运行时正是经 jiti 加载扩展, 而 Node 原生 import 无法
	// 剥离 node_modules 下的 .ts (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)
	let createPricer = null;
	try {
		const mod = await jiti.import("@foolsecret/pi-pricer/pricing");
		createPricer = mod.createPricingResolver ?? null;
	} catch {
		t.skip("pi-pricer 不可用，跳过真实集成用例");
		return;
	}
	if (!createPricer) {
		t.skip("pi-pricer 不可用，跳过真实集成用例");
		return;
	}
	const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "pi-usager-pricer-"));
	try {
		const pricingPath = join(dir, "model-pricing.json");
		writeFileSync(pricingPath, JSON.stringify({
			version: 2,
			calendars: {},
			prices: { always: { name: "全时", input: { miss: 10, hit: 1 }, output: 20 } },
			plans: { always: { name: "全时方案", rules: [{ schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] }, price: "always" }] } },
			providers: { deepseek: { models: { "deepseek-flash": { plans: [{ plan: "always", enabled: true }] } } } },
		}), "utf8");

		source.resetPricingSource();
		await source.ensurePricingSource(async () => createPricer(pricingPath));
		assert.equal(source.getPricingSource().source, "pi-pricer");
		const r = cost.calculateCost(adapter, "deepseek-flash", usage);
		assert.ok(Math.abs(r.totalCNY - 31) < 1e-9, `期望 31 (10+1+20), 实际 ${r.totalCNY}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		source.resetPricingSource();
	}
});
