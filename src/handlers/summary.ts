import type { BotContext, MessageRecord } from '../types';
import { getMessagesByCount, getMessagesByHours } from '../db';
import { getSummary } from '../ai';
import { foldText, processMarkdownLinks } from '../utils/markdown';
import { messageTemplate, fixLink } from '../utils/telegram';
import telegramifyMarkdown from 'telegramify-markdown';

export async function handleSummaryCommand(ctx: BotContext, env: Env) {
	const groupId = ctx.update.message!.chat.id;
	if (ctx.update.message!.text!.split(' ').length === 1) {
		await ctx.reply('请输入要查询的时间范围/消息数量, 如 /summary 114h 或 /summary 514');
		return new Response('ok');
	}
	const summaryArg = ctx.update.message!.text!.split(' ')[1];
	let messages: MessageRecord[];

	try {
		if (summaryArg.endsWith('h')) {
			messages = await getMessagesByHours(env.DB, groupId, parseInt(summaryArg));
		} else {
			messages = await getMessagesByCount(env.DB, groupId, parseInt(summaryArg));
		}
	} catch (e) {
		await ctx.reply('请输入要查询的 时间范围 或 消息数量, 如 /summary 12h 或 /summary 420');
		return new Response('ok');
	}

	if (messages.length > 0) {
		try {
			const summaryContent = await getSummary(env, messages);
			await ctx.reply(
				messageTemplate(
					foldText(fixLink(processMarkdownLinks(telegramifyMarkdown(summaryContent, 'keep')))),
					env.AI_MODEL_NAME || 'google-ai-studio/gemini-2.0-flash',
				),
				'MarkdownV2',
			);
		} catch (e) {
			console.error(e);
			await ctx.reply(`生成摘要时出错: ${e instanceof Error ? e.message : 'Unknown error'}`);
		}
	} else {
		await ctx.reply('在此期间内没有足够的消息可供总结。');
	}

	return new Response('ok');
}
