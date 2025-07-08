// src/utils/telegram.ts

import type { TelegramMessage } from '@codebam/cf-workers-telegram-bot';
import { escapeMarkdownV2 } from './markdown';

/**
 * 生成消息的永久链接，适应私有群ID（如-987654321）。
 * @param r 包含 groupId 和 messageId 的对象
 */
export function getMessageLink(r: { groupId: number; messageId: number }): string {
	// 步骤 1: 数据库中 groupId 可能为浮点数 (例如 -1002803482189.0)，需要先取整。
	const groupIdInt = Math.trunc(r.groupId);

	// 步骤 2: 将整数 groupId 转换为字符串，以进行后续处理。
	const groupIdStr = groupIdInt.toString();

	// 步骤 3: 处理 Telegram 的群组ID规则。
	// - 对于超级群组，其 ID 格式为 "-100xxxxxxxxxx"，在生成链接时需要移除 "-100" 前缀。
	// - 对于普通群组或频道，其 ID 为负数，链接中需要使用其绝对值。
	const formattedGroupId = groupIdStr.startsWith('-100')
		? groupIdStr.substring(4) // 移除前4个字符 "-100"
		: Math.abs(groupIdInt).toString(); // 取绝对值

	// 步骤 4: 使用格式化后的群组ID组合成最终的 Telegram 消息链接。
	return `https://t.me/c/${formattedGroupId}/${r.messageId}`;
}

/**
 * 从消息对象中提取发送者的名称。
 * 如果是频道匿名发送，则返回频道标题；否则返回用户名字。
 * @param msg - Telegram 消息对象。
 * @returns 发送者的名称字符串。
 */
export function getUserName(msg: TelegramMessage): string {
	if (msg.sender_chat?.title) {
		return msg.sender_chat.title;
	}
	return msg.from?.first_name || 'anonymous';
}

/**
 * 修复 LLM 可能输出的错误链接格式。
 * @param text
 */
export function fixLink(text: string): string {
	return text.replace(/tme\.cat/g, 't.me/c').replace(/\/c\/c/g, '/c');
}

/**
 * 从命令中提取参数。
 * @param str 原始字符串
 * @param delim 分隔符
 */
export function getCommandVar(str: string, delim: string): string {
	return str.slice(str.indexOf(delim) + delim.length);
}

/**
 * 机器人回复的消息模板。
 * @param s 核心内容
 */
export function messageTemplate(s: string, modelName: string): string {
	return `下面由财大气粗的 ${escapeMarkdownV2(modelName)} 概括群聊信息\n` + s;
}
