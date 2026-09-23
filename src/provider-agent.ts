/**
 * AI 辅助配置的 balance_* 工具 (balance_get / balance_probe / balance_apply / balance_test)。
 *
 * 安全性靠能力隔离: 工具始终 register, 但默认**不激活**; 由 /usage ai 确认后调用
 * pi.setActiveTools 加入激活集, 模型才会看到。未启用时返回指引文本而非抛错。
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getAdapters, getDescriptors } from "./index.ts";
import { getCustomProviders, setCustomProviders } from "./config.ts";
import {
	applyProviderAction, describeProviders, expandEnvHeaders, probeEndpoint,
	type ProviderDescriptor,
} from "./provider-engine.ts";

/** 本组工具名 (供 /usage ai 激活/停用) */
export const BALANCE_AI_TOOL_NAMES = ["balance_get", "balance_probe", "balance_apply", "balance_test"] as const;

function text(message: string): AgentToolResult<Record<string, never>> {
	return { content: [{ type: "text", text: message }], details: {} };
}

const DISABLED_HINT = "AI 配置模式未启用。请让用户先执行 /usage ai，然后再重试本工具。";

const AuthStrategySchema = Type.Union([
	Type.Object({ type: Type.Literal("bearer") }),
	Type.Object({ type: Type.Literal("header"), name: Type.String(), value: Type.String() }),
	Type.Object({ type: Type.Literal("none") }),
	Type.Object({ type: Type.Literal("jwt-hs256") }),
	Type.Object({ type: Type.Literal("command"), command: Type.String() }),
]);

const BalanceSpecSchema = Type.Object({
	endpoints: Type.Array(Type.String()),
	method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")])),
	body: Type.Optional(Type.String()),
	auth: AuthStrategySchema,
	authFallbacks: Type.Optional(Type.Array(AuthStrategySchema)),
	balancePath: Type.Union([Type.String(), Type.Array(Type.String())]),
	availablePath: Type.Optional(Type.String()),
	toppedUpPath: Type.Optional(Type.String()),
	grantedPath: Type.Optional(Type.String()),
	currency: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const ProviderSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	piProviderId: Type.Optional(Type.String()),
	priceProvider: Type.Optional(Type.String()),
	matchPatterns: Type.Array(Type.String()),
	billingNote: Type.Optional(Type.String()),
	cacheNote: Type.Optional(Type.String()),
	depletionStatuses: Type.Optional(Type.Array(Type.Number())),
	balance: Type.Optional(BalanceSpecSchema),
});

/** balance_* 工具的注册与执行 */
export class ProviderAgentTools {
	private enabled = false;

	/** 切换启用状态 (/usage ai 调用) */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	/** 向 pi 注册全部工具 (不激活) */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "balance_get",
			label: "读取厂商配置现状",
			description: "读取内置预设与自定义厂商的余额查询配置摘要（不含凭证）。添加/修改前先调用它了解现状。",
			promptSnippet: "读取厂商余额配置现状",
			promptGuidelines: ["添加或修改厂商余额查询前，先用 balance_get 看现状与命名习惯。"],
			parameters: Type.Object({}),
			execute: async () => this.guard(() => text(describeProviders(getDescriptors()))),
		});

		pi.registerTool({
			name: "balance_probe",
			label: "探测余额接口",
			description:
				"执行一次 HTTP 请求，返回状态码与响应 JSON（超长截断），用于推断余额字段路径。headers 值中 $VAR 会从环境变量展开（cookie 等秘密用此法，不写进配置）。",
			promptSnippet: "探测厂商余额接口响应",
			promptGuidelines: [
				"先用 balance_probe 看真实响应，再决定 balancePath —— 不要猜字段。",
				"端点未知时请用户从控制台 DevTools 抓 Copy as cURL，不要猜端点。",
				"cookie/密钥用 $ENV 引用，不要写进配置或输出。",
			],
			parameters: Type.Object({
				url: Type.String(),
				method: Type.Optional(Type.String()),
				headers: Type.Optional(Type.Record(Type.String(), Type.String())),
				body: Type.Optional(Type.String()),
			}),
			execute: async (_id: string, params: { url: string; method?: string; headers?: Record<string, string>; body?: string }) =>
				this.guardAsync(async () => {
					const result = await probeEndpoint(params.url, {
						method: params.method,
						headers: expandEnvHeaders(params.headers ?? {}),
						body: params.body,
					});
					const bodyText = result.data === undefined ? result.error : JSON.stringify(result.data);
					const shown = bodyText && bodyText.length > 4000 ? `${bodyText.slice(0, 4000)}…(截断)` : bodyText;
					return text(`HTTP ${result.status ?? "-"} ${result.ok ? "OK" : "FAIL"}\n${shown}`);
				}),
		});

		pi.registerTool({
			name: "balance_apply",
			label: "应用厂商配置改动",
			description: "新增/修改/删除一条自定义厂商（写入 ~/.pi/pi-usager.json 的 customProviders）。",
			promptSnippet: "应用厂商余额配置改动",
			promptGuidelines: [
				"用 balance_apply 写配置，不要直接编辑 ~/.pi/pi-usager.json。",
				"add 时 id 已存在会失败，改用 update；provider.id 必须与 id 一致。",
			],
			parameters: Type.Object({
				action: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("delete")]),
				id: Type.String(),
				provider: Type.Optional(ProviderSchema),
			}),
			execute: async (_id: string, params: { action: "add" | "update" | "delete"; id: string; provider?: ProviderDescriptor }) =>
				this.guard(() => {
					const result = applyProviderAction(getCustomProviders(), {
						type: params.action,
						id: params.id,
						provider: params.provider,
					});
					if (!result.ok) return text(`改动未生效：${result.reason}`);
					setCustomProviders(result.list);
					return text(`${result.message}。当前自定义厂商：\n${describeProviders(result.list)}`);
				}),
		});

		pi.registerTool({
			name: "balance_test",
			label: "试查厂商余额",
			description: "对指定厂商真实执行一次余额查询，返回余额或错误。",
			promptSnippet: "试查厂商余额",
			promptGuidelines: ["balance_apply 之后用 balance_test 验证；失败时按错误原因修正后重试。"],
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id: string, params: { id: string }) =>
				this.guardAsync(async () => {
					const adapter = getAdapters().find((a) => a.id === params.id);
					if (!adapter?.queryBalance) return text(`未找到支持余额查询的厂商 ${params.id}`);
					const result = await adapter.queryBalance();
					return text("error" in result ? `⚠️ ${result.error}` : `✅ ${adapter.name} 余额 ¥${result.total} (${result.currency})`);
				}),
		});
	}

	/** 同步守卫: 未启用返回指引; 其余异常转成结构化失败文本 */
	private guard(run: () => AgentToolResult<Record<string, never>>): AgentToolResult<Record<string, never>> {
		if (!this.enabled) return text(DISABLED_HINT);
		try {
			return run();
		} catch (error) {
			return text(`出错：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** 异步守卫 */
	private async guardAsync(run: () => Promise<AgentToolResult<Record<string, never>>>): Promise<AgentToolResult<Record<string, never>>> {
		if (!this.enabled) return text(DISABLED_HINT);
		try {
			return await run();
		} catch (error) {
			return text(`出错：${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
