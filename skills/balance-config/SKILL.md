---
name: balance-config
description: Configure pi-usager's provider balance queries (~/.pi/pi-usager.json customProviders) when a user wants to add or fix a vendor's balance/account display. Use when the user gives an account endpoint, a cURL capture, or says a vendor's balance is unavailable. Requires the user to have run /usage ai first.
disable-model-invocation: true
---

# 厂商余额查询配置（AI 辅助）

帮用户把某厂商的**账户余额查询**接进 pi-usager。厂商支持是数据驱动的：
内置预设（DeepSeek / GLM）开箱即用；其余厂商写一条 `customProviders` 描述即可，无需改代码。

## 前置条件

**必须先让用户执行 `/usage ai` 启用 AI 配置模式**（本次会话内有效）。
未启用时 `balance_*` 工具不在可用工具列表中；若调用返回"未启用"提示，
请明确告诉用户先执行该命令，不要绕过。

## 硬性禁止

- **禁止**用 `edit` / `write` / `bash` 直接修改 `~/.pi/pi-usager.json`。所有改动走 `balance_apply`。
- **禁止猜测**：端点 URL、认证方式、余额字段路径、货币 —— 资料/响应里没有的，问用户或先用 `balance_probe` 探出来。
- **禁止**把 cookie、token 等秘密写进配置。需要秘密时用 `command` 策略 + 环境变量
  （如 `curl -s -H "Cookie: $MIMO_COOKIE" ...`），或 `$VAR` 引用。
- **禁止**在未验证前宣称成功。写完必须 `balance_test` 确认能拿到真实余额。

## 数据模型（一条自定义厂商描述）

| 字段 | 说明 |
|---|---|
| `id` | 内部 id（小写英文，台账/配置的 key） |
| `name` | 显示名 |
| `matchPatterns` | 模型匹配子串，如 `["mimo","xiaomi"]`；声明序即优先级 |
| `piProviderId` | 取密钥用的 pi provider id（auth 为 bearer/header 时）；缺省回退 id |
| `priceProvider` | pi-pricer 价表的 provider key；缺省回退 piProviderId |
| `balance.endpoints` | 余额接口 URL（多个按序尝试） |
| `balance.method` | `GET`（默认）/ `POST` |
| `balance.auth` | 主认证策略（见下） |
| `balance.authFallbacks` | 主认证失败后依次尝试的策略 |
| `balance.balancePath` | 余额字段路径（可多个候选），如 `data.availableBalance` 或 `balance_infos[0].total_balance`；`command` 直接输出数值时留空 |
| `balance.availablePath` | 可用性字段路径（可选，如 `is_available`） |
| `balance.toppedUpPath` / `grantedPath` | 充值 / 赠送字段路径（可选） |
| `balance.currency` | 默认 `CNY` |

### 认证策略

| type | 用途 | 备注 |
|---|---|---|
| `bearer` | 用 pi 中该 provider 的 API Key 作 Bearer | 最干净，优先试 |
| `header` | 自定义请求头，值中 `{{key}}` 替换为 pi 的 Key | 控制台自定义头 |
| `none` | 无需认证 | |
| `jwt-hs256` | 智谱同款 HMAC 签名（key 为 `id.secret`） | |
| `command` | 执行一条命令读 stdout JSON | 兜底：cookie / OAuth / 多次请求 / 怪响应 |

## 工作流

1. **读现状**：`balance_get`。注意已有厂商与命名习惯。
2. **拿到端点**（按优先级）：
   a. 用户提供控制台 DevTools 的 **Copy as cURL**（最准）；
   b. 用 `balance_probe` 试该厂商 API 域的常见余额路径（`/user/balance`、`/balance`、`/dashboard/billing/...`）；
   c. 都没有 → 明确请用户抓包，**不要猜**。
3. **看真实响应**：`balance_probe`（cookie 用 `$ENV` 引用）。从响应里定位余额字段 → `balancePath`。
4. **写配置**：`balance_apply`（`action=add`；已存在用 `update`）。
5. **验证**：`balance_test`。失败按错误修正重试，直至拿到真实余额。
6. **报告**：说明厂商 id、端点、认证方式、余额字段、验证结果。**凭证类信息不要回显**。

## 场景示例

### 一、API Key 直查（最常见）

用户："加一下 MiMo 余额，key 已在 pi 里配好。"

```
balance_probe { url: "https://api.xiaomimimo.com/v1/user/balance", headers: { Authorization: "Bearer $XIAOMI_API_KEY" } }
  → 假设返回 {"data":{"balance":12.3}}

balance_apply { action: "add", id: "mimo", provider: {
  id: "mimo", name: "MiMo", piProviderId: "xiaomi", priceProvider: "xiaomi",
  matchPatterns: ["mimo", "xiaomi"],
  balance: { endpoints: ["https://api.xiaomimimo.com/v1/user/balance"], auth: { type: "bearer" }, balancePath: "data.balance" }
} }

balance_test { id: "mimo" }
```

### 二、网页控制台 cookie（秘密不落配置；MiMo 即此形态）

用户登录控制台后，余额接口要会话 cookie（不是 API key），且各账号 cookie 不同。
把 cookie 存到用户目录下的文件（如 `~/.mimo-cookie`），配置里用 `command` 读取 —— **不写进配置**：

```
balance_apply { action: "add", id: "mimo", provider: {
  id: "mimo", name: "MiMo", piProviderId: "xiaomi", priceProvider: "xiaomi",
  matchPatterns: ["mimo", "xiaomi"],
  balance: {
    endpoints: [],
    auth: { type: "command",
      command: "curl -s 'https://platform.xiaomimimo.com/api/v1/balance' -H \"Cookie: $(cat ~/.mimo-cookie)\" -H 'x-timeZone: Asia/Shanghai'" },
    balancePath: "data.balance",
    toppedUpPath: "data.cashBalance", grantedPath: "data.giftBalance", currency: "CNY"
  }
} }
```

备选：若不想落文件，可把 cookie 放环境变量，用 `header` 策略（值支持 `$VAR` / `${VAR}` 展开）：

```
auth: { type: "header", name: "Cookie", value: "$MIMO_COOKIE" }
```

但本进程要能读到该变量（需在启动 pi 前 `export`），文件方案更耐重启。

### 三、bearer 失败回退签名

GLM 预设即此形态：`auth: bearer` + `authFallbacks: [jwt-hs256]`。

## 出错时怎么办

- `balance_apply` 失败：看清 reason（id 重复用 `update`；`provider.id` 与 `id` 不一致）。
- `balance_test` 报"未匹配到余额字段"：用 `balance_probe` 看真实结构，改 `balancePath`。
- 401/403：认证方式不对（换 `header` / `command`，或检查 pi 是否配置了该 provider）。
- 任何一步不确定，停下来问用户。宁可少改，不可乱改。
