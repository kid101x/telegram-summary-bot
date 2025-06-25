/**
 * 用于存放不希望机器人响应和记录的关键词。
 * 如果收到的消息以这个列表中的任何一个词开头，机器人将直接忽略该消息。
 */
export const IGNORED_KEYWORDS: string[] = ['签到', '打卡', '查找'];
/*
 * 计划将常量、变量都转移过来，集中管理
 */

export const aiConfig = {
	model: 'gemini-2.0-flash',
	temperature: 0.4,
	timeout: 30000, // 30 seconds
};

export const prompts = {
	summarizeChat: '你是一个专业的群聊概括助手...', // 省略长文本
	answerQuestion: '你是一个群聊智能助手...', // 省略长文本
};

export const botConfig = {
	baseRepoUrl: 'https://github.com/asukaminato0721/telegram-summary-bot',
};
