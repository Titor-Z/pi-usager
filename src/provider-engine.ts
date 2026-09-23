/**
 * 厂商通用引擎
 *
 * 厂商差异 = 一份 ProviderDescriptor 数据 (模型归属 + 余额查询描述),
 * 由本引擎统一执行; 新增厂商不再需要写代码:
 *   - 内置厂商: 在 src/presets.ts 加一条数据
 *   - 冷门厂商: 用户在 /usage config → 厂商管理 填一份配置
 *   - 极端特例: 用 `command` 认证策略 (用户给一条命令输出 JSON)
 *
 * 账户/余额接口没有行业标准 (不像推理有 OpenAI 兼容格式), 因此 URL/认证/字段
 * 这些信息必须由数据提供; 引擎负责按描述执行。
 */

import type { BalanceResult, ProviderAdapter } from "./types.ts";
import { resolveApiKey } from "./auth.ts";
import { createHmac } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

// ═══════════════════════════════════════════
//  描述数据模型
// ═══════════════════════════════════════════

export type AuthStrategy =
	/** 用 pi 凭证层的 key 作 Bearer */
	| { type: "bearer" }
	/** 自定义 header; value 中 {{key}} 会替换为 pi 的 key */
	| { type: "header"; name: string; value: string }
	/** 无认证 */
	| { type: "none" }
	/** 智谱同款 HMAC-SHA256 签名 (key 需为 id.secret 格式) */
	| { type: "jwt-hs256" }
	/** 执行一条命令, 读 stdout JSON (高级逃生舱, 覆盖声明式表达不了的特例) */
	| { type: "command"; command: string };

export interface BalanceSpec {
	/** 候选端点 (按序尝试); command 策略下可空 */
	endpoints: string[];
	method?: "GET" | "POST";
	/** POST body (可选) */
	body?: string;
	/** 主认证策略 */
	auth: AuthStrategy;
	/** 主认证全部端点失败后依次尝试的后备策略 (如 GLM 的 bearer → jwt) */
	authFallbacks?: AuthStrategy[];
	/** 余额字段路径 (候选, 首个命中生效), 如 data.availableBalance / balance_infos[0].total_balance */
	balancePath: string | string[];
	/** 可用性字段路径 (可选) */
	availablePath?: string;
	/** 充值/赠送字段路径 (可选, 用于明细展示) */
	toppedUpPath?: string;
	grantedPath?: string;
	/** 货币, 默认 CNY */
	currency?: string;
	/** 附加请求头 */
	headers?: Record<string, string>;
}

export interface ProviderDescriptor {
	id: string;
	name: string;
	/** pi 真实 provider id (bearer 认证时据此取 key); 缺省回退 id */
	piProviderId?: string;
	/** 价表 provider key (pi-pricer); 缺省回退 piProviderId ?? id */
	priceProvider?: string;
	/** 模型匹配子串 (大小写不敏感), 声明序即匹配优先级 */
	matchPatterns: string[];
	billingNote?: string;
	cacheNote?: string;
	depletionStatuses?: number[];
	balance?: BalanceSpec;
	/** 内置预设标记 (用户自定义为 undefined) */
	builtin?: boolean;
}

// ═══════════════════════════════════════════
//  工具
// ═══════════════════════════════════════════

/** 按 "a.b[0].c" 形式的路径取值 */
export function evaluateJsonPath(root: unknown, path: string): unknown {
	let cur: any = root;
	for (const token of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
		if (token === "") continue;
		if (cur === null || cur === undefined) return undefined;
		cur = cur[token];
	}
	return cur;
}

/** 首个非空且非对象的候选路径取值 (对象无法作为余额数值) */
function pickValue(data: unknown, paths: string | string[] | undefined): unknown {
	if (!paths) return undefined;
	for (const path of Array.isArray(paths) ? paths : [paths]) {
		const value = evaluateJsonPath(data, path);
		if (value !== undefined && value !== null && typeof value !== "object") return value;
	}
	return undefined;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function shortEndpoint(endpoint: string): string {
	try {
		return new URL(endpoint).pathname;
	} catch {
		return endpoint;
	}
}

export interface ProbeResult {
	ok: boolean;
	status?: number;
	data?: unknown;
	error?: string;
}

/** 执行一次 HTTP 请求并解析 JSON (余额查询与 AI 探测共用; 解析失败不抛错) */
export async function probeEndpoint(url: string, opts: {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
} = {}): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
	try {
		const response = await fetch(url, {
			method: opts.method ?? "GET",
			headers: { Accept: "application/json", ...(opts.headers ?? {}) },
			...(opts.body ? { body: opts.body } : {}),
			signal: controller.signal,
		});
		if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
		try {
			return { ok: true, status: response.status, data: await response.json() };
		} catch {
			return { ok: false, status: response.status, error: "响应不是合法 JSON" };
		}
	} catch (err) {
		return { ok: false, error: errMessage(err) };
	} finally {
		clearTimeout(timer);
	}
}

