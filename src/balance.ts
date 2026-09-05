/**
 * 余额查询模块
 *
 * 每个厂商实现一个 BalanceProvider, 声明自己需要的凭证字段,
 * 凭证来源优先级: ~/.pi/pi-usager.json (交互式配置) → 环境变量 → auth.json 兜底。
 *
 * 新增厂商: 实现 BalanceProvider 并加入 BALANCE_PROVIDERS 即可,
 * /usage config 的交互式配置流会自动读取 fields 生成录入表单。
 */

import type { BalanceResult } from "./types.ts";
import { loadConfig, type BalanceProviderConfig } from "./config.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ═══════════════════════════════════════════
//  类型
// ═══════════════════════════════════════════

export interface ConfigField {
	key: string;
	label: string;
	/** 输入提示 placeholder */
	placeholder?: string;
	/** 敏感字段 (配置回显时打码) */
	secret?: boolean;
	/** 帮助文案 (录入前展示) */
	help?: string;
	/** 可选字段 */
	optional?: boolean;
	/** 提供选项时用 select 交互 (第一个为默认推荐项), 否则用 input */
	options?: string[];
	/** select 选项中的推荐项 (展示 ⭐推荐 标记, 录入后按原始值存储) */
	recommended?: string;
}

export interface BalanceProvider {
	id: string;
	name: string;
	/** 交互式配置 (/usage config) 需要录入的字段 */
	fields: ConfigField[];
	/** 使用凭证查询余额 */
	query(creds: BalanceProviderConfig): Promise<BalanceResult>;
}

// ═══════════════════════════════════════════
//  凭证读取
// ═══════════════════════════════════════════

function readAuthJson(): any {
	try {
		const authPath = join(homedir(), ".pi/agent/auth.json");
		if (existsSync(authPath)) return JSON.parse(readFileSync(authPath, "utf-8"));
	} catch { /* ignore */ }
	return undefined;
}

/** 凭证优先级: ~/.pi/pi-usager.json → 环境变量 → auth.json */
export function getCredentials(providerId: string, envKeys: string[], authJsonKeys: string[]): BalanceProviderConfig {
	const fromConfig = loadConfig().providers?.[providerId];
	if (fromConfig && Object.keys(fromConfig).length > 0) return fromConfig;
	for (const envKey of envKeys) {
		const v = process.env[envKey];
		if (v) return { [envKeys[0]]: v };
	}
	const auth = readAuthJson();
	if (auth) {
		for (const authKey of authJsonKeys) {
			const v = auth[authKey]?.key;
			if (v) return { [envKeys[0]]: v };
		}
	}
	return {};
}

// ═══════════════════════════════════════════
//  DeepSeek
// ═══════════════════════════════════════════

export const deepseekBalance: BalanceProvider = {
	id: "deepseek",
	name: "DeepSeek",
	fields: [
		{
			key: "apiKey",
			label: "DeepSeek API Key",
			placeholder: "sk-...",
			secret: true,
			help: "从 https://platform.deepseek.com 获取；留空则回退到环境变量 DEEPSEEK_API_KEY 或 pi 的 auth.json",
		},
	],
	query: async (creds) => {
		const apiKey = creds.apiKey;
		if (!apiKey) return { error: "未配置 DeepSeek API Key (/usage config)" };
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);
			const response = await fetch("https://api.deepseek.com/user/balance", {
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
				signal: controller.signal,
			});
			clearTimeout(timer);
			if (!response.ok) return { error: `API 请求失败 (${response.status})` };
			const data: any = await response.json();
			const info = data?.balance_infos?.[0];
			if (!info) return { error: "余额响应格式异常" };
			return {
				available: !!data.is_available,
				currency: info.currency ?? "CNY",
				total: info.total_balance ?? "0",
				granted: info.granted_balance,
				toppedUp: info.topped_up_balance,
			};
		} catch (err) {
			return { error: `查询失败: ${err instanceof Error ? err.message : String(err)}` };
		}
	},
};

// ═══════════════════════════════════════════
//  GLM (智谱)
// ═══════════════════════════════════════════

/**
 * 智谱无公开文档化的余额 API, 采用候选端点探测:
 * 1. API Key 模式: Bearer 直调 (部分端点接受 "id.secret" 形式的原始 key)
 * 2. JWT 模式: 按官方 SDK 规则, 用 "id.secret" 的 secret 部分 HMAC-SHA256 签发 JWT
 * 响应解析为通用启发式: 在 JSON 中寻找余额字段。
 */
