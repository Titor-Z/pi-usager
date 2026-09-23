/**
 * 凭证解析入口
 *
 * 厂商 API key 统一来自 pi 凭证层, 由扩展层注入解析器
 * (extensions/index.ts 于 session_start 绑定 ctx.modelRegistry.getApiKeyForProvider)。
 * 本插件不存储任何厂商凭证。
 */

type ApiKeyResolver = (piProviderId: string) => Promise<string | undefined>;

let apiKeyResolver: ApiKeyResolver = async () => undefined;

/** 注入 pi 凭证层解析器 */
export function setApiKeyResolver(resolver: ApiKeyResolver): void {
	apiKeyResolver = resolver;
}

/** 解析 pi 凭证层中某 provider 的 apiKey (未配置返回 undefined) */
export async function resolveApiKey(piProviderId: string): Promise<string | undefined> {
	return apiKeyResolver(piProviderId);
}
