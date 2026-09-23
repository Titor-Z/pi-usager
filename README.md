# pi-usager

**Pi Agent 的用量与计费状态栏** —— 实时显示每轮 / 会话费用、token 与缓存命中率，
以及 GLM / DeepSeek 账户余额。

*Usage & billing HUD for Pi Agent — real-time cost, token & cache stats, and multi-provider balance.*

pi-usager **不维护任何价格数据**。所有单价来自
[`@foolsecret/pi-pricer`](https://www.npmjs.com/package/@foolsecret/pi-pricer) 的共享价表
（`~/.pi/model-pricing.json`），改一处即全生态生效。

---

## 安装

```bash
pi extension add @foolsecret/pi-pricer   # 价格数据源，需单独安装
pi extension add @foolsecret/pi-usager
/price                                   # 建议：核对价格与你的实际付费一致
```

pi-pricer 声明为**可选 peer 依赖**，不会自动安装。未安装时用量统计照常，但费用显示 `价格未知`，
并在首次对话时提示。

**版本要求**：需 pi-pricer **≥ 0.15.0**（Schema v5）。旧版价表（`version ≠ 5`）会被 pi-pricer 忽略，
pi-usager 会提示「内置默认价」而非假装你的配置已生效。

## 状态栏

```
~/projects/pi-usager@main +3-5 • my-session   auto∙normal∙deep   💰¥2.12 🦦
↑130.9k ↓24.5k R1.34M CH89.4%·95.1% ¥0.0078/¥0.24·工作日高峰  5.9%/1.00M   glm-5.3-flash • high
```

| 字段 | 含义 |
| --- | --- |
| `~/projects/pi-usager@main` | 工作目录 + git 分支（`+N` 已暂存 / `-M` 未暂存） |
| `• my-session` | 会话名（空间不足时最先省略） |
| `auto∙normal∙deep` | pi-prompt 三轴状态（仅装了 pi-prompt 时出现） |
| `↑ / ↓ / R` | 累计输入 / 输出 / 缓存命中 token |
| `CH89.4%·95.1%` | 缓存命中率（**本次** · **会话平均**），分档着色 |
| `¥0.0078/¥0.24` | 此次回答 / 会话累计预估费用（免费模型显示 `FREE`） |
| `·工作日高峰` | 当前命中的计价方案（别名优先），来自 pi-pricer |
| `5.9%/1.00M` | 上下文使用率 / 模型窗口 |
| `glm-5.3-flash • high` | 模型名 + 思考深度 |
| `💰¥2.12` | 账户余额 |
| `🦦 / 🕸️` | 命中兜底价 / 时段价规则 |

余额颜色分档：低于告急线（默认 ¥0.50）红 → 低于提醒线（默认 ¥1.00）黄 → 其余主题蓝；
阈值在 `/usage config` 调整。单行布局把 prompt 状态移到第二行，横向更省空间。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/usage` | 余额 + 会话用量总览 |
| `/usage session` | 用量与费用明细 |
| `/usage balance` | 立即校准余额 |
| `/usage status` | 开关状态栏余额显示 |
| `/usage peak` | 当前方案结构：方案 / 规则 / 命中链 |
| `/usage config` | 配置：校准间隔 / HUD 开关 / 布局 / 余额颜色 / 厂商管理 / 查看配置 |

配置存于 `~/.pi/pi-usager.json`（余额缓存等，**勿分享或提交**）；厂商凭证不在此维护，
统一取自 pi 的凭证层（见下节）。
修改价格请用 pi-pricer 的 `/price`，pi-usager 不提供计价配置入口。

## 余额机制

余额分两层：

| 层 | 来源 | 说明 |
| --- | --- | --- |
| 校准层（权威） | 服务端返回值 | 会话启动、定时器（默认 5 分钟）、`/usage balance` 时写入并持久化 |
| 估算层（过渡） | 每轮实际 token × 当前单价 | 仅存内存，供两次校准之间显示 |

显示值 = 上次校准值 − 会话内估算扣减（不钳零；负数为透支预警）。
欠费判定以服务端信号为准：DeepSeek `HTTP 402` 直接判定；GLM `429` 下含多种业务码，
需经余额查询二次确认。任何一次成功对话或查询后自动解除欠费态。

费用为**本地估算**，非平台账单；GLM 余额接口为控制台端点，可能随平台更新失效。

## 凭证来源

余额查询需要厂商 API Key。pi-usager **不自行保存凭证**，统一从 pi 的凭证层读取
（`ctx.modelRegistry.getApiKeyForProvider`，覆盖 `~/.pi/agent/auth.json`、`models.json`
的 `$ENV` 插值 / `!command`，以及 OAuth 令牌自动刷新）。在 pi 里配置一次即可：

```bash
/login   # 或在 pi 内选择 provider 登录 / 填入 API Key
```

DeepSeek 与 GLM（pi 的 provider id 为 `zai`）的密钥均由此提供，pi-usager 不再二次录入。

## 添加厂商

厂商支持是**数据驱动**的，新增厂商**不需要写代码**：

- **AI 辅助（荐）**：`/usage ai` 激活 `balance_*` 工具后，说「帮我加 XX 厂商余额」即可；
  agent 会探测接口、写入 `customProviders` 并试查验证 —— 你只需提供端点或一段控制台 cURL。
  详细配方在惰性加载的 skill `balance-config`（**不占默认上下文**，可用 `/skill:balance-config` 显式加载）。
- **内置预设**：GLM、DeepSeek 开箱即用。启用/停用、试查余额在 `/usage config → 厂商管理`。
- **自定义厂商**：同处选「➕ 添加自定义厂商」，填 名称 / 模型匹配串 / 余额接口 URL /
  认证方式 / 余额字段路径 即可。支持五种认证：
  - `bearer` —— 用 pi 中该 provider 的 API Key
  - `header` —— 自定义请求头，值中 `{{key}}` 会替换为 pi 的 Key
  - `none` —— 无需认证
  - `jwt-hs256` —— 智谱同款 HMAC 签名（Key 需为 `id.secret` 格式）
  - `command` —— 高级兜底：执行一条命令读 stdout JSON，覆盖声明式表达不了的认证/响应
- **价格**：仍由 pi-pricer 的 `/price` 配置，与厂商无关。
- **凭证**：自定义厂商用 `bearer`/`header` 时，填的 `pi provider id` 指向 pi 已配置的
  provider，密钥由 pi 凭证层提供，不落盘。

自定义厂商写入 `~/.pi/pi-usager.json` 的 `customProviders`，也可直接手改该字段。

## 调试

```bash
PI_USAGER_DEBUG=1 pi    # stderr 输出校准 / 扣减 / 翻页 / 欠费 / 价表加载日志
```

## 厂商支持

| 厂商 | 用量 | 费用 | 余额 | 欠费检测 |
| --- | --- | --- | --- | --- |
| GLM | ✅ | 由 pi-pricer 定价 | ✅ | ✅ `429` + 余额二次确认 |
| DeepSeek | ✅ | 由 pi-pricer 定价 | ✅ | ✅ `402` |
| 其他（含 MiMo） | ✅ | 需在 pi-pricer 配置 | 可自行接入 * | — |

\* 无公开余额 API 的厂商（如 MiMo）可用 `/usage config → 厂商管理` 或 `/usage ai` + skill 接入，
见上文「添加厂商」。

## 兼容性

- 需 pi-pricer **≥ 0.15.0**（Schema v5）。
- 从 v1.x 升级：`/usage config → 自定义计价` 已移除，请在 pi-pricer 的 `/price` 面板重建等价规则。

## License

AGPL-3.0-only。本项目为非官方社区项目，与智谱（Z.ai / BigModel）、DeepSeek 无关联。

---

## English

`pi-usager` is a usage & billing HUD for Pi Agent. It renders live in the status bar: per-turn and
cumulative cost estimates, token flow, cache hit rate, and GLM / DeepSeek account balance.

It holds no price data of its own — unit prices come from the shared price table provided by
[`@foolsecret/pi-pricer`](https://www.npmjs.com/package/@foolsecret/pi-pricer). Install pi-pricer first
(≥ 0.15.0), then pi-usager. Costs are local estimates, not invoices.
