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

// 定义数据库记录的类型
type MessageRecord = {
	groupId: string;
	userName: string;
	content: string;
	messageId: number;
	timeStamp: number;
};

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
		// Clean up oldest 4000 messages
		// ctx.waitUntil 异步延迟执行
		if (date.getHours() === 0 && date.getMinutes() < 6) {
			await env.DB.prepare(
				`
					DELETE FROM Messages
					WHERE id IN (
						SELECT id
						FROM (
							SELECT
								id,
								ROW_NUMBER() OVER (
									PARTITION BY groupId
									ORDER BY timeStamp DESC
								) as row_num
							FROM Messages
						) ranked
						WHERE row_num > 3000
					);`,
			)
				.bind(cronConfig.messageCleanupThreshold)
				.run();
		}

		// 获取需要处理的群组列表，并进行缓存
		const cache = caches.default;
		const cacheKey = new Request(`https://dummy-url/${env.SECRET_TELEGRAM_API_TOKEN}`);
		const cachedResponse = await cache.match(cacheKey);
		let groups: any[] = [];
		if (cachedResponse) {
			console.debug('Using cached response');
			groups = await cachedResponse.json();
		} else {
			console.debug('Fetching groups');
			groups = (
				await env.DB.prepare(
					`
		WITH MessageCounts AS (
			SELECT
				groupId,
				COUNT(*) as message_count
			FROM Messages
			WHERE timeStamp >= ?1 - (24 * 3600 * 1000)
			GROUP BY groupId
		)
		SELECT groupId, message_count
		FROM MessageCounts
		WHERE message_count > 10
		ORDER BY message_count DESC;
		`,
				)
					.bind(Date.now(), cronConfig.dailySummaryMessageThreshold)
					.all()
			).results;
			ctx.waitUntil(
				cache.put(
					cacheKey,
					new Response(JSON.stringify(groups), {
						headers: {
							'content-type': 'application/json',
							'Cache-Control': 's-maxage=10000', // > 7200 < 86400
						},
					}),
				),
			);
		}

		// 分批处理群组
		const batch = Math.floor(date.getMinutes() / 6); // 0 <= batch < 10
		console.debug('Batch:', batch);
		console.debug('Found groups:', groups.length, JSON.stringify(groups));
		for (const [id, group] of groups.entries()) {
			if (id % 10 !== batch) {
				continue;
			}
			console.debug(`Processing group ${id + 1}/${groups.length}: ${group.groupId}`);

			const { results } = await env.DB.prepare('SELECT * FROM Messages WHERE groupId=? AND timeStamp >= ? ORDER BY timeStamp ASC')
				.bind(group.groupId, Date.now() - 24 * 60 * 60 * 1000)
				.all();

			const result = await getGenModel(env).chat.completions.create({
				model: aiConfig.model,
				messages: [
					{
						role: 'system',
						content: SYSTEM_PROMPTS.summarizeChat,
					},
					{
						role: 'user',
						content: results.flatMap((r: any) => [
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
		// 每天清理一次超过2天的图片
		if (date.getHours() === 0 && date.getMinutes() < 6) {
			// 定义2天的毫秒数，更具可读性
			const cutoffTimestamp = Date.now() - cronConfig.imageRetentionPeriodMs;

			ctx.waitUntil(
				env.DB.prepare(
					`
            DELETE
            FROM Messages
            WHERE timeStamp < ?1 AND content LIKE 'data:image/jpeg;base64,%'`,
				)
					.bind(cutoffTimestamp) // 使用计算好的时间戳
					.run(),
			);
		}

		console.debug('cron processed');
	},

	fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
		await new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN)
			.on('version', async (bot) => {
				// /version 命令处理器
				// 读取由 CI/CD 注入的 GIT_COMMIT_SHA 变量
				const sha = env.GIT_COMMIT_SHA || 'unknown';
				// 取前7位通常就足够唯一了
				const versionMessage = `当前版本: \`${sha.slice(0, 7)}\``;
				await bot.reply(versionMessage, 'MarkdownV2');
				return new Response('ok');
			})
			.on('status', async (ctx) => {
				const res = (await ctx.reply('我家还蛮大的'))!;
				if (!res.ok) {
					console.error('Error sending message:', res);
				}
				return new Response('ok');
			})
			.on('query', async (ctx) => {
				const groupId = ctx.update.message!.chat.id;
				const messageText = ctx.update.message!.text || '';
				if (!messageText.split(' ')[1]) {
					const res = (await ctx.reply('请输入要查询的关键词'))!;
					if (!res.ok) {
						console.error('Error sending message:', res);
					}
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(
					`
					SELECT * FROM Messages
					WHERE groupId=? AND content GLOB ?
					ORDER BY timeStamp DESC
					LIMIT 2000`,
				)
					.bind(groupId, `*${messageText.split(' ')[1]}*`)
					.all();
				const res = (await ctx.reply(
					escapeMarkdownV2(`查询结果:
${results.map((r: any) => `${r.userName}: ${r.content} ${r.messageId === null ? '' : `[link](https://t.me/c/${parseInt(r.groupId.slice(2))}/${r.messageId})`}`).join('\n')}`),
					'MarkdownV2',
				))!;
				if (!res.ok) {
					console.error('Error sending message:', res.status, res.statusText, await res.text());
				}
				return new Response('ok');
			})
			.on('ask', async (ctx) => {
				const groupId = ctx.update.message!.chat.id;
				const userId = ctx.update.message!.from!.id;
				const messageText = ctx.update.message!.text || '';
				if (!messageText.split(' ')[1]) {
					const res = (await ctx.reply('请输入要问的问题'))!;
					if (!res.ok) {
						console.error('Error sending message:', res);
					}
					return new Response('ok');
				}
				let res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
					chat_id: userId,
					parse_mode: 'MarkdownV2',
					text: 'bot 已经收到你的问题, 请稍等',
					reply_to_message_id: -1,
				});
				if (!res.ok) {
					await ctx.reply('请开启和 bot 的私聊, 不然无法接收消息');
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(
					`
					WITH latest_1000 AS (
						SELECT * FROM Messages
						WHERE groupId=?
						ORDER BY timeStamp DESC
						LIMIT 1000
					)
					SELECT * FROM latest_1000
					ORDER BY timeStamp ASC
					`,
				)
					.bind(groupId)
					.all();
				let result;
				try {
					result = await getGenModel(env).chat.completions.create({
						model: aiConfig.model,
						messages: [
							{
								role: 'system',
								content: SYSTEM_PROMPTS.answerQuestion,
							},
							{
								role: 'user',
								content: results.flatMap((r: any) => [
									dispatchContent('===================='),
									dispatchContent(`${r.userName}:`),
									dispatchContent(r.content),
									dispatchContent(getMessageLink(r)),
								]),
							},
							{
								role: 'user',
								content: `问题：${getCommandVar(messageText, ' ')}`,
							},
						],
						max_tokens: 4096,
						temperature: aiConfig.temperature,
					});
				} catch (e) {
					console.error(e);
					return new Response('ok');
				}
				let response_text: string;
				response_text = processMarkdownLinks(telegramifyMarkdown(result.choices[0].message.content || '', 'keep'));

				res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
					chat_id: userId,
					parse_mode: 'MarkdownV2',
					text: foldText(response_text),
					reply_to_message_id: -1,
				});
				if (!res.ok) {
					const reason = ((await res.json()) as any)?.promptFeedback?.blockReason;
					if (reason) {
						await ctx.reply(`无法回答, 理由 ${reason}`);
						return new Response('ok');
					}
					await ctx.reply('发送失败');
				}
				return new Response('ok');
			})
			.on('summary', async (bot) => {
				const groupId = bot.update.message!.chat.id;
				if (bot.update.message!.text!.split(' ').length === 1) {
					await bot.reply('请输入要查询的时间范围/消息数量, 如 /summary 114h 或 /summary 514');
					return new Response('ok');
				}
				const summary = bot.update.message!.text!.split(' ')[1];
				let results: Record<string, unknown>[];
				try {
					const test = parseInt(summary);
					if (Number.isNaN(test)) {
						throw new Error('not a number');
					}
					if (test < 0) {
						throw new Error('negative number');
					}
					if (!Number.isFinite(test)) {
						throw new Error('infinite number');
					}
				} catch (e: any) {
					await bot.reply('请输入要查询的时间范围/消息数量, 如 /summary 114h 或 /summary 514  ' + e.message);
					return new Response('ok');
				}
				if (summary.endsWith('h')) {
					results = (
						await env.DB.prepare(
							`
						SELECT *
						FROM Messages
						WHERE groupId=? AND timeStamp >= ?
						ORDER BY timeStamp ASC
						`,
						)
							.bind(groupId, Date.now() - parseInt(summary) * 60 * 60 * 1000)
							.all()
					).results;
				} else {
					results = (
						await env.DB.prepare(
							`
						WITH latest_n AS (
							SELECT * FROM Messages
							WHERE groupId=?
							ORDER BY timeStamp DESC
							LIMIT ?
						)
						SELECT * FROM latest_n
						ORDER BY timeStamp ASC
						`,
						)
							.bind(groupId, Math.min(parseInt(summary), 4000))
							.all()
					).results;
				}
				if (results.length > 0) {
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
									content: results.flatMap((r: any) => [
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

						const res = await bot.reply(
							messageTemplate(
								foldText(fixLink(processMarkdownLinks(telegramifyMarkdown(result.choices[0].message.content || '', 'keep')))),
							),
							'MarkdownV2',
						);
						if (!res?.ok) {
							console.error('Failed to send reply', res?.statusText, await res?.text());
						}
					} catch (e) {
						console.error(e);
					}
				}

				return new Response('ok');
			})
			.on(':message', async (bot) => {
				if (!bot.update.message!.chat.type.includes('group')) {
					await bot.reply('I am a bot, please add me to a group to use me.');
					return new Response('ok');
				}

				switch (bot.update_type) {
					case 'message': {
						const msg = bot.update.message!;
						const groupId = msg.chat.id;
						let content = msg.text || '';

						// <-- 精确匹配忽略逻辑
						if (IGNORED_KEYWORDS.includes(content)) {
							console.log(`Ignored exact match message in group ${groupId}: "${content}"`);
							return new Response('ok');
						}

						const fwd = msg.forward_from?.last_name;
						const replyTo = msg.reply_to_message?.message_id;
						if (fwd) {
							content = `转发自 ${fwd}: ${content}`;
						}
						if (replyTo) {
							content = `回复 ${getMessageLink({ groupId: groupId.toString(), messageId: replyTo })}: ${content}`;
						}
						if (content.startsWith('http') && !content.includes(' ')) {
							content = await extractAllOGInfo(content);
						}
						const messageId = msg.message_id;
						const groupName = msg.chat.title || 'anonymous';
						const timeStamp = Date.now();
						const userName = getUserName(msg);
						try {
							await env.DB.prepare(
								`
								INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`,
							)
								.bind(
									getMessageLink({ groupId: groupId.toString(), messageId }),
									groupId,
									timeStamp,
									userName, // not interested in user id
									content,
									messageId,
									groupName,
								)
								.run();
						} catch (e) {
							console.error(e);
						}
						return new Response('ok');
					}
					case 'photo': {
						const msg = bot.update.message!;
						const groupId = msg.chat.id;
						const messageId = msg.message_id;
						const groupName = msg.chat.title || 'anonymous';
						const timeStamp = Date.now();
						const userName = getUserName(msg);
						const photo = msg.photo![msg.photo!.length - 1];
						const file = await bot.getFile(photo.file_id).then((response) => response.arrayBuffer());
						if (!isJPEGBase64(Buffer.from(file).toString('base64')).isValid) {
							console.error('not a jpeg');
							return new Response('ok');
						}
						try {
							await env.DB.prepare(
								`
							INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`,
							)
								.bind(
									getMessageLink({ groupId: groupId.toString(), messageId }),
									groupId,
									timeStamp,
									userName, // not interested in user id
									'data:image/jpeg;base64,' + Buffer.from(file).toString('base64'),
									messageId,
									groupName,
								)
								.run();
						} catch (e) {
							console.error(e);
						}
						return new Response('ok');
					}
				}
				return new Response('ok');
			})
			.on(':edited_message', async (ctx) => {
				const msg = ctx.update.edited_message!;
				const groupId = msg.chat.id;
				const content = msg.text || '';
				const messageId = msg.message_id;
				const groupName = msg.chat.title || 'anonymous';
				const timeStamp = Date.now();
				const userName = getUserName(msg);
				try {
					await env.DB.prepare(
						`
					INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
						.bind(
							getMessageLink({ groupId: groupId.toString(), messageId }),
							groupId,
							timeStamp,
							userName, // not interested in user id
							content,
							messageId,
							groupName,
						)
						.run();
				} catch (e) {
					console.error(e);
				}
				return new Response('ok');
			})
			.handle(request.clone());
		return new Response('ok');
	},
};
