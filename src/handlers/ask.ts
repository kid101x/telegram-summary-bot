import type { BotContext, Env } from '../types';
import { getMessagesByCount } from '../db';
import { answerQuestion } from '../ai';
import { foldText, processMarkdownLinks } from '../utils/markdown';
import { getCommandVar } from '../utils/telegram';
import telegramifyMarkdown from 'telegramify-markdown';

export async function handleAskCommand(ctx: BotContext, env: Env) {
	const groupId = ctx.update.message!.chat.id;
	const userId = ctx.update.message!.from!.id;
	const messageId = ctx.update.message!.message_id;
	const messageText = ctx.update.message!.text || '';
	const question = getCommandVar(messageText, ' ');

	if (!question) {
		await ctx.reply('请输入要问的问题');
		return new Response('ok');
	}

	let res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
		chat_id: userId,
		text: 'bot 已经收到你的问题, 正在思考中...',
		reply_to_message_id: messageId,
		parse_mode: '',
	});
	if (!res.ok) {
		await ctx.reply('请先私聊我并点击 "Start"，否则无法向您发送回答。');
	}

	const messages = await getMessagesByCount(env.DB, groupId, 1000);

	try {
		const answer = await answerQuestion(env, messages, question);
		const response_text = processMarkdownLinks(telegramifyMarkdown(answer, 'keep'));

		res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
			chat_id: userId,
			text: foldText(response_text),
			parse_mode: 'MarkdownV2',
			reply_to_message_id: messageId,
		});
		if (!res.ok) {
			console.error('Failed to send answer:', await res.text());
		}
	} catch (e) {
		console.error(e);
		await ctx.api.sendMessage(ctx.bot.api.toString(), {
			chat_id: userId,
			text: `抱歉，思考时遇到了一些问题，无法回答: ${e instanceof Error ? e.message : 'Unknown error'}`,
			reply_to_message_id: messageId,
			parse_mode: '',
		});
	}

	return new Response('ok');
}
