// 外部库 (External Libraries)
import TelegramBot from '@codebam/cf-workers-telegram-bot';
import telegramifyMarkdown from 'telegramify-markdown';
// Node.js 内置模块 (Built-in Modules)
import { Buffer } from 'node:buffer';
// 项目内部模块 (Local Modules)
import { extractAllOGInfo } from './og';
import { isJPEGBase64 } from './isJpeg';
import { IGNORED_KEYWORDS, cronConfig } from './config'; // <-- 移除 SYSTEM_PROMPTS
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
import { getSummary, answerQuestion } from './ai'; // <-- 新增 ai 模块导入
import type { MessageRecord } from './types';

// 移除了 dispatchContent 和 getGenModel 函数，因为它们已经被抽象到 src/ai.ts

// --- Refactored Scheduled Task Handlers ---

async function handleScheduledSummary(env: Env, summary_period_minutes: number) {
	console.log('[cron] summary job: fetching active groups.');
	const groups = await getActiveGroups(env.DB, cronConfig.dailySummaryMessageThreshold);
	console.log(`[cron] summary job: found ${groups.length} active groups.`);

	for (const group of groups) {
		if (cronConfig.skipSummaryGroupIds.includes(group.groupId)) {
			console.log(`[cron] skipping summary for group ${group.groupId} as per config.`);
			continue;
		}

		console.log(`[cron] processing summary for group ${group.groupId}`);
		const summary_period_hours = summary_period_minutes / 60.0;
		const messages = await getMessagesByHours(env.DB, group.groupId, summary_period_hours);

		if (messages.length === 0) {
			console.log(`[cron] no messages found for group ${group.groupId} in the last ${summary_period_hours} hours.`);
			continue;
		}

		try {
			// <-- 使用新的 getSummary 函数
			const summaryContent = await getSummary(env, messages);

			if (!summaryContent) {
				console.log(`[cron] summary generation returned empty content for group ${group.groupId}`);
				continue;
			}

			const text = messageTemplate(
				foldText(fixLink(processMarkdownLinks(telegramifyMarkdown(summaryContent, 'keep')))),
				env.AI_MODEL_NAME || 'google-ai-studio/gemini-2.0-flash',
			);

			const message = `${escapeMarkdownV2('#summary')}\n\n${text}`;

			const res = await fetch(`https://api.telegram.org/bot${env.SECRET_TELEGRAM_API_TOKEN}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: group.groupId,
					text: message,
					parse_mode: 'MarkdownV2',
				}),
			});

			if (!res.ok) {
				console.error(`[cron] failed to send summary to group ${group.groupId}`, res.statusText, await res.text());
			} else {
				console.log(`[cron] summary sent to group ${group.groupId}`);
			}
		} catch (e) {
			console.error(`[cron] error processing summary for group ${group.groupId}`, e);
		}
	}
	console.log('[cron] summary job finished.');
}

async function handleScheduledCleanup(env: Env) {
	console.log('[cron] cleanup job: starting global cleanup.');
	try {
		// 清理函数可能会返回已删除项目的数量。
		const messagesCleaned = await cleanupOldMessages(env.DB, cronConfig.messageCleanupThreshold); // 保留最新的 N 条
		console.log(`[cron] cleanup job: cleaned up ${messagesCleaned} old messages (retaining last ${cronConfig.messageCleanupThreshold}).`);
		const imagesCleaned = await cleanupOldImages(env.DB, cronConfig.imageRetentionPeriodMs); // 清理 N 天前的图片
		const retentionDays = cronConfig.imageRetentionPeriodMs / (24 * 60 * 60 * 1000);
		// 将计算逻辑从模板字符串中提取出来，提高代码清晰度并解决潜在的 linter 问题。
		console.log(`[cron] cleanup job: cleaned up ${imagesCleaned} old images (older than ${retentionDays} days).`);
	} catch (e) {
		console.error('[cron] error during cleanup job', e);
	}
	console.log('[cron] cleanup job finished.');
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		console.log(`[cron] event start, cron: ${controller.cron}`);

		switch (controller.cron) {
			// 每天上海时间 23:23 (UTC 15:23) 触发总结任务
			case '23 15 * * *': {
				console.log('[cron] summary job start');
				// 总结最近 24 小时 42 分钟的内容 (24 * 60 + 42 = 1482 分钟)
				const SUMMARY_HOURS = 24;
				const SUMMARY_OVERLAP_MINUTES = 42;
				const summary_period_minutes = SUMMARY_HOURS * 60 + SUMMARY_OVERLAP_MINUTES;
				ctx.waitUntil(handleScheduledSummary(env, summary_period_minutes));
				break;
			}
			// 每天上海时间 02:42 (UTC 18:42) 触发清理任务
			case '42 18 * * *': {
				console.log('[cron] cleanup job start');
				ctx.waitUntil(handleScheduledCleanup(env));
				break;
			}
			default: {
				console.log(`[cron] unknown cron job: ${controller.cron}`);
				break;
			}
		}
	},

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	fetch: async (request: Request, env: Env, _ctx: ExecutionContext) => {
		const bot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN);

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
			await ctx.reply('我家还蛮大的');
			return new Response('ok');
		});

		bot.on('test_summary', async (ctx) => {
			const userId = ctx.update.message!.from!.id;

			// 验证是否为管理员
			if (userId.toString() !== env.TELEGRAM_ADMIN_ID) {
				await ctx.reply('抱歉，此命令仅限管理员使用。');
				return new Response('ok');
			}

			await ctx.reply('正在为您手动触发每日总结任务，请稍候...');

			// 使用与 cron 任务相同的参数
			const SUMMARY_HOURS = 24;
			const SUMMARY_OVERLAP_MINUTES = 42;
			const summary_period_minutes = SUMMARY_HOURS * 60 + SUMMARY_OVERLAP_MINUTES;

			// 在后台执行，防止请求超时
			_ctx.waitUntil(handleScheduledSummary(env, summary_period_minutes));

			// 可以在这里添加一个完成后的通知，但 handleScheduledSummary 内部没有返回群组ID，
			// 所以暂时只通知任务已启动。
			console.log(`[manual_trigger] test_summary triggered by admin: ${userId}`);
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

			const replyLines = results.map((r: MessageRecord) => {
				const userName = escapeMarkdownV2(r.userName);
				const content = escapeMarkdownV2(r.content);
				const link = r.messageId === null ? '' : `[link](${getMessageLink(r)})`;
				return `${userName}: ${content} ${link}`;
			});
			const replyText = `查询结果:\n${replyLines.join('\n')}`;

			await ctx.reply(replyText, 'MarkdownV2');
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
				// <-- 使用新的 answerQuestion 函数
				const answer = await answerQuestion(env, messages, question);
				const response_text = processMarkdownLinks(telegramifyMarkdown(answer, 'keep'));

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
					text: `抱歉，思考时遇到了一些问题，无法回答: ${e instanceof Error ? e.message : 'Unknown error'}`,
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
					// <-- 使用新的 getSummary 函数
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
		});

		bot.on(':edited_message', async (ctx) => {
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
		});

		await bot.handle(request.clone());
		return new Response('ok');
	},
};
