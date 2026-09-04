<div align="center">

# pi-usager

**Usager**（法语"使用者"）—— 这个插件让每一位 Pi Agent 用户成为实时费用可视化的特权持有者。

为 Pi Agent 打造的特权状态栏监控 — 实时掌握 GLM/DeepSeek 用量、费用与余额
A privileged status bar monitor for Pi Agent — real-time usage & multi-provider balance (GLM + DeepSeek)

</div>

---

## ✨ 它是什么？

一条状态栏，让你在 Pi Agent 中随时看到：

```
↑130.9k ↓24.5k R1.34M CH91.1% ¥0.0078/¥0.24·限时5折  5.9%/1.00M · low    glm-5.3-flash
```

每次对话花了多少钱、这个会话累计花了多少钱、缓存帮你省了多少 —— 一目了然。支持 GLM 与 DeepSeek，价格档位、限时折扣、峰谷计费自动切换。

## 📦 安装

```bash
pi install npm:pi-usager
# 或从 GitHub
pi install git:github.com/Titor-Z/pi-usager
```

## 🚀 使用

输入 `/usage` 即可。全部子命令：

| 命令 | 说明 |
|---|---|
| `/usage` | 余额 + 会话用量总览 |
| `/usage session` | 用量与费用明细 |
| `/usage balance` | 账户余额 |
| `/usage footer` | 开关状态栏（默认开启） |
| `/usage peak` | 当前计价档位及切换时间 |
| `/usage config` | 交互式配置厂商凭证 |

> 另有交互式配置：`/usage config`（凭证、刷新间隔）。

## 🔧 添加新厂商（欢迎 PR！）

三步接入（以 Mimo 为例）：

1. **定价适配器** `extensions/usage-providers/mimo.ts`：

```typescript
import type { ProviderAdapter } from "./types.ts";

export const mimoAdapter: ProviderAdapter = {
	id: "mimo",
	name: "Mimo",
	currency: "CNY",
	matchModel: (id) => !!id && id.toLowerCase().includes("mimo"),
	hasPeakPricing: false,
	pricing: {
		"mimo-pro": { tiers: [{ variants: [{ label: "标准价", default: true,
			prices: { inputCacheHit: 0.5, inputCacheMiss: 2, output: 8 } }] }] },
	},
};
```

2. **余额提供者**（可选）在 `balance.ts` 实现 `BalanceProvider`。
3. **注册**：加入 `index.ts` 与 `balance.ts` 的注册表。

## ⚠️ 免责声明

- 本项目为非官方社区项目，与智谱（Z.ai / BigModel）、DeepSeek 无关联
- 模型价格可能随时调整，计费金额为本地估算，仅供参考
- GLM 余额接口为控制台内部端点，可能随平台版本更新失效

## English

**pi-usager** is a status-bar usage & billing monitor for Pi Agent. It shows per-turn / session cost estimates, token flow, cache hit rate, and account balance for GLM and DeepSeek, with automatic price-tier and discount switching. Install with `pi install npm:pi-usager`, then type `/usage`. New providers are welcome — three small files per provider, see the guide above.

## License

MIT © 2026 Titor-Z
