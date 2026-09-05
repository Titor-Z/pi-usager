<div align="center">

# pi-usager

**Usager**（法语“使用者”）—— 给每一位在意每一分钱的 Pi 用户。

实时监控 GLM / DeepSeek 的用量、费用与余额，`/usage` 即见分晓。

**A privileged status bar monitor for Pi Agent — real-time usage & multi-provider balance (GLM + DeepSeek).**

</div>

---

## ✨ 它是什么？

一条状态栏，让你在 Pi Agent 中随时看到：

```
↑130.9k ↓24.5k R1.34M CH91.1% ¥0.0078/¥0.24·限时5折  5.9%/1.00M · low    glm-5.3-flash
```

每次对话花了多少钱、这个会话累计花了多少钱、缓存帮你省了多少 —— 一目了然。

### 状态栏字段说明

| 字段 | 含义 |
|---|---|
| `↑130.9k` / `↓24.5k` | 累计输入 / 输出 Token |
| `R1.34M` | 累计缓存命中 Token |
| `CH91.1%` | 缓存命中率 |
| `¥0.0078/¥0.24` | 此次回答预估价 / 会话累计预估价 |
| `·限时5折` | 当前计价档位标记（限时折扣等） |
| `5.9%/1.00M` | 上下文使用率 / 模型窗口 |
| `·low` | 思考深度 |
| `💰¥2.12` | 账户余额（按厂商支持情况显示） |

价格档位、限时折扣、峰谷计费自动切换，无需手动干预。

## 📦 安装

```bash
pi install npm:@foolsecret/pi-usager
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

> 另有交互式配置：`/usage config`（凭证、刷新间隔）。配置存储于 `~/.pi/pi-usager.json`（含凭证，勿分享）。

## 🔧 添加新厂商（欢迎 PR！）

三步接入（以 Mimo 为例）：

1. **定价适配器** `src/mimo.ts`：

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
3. **注册**：加入 `src/index.ts` 与 `src/balance.ts` 的注册表。

## 🧩 厂商支持

| 厂商 | 费用统计 | 余额查询 | 计价档位 |
|---|---|---|---|
| GLM | ✅ | ✅ | 阶梯定价 + 限时折扣 |
| DeepSeek | ✅ | ✅ | 峰谷定价 |

更多厂商正在适配中（Mimo 等欢迎 PR，见下方指南）。

## ⚠️ 免责声明

- 本项目为非官方社区项目，与智谱（Z.ai / BigModel）、DeepSeek 无关联
- 模型价格可能随时调整，计费金额为本地估算，仅供参考
- GLM 余额接口为控制台内部端点，可能随平台版本更新失效

## English

**pi-usager** is a status-bar usage & billing monitor for Pi Agent. It shows per-turn / session cost estimates, token flow, cache hit rate, and account balance for GLM and DeepSeek, with automatic price-tier and discount switching. Install with `pi install npm:@foolsecret/pi-usager`, then type `/usage`. New providers are welcome — three small files per provider, see the guide above.

## License

MIT © 2026 Titor-Z

---

**Star 🌟 这个项目，让更多 Pi 用户看见他们的每一分钱花在了哪里。**
