/**
 * 用于存放不希望机器人响应和记录的关键词。
 * 如果收到的消息以这个列表中的任何一个词开头，机器人将直接忽略该消息。
 */
export const IGNORED_KEYWORDS: string[] = ['签到', '打卡', '查找'];
/*
 * 计划将常量、变量都转移过来，集中管理
 */

// AI 模型相关配置
export const aiConfig = {
	model: 'gemini-2.0-flash',
	temperature: 0.4,
	timeout: 30000, // 30秒
};

// 系统提示
export const SYSTEM_PROMPTS = {
	summarizeChat: `你是一个专业的群聊概括助手。你的任务是用符合群聊风格的语气概括对话内容。
对话将按以下格式提供：
====================
用户名:
发言内容
相应链接
====================

请遵循以下指南：
1. 如果对话包含多个主题，请分条概括，每条开头插入接近主题的emoji。
2. 如果对话中提到图片，请在概括中包含相关内容描述。
3. 在回答中用markdown格式引用原对话的链接。
4. 链接格式应为：[引用1](链接本体)、[关键字1](链接本体)等。
5. 概括要简洁明了，捕捉对话的主要内容和情绪。
6. 概括的开头使用"本日群聊总结如下："`,

	answerQuestion: `你是一个群聊智能助手。你的任务是基于提供的群聊记录回答用户的问题。
群聊记录将按以下格式提供：
====================
用户名:
发言内容
相应链接
====================

请遵循以下指南：
1. 用符合群聊风格的语气回答问题。
2. 在回答中引用相关的原始消息作为依据。
3. 使用markdown格式引用原对话，格式为：[引用1](链接本体)、[关键字1](链接本体)。
4. 在链接两侧添加空格。
5. 如果找不到相关信息，请诚实说明。
6. 回答应该简洁但内容完整。`,
};

// 定时任务(Cron)相关配置
export const cronConfig = {
	// 触发每日总结需要的最小消息数
	dailySummaryMessageThreshold: 10,
	// 消息保留数量上限
	messageCleanupThreshold: 5000,
	// 图片保留时间（毫秒）
	imageRetentionPeriodMs: 2 * 24 * 60 * 60 * 1000, // 2天
	// 需要跳过发送总结的群组ID列表
	skipSummaryGroupIds: [-1001687785734],
};

// 机器人通用配置
export const botConfig = {
	// 开源项目地址
	repoUrl: 'https://github.com/asukaminato0721/telegram-summary-bot',
};
