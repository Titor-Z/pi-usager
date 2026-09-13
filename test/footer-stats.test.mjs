/**
 * footer 统计口径测试 (node:test + jiti 直载 TS)
 *
 * 运行: node --test
 * 覆盖: fmtTokens 去尾随 0、sessionHitRate 的 provider 自适应分母、
 *       turnHitRate 对齐 pi 原生公式、getSessionUsage 穷尽 usage 来源
 *       (assistant + toolResult + compaction/branch_summary)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const cost = await jiti.import(`${SRC}/cost.ts`);

// ── fmtTokens: 2 位小数 + 去尾随 0 (<1000 原值) ──

test("fmtTokens: <1000 原值, 无小数", () => {
	assert.equal(cost.fmtTokens(0), "0");
	assert.equal(cost.fmtTokens(999), "999");
});

test("fmtTokens: k 档 2 位小数去尾 0", () => {
	assert.equal(cost.fmtTokens(1000), "1k");        // 1.00 → 1
	assert.equal(cost.fmtTokens(1500), "1.5k");
	assert.equal(cost.fmtTokens(15000), "15k");      // 15.00 → 15
	assert.equal(cost.fmtTokens(15800), "15.8k");    // 不做原生式四舍五入到 16k
	assert.equal(cost.fmtTokens(999000), "999k");
});

test("fmtTokens: M 档 2 位小数去尾 0", () => {
	assert.equal(cost.fmtTokens(1_000_000), "1M");
	assert.equal(cost.fmtTokens(1_200_000), "1.2M");   // 1.20 → 1.2
	assert.equal(cost.fmtTokens(1_240_000), "1.24M");  // 不降到原生 1.2M
	assert.equal(cost.fmtTokens(15_890_000), "15.89M"); // 不四舍五入到 16M
});

// ── turnHitRate: 对齐原生公式, 总是含 cacheWrite ──

test("turnHitRate: 含 cacheWrite 的原生公式", () => {
	// input=100, cacheRead=800, cacheWrite=100 → 800/1000 = 80%
	assert.equal(cost.turnHitRate({ input: 100, output: 0, cacheRead: 800, cacheWrite: 100 }), 80);
});

test("turnHitRate: 无缓存活动 → null", () => {
	assert.equal(cost.turnHitRate({ input: 500, output: 10, cacheRead: 0, cacheWrite: 0 }), null);
	assert.equal(cost.turnHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

// ── sessionHitRate: 分母 provider 自适应 ──

test("sessionHitRate: 无 cacheWrite 厂商 (DeepSeek/GLM) 分母 = input + cacheRead", () => {
	// 800/(200+800) = 80%
	assert.equal(cost.sessionHitRate({ input: 200, output: 0, cacheRead: 800, cacheWrite: 0 }), 80);
});

test("sessionHitRate: 有 cacheWrite 厂商 (Anthropic 系) 计入分母", () => {
	// 800/(100+800+100) = 80%
	assert.equal(cost.sessionHitRate({ input: 100, output: 0, cacheRead: 800, cacheWrite: 100 }), 80);
});

test("sessionHitRate: 无可算数据 → null", () => {
	assert.equal(cost.sessionHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

// ── getSessionUsage: 穷尽 usage 来源 (对齐 pi 原生 footer) ──

const mkCtx = (entries) => ({ sessionManager: { getBranch: () => entries } });

test("getSessionUsage: 累加 toolResult / compaction / branch_summary 的 usage", () => {
	const u = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });
	const ctx = mkCtx([
		{ type: "message", message: { role: "assistant", usage: u(100, 10, 900, 0) } },
		{ type: "message", message: { role: "toolResult", usage: u(50, 0, 50, 0) } },
		{ type: "compaction", usage: u(20, 5, 25, 0) },
		{ type: "branch_summary", usage: u(10, 1, 9, 0) },
		{ type: "message", message: { role: "user" } },
	]);
	const { total, messageCount } = cost.getSessionUsage(ctx);
	assert.equal(total.input, 100 + 50 + 20 + 10);
	assert.equal(total.output, 10 + 0 + 5 + 1);
	assert.equal(total.cacheRead, 900 + 50 + 25 + 9);
	assert.equal(messageCount, 1); // 只数 assistant
});

test("getSessionUsage: lastTurn 只取最近一条 assistant (不含 toolResult)", () => {
	const u = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });
	const ctx = mkCtx([
		{ type: "message", message: { role: "assistant", usage: u(100, 10, 900, 0) } },
		{ type: "message", message: { role: "assistant", usage: u(200, 20, 800, 0) } },
		{ type: "message", message: { role: "toolResult", usage: u(999, 999, 999, 999) } },
	]);
	const { lastTurn } = cost.getSessionUsage(ctx);
	assert.equal(lastTurn.input, 200);
	assert.equal(lastTurn.cacheRead, 800);
});
