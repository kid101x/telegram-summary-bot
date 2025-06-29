// src/utils/telegram.ts

import type { TelegramMessage } from '@codebam/cf-workers-telegram-bot';
import { aiConfig, botConfig } from '../config';
import { escapeMarkdownV2 } from './markdown';

/**
 * 生成消息的永久链接，适应私有群ID（如-987654321）。
 * @param r 包含 groupId 和 messageId 的对象
 */
export function getMessageLink(r: { groupId: number; messageId: number }): string {
	// 1. groupId 已经是 number，无需转换
	const groupIdStr = r.groupId.toString();
	// 2. 根据群组类型处理 ID。
	// 超级群组的 ID 以 '-100' 开头，链接中需要移除此部分。
	// 其他群组（如果可链接）则使用其 ID 的绝对值。
	const processedId = groupIdStr.startsWith('-100') ? groupIdStr.slice(4) : Math.abs(r.groupId).toString();
	return `https://t.me/c/${processedId}/${r.messageId}`;
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
export function messageTemplate(s: string): string {
	return `下面由财大气粗的 ${escapeMarkdownV2(aiConfig.model)} 概括群聊信息\n` + s;
}
