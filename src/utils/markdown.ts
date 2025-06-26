// src/utils/markdown.ts

// --- 正则表达式常量 ---
// 将正则表达式的构建提升到模块级别，避免在函数调用时重复创建
const MARKDOWN_V2_RESERVED_CHARS = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
const MARKDOWN_V2_ESCAPE_REGEX = new RegExp(`([${MARKDOWN_V2_RESERVED_CHARS.map((char) => '\\' + char).join('')}])`, 'g');

/**
 * 转义 MarkdownV2 的特殊字符
 * @param text 要转义的文本
 */
export function escapeMarkdownV2(text: string): string {
	return text.replace(MARKDOWN_V2_ESCAPE_REGEX, '\\$1');
}

/**
 * 将数字转换为上标数字
 * @param {number} num - 要转换的数字
 * @returns {string} 上标形式的数字
 */
export function toSuperscript(num: number): string {
	const superscripts: { [key: string]: string } = {
		'0': '⁰',
		'1': '¹',
		'2': '²',
		'3': '³',
		'4': '⁴',
		'5': '⁵',
		'6': '⁶',
		'7': '⁷',
		'8': '⁸',
		'9': '⁹',
	};
	return num
		.toString()
		.split('')
		.map((digit) => superscripts[digit])
		.join('');
}

/**
 * 处理 Markdown 文本中的重复链接，将其转换为带上标的引用格式。
 * 例如，将多个相同的 `[http://a.com](http://a.com)` 转换为 `[引用¹](http://a.com)`。
 *
 * @param {string} text - 输入的 Markdown 文本。
 * @param {object} options - 配置选项。
 * @param {string} [options.prefix='引用'] - 链接文本的前缀。
 * @param {boolean} [options.useEnglish=false] - 是否使用英文格式（如 "link¹"）而不是中文("链接¹")，。
 * @returns {string} 处理后的 Markdown 文本。
 */
export function processMarkdownLinks(
	text: string,
	options: { prefix: string; useEnglish: boolean } = {
		prefix: '引用',
		useEnglish: false,
	},
): string {
	const { prefix, useEnglish } = options;
	// 用于存储已经出现过的链接
	const linkMap = new Map<string, number>();
	let linkCounter = 1;
	// 匹配 markdown 链接的正则表达式
	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

	return text.replace(linkPattern, (match, displayText, url) => {
		// 只处理显示文本和 URL 完全相同的情况
		if (displayText !== url) {
			return match;
		}
		// 如果这个 URL 已经出现过，使用已存在的编号
		if (!linkMap.has(url)) {
			linkMap.set(url, linkCounter++);
		}
		const linkNumber = linkMap.get(url)!;
		// 根据选项决定使用中文还是英文格式
		const linkPrefix = useEnglish ? 'link' : prefix;
		// 返回新的格式 [链接1](原URL) 或 [link1](原URL)
		return `[${linkPrefix}${toSuperscript(linkNumber)}](${url})`;
	});
}

/** 将文本折叠成可展开的 Markdown 格式
 * 将长文本折叠成 Telegram 支持的 MarkdownV2 可展开/隐藏格式。
 * 这种格式要求以 `**>` 开始，以 `||` 结束，且内部所有行都以 `>` 作为前缀。
 * @param text 要折叠的文本
 * @returns 格式化后的字符串
 */
export function foldText(text: string): string {
	return '**>' + text.replace(/\n/g, '\n>') + '||';
}
