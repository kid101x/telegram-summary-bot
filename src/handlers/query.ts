import type { BotContext, MessageRecord } from '../types';
import { searchMessages } from '../db';
import { escapeMarkdownV2 } from '../utils/markdown';
import { getMessageLink } from '../utils/telegram';

export async function handleQueryCommand(ctx: BotContext, env: Env) {
	const groupId = ctx.update.message!.chat.id;
	const messageText = ctx.update.message!.text || '';
	const queryTerm = messageText.split(' ')[1];

	if (!queryTerm) {
		await ctx.reply('请输入要查询的关键词');
		return new Response('ok');
	}

	const results = await searchMessages(env.DB, groupId, `*${queryTerm}*`);

	const replyLines = results.map((r: MessageRecord) => {
		const userName = escapeMarkdownV2(r.userName);
		const content = escapeMarkdownV2(r.content);
		const link = r.messageId === null ? '' : `[link](${getMessageLink(r)})`;
		return `${userName}: ${content} ${link}`;
	});
	const replyText = `查询结果:\n${replyLines.join('\n')}`;

	await ctx.reply(replyText, 'MarkdownV2');
	return new Response('ok');
}
