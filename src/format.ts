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

/** card 宽度 → 已废弃边框；终端宽度每次实时读 (模块加载时 TUI 可能未就绪)，非 TTY 回退 80 */
export function getTermWidth(): number {
	return process.stdout?.columns ?? 80;
}
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

/**
 * 长说明悬挂缩进换行: 续行与首行内容列对齐 (统一缩进, 不顶格)。
 * 优先在行内最后一个空格/CJK 标点处断行 (不切碎词语); 无断点才按字符断。
 * prefix 为首行前缀 (含缩进), hangIndent 为续行缩进。
 */
const BREAK_CHARS = new Set([" ", "，", "、", "；", "。", "：", "）"]);

export function noteWrap(text: string, prefix: string, hangIndent: string): string[] {
	const out: string[] = [];
	const width = getTermWidth() - 2;
	let line = prefix;
	let cur = visibleWidth(prefix);
	for (const ch of text) {
		const w = visibleWidth(ch);
		if (cur + w > width) {
			// 回退到行内最后一个断点, 断点后的内容挪到续行
			let cut = -1;
			for (let i = line.length - 1; i > hangIndent.length; i--) {
				if (BREAK_CHARS.has(line[i])) { cut = i; break; }
			}
			if (cut > 0) {
				const rest = line.slice(cut + 1).trimStart();
				out.push(line.slice(0, cut + 1).trimEnd());
				line = hangIndent + rest;
				cur = visibleWidth(line);
			} else {
				out.push(line);
				line = hangIndent;
				cur = visibleWidth(hangIndent);
			}
		}
		line += ch;
		cur += visibleWidth(ch);
	}
	out.push(line);
	return out;
}
