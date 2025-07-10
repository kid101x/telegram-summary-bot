import type { BotContext } from '../types';
import { saveMessage } from '../db';
import { getUserName, getMessageLink } from '../utils/telegram';
import { IGNORED_KEYWORDS } from '../config';
import { extractAllOGInfo } from '../utils/og';
import { isJPEGBase64 } from '../utils/isJpeg';
import { Buffer } from 'node:buffer';

export async function handleMessage(ctx: BotContext, env: Env) {
	if (!ctx.update.message!.chat.type.includes('group')) {
		await ctx.reply('我是一个群聊机器人，请把我加到群组里使用。');
		return new Response('ok');
	}

	switch (ctx.update_type) {
		case 'message': {
			const msg = ctx.update.message!;
			const content = msg.text || '';

			if (IGNORED_KEYWORDS.some((keyword) => content.startsWith(keyword))) {
				return new Response('ok');
			}

			let finalContent = content;
			if (msg.reply_to_message?.message_id) {
				finalContent = `回复 ${getMessageLink({ groupId: msg.chat.id, messageId: msg.reply_to_message.message_id })}: ${content}`;
			}
			if (content.startsWith('http') && !content.includes(' ')) {
				finalContent = await extractAllOGInfo(content);
			}

			await saveMessage(env.DB, {
				groupId: msg.chat.id,
				timeStamp: Date.now(),
				userName: getUserName(msg),
				content: finalContent,
				messageId: msg.message_id,
				groupName: msg.chat.title,
			});

			return new Response('ok');
		}
		case 'photo': {
			const msg = ctx.update.message!;
			const photo = msg.photo![msg.photo!.length - 1];
			const response = await ctx.getFile(photo.file_id);
			if (!response.ok) {
				console.error('Failed to get file:', await response.text());
				return new Response('ok');
			}
			const file = await response.arrayBuffer();

			if (!isJPEGBase64(Buffer.from(file).toString('base64')).isValid) {
				console.error('not a jpeg');
				return new Response('ok');
			}
			const content = 'data:image/jpeg;base64,' + Buffer.from(file).toString('base64');

			await saveMessage(env.DB, {
				groupId: msg.chat.id,
				timeStamp: Date.now(),
				userName: getUserName(msg),
				content: content,
				messageId: msg.message_id,
				groupName: msg.chat.title,
			});
			return new Response('ok');
		}
	}
	return new Response('ok');
}

export async function handleEditedMessage(ctx: BotContext, env: Env) {
	const msg = ctx.update.edited_message!;
	await saveMessage(env.DB, {
		groupId: msg.chat.id,
		timeStamp: Date.now(),
		userName: getUserName(msg),
		content: msg.text || '',
		messageId: msg.message_id,
		groupName: msg.chat.title,
	});
	return new Response('ok');
}
