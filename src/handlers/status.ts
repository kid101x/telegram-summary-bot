import type { BotContext } from '../types';

export async function handleStatusCommand(ctx: BotContext) {
	await ctx.reply('我家还蛮大的');
	return new Response('ok');
}
