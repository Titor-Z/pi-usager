/**
 * 厂商引擎测试 (node:test + jiti 直载 TS)
 *
 * 运行: node --test
 * 覆盖: 预设 → 适配器 (id/priceProvider/piProviderId/matchModel)、JSON path 取值、
 *       四种认证策略 (bearer / header / none / jwt-hs256 / command)、多端点轮询、
 *       GLM bearer→jwt 后备回归、无密钥报错。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const engine = await jiti.import(`${SRC}/provider-engine.ts`);
const presets = await jiti.import(`${SRC}/presets.ts`);
const auth = await jiti.import(`${SRC}/auth.ts`);

const byId = (id) => presets.PRESET_PROVIDERS.find((d) => d.id === id);

async function withFetch(handler, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

// ── 描述 → 适配器 ──

test("preset → adapter: id / name / priceProvider / piProviderId", () => {
	const deepseek = engine.descriptorToAdapter(byId("deepseek"));
	assert.equal(deepseek.id, "deepseek");
	assert.equal(deepseek.priceProvider, "deepseek");
	assert.equal(deepseek.piProviderId, "deepseek");

	const glm = engine.descriptorToAdapter(byId("glm"));
	assert.equal(glm.priceProvider, "zai");
	assert.equal(glm.piProviderId, "zai");
});

test("preset → adapter: matchModel 按 matchPatterns", () => {
	const deepseek = engine.descriptorToAdapter(byId("deepseek"));
	assert.equal(deepseek.matchModel("deepseek-v4-flash"), true);
	assert.equal(deepseek.matchModel("glm-5.3"), false);

	const glm = engine.descriptorToAdapter(byId("glm"));
	assert.equal(glm.matchModel("GLM-5.3-Flash"), true);
	assert.equal(glm.matchModel(undefined), false);
});

test("无 balance 描述 → adapter 无 queryBalance", () => {
	const adapter = engine.descriptorToAdapter({ id: "x", name: "X", matchPatterns: ["x"] });
	assert.equal(adapter.queryBalance, undefined);
	assert.equal(adapter.priceProvider, "x");
});

// ── JSON path ──

test("evaluateJsonPath: 嵌套 + 数组下标", () => {
	const data = { balance_infos: [{ total_balance: "1.59" }], data: { availableBalance: 12.5 } };
	assert.equal(engine.evaluateJsonPath(data, "balance_infos[0].total_balance"), "1.59");
	assert.equal(engine.evaluateJsonPath(data, "data.availableBalance"), 12.5);
	assert.equal(engine.evaluateJsonPath(data, "data.missing"), undefined);
});

// ── 认证与查询 ──

test("bearer: 密钥透传 + 按 balancePath 取值", async () => {
	let authHeader;
	await withFetch(async (_url, init) => {
		authHeader = init.headers.Authorization;
		return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "1.59" }] }) };
	}, async () => {
		auth.setApiKeyResolver(async (pid) => (pid === "deepseek" ? "sk-test" : undefined));
		const result = await engine.queryDescriptorBalance(byId("deepseek"));
		assert.ok(!("error" in result));
		assert.equal(result.total, "1.59");
		assert.equal(result.available, true);
		assert.equal(authHeader, "Bearer sk-test");
	});
});

test("bearer: pi 未配置凭证时报错", async () => {
	auth.setApiKeyResolver(async () => undefined);
	const result = await engine.queryDescriptorBalance(byId("deepseek"));
	assert.ok("error" in result);
	assert.match(result.error, /未配置/);
});

test("GLM: bearer 失败且 key 为 id.secret 时自动 jwt 后备", async () => {
	const seenAuth = [];
	await withFetch(async (_url, init) => {
		const token = init.headers.Authorization.replace(/^Bearer /, "");
		seenAuth.push(token.split(".").length);
		if (token.split(".").length === 3) {
			return { ok: true, json: async () => ({ success: true, data: { availableBalance: 12.5, rechargeAmount: 10, giveAmount: 2.5 } }) };
		}
		return { ok: false, status: 401, json: async () => ({}) };
	}, async () => {
		auth.setApiKeyResolver(async (pid) => (pid === "zai" ? "abc123.secret456" : undefined));
		const result = await engine.queryDescriptorBalance(byId("glm"));
		assert.ok(!("error" in result), "jwt 后备应成功");
		assert.equal(result.total, "12.5");
		assert.equal(result.toppedUp, "10");
		assert.ok(seenAuth.includes(3), "应出现过 jwt 形态请求");
	});
});

test("GLM: 备份端点返回裸数值 (data) 时命中候选路径", async () => {
	await withFetch(async (url) => {
		if (url.includes("query-customer-account-report")) return { ok: false, status: 404, json: async () => ({}) };
		return { ok: true, json: async () => ({ data: 5 }) };
	}, async () => {
		auth.setApiKeyResolver(async () => "abc.secret");
		const result = await engine.queryDescriptorBalance(byId("glm"));
		assert.ok(!("error" in result));
		assert.equal(result.total, "5");
	});
});

test("header 认证: {{key}} 替换为 pi 的 key", async () => {
	let headerValue;
	await withFetch(async (_url, init) => {
		headerValue = init.headers["X-Api-Key"];
		return { ok: true, json: async () => ({ balance: 3 }) };
	}, async () => {
		auth.setApiKeyResolver(async () => "secret-key");
		const result = await engine.queryDescriptorBalance({
			id: "h", name: "H", matchPatterns: ["h"],
			balance: { endpoints: ["https://example.com/b"], auth: { type: "header", name: "X-Api-Key", value: "{{key}}" }, balancePath: "balance" },
		});
		assert.ok(!("error" in result));
		assert.equal(result.total, "3");
		assert.equal(headerValue, "secret-key");
	});
});

test("none 认证: 不带 Authorization", async () => {
	let sawAuth;
	await withFetch(async (_url, init) => {
		sawAuth = init.headers.Authorization;
		return { ok: true, json: async () => ({ total: "8" }) };
	}, async () => {
		const result = await engine.queryDescriptorBalance({
			id: "n", name: "N", matchPatterns: ["n"],
			balance: { endpoints: ["https://example.com/b"], auth: { type: "none" }, balancePath: "total" },
		});
		assert.equal(result.total, "8");
		assert.equal(sawAuth, undefined);
	});
});

test("command 认证: 读 stdout JSON", async () => {
	const result = await engine.queryDescriptorBalance({
		id: "c", name: "C", matchPatterns: ["c"],
		balance: { endpoints: [], auth: { type: "command", command: `printf '{"balance":7.5}'` }, balancePath: "balance" },
	});
	assert.ok(!("error" in result));
	assert.equal(result.total, "7.5");
});

test("command 认证: 空 balancePath 时把 stdout 根当作数值", async () => {
	const result = await engine.queryDescriptorBalance({
		id: "c2", name: "C2", matchPatterns: ["c2"],
		balance: { endpoints: [], auth: { type: "command", command: "printf '9.9'" }, balancePath: "" },
	});
	assert.ok(!("error" in result));
	assert.equal(result.total, "9.9");
});

// ── AI 辅助纯函数 ──

test("expandEnvHeaders: $VAR / ${VAR} 从环境变量展开", () => {
	process.env.PI_USAGER_TEST_VAR = "secret-cookie";
	try {
		assert.deepEqual(
			engine.expandEnvHeaders({ Cookie: "sid=$PI_USAGER_TEST_VAR", "X-A": "${PI_USAGER_TEST_VAR}", "X-B": "plain" }),
			{ Cookie: "sid=secret-cookie", "X-A": "secret-cookie", "X-B": "plain" },
		);
		assert.equal(engine.expandEnvHeaders({ Cookie: "$MISSING_XYZ" }).Cookie, "");
	} finally {
		delete process.env.PI_USAGER_TEST_VAR;
	}
});

test("applyProviderAction: add / 重复 add / update / delete", () => {
	const p = (id) => ({ id, name: id.toUpperCase(), matchPatterns: [id] });
	const add = engine.applyProviderAction([], { type: "add", id: "a", provider: p("a") });
	assert.equal(add.ok, true);
	assert.equal(add.list.length, 1);

	const dup = engine.applyProviderAction(add.list, { type: "add", id: "a", provider: p("a") });
	assert.equal(dup.ok, false);

	const upd = engine.applyProviderAction(add.list, { type: "update", id: "a", provider: { ...p("a"), name: "A2" } });
	assert.equal(upd.ok, true);
	assert.equal(upd.list[0].name, "A2");

	const del = engine.applyProviderAction(upd.list, { type: "delete", id: "a" });
	assert.equal(del.ok, true);
	assert.equal(del.list.length, 0);
	assert.equal(engine.applyProviderAction([], { type: "delete", id: "nope" }).ok, false);
	assert.equal(engine.applyProviderAction([], { type: "update", id: "nope", provider: p("nope") }).ok, false);
});

test("describeProviders: 含 id / 名称 / 认证 / 字段路径", () => {
	const summary = engine.describeProviders(presets.PRESET_PROVIDERS);
	assert.match(summary, /deepseek/);
	assert.match(summary, /bearer/);
	assert.match(summary, /balance_infos\[0\]\.total_balance/);
});

test("header 认证: 值中 $VAR 从环境变量展开 (cookie 不落配置)", async () => {
	let cookie;
	process.env.PI_USAGER_TEST_COOKIE = "sid=abc";
	try {
		await withFetch(async (_url, init) => {
			cookie = init.headers.Cookie;
			return { ok: true, json: async () => ({ data: { balance: 1 } }) };
		}, async () => {
			const result = await engine.queryDescriptorBalance({
				id: "m", name: "M", matchPatterns: ["m"],
				balance: {
					endpoints: ["https://example.com/b"],
					auth: { type: "header", name: "Cookie", value: "$PI_USAGER_TEST_COOKIE" },
					balancePath: "data.balance",
				},
			});
			assert.ok(!("error" in result));
			assert.equal(result.total, "1");
			assert.equal(cookie, "sid=abc");
		});
	} finally {
		delete process.env.PI_USAGER_TEST_COOKIE;
	}
});
