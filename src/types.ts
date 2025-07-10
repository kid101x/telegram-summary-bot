// src/types.ts

import type { TelegramUpdate, TelegramApi } from '@codebam/cf-workers-telegram-bot';
import type TelegramBot from '@codebam/cf-workers-telegram-bot';

export interface Env {
	// Bindings
	DB: D1Database;

	// Vars from wrangler.toml
	ENV: 'prod' | 'dev-test' | 'local-demo';
	AI_MODEL_NAME: 'google-ai-studio/gemini-2.0-flash' | 'llama3';
	FORCE_USE_AI_BASE_URL: 'true';
	AI_BASE_URL: string;

	// Secrets
	SECRET_TELEGRAM_API_TOKEN: string;
	TELEGRAM_ADMIN_ID: string;
	ACCOUNT_ID: string;
	AI_GATEWAY_ID: string;
	AI_API_KEY: string;

	[key: string]: unknown;
}

/**
 * 代表传递给命令处理程序的上下文对象。
 * 它封装了来自 Telegram 的传入更新并提供了实用方法。
 * 注意: 这��根据其在各个处理程序中的用法推断出的类型。
 */
export interface BotContext {
	update: TelegramUpdate; // 通常这会是来自 Telegram 库的更具体的类型 (例如 Telegraf 的 `Update`)
	reply: (text: string, parse_mode?: string) => Promise<Response | undefined>;
	getFile: (file_id: string) => Promise<Response>;
	api: TelegramApi;
	bot: TelegramBot;
	update_type: string;
}

/**
 * 代表 D1 数据库中消息记录的结构。
 */
export type MessageRecord = {
	id: string; // 主键，通常是消息链接
	groupId: number;
	userName: string;
	content: string;
	messageId: number;
	timeStamp: number;
	groupName: string;
};