/** 智谱同款 HMAC-SHA256 签名; key 非 id.secret 格式返回 null */
export function signZhipuJwt(apiKey: string): string | null {
	const parts = apiKey.split(".");
	if (parts.length !== 2) return null;
	const [id, secret] = parts;
	try {
		const b64url = (input: string | Uint8Array) =>
			Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const header = b64url(JSON.stringify({ alg: "HS256", sign_type: "SIGN" }));
		const now = Math.floor(Date.now() / 1000);
		const payload = b64url(JSON.stringify({ api_key: id, exp: now + 3600, timestamp: now }));
		const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
		return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
	} catch {
		return null;
	}
}

// ═══════════════════════════════════════════
//  余额查询引擎
// ═══════════════════════════════════════════

function extractBalance(desc: ProviderDescriptor, spec: BalanceSpec, data: unknown): BalanceResult {
	const paths = spec.balancePath;
	// 空路径 = 直接把取回的数据当作余额 (command 常输出裸数值/JSON)
	const useRoot = !paths || (typeof paths === "string" ? paths === "" : paths.length === 0);
	const total = useRoot ? data : pickValue(data, paths);
	if (total === undefined || total === null || typeof total === "object") {
		const shown = Array.isArray(paths) ? paths.join(" / ") : paths;
		return { error: `${desc.name} 响应未匹配到余额字段 (${shown || "<root>"})` };
	}
	const available = pickValue(data, spec.availablePath);
	const toppedUp = pickValue(data, spec.toppedUpPath);
	const granted = pickValue(data, spec.grantedPath);
	return {
		available: available === undefined ? true : !!available,
		currency: spec.currency ?? "CNY",
		total: String(total),
		...(toppedUp !== undefined ? { toppedUp: String(toppedUp) } : {}),
		...(granted !== undefined ? { granted: String(granted) } : {}),
	};
}

/** 按描述查询余额: 认证策略 × 端点轮询, 汇总最后失败原因 */
export async function queryDescriptorBalance(desc: ProviderDescriptor): Promise<BalanceResult> {
	const spec = desc.balance;
	if (!spec) return { error: `${desc.name} 未配置余额查询` };

	const piProviderId = desc.piProviderId ?? desc.id;
	const strategies: AuthStrategy[] = [spec.auth, ...(spec.authFallbacks ?? [])];
	let lastError = "";

	for (const strategy of strategies) {
		// command: 自行取数, 与端点无关
		if (strategy.type === "command") {
			try {
				const { stdout } = await exec(strategy.command, { timeout: 15000, encoding: "utf-8" });
				return extractBalance(desc, spec, JSON.parse(stdout));
			} catch (err) {
				lastError = `command → ${errMessage(err)}`;
				continue;
			}
		}

		// 需要密钥的策略: 从 pi 凭证层取
		const needsKey = strategy.type === "bearer" || strategy.type === "jwt-hs256"
			|| (strategy.type === "header" && strategy.value.includes("{{key}}"));
		const apiKey = needsKey ? await resolveApiKey(piProviderId) : undefined;
		if (needsKey && !apiKey) {
			lastError = `pi 未配置 ${desc.name} 凭证 (provider: ${piProviderId})`;
			continue;
		}

		const authHeaders: Record<string, string> = {};
		if (strategy.type === "bearer") {
			authHeaders.Authorization = `Bearer ${apiKey}`;
		} else if (strategy.type === "jwt-hs256") {
			const jwt = signZhipuJwt(apiKey!);
			if (!jwt) {
				lastError = "jwt → key 非 id.secret 格式, 无法签名";
				continue;
			}
			authHeaders.Authorization = `Bearer ${jwt}`;
		} else if (strategy.type === "header") {
			authHeaders[strategy.name] = expandEnvVars(strategy.value).replace(/\{\{key\}\}/g, apiKey ?? "");
		}

		for (const endpoint of spec.endpoints) {
			const label = `${strategy.type} ${shortEndpoint(endpoint)}`;
			const probe = await probeEndpoint(endpoint, {
				method: spec.method,
				headers: { ...authHeaders, ...expandEnvHeaders(spec.headers ?? {}) },
				body: spec.body,
			});
			if (!probe.ok) {
				lastError = `${label} → ${probe.error}`;
				continue;
			}
			const data: any = probe.data;
			if (data?.success === false) {
				lastError = `${label} → ${data.msg ?? "rejected"}`;
				continue;
			}
			return extractBalance(desc, spec, data);
		}
	}
	return { error: `${desc.name} 余额查询失败 (最后: ${lastError})` };
}

