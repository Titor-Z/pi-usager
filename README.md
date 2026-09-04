<div align="center">

# pi-usager

**Usager** (French for "user") — because this plugin turns every Pi Agent user into a privileged holder of real-time cost visibility.

A privileged status bar monitor for Pi Agent — real-time usage & multi-provider balance (GLM + DeepSeek)
为 Pi Agent 打造的特权状态栏监控，实时掌握 GLM/DeepSeek 用量与余额

</div>

---

## ✨ 功能

```
↑130.9k ↓24.5k R1.34M CH91.1% ¥0.0078/¥0.24·限时5折  5.9%/1.00M · low    glm-5.3-flash
```

- **双价格标识**：`¥0.0078/¥0.24` = 此次回答预估价 / 会话累计预估价，每轮对话实时更新
- **Token 流量**：输入 `↑`、输出 `↓`、缓存命中 `R`、缓存命中率 `CH`
- **自动计价切换**：限时折扣（如 GLM-5.3-Flash 5折）到期自动恢复原价；DeepSeek 峰谷价（高峰 ×2）按时段自动切换
- **阶梯定价**：GLM 按输入/输出长度自动匹配对应价格档位
- **多厂商余额**：DeepSeek / GLM 余额直接显示在状态栏
- **交互式配置**：`/usage config` 仿 `/settings` 的向导式凭证配置
- **免费模型**：自动识别并显示 `FREE`

## 📦 安装

```bash
pi install npm:pi-usager
# 或从 GitHub
pi install git:github.com/Titor-Z/pi-usager
```

## 🚀 使用

| 命令 | 说明 |
|---|---|
| `/usage` | 余额 + 当前会话用量总览 |
| `/usage session` | 会话用量明细（含费用明细与最近一次回答费用） |
| `/usage balance` | 仅查账户余额 |
| `/usage footer` | 开关专属状态栏（默认开启） |
| `/usage status` | 状态栏余额显示开关 |
| `/usage peak` | 当前生效的计价变体（峰谷/限时折扣）及切换时间 |
| `/usage config` | 交互式配置厂商凭证、刷新间隔 |

> `/deepseek` 命令保留为向后兼容别名。

### 凭证配置

`/usage config` → 配置厂商凭证，按向导录入。凭证读取优先级：

1. `usage-providers/balance-config.json`（交互式配置产出，勿提交 git）
2. 环境变量（`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `GLM_API_KEY`）
3. pi 的 `~/.pi/agent/auth.json`

GLM 余额推荐 `bearer` 模式（实测可用）；`jwt`（官方 SDK 同款签名）为备用。

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
	billingNote: "按量实时计费",
	cacheNote: "usage.cacheRead 对应其缓存命中统计",
};
```

2. **余额提供者**（可选）在 `balance.ts` 实现 `BalanceProvider`（声明式 `fields` 自动生成 `/usage config` 表单）。
3. **注册**：加入 `index.ts` 的 `ADAPTERS` 与 `balance.ts` 的 `BALANCE_PROVIDERS`。

## 📊 价格来源

价格数据来源于 [bigmodel.cn/pricing](https://bigmodel.cn/pricing)、[DeepSeek 官方定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（2026-09 核验）。

## ⚠️ 免责声明

- 本项目为非官方社区项目，与智谱（Z.ai / BigModel）、DeepSeek 无关联
- 模型价格可能随时调整，实际费用以厂商官方账单为准；计价变体截止时间请以官方公告核对
- GLM 余额接口为控制台内部端点，非官方公开 API，可能随平台版本更新失效
- 计费金额为本地估算，仅供参考

## English

**pi-usager** is a status-bar usage & billing monitor for [Pi Agent](https://pi.dev). It shows per-turn / session cost estimates, token flow, cache hit rate, and account balance for Chinese LLM providers (GLM, DeepSeek) with automatic price-tier and discount switching. Install with `pi install npm:pi-usager`, then type `/usage`. Contributions for new providers are welcome — see the guide above (three small files per provider).

## License

MIT © 2026 Titor-Z
