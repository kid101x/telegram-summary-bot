import { cronConfig } from './config';
import { getActiveGroups, getMessagesByHours, cleanupOldMessages, cleanupOldImages } from './db';
import { getSummary } from './ai';
import { escapeMarkdownV2, foldText, processMarkdownLinks } from './utils/markdown';
import { messageTemplate, fixLink } from './utils/telegram';
import type { Env } from './types';
import telegramifyMarkdown from 'telegramify-markdown';

export async function handleScheduledSummary(env: Env, summary_period_minutes: number) {
	console.log('[cron] summary job: fetching active groups.');
	const groups = await getActiveGroups(env.DB, cronConfig.dailySummaryMessageThreshold, cronConfig.maxSummaryGroupsPerRun);
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

export async function handleScheduledCleanup(env: Env) {
	console.log('[cron] cleanup job: starting global cleanup.');
	try {
		const messagesCleaned = await cleanupOldMessages(env.DB, cronConfig.messageCleanupThreshold);
		console.log(`[cron] cleanup job: cleaned up ${messagesCleaned} old messages (retaining last ${cronConfig.messageCleanupThreshold}).`);
		const imagesCleaned = await cleanupOldImages(env.DB, cronConfig.imageRetentionPeriodMs);
		const retentionDays = cronConfig.imageRetentionPeriodMs / (24 * 60 * 60 * 1000);
		console.log(`[cron] cleanup job: cleaned up ${imagesCleaned} old images (older than ${retentionDays} days).`);
	} catch (e) {
		console.error('[cron] error during cleanup job', e);
	}
	console.log('[cron] cleanup job finished.');
}
