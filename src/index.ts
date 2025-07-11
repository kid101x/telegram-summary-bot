import { getRuntimeEnvironment } from './config';
// 外部库 (External Libraries)
import TelegramBot from '@codebam/cf-workers-telegram-bot';

// 项目内部模块 (Local Modules)
import { handleScheduledSummary, handleScheduledCleanup } from './cron';
import {
	handleVersionCommand,
	handleStatusCommand,
	handleTestSummaryCommand,
	handleQueryCommand,
	handleAskCommand,
	handleSummaryCommand,
	handleMessage,
	handleEditedMessage,
} from './handlers';

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const runtimeEnv = getRuntimeEnvironment(env);
		console.log(`[cron] event start, cron: ${controller.cron}, env: ${runtimeEnv}`);

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

	async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
		const runtimeEnv = getRuntimeEnvironment(env);
		console.log(`[fetch] event start, env: ${runtimeEnv}`);
		const bot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN);

		bot.on('version', (ctx) => handleVersionCommand(ctx, env));
		bot.on('status', (ctx) => handleStatusCommand(ctx));
		bot.on('test_summary', (ctx) => handleTestSummaryCommand(ctx, env, _ctx));
		bot.on('query', (ctx) => handleQueryCommand(ctx, env));
		bot.on('ask', (ctx) => handleAskCommand(ctx, env));
		bot.on('summary', (ctx) => handleSummaryCommand(ctx, env));
		bot.on(':message', (ctx) => handleMessage(ctx, env));
		bot.on(':edited_message', (ctx) => handleEditedMessage(ctx, env));

		await bot.handle(request.clone());
		return new Response('ok');
	},
};