// ═══════════════════════════════════════════
//  AI 辅助函数 (供 balance_* 工具)
// ═══════════════════════════════════════════

/** 展开单个字符串里的 `$VAR` / `${VAR}` */
export function expandEnvVars(value: string): string {
	return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => process.env[a ?? b] ?? "");
}

/** 展开 header 值里的 `$VAR` / `${VAR}` (cookie 等秘密从环境变量取, 不落配置) */
export function expandEnvHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key] = expandEnvVars(value);
	}
	return out;
}

export type ProviderActionType = "add" | "update" | "delete";

/** 对自定义厂商列表应用一次增/改/删 (纯函数) */
export function applyProviderAction(
	list: ProviderDescriptor[],
	action: { type: ProviderActionType; id: string; provider?: ProviderDescriptor },
): { ok: true; list: ProviderDescriptor[]; message: string } | { ok: false; reason: string } {
	if (action.type === "delete") {
		if (!list.some((d) => d.id === action.id)) return { ok: false, reason: `未找到自定义厂商 ${action.id}` };
		return { ok: true, list: list.filter((d) => d.id !== action.id), message: `已删除 ${action.id}` };
	}
	const provider = action.provider;
	if (!provider) return { ok: false, reason: "缺少 provider 描述" };
	if (provider.id !== action.id) return { ok: false, reason: "provider.id 与 id 不一致" };
	if (action.type === "add") {
		if (list.some((d) => d.id === action.id)) return { ok: false, reason: `${action.id} 已存在（如需修改请用 update）` };
		return { ok: true, list: [...list, provider], message: `已添加 ${provider.name}` };
	}
	if (!list.some((d) => d.id === action.id)) return { ok: false, reason: `未找到自定义厂商 ${action.id}` };
	return { ok: true, list: list.map((d) => (d.id === action.id ? provider : d)), message: `已更新 ${provider.name}` };
}

/** 供 AI 读取的现状摘要 (不含秘密) */
export function describeProviders(descriptors: ProviderDescriptor[]): string {
	const lines = descriptors.map((d) => {
		const b = d.balance;
		const auth = b
			? b.auth.type + (b.authFallbacks?.length ? `→${b.authFallbacks.map((a) => a.type).join("→")}` : "")
			: "无余额查询";
		const path = b ? (Array.isArray(b.balancePath) ? b.balancePath.join(" / ") : b.balancePath) : "-";
		return `- ${d.id} (${d.name})${d.builtin ? " [内置]" : " [自定义]"} | match: ${d.matchPatterns.join(",")} | pi: ${d.piProviderId ?? d.id} | ${auth} | ${b ? (b.endpoints.join(" ") || "(command)") : "-"} | path: ${path || "<root>"}`;
	});
	return lines.join("\n") || "(无)";
}

// ═══════════════════════════════════════════
//  描述 → 适配器
// ═══════════════════════════════════════════

/** 由厂商描述生成 ProviderAdapter */
export function descriptorToAdapter(desc: ProviderDescriptor): ProviderAdapter {
	const patterns = desc.matchPatterns.map((p) => p.toLowerCase());
	return {
		id: desc.id,
		name: desc.name,
		priceProvider: desc.priceProvider ?? desc.piProviderId ?? desc.id,
		piProviderId: desc.piProviderId ?? desc.id,
		currency: "CNY",
		matchModel: (modelId) => !!modelId && patterns.some((p) => modelId.toLowerCase().includes(p)),
		queryBalance: desc.balance ? () => queryDescriptorBalance(desc) : undefined,
		depletionStatuses: desc.depletionStatuses,
		billingNote: desc.billingNote,
		cacheNote: desc.cacheNote,
	};
}
