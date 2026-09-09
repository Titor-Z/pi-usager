<div align="center">

# pi-usager

**pi-usager**（法语“使用者”）—— 给每一位在意每一分钱的 Pi 用户。

实时监控 GLM / DeepSeek 的用量、费用与余额，`/usage` 即见分晓。

**A privileged usage HUD for Pi Agent — real-time usage & multi-provider balance (GLM + DeepSeek).**

</div>

---

## ✨ 它是什么？

一条状态栏（双行，对齐 pi 0.85.1 原生布局），让你在 Pi Agent 中随时看到：

```
~/projects/pi-usager (main) +3-5 • my-session                💰¥2.12 🦦
↑130.9k ↓24.5k R1.34M CH91.1% ¥0.0078/¥0.24·限时5折  5.9%/1.00M  glm-5.3-flash
```

每次对话花了多少钱、这个会话累计花了多少钱、缓存帮你省了多少 —— 一目了然。

### 状态栏字段说明

| 字段 | 含义 |
|---|---|
| `~/projects/pi-usager (main)` | 工作目录（~ 缩写）+ git 分支（原生同款首行） |
| `+3-5` | git 工作区状态：`+N` 绿 = 已暂存变更，`-M` 红 = 未暂存变更（含新文件）；零段省略，干净则不显示 |
| `• my-session` | 会话名（空间不足时最先省略） |
| `↑130.9k` / `↓24.5k` | 累计输入 / 输出 Token |
| `R1.34M` | 累计缓存命中 Token |
| `CH91.1%` | 缓存命中率 |
| `¥0.0078/¥0.24` | 此次回答预估价 / 会话累计预估价 |
| 余额分档色 | < ¥0.50 红（告急，可配置）→ < ¥1.00 黄（提醒，可配置）→ 其余绿（充裕）；`/usage hud` 第 ③ 项可改两条线 |
| `·限时5折` | 当前计价档位标记（限时折扣等） |
| `5.9%/1.00M` | 上下文使用率 / 模型窗口 |
| `glm-5.3-flash • high` | 模型名 + 思考深度（行尾右对齐，与原生一致） |
| `💰¥2.12` | 账户余额（首行右侧，按厂商支持情况显示） |
| `▼¥-0.0078` → `💰¥2.11` | 余额翻页动画（~3s 三帧：旧值静置 → 红色 ▼ 扣款帧 → 新值高亮 → 落定） |
| `▲¥+10.00` | 余额校准发现回充（如充值）时的绿色翻页动画；校准发现下跌同样有 ▼ 红色翻页 |
| `💰-¥0.02`（红色） | 估算透支预警：两次校准间本地扣减超过已知余额 |
| `⚠️欠费` | 服务端判定欠费（DeepSeek 402 / GLM 429+余额确认），缴费后下次对话自动恢复 |

价格档位、限时折扣、峰谷计费自动切换，无需手动干预。

### 余额机制：校准 + 估算双层台账

余额显示采用本地台账，分两层：

- **校准（权威）**：会话启动、定时器（默认 5 分钟）、手动 `/usage balance`、欠费确认——以服务端返回值覆盖本地并持久化到 `~/.pi/pi-usager.json`，因此**启动 pi 时余额立即显示**（读上次校准的缓存），无需等首次查询
- **估算（过渡）**：每轮对话完成后按实际 token 用量本地扣减（翻页动画同步展示），两次校准间让数字实时"活着"；多会话并发、计价档位切换等场景可能有微小漂移，由下次校准纠偏

估算扣减允许显示为负数（红色），作为透支预警——GLM 归 0 即拒、DeepSeek 欠费前可短暂透支，负数均有可能真实发生。欠费判定以服务端信号为准：DeepSeek 返回 HTTP 402（实测）即清零；GLM 归 0 后请求被拒（HTTP 429 业务码 1113），插件会延迟触发余额查询二次确认。缴费后任何一次成功对话/查询都会自动解除欠费态。

## 🐛 调试

设置环境变量 `PI_USAGER_DEBUG=1` 后启动 pi，stderr 会输出校准/扣减/翻页/欠费判定的链路日志，便于排查问题：

```bash
PI_USAGER_DEBUG=1 pi
```

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
| `/usage hud` | HUD 显示设置抽屉（开关/布局双行⭐/单行）；`on\|off` 直接开关 |
| `/usage peak` | 当前计价档位及切换时间 |
| `/usage config` | 交互式配置厂商凭证 |

> 另有交互式配置：`/usage config`（凭证、校准间隔）。配置存储于 `~/.pi/pi-usager.json`（含凭证与余额缓存，勿分享）。

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

**pi-usager** is a usage & billing HUD for Pi Agent. It shows per-turn / session cost estimates, token flow, cache hit rate, and account balance for GLM and DeepSeek, with automatic price-tier and discount switching. The balance uses a two-layer local ledger: authoritative server calibration (on startup / timer / manual query, persisted so the balance shows instantly on launch) plus per-turn local deduction with a flip-clock animation (~3s: old value → red ▼ spend frame → new value highlight, green ▲ for top-ups and calibration changes); depletion is detected from server signals (DeepSeek HTTP 402, GLM 429 + balance re-check) and recovers automatically after recharge. The HUD footer is dual-line, matching pi 0.85.1's native layout. Install with `pi install npm:@foolsecret/pi-usager`, then type `/usage`. New providers are welcome — three small files per provider, see the guide above.

## License

MIT © 2026 Titor-Z

---

**Star 🌟 这个项目，让更多 Pi 用户看见他们的每一分钱花在了哪里。**
