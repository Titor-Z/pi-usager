---
version: alpha
name: pi-usager 自定义计价抽屉（已废弃）
description: "⚠️ 已废弃（v2.0.0，2026-09-11）：自定义计价已整体移交 @foolsecret/pi-pricer 的 /price 面板，本文件仅作历史存档与 TUI 抽屉模块范式参考。价格数据不再由 pi-usager 维护。"
colors:
  accent: accent
  border-accent: borderAccent
  error: error
  dim: dim
omitted:
  - section: typography
    reason: "终端 TUI：字体随用户终端主题，不设定字体族，继承 pi Theme"
  - section: spacing
    reason: "行距/缩进由 DrawerShell/SettingsList 布局决定，不额外定义网格"
  - section: rounded
    reason: "终端无圆角；边框为整框线"
  - section: elevation
    reason: "TUI 抽屉用边框分隔层级，不用阴影"
  - section: shapes
    reason: "矩形全框，无形状语言"
components:
  config-drawer:
    shellBorder: "{colors.border-accent}"
    titleText: "{colors.accent}"
    titleWeight: bold
    dirtyMark: "标题右侧 ● 未保存 / ○ 已保存"
    maxVisibleRows: 12
    descriptionBar: "选中行的 description 渲染在快捷键栏上方，随光标切换"
    shortcutBar: "Ctrl+S 保存全部草稿（导航键说明由 SettingsList 自带提示行给出）"
---

# pi-usager 自定义计价抽屉（已废弃）

