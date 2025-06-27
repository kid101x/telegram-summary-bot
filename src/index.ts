// 外部库 (External Libraries)
import TelegramBot, { type TelegramMessage } from '@codebam/cf-workers-telegram-bot';
import OpenAI from 'openai';
import telegramifyMarkdown from 'telegramify-markdown';
// Node.js 内置模块 (Built-in Modules)
import { Buffer } from 'node:buffer';
// 项目内部模块 (Local Modules)
import { extractAllOGInfo } from './og';
import { isJPEGBase64 } from './isJpeg';
import { IGNORED_KEYWORDS, aiConfig, botConfig, cronConfig, SYSTEM_PROMPTS } from './config'; // <-- 外部参数文件，导入忽略列表
// ⬇️ --- 新增的 Imports --- ⬇️
import { escapeMarkdownV2, foldText, processMarkdownLinks } from './utils/markdown';
import { fixLink, getCommandVar, getMessageLink, getUserName, messageTemplate } from './utils/telegram';
import {
	saveMessage,
	getMessagesByCount,
	getMessagesByHours,
	getActiveGroups,
	cleanupOldMessages,
	cleanupOldImages,
	searchMessages,
} from './db';
import type { MessageRecord } from './types';

// 定义消息内容的类型，可以是文本或图片
function dispatchContent(content: string): { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } {
	if (content.startsWith('data:image/jpeg;base64,')) {
		return {
			type: 'image_url',
			image_url: {
				url: content,
			},
		};
	}
	return {
		type: 'text',
		text: content,
	};
}

// 获取格式化的发送时间，从未被调用
//function getSendTime(r: R) {
//  return new Date(r.timeStamp).toLocaleString('zh-CN', {
//    timeZone: 'Asia/Shanghai',
//  });
//}

