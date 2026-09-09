/**
 * /usage 命令输出的文本样式工具
 *
 * ctx.ui.notify 输出为纯文本 (无 Theme 对象), 用 ANSI 256 色直接着色
 * (与 footer 的 CH 紫同款方案); 宽度计算用 pi-tui 的 visibleWidth (ANSI 感知)。
 * 排版约定: ▎竖线 + accent 色做区块标题, 不用 ━━━ 长线; 列对齐用 kv() 按可见宽度补齐;
 * 整块输出用 box() 上下边框包成 card。
 */

import { visibleWidth } from "@earendil-works/pi-tui";

export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
/** 主题蓝近似 (256 色 75) — 与 footer accent 的观感一致 */
export const ACCENT = "\x1b[38;5;75m";
/** 边框灰 (256 色 240) */
export const BORDER = "\x1b[38;5;240m";
/** 紫色 (256 色 141) — CH ≥95% 优秀档 */
export const PURPLE = "\x1b[38;5;141m";

/** card 宽度 (notify 场景拿不到终端宽度, 取安全固定值) */
const BOX_WIDTH = 56;

/** 区块标题: ▎竖线 + accent 色 (替代 ━━━ 长线) */
export function sectionTitle(text: string): string {
	return `${ACCENT}▎ ${text}${RESET}`;
}

/** 次级标题: ▎竖线 + dim 色 (替代 ── … ──) */
export function subTitle(text: string): string {
	return `${DIM}▎ ${text}${RESET}`;
}

/**
 * 标签列对齐: label 按可见宽度补齐到 labelWidth 后接 value。
 * emoji/全角不再导致列错位 (padEnd 按码点数算, 对 CJK/emoji 不准)。
 */
export function kv(label: string, value: string, labelWidth = 18): string {
	const pad = Math.max(1, labelWidth - visibleWidth(label));
	return `${label}${" ".repeat(pad)}${value}`;
}

/** card 上下边框横线 (border 色) */
function rule(): string {
	return `${BORDER}${"─".repeat(BOX_WIDTH)}${RESET}`;
}

/** 整块输出包裹上下边框, 成为一个 card */
export function box(lines: string[]): string[] {
	return [rule(), ...lines, rule()];
}

/**
 * 长说明悬挂缩进换行: 续行与首行内容列对齐 (统一缩进, 不顶格)。
 * prefix 为首行前缀 (含缩进), hangIndent 为续行缩进。
 */
export function noteWrap(text: string, prefix: string, hangIndent: string): string[] {
	const out: string[] = [];
	let line = prefix;
	let cur = visibleWidth(prefix);
	for (const ch of text) {
		const w = visibleWidth(ch);
		if (cur + w > BOX_WIDTH - 2) {
			out.push(line);
			line = hangIndent;
			cur = visibleWidth(hangIndent);
		}
		line += ch;
		cur += w;
	}
	out.push(line);
	return out;
}
