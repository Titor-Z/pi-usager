<div align="center">

# pi-usager

**给每一位在意每一分钱的 Pi 用户 —— 实时掌握 GLM / DeepSeek 的用量、费用与余额。**

**A privileged usage HUD for Pi Agent — real-time usage & multi-provider balance (GLM + DeepSeek).**

</div>

---

## 一、这是什么

pi-usager 是 Pi Agent 的**用量与计费状态栏（HUD）**。它把三件本来要你手动算的事，变成常驻状态栏上的一行实时数字：

1. **这一轮、这个会话花了多少钱** —— 每轮对话结束即时更新
2. **账户还剩多少钱** —— 服务端校准 + 对话间本地估算，双层台账
3. **缓存帮你省了多少** —— 命中 token 与命中率，分档着色

它**不维护任何价格数据**。所有单价来自 [`@foolsecret/pi-pricer`](https://www.npmjs.com/package/@foolsecret/pi-pricer) 提供的**共享价表**（`~/.pi/model-pricing.json`）—— 一次配置，全生态生效。厂商调价、峰谷、节假日、促销，你改一处，pi-usager 立刻按新价算。

## 二、为什么需要它

| 你遇到的 | 没有 pi-usager | 有 pi-usager |
|---|---|---|
| 想知道这轮对话花了多少 | 去平台账单页对账，滞后、跨模型难对齐 | 状态栏实时显示「此次 / 累计」，精确到 4 位小数 |
| 想知道余额够不够 | 手动查、忘了查，欠费了才发现 | 常驻显示，低于阈值变色，欠费自动标记、充值自动恢复 |
| 想知道缓存省了多少 | 只能看原始 token，自己算命中率 | `CH91.1%` 实时命中率，分档着色 |
| 厂商调价 | 每个扩展各自发版更新价表，账对不上 | 改 pi-pricer 一处，所有扩展同一口径 |

## 三、安装

```bash
# 1. 安装共享价表（pi-usager 的计费数据源）
#    必须单独安装为 Pi 扩展 —— pi-usager 不会代你安装
pi extension add @foolsecret/pi-pricer

# 2. 再装 pi-usager
pi extension add @foolsecret/pi-usager

# 3. 核对价格是否与实际付费一致（强烈建议）
/price
```

> **依赖关系（关键）**：pi-usager 强依赖 [`@foolsecret/pi-pricer`](https://www.npmjs.com/package/@foolsecret/pi-pricer) 提供价格数据，
> 且把它声明为**可选 peer 依赖**（不会自动安装）。未安装时用量统计照常，但**费用无法估算**
> （状态栏显示 `价格未知`，并在首次对话时提示安装）。这是设计选择 —— 价表由专职模块统一维护，
> 插件不再各自硬编码，避免多扩展口径不一致。

## 四、状态栏读法

双行布局（默认，对齐 Pi 原生结构）：

```
~/projects/pi-usager (main) +3-5 • my-session   PROMPT auto·normal·deep   💰¥2.12 🦦
↑130.9k ↓24.5k R1.34M CH91.1% ¥0.0078/¥0.24·工作日高峰  5.9%/1.00M   glm-5.3-flash • high
```

### 字段口径

| 字段 | 含义 | 口径说明 |
|---|---|---|
| `~/projects/pi-usager (main)` | 工作目录（`~` 缩写）+ git 分支 | 与 Pi 原生 footer 同款 |
| `+3-5` | git 工作区：`+N` 绿＝已暂存，`-M` 红＝未暂存（含新文件） | 零值段省略，干净则不显示 |
| `• my-session` | 会话名 | 空间不足时最先省略 |
| `PROMPT auto·normal·deep` | pi-prompt 的三轴状态（软检测） | 装 pi-prompt 时出现，位于余额左侧 |
| `↑ / ↓ / R` | 累计输入 / 输出 / 缓存命中 token | 单位 k / M，来源 Pi 上报的 usage |
| `CH91.1%` | 缓存命中率 | `<90%` 常态 → `90~95%` 主题蓝 → `≥95%` 紫 |
| `¥0.0078/¥0.24` | 此次回答 / 会话累计预估费用 | 免费模型显示 `FREE`；无价表显示 `价格未知` |
| `·工作日高峰` | 当前命中的**计价方案名** | 来自 pi-pricer 解析链，非硬编码 |
| `5.9%/1.00M` | 上下文使用率 / 模型窗口 | — |
| `glm-5.3-flash • high` | 模型名 + 思考深度 | 多 provider 时带 `(provider)` 前缀 |
| `💰¥2.12` | 账户余额 | 分档着色，见下 |
| `🦦` / `🕸️` | 平时价 / 时段价 | 命中规则是否含时间窗，由 pi-pricer schedule 决定 |

**余额颜色分档**：`< 告急线`（默认 ¥0.50）红 → `< 提醒线`（默认 ¥1.00）黄 → 其余主题蓝。两条线可在 `/usage config` 调整。

**价格来源四态**（`/usage config → 查看当前配置`）：

| 状态 | 含义 | 提示行为 |
|---|---|---|
| `pi-pricer 共享价表` | 已读取你自己的 `~/.pi/model-pricing.json` | 无提示 |
| `pi-pricer 内置默认价` | 装了 pi-pricer，但价表文件缺失/为空 → **静默回退内置默认价** | 首次对话提示核对 |
| `未安装 pi-pricer` | 未装 → 费用无法估算 | 首次对话提示安装 |
| `不可用` | 已装但解析失败（附原因） | 首次对话提示检查 JSON |

> 特别注意第二态：pi-pricer 在价表文件缺失或损坏时会**静默回退到内置默认价**，
> 且首次启动会写入一份默认值 —— 所以「能算出费用」并不等于「用的是你配置的价」。
> pi-usager 会显式区分这两者，不会假装你的配置已生效。

**翻页动画**（约 3 秒三帧）：旧值静置 → `▼¥-0.0078`（红，扣款）或 `▲¥+10.00`（绿，回充/校准发现上涨）→ 新值高亮 → 落定。

单行布局：第一行为紧凑统计与余额，**第二行放 prompt 状态** —— 横向省空间，prompt 不被挤掉。

## 五、余额机制：校准 + 估算双层台账

余额不是一个数，是两层：

| 层 | 来源 | 特点 |
|---|---|---|
| **校准层**（权威） | 服务端返回值 | 会话启动 / 定时器（默认 5 分钟）/ `/usage balance` / 欠费确认时写入并持久化 |
| **估算层**（过渡） | 每轮实际 token × 当前单价 | 仅存内存，让数字在两次校准之间"活着" |

**显示值 = 上次校准值 − 会话内估算扣减**（不钳零）。

- **启动即显示**：读上次校准的持久化缓存，无需等首次查询
- **允许负数**：红色显示作透支预警。GLM 归 0 即拒、DeepSeek 欠费前可短暂透支，负数均可能真实发生
- **漂移预期**：多会话并发、跨峰谷切换时估算会漂移，由下次校准纠偏。本地估算与服务端真实扣费的微差实测约 `1e-5` 量级，故校准翻页设 0.01 元阈值以过滤伪动画

**欠费判定**（以服务端信号为准，不做猜测）：

| 厂商 | 信号 | 判定方式 |
|---|---|---|
| DeepSeek | HTTP 402 | 无歧义，立即置欠费（2026-09-09 真实欠费账户实测采样） |
| GLM | HTTP 429 | **不可直接判定** —— 429 下有 11 种业务码（欠费/限速/过载…），故延迟 3 秒触发余额查询二次确认 |

缴费后任何一次成功对话或查询都会自动解除欠费态。

## 六、命令

| 命令 | 说明 |
|---|---|
| `/usage` | 余额 + 会话用量总览 |
| `/usage session` | 用量与费用明细（含最近一次回答） |
| `/usage balance` | 立即校准余额 |
| `/usage status` | 开关状态栏余额显示 |
| `/usage peak` | **当前生效价格的完整解析链**（命中/未命中逐条 + 原因） |
| `/usage config` | 配置菜单：厂商凭证 / 校准间隔 / HUD 开关 / 布局 / 余额颜色 / 清除凭证 / 查看配置 |

配置存储于 `~/.pi/pi-usager.json`（含凭证与余额缓存，**勿分享/提交**）。

**改价格请用 pi-pricer 的 `/price` 面板** —— pi-usager 不再提供计价配置入口（v2.0.0 起移交）。

> **从 v1.x 升级**：`/usage config → 自定义计价` 已移除。请在 pi-pricer 的 `/price` 面板中重建等价规则（pi-pricer 支持时段、星期、日历、节假日、促销日、规则有效期，表达力高于旧的自定义计价）。旧配置文件中的 `customPricing` 字段不会被删除，但也不再读取。

## 七、调试

```bash
PI_USAGER_DEBUG=1 pi
```

stderr 输出校准 / 扣减 / 翻页 / 欠费判定 / 价表加载的链路日志。

## 八、厂商支持与已知边界

| 厂商 | 用量统计 | 费用估算 | 余额查询 | 欠费检测 |
|---|---|---|---|---|
| GLM | ✅ | ✅ 由 pi-pricer 定价 | ✅ | ✅ 429 + 余额二次确认 |
| DeepSeek | ✅ | ✅ 由 pi-pricer 定价 | ✅ | ✅ 402 |
| 其他 | ✅ | 需在 pi-pricer 配置 | — | — |

**明确的不确定性声明**（诚实账本原则）：

- 费用为**本地估算**，非平台账单。口径为 `未命中输入 × miss + 缓存命中 × hit + 输出 × output`，与平台账单实测同口径，但可能因厂商口径调整而偏离
- GLM 余额接口为**控制台内部端点**，可能随平台版本更新失效。失效时余额显示异常，请在 issue 中反馈
- pi-pricer 的 `isPeak` 语义是「命中规则含时间窗」，**不是**「此刻是高峰」。故 `🕸️` 表示「当前命中的是时段价规则」—— 是否真为高峰由你在价表中定义的语义决定

## 九、开发

```bash
npm test                # node --test，全部用例
npm test -- --test-name-pattern 峰谷   # 针对性运行
```

架构：`extensions/index.ts` 为薄入口（命令 + 事件接线），业务模块在 `src/`：

| 模块 | 职责 |
|---|---|
| `pricing-source.ts` | pi-pricer 集成：加载解析器、三态暴露（`pi-pricer`/`missing`/`failed`） |
| `cost.ts` | 取价 → 费用换算、会话用量汇总、格式化 |
| `ledger.ts` | 双层余额台账（校准 + 估算） |
| `balance.ts` | 各厂商余额查询（声明式 fields） |
| `glm.ts` / `deepseek.ts` | 厂商身份（matchModel）+ 余额委托 + 欠费码声明 |
| `config.ts` / `format.ts` | 配置读写 / 输出排版 |

**新增厂商**：新建 `src/xxx.ts` 实现 `ProviderAdapter`（`matchModel` + 可选 `queryBalance` + 可选 `depletionStatuses`），加入 `src/index.ts` 的 `ADAPTERS`。**价格不用写** —— 在 pi-pricer 里配。

## 十、许可

**AGPL-3.0-only**（与姊妹项目 pi-pricer 一致）。

本项目为非官方社区项目，与智谱（Z.ai / BigModel）、DeepSeek 无关联。模型价格可能随时调整，计费金额为本地估算，仅供参考。

## English

**pi-usager** is a usage & billing HUD for Pi Agent. It renders, live in the status bar: per-turn and cumulative cost estimates, token flow, cache hit rate, and account balance for GLM and DeepSeek.

It holds **no price data of its own** — all unit prices come from the shared price table provided by [`@foolsecret/pi-pricer`](https://www.npmjs.com/package/@foolsecret/pi-pricer) (`~/.pi/model-pricing.json`), so updating a price in one place updates every extension that bills.

Highlights: a two-layer balance ledger (authoritative server calibration persisted so the balance shows instantly on launch, plus per-turn local estimation with a ~3s flip-clock animation); depletion detection from unambiguous server signals (DeepSeek HTTP 402; GLM 429 confirmed via a balance re-query, because 429 carries 11 distinct business codes); peak/off-peak price marking driven entirely by your own `schedule` rules in pi-pricer; and a dual-line footer matching Pi's native layout, with single-line mode available (prompt status moves to a second row).

Install: `pi extension add @foolsecret/pi-pricer`, then `pi extension add @foolsecret/pi-usager`, then type `/usage`. Prices are estimates, not invoices.

## License

AGPL-3.0-only © 2026 Titor-Z

---

**Star 🌟 这个项目，让更多 Pi 用户看见他们的每一分钱花在了哪里。**