// 获取 AI 模型实例
function getGenModel(env: Env) {
	return new OpenAI({
		apiKey: env.GEMINI_API_KEY,
		baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
		timeout: aiConfig.timeout,
	});
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		console.debug('Scheduled task starting:', new Date().toISOString());
		const date = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
		// Clean up oldest 50000 messages
		// ctx.waitUntil 异步延迟执行
		if (date.getHours() === 0 && date.getMinutes() < 6) {
			// 使用数据库模块函数进行清理
			ctx.waitUntil(cleanupOldMessages(env.DB, cronConfig.messageCleanupThreshold));
			ctx.waitUntil(cleanupOldImages(env.DB, cronConfig.imageRetentionPeriodMs));
		}

		// 获取需要处理的群组列表，并进行缓存
		const cache = caches.default;
		const cacheKey = new Request(`https://dummy-url/${env.SECRET_TELEGRAM_API_TOKEN}`);
		const cachedResponse = await cache.match(cacheKey);
		let groups: { groupId: string; message_count: number }[] = [];
		if (cachedResponse) {
			console.debug('Using cached response');
			groups = await cachedResponse.json();
		} else {
			console.debug('Fetching groups from DB');
			// 使用数据库模块函数获取活跃群组
			groups = await getActiveGroups(env.DB, cronConfig.dailySummaryMessageThreshold);
			ctx.waitUntil(
				cache.put(
					cacheKey,
					new Response(JSON.stringify(groups), {
						headers: { 'content-type': 'application/json', 'Cache-Control': 's-maxage=10000' }, // > 7200 < 86400
					}),
				),
			);
		}

		// 分批处理群组
		const batch = Math.floor(date.getMinutes() / 6); // 0 <= batch < 10
		console.debug('Batch:', batch);
		console.debug('Found groups:', groups.length, JSON.stringify(groups));

		for (const [id, group] of groups.entries()) {
			if (id % 10 !== batch) continue;

			console.debug(`Processing group ${id + 1}/${groups.length}: ${group.groupId}`);
			// 使用数据库模块函数获取消息
			const messages = await getMessagesByHours(env.DB, group.groupId, 24);

			if (messages.length === 0) continue;

			const result = await getGenModel(env).chat.completions.create({
				model: aiConfig.model,
				messages: [
					{
						role: 'system',
						content: SYSTEM_PROMPTS.summarizeChat,
					},
					{
						role: 'user',
						content: messages.flatMap((r: MessageRecord) => [
							dispatchContent('===================='),
							dispatchContent(`${r.userName}:`),
							dispatchContent(r.content),
							dispatchContent(getMessageLink(r)),
						]),
					},
				],
				max_tokens: 4096,
				temperature: aiConfig.temperature,
			});

			if (cronConfig.skipSummaryGroupIds.includes(parseInt(group.groupId as string))) {
				continue;
			}
			console.debug('send message to', group.groupId);

			// Use fetch to send message directly to Telegram API
			const res = await fetch(`https://api.telegram.org/bot${env.SECRET_TELEGRAM_API_TOKEN}/sendMessage`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					chat_id: group.groupId,
					text: messageTemplate(
						foldText(fixLink(processMarkdownLinks(telegramifyMarkdown(result.choices[0].message.content || '', 'keep')))),
					),
					parse_mode: 'MarkdownV2',
				}),
			});
			if (!res?.ok) {
				console.error('Failed to send reply', res?.statusText, await res?.text());
			}
		}

		console.debug('cron processed');
	},

	fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
		// 将 bot 实例创建与事件注册分离，增强可读性 -->
		const bot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN);

		// 恢复所有命令处理器，并使用新的数据库模块函数 -->
		bot.on('version', async (ctx) => {
			// /version 命令处理器
			// 读取由 CI/CD 注入的 GIT_COMMIT_SHA 变量
			const sha = env.GIT_COMMIT_SHA || 'unknown';
			// 取前7位通常就足够唯一了
			const versionMessage = `当前版本: \`${sha.slice(0, 7)}\``;
			await ctx.reply(versionMessage, 'MarkdownV2');
			return new Response('ok');
		});

		bot.on('status', async (ctx) => {
			const res = (await ctx.reply('我家还蛮大的'))!;
			if (!res.ok) {
				console.error('Error sending message:', res);
			}
			return new Response('ok');
		});

		bot.on('query', async (ctx) => {
			const groupId = ctx.update.message!.chat.id;
			const messageText = ctx.update.message!.text || '';
			const queryTerm = messageText.split(' ')[1];

			if (!queryTerm) {
				await ctx.reply('请输入要查询的关键词');
				return new Response('ok');
			}

			const results = await searchMessages(env.DB, groupId, `*${queryTerm}*`);

			// <-- 修正：仅对用户内容进行转义，以保护 Markdown 链接 -->
			const replyLines = results.map((r: MessageRecord) => {
				const userName = escapeMarkdownV2(r.userName);
				const content = escapeMarkdownV2(r.content);
				const link = r.messageId === null ? '' : `[link](${getMessageLink(r)})`;
				return `${userName}: ${content} ${link}`;
			});
			const replyText = `查询结果:\n${replyLines.join('\n')}`;

			const res = (await ctx.reply(replyText, 'MarkdownV2'))!;
			if (!res.ok) {
				console.error('Error sending message:', res.status, res.statusText, await res.text());
			}
			return new Response('ok');
		});

		bot.on('ask', async (ctx) => {
			const groupId = ctx.update.message!.chat.id;
			const userId = ctx.update.message!.from!.id;
			const messageText = ctx.update.message!.text || '';
			const question = getCommandVar(messageText, ' ');

			if (!question) {
				await ctx.reply('请输入要问的问题');
				return new Response('ok');
			}

			let res = await (ctx.api as any).sendMessage(ctx.bot.api.toString(), {
				chat_id: userId,
				text: 'bot 已经收到你的问题, 正在思考中...',
			});
			if (!res.ok) {
				await ctx.reply('请先私聊我并点击 "Start"，否则无法向您发送回答。');
				return new Response('ok');
			}

			const messages = await getMessagesByCount(env.DB, groupId, 1000);

			try {
				const result = await getGenModel(env).chat.completions.create({
					model: aiConfig.model,
					messages: [
						{
							role: 'system',
							content: SYSTEM_PROMPTS.answerQuestion,
						},
						{
							role: 'user',
							content: messages.flatMap((r: MessageRecord) => [
								dispatchContent('===================='),
								dispatchContent(`${r.userName}:`),
								dispatchContent(r.content),
								dispatchContent(getMessageLink(r)),
							]),
						},
						{
							role: 'user',
							content: `问题：${question}`,
						},
					],
					max_tokens: 4096,
					temperature: aiConfig.temperature,
				});

				const response_text = processMarkdownLinks(telegramifyMarkdown(result.choices[0].message.content || '', 'keep'));

				res = await (ctx.api as any).sendMessage(ctx.bot.api.toString(), {
					chat_id: userId,
					parse_mode: 'MarkdownV2',
					text: foldText(response_text),
				});
				if (!res.ok) {
					console.error('Failed to send answer:', await res.text());
				}
			} catch (e) {
				console.error(e);
				await (ctx.api as any).sendMessage(ctx.bot.api.toString(), {
					chat_id: userId,
					text: '抱歉，思考时遇到了一些问题，无法回答。',
				});
			}

			return new Response('ok');
		});

		bot.on('summary', async (ctx) => {
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
					const result = await getGenModel(env).chat.completions.create({
						model: aiConfig.model,
						// reasoning_effort,
						messages: [
							{
								role: 'system',
								content: SYSTEM_PROMPTS.summarizeChat,
							},
							{
								role: 'user',
								content: messages.flatMap((r: MessageRecord) => [
									dispatchContent('===================='),
									dispatchContent(`${r.userName}:`),
									dispatchContent(r.content),
									dispatchContent(getMessageLink(r)),
								]),
							},
						],
						max_tokens: 4096,
						temperature: aiConfig.temperature,
					});

					const res = await ctx.reply(
						messageTemplate(foldText(fixLink(processMarkdownLinks(telegramifyMarkdown(result.choices[0].message.content || '', 'keep'))))),
						'MarkdownV2',
					);
					if (!res?.ok) {
						console.error('Failed to send reply', res?.statusText, await res?.text());
					}
				} catch (e) {
					console.error(e);
					await ctx.reply('生成摘要时出错，请稍后再试。');
				}
			} else {
				await ctx.reply('在此期间内没有足够的消息可供总结。');
			}

			return new Response('ok');
		});

		bot.on(':message', async (ctx) => {
			if (!ctx.update.message!.chat.type.includes('group')) {
				await ctx.reply('我是一个群聊机器人，请把我加到群组里使用。');
				return new Response('ok');
			}

			switch (ctx.update_type) {
				case 'message': {
					const msg = ctx.update.message!;
					const content = msg.text || '';

					// <-- 精确匹配忽略逻辑
					if (IGNORED_KEYWORDS.includes(content)) {
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
						groupId: String(msg.chat.id),
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
					const file = await ctx.api.getFile(photo.file_id).then((response) => response.arrayBuffer());
					if (!isJPEGBase64(Buffer.from(file).toString('base64')).isValid) {
						console.error('not a jpeg');
						return new Response('ok');
					}
					const content = 'data:image/jpeg;base64,' + Buffer.from(file).toString('base64');

					await saveMessage(env.DB, {
						groupId: String(msg.chat.id),
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
		});

		bot.on(':edited_message', async (ctx) => {
			const msg = ctx.update.edited_message!;
			await saveMessage(env.DB, {
				groupId: String(msg.chat.id),
				timeStamp: Date.now(),
				userName: getUserName(msg),
				content: msg.text || '',
				messageId: msg.message_id,
				groupName: msg.chat.title,
			});
			return new Response('ok');
		});

		await bot.handle(request.clone());
		return new Response('ok');
	},
};