function signZhipuJwt(apiKey: string): string | null {
	const parts = apiKey.split(".");
	if (parts.length !== 2) return null;
	const [id, secret] = parts;
	try {
		const b64url = (input: string | Uint8Array) =>
			Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const header = b64url(JSON.stringify({ alg: "HS256", sign_type: "SIGN" }));
		const now = Math.floor(Date.now() / 1000);
		const payload = b64url(JSON.stringify({ api_key: id, exp: now + 3600, timestamp: now }));
		// @ts-ignore node:crypto 在 pi 运行时可用
		const crypto = require("node:crypto");
		const sig = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest();
		return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
	} catch {
		return null;
	}
}

// (原启发式解析已移除: 主端点响应结构已实测确认, 见 parseGlmReport)

const GLM_BALANCE_ENDPOINTS = [
	// 主端点: 控制台余额报告 (实测可用, Bearer 原始 key 即可)
	"https://open.bigmodel.cn/api/biz/account/query-customer-account-report",
	// 备用: 仅返回余额数值
	"https://open.bigmodel.cn/api/biz/account/getAccountBalanceEnough",
];

/** 解析 query-customer-account-report 的响应 */
function parseGlmReport(data: any): BalanceResult {
	const d = data?.data;
	if (!d || typeof d !== "object") return { error: "余额响应格式异常" };
	const total = d.availableBalance ?? d.balance;
	if (total === undefined || total === null) return { error: "余额响应缺少字段" };
	return {
		available: true,
		currency: "CNY",
		total: String(total),
		toppedUp: d.rechargeAmount !== undefined ? String(d.rechargeAmount) : undefined,
		granted: d.giveAmount !== undefined ? String(d.giveAmount) : undefined,
	};
}

export const glmBalance: BalanceProvider = {
	id: "glm",
	name: "GLM",
	fields: [
		{
			key: "apiKey",
			label: "GLM API Key",
			placeholder: "id.secret 格式",
			secret: true,
			help: "从 https://open.bigmodel.cn 控制台获取；JWT 模式需要 id.secret 格式的 key",
		},
		{
			key: "authMode",
			label: "鉴权模式",
			help: "bearer = 直接用 API Key 调用 (实测可用，推荐)；jwt = 官方 SDK 同款签名，备用",
			options: ["bearer", "jwt"],
			recommended: "bearer",
		},
	],
	query: async (creds) => {
		const apiKey = creds.apiKey;
		if (!apiKey) return { error: "未配置 GLM API Key (/usage config)" };
		const useJwt = (creds.authMode ?? "").toLowerCase() === "jwt";
		const token = useJwt ? (signZhipuJwt(apiKey) ?? apiKey) : apiKey;
		let lastError = "";
		for (const endpoint of GLM_BALANCE_ENDPOINTS) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 5000);
				const response = await fetch(endpoint, {
					headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
					signal: controller.signal,
				});
				clearTimeout(timer);
				if (!response.ok) {
					lastError = `${endpoint.split("/api/")[1]} → HTTP ${response.status}`;
					continue;
				}
				const data: any = await response.json();
				if (data?.success === false) {
					lastError = `${endpoint.split("/api/")[1]} → ${data.msg ?? "rejected"}`;
					continue;
				}
				// 主端点: 余额报告 (含充值/赠送明细); 备用端点: data 为数值
				if (endpoint.includes("query-customer-account-report")) {
					return parseGlmReport(data);
				}
				if (typeof data?.data === "number") {
					return { available: true, currency: "CNY", total: String(data.data) };
				}
				lastError = `${endpoint.split("/api/")[1]} → 响应中未识别余额字段`;
			} catch (err) {
				lastError = `${endpoint.split("/api/")[1]} → ${err instanceof Error ? err.message : String(err)}`;
			}
		}
		return {
			error: `GLM 余额查询失败 (最后: ${lastError})。可在 /usage config 中更换鉴权模式 (bearer/jwt)`,
		};
	},
};

// ═══════════════════════════════════════════
//  注册表
// ═══════════════════════════════════════════

export const BALANCE_PROVIDERS: Record<string, BalanceProvider> = {
	deepseek: deepseekBalance,
	glm: glmBalance,
};

export function getBalanceProvider(id: string): BalanceProvider | undefined {
	return BALANCE_PROVIDERS[id];
}

/** 便捷入口: 解析凭证并查询指定 provider 的余额 */
export async function queryBalanceFor(providerId: string): Promise<BalanceResult> {
	const bp = BALANCE_PROVIDERS[providerId];
	if (!bp) return { error: `余额查询不支持该厂商: ${providerId}` };
	const envMap: Record<string, string[]> = {
		deepseek: ["DEEPSEEK_API_KEY"],
		glm: ["ZHIPU_API_KEY", "GLM_API_KEY"],
	};
	const authMap: Record<string, string[]> = {
		deepseek: ["deepseek"],
		glm: ["glm", "zhipu", "zai"],
	};
	const creds = getCredentials(providerId, envMap[providerId] ?? [], authMap[providerId] ?? []);
	return bp.query(creds);
}
