import type { BotContext } from '../types';
export async function handleVersionCommand(ctx: BotContext, env: Env) {
	const sha = env.GIT_COMMIT_SHA || 'unknown';
	const versionMessage = `当前版本: \`${sha.slice(0, 7)}\``;
	await ctx.reply(versionMessage, 'MarkdownV2');
	return new Response('ok');
}
