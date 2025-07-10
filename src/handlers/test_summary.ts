import type { BotContext } from '../types';
import { handleScheduledSummary } from '../cron'; // This will cause a circular dependency, we need to fix this.

export async function handleTestSummaryCommand(ctx: BotContext, env: Env, _ctx: ExecutionContext) {
	const userId = ctx.update.message!.from!.id;

	if (userId.toString() !== env.TELEGRAM_ADMIN_ID) {
		await ctx.reply('抱歉，此命令仅限管理员使用。');
		return new Response('ok');
	}

	await ctx.reply('正在为您手动触发每日总结任务，请稍候...');

	const SUMMARY_HOURS = 24;
	const SUMMARY_OVERLAP_MINUTES = 42;
	const summary_period_minutes = SUMMARY_HOURS * 60 + SUMMARY_OVERLAP_MINUTES;

	_ctx.waitUntil(handleScheduledSummary(env, summary_period_minutes));

	console.log(`[manual_trigger] test_summary triggered by admin: ${userId}`);
	return new Response('ok');
}