> **⚠️ 本设计已废弃（v2.0.0，2026-09-11）。**
>
> 原因：价格数据已统一移交 [`@foolsecret/pi-pricer`](https://www.npmjs.com/package/@foolsecret/pi-pricer)
> 的 `/price` 面板维护，pi-usager 不再内置任何价表与计价配置入口。
> 相关代码（`src/pricing-form/`）已删除。
>
> **本文保留的两个用途**：① 历史存档，说明为何当初那样设计；
> ② 作为 TUI 抽屉组件（全屏 DynamicBorder + SettingsList + 草稿-提交）的
> **通用模块切分范式**参考 —— 该范式已由 pi-pricer 承接，供其他延伸项目沿用。
>
> 下文描述的行为与模块结构**不再对应本仓库现有代码**。

厂商随时可能调价，而插件版本不可能跟着涨价。自定义计价就是把这个控制权交给
用户：你在抽屉里录入模型匹配串和三档价格，保存后从下一轮对话起，费用就按你的
价格计算。本设计系统规定这个抽屉长什么样、怎么操作、代码如何分层，目标只有
一个——**让人敢改、看得懂、改错能退**。

抽屉的交互范式复刻 pi 自带的 `/settings`：全屏、上下两条彩色边框、一眼看清
所有可改项、光标所在行实时解释"这一项是什么"。区别在于本抽屉采用
**草稿-提交模型**：所有修改先留在草稿里，按 `Ctrl+S` 才一次性写入配置文件。
这样用户可以放心地连续调整多条规则，不必担心改一半就已经生效。

## Overview

产品人格是**克制而可靠**：一个全宽抽屉，顶部说明"这是什么设置"，底部固定
快捷键栏说明"能做什么、改完怎么保存"。信息密度高、零装饰、层级分明。

情绪响应：可预期、可反悔。任何时候标题右侧的 `● 未保存` 都在提醒"还有改动
没有落盘"；按 `Ctrl+S` 后变成 `○ 已保存` 并弹出确认提示。用户不必记住自己
改过什么，只需要记住一个动作。

## Colors

抽屉不引入新色板，全部运行时取自当前 pi Theme 的命名槽位，随用户主题变化。

- **Accent（accent）**：唯一强调色。标题、光标行、当前值用 accent 加粗，传达
  "这里是可操作项"。
- **Border Accent（borderAccent）**：上下两条全宽 DynamicBorder 边框。用
  border 系强调色，使抽屉在聊天流中像一个自洽的"卡片"。
- **Error（error）**：输入校验失败的就地提示色（如价格不是数字）。
- **Dim（dim）**：说明栏、快捷键栏等次要信息。

规则：不自定义 hex；不在组件里写死颜色；值一律由扩展在运行时
`theme.fg("accent", …)` 取用。

## Components

- **Shell（上下 DynamicBorder）**：顶部边框 = 进入提示，底部边框 = 收束。
- **标题 Text**：左上角 `accent + bold`，形如 `▎ 自定义计价 · DeepSeek`；
  右侧或同一行显示脏标记 `● 未保存` / `○ 已保存`。
- **SettingsList**：设置项列表，`enableSearch: true`。行数据结构：
  - `id`：机器标识（如 `rule:0`、`base:output`、`day:3`）
  - `label`：人类可读名（"基础·输出价 (¥/M)"）
  - `currentValue`：当前值（渲染在行尾）
  - `values`：档位候选（如 `关/开`）；有 `submenu` 的项按 Enter 进入子屏
  - `description`：该行说明栏文案，光标到即显示
- **说明栏（description）**：渲染在快捷键栏上方，随选中行切换。每行只回答
  一个问题——"这一项是什么、改了会怎样"。
- **快捷键栏（shortcutBar）**：固定在底部边框内侧，写明本屏可用快捷键。
- **输入屏（TextFieldInput）**：独立抽屉子屏，上下边框 + 字段标题 + 真预填
  输入行（光标落在末尾）+ 校验错误行 + 快捷键栏。

## Interaction

- **键盘**：`↑/↓` 移动光标；`Enter/Space` 进入子屏或循环档位；`Esc` 返回上一层；
  直接键入文本即搜索过滤；`Ctrl+S` 保存全部草稿并落盘。
- **草稿-提交模型**：所有编辑（新增规则、删除规则、改价格、改时段）只修改内存
  草稿，不写文件。标题右侧 `●` 表示有未保存改动。`Ctrl+S` 一次性写入并在
  底部提示"已保存"。这是低风险可反悔的操作——改错了继续改，或直接 Esc 退出
  放弃。
- **输入交互**：进入文本字段时输入框内已经是当前值，光标在末尾，可直接追加
  或退格修改；按 `Enter` 应用本次修改（失败则就地报错并留在输入态），
  `Esc` 取消本次修改。
- **无 TUI 回退**：非交互模式无法打开抽屉，必须退化为文字提示，保证命令面
  在任何运行模式都可用。

## Module Design

抽屉按"纯函数层 / 表现层 / 接线层"三层切分，是可复用部件模板：

- **纯函数层（logic.ts）**：解析与校验（`parseWindows`、`validatePrice`、
  `validateWindows`）与 id 分发（`resolveItemRef`）。不 import 任何 TUI 依赖，
  node 单测直接断言；`resolveItemRef` 是 id→语义的唯一分发点，非法 id 返回 null。
- **表现层（drawer.ts）**：`DrawerShell`（模板方法，固定边框/标题/说明栏/快捷键栏
  骨架）、`TextFieldInput`（输入屏，组合字段编辑策略）、`SettingItemFactory`
  （工厂方法，生成带 description 的设置项）。表现层只负责渲染与转发，不读写配置。
- **接线层（index.ts）**：`PricingFormController`（Facade）。持有草稿、负责深拷贝、
  提交与放弃、调用配置读写；对表现层只暴露回调。配置读写全部钉在这一层。

设计模式落点：模板方法（DrawerShell）、策略（字段编辑策略）、工厂方法
（SettingItemFactory）、观察者（FormHooks.onCommit）、Facade（PricingFormController）。

## Do's and Don'ts

- Do 所有编辑只改草稿，只有 `Ctrl+S` 才落盘
- Do 标题实时显示 `● 未保存 / ○ 已保存`，让"是否已保存"始终可见
- Do 每行 description 只说一句后果，快捷键栏只说本屏能按什么
- Do 字段编辑真预填、光标落尾、非法输入就地提示
- Do 抽取公共方法，方便未来打包成工具包
- Don't 在组件里硬编码颜色（取 theme 槽位）
- Don't 让表现层直接读写配置文件（接线层负责）
- Don't 用多层嵌套 if-else 处理分发（用 switch / 早返回）
- Don't 手写内部 .d.ts：业务源码类型即真相，发布工具时才用
  `tsc --emitDeclarationOnly` 生成
