// src/ai.ts
import OpenAI from 'openai';
import type { MessageRecord } from './types';
import { aiConfig, SYSTEM_PROMPTS, PROMPT_FORMATTING } from './config';
import { getMessageLink } from './utils/telegram';

// 定义消息内容的类型
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

/**
 * 根据环境变量创建和配置 OpenAI 客户端。
 * 优先使用 AI Gateway (通过 secrets)，否则在显式开启时回退到 AI_BASE_URL (通过 vars)。
 * @param env Worker 环境变量
 * @returns 配置好的 OpenAI 实例
 */
function createOpenAIClient(env: Env): OpenAI {
	let baseURL: string | undefined;
	const apiKey = env.AI_API_KEY || 'local-no-key';

	// 1. 默认模式：尝试使用 AI Gateway
	if (env.ACCOUNT_ID && env.AI_GATEWAY_ID) {
		// 根据 OpenAI-Compatibility.md 文档，使用 /compat 路径
		baseURL = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.AI_GATEWAY_ID}/compat`;
	}
	// 2. 回退模式：检查是否显式要求使用 AI_BASE_URL
	else if (env.FORCE_USE_AI_BASE_URL === 'true') {
		if (!env.AI_BASE_URL) {
			throw new Error("Configuration error: FORCE_USE_AI_BASE_URL is 'true', but the AI_BASE_URL variable is missing.");
		}
		baseURL = env.AI_BASE_URL;
	}
	// 3. 如果两种模式都未配置，则抛出清晰的错误
	else {
		throw new Error(
			"AI provider is not configured. Please provide EITHER [ACCOUNT_ID and AI_GATEWAY_ID secrets] OR [set FORCE_USE_AI_BASE_URL='true' and define the AI_BASE_URL variable]."
		);
	}

	return new OpenAI({
		apiKey: apiKey,
		baseURL: baseURL,
		defaultHeaders: {
			// 超时单位为秒
			'cf-aig-request-timeout': `${aiConfig.timeout}`,
		},
	});
}


/**
 * 获取 AI 模型的响应
 * @param env Worker 环境变量
 * @param messages 消息列表
 * @param promptType 提示类型
 * @param question 用户问题（可选）
 * @returns AI 模型的响应文本
 */
async function getAIResponse(
	env: Env,
	messages: MessageRecord[],
	promptType: 'summarizeChat' | 'answerQuestion',
	question?: string,
): Promise<string> {
	const ai = createOpenAIClient(env);
	const model = env.AI_MODEL_NAME || 'google/gemini-pro';

	const systemPrompt = SYSTEM_PROMPTS[promptType];
	const contentParts: (OpenAI.Chat.Completions.ChatCompletionContentPartText | OpenAI.Chat.Completions.ChatCompletionContentPartImage)[] = [];
    const textParts: string[] = [];

    messages.forEach((r: MessageRecord) => {
        const dispatched = dispatchContent(r.content);
        if (dispatched.type === 'image_url') {
            contentParts.push(dispatched);
            textParts.push(`${r.userName}: [发了一张图片] ${getMessageLink(r)}`);
        } else {
            textParts.push(`${r.userName}:\n${r.content}\n${getMessageLink(r)}`);
        }
    });

    const combinedText = textParts.join(`\n${PROMPT_FORMATTING.messageSeparator}\n`);
    contentParts.unshift({ type: 'text', text: combinedText });

    if (question) {
        const lastTextPart = contentParts.find(part => part.type === 'text');
        if (lastTextPart && lastTextPart.type === 'text') {
            lastTextPart.text += `\n\n问题：${question}`;
        } else {
            contentParts.push({ type: 'text', text: `问题：${question}` });
        }
    }

	try {
		const result = await ai.chat.completions.create({
			model: model,
			messages: [
				{
					role: 'system',
					content: systemPrompt,
				},
				{
					role: 'user',
					content: contentParts,
				},
			],
			max_tokens: 4096,
			temperature: aiConfig.temperature,
		});
		return result.choices[0].message.content || '';
	} catch (e) {
		console.error(`Error getting AI response for ${promptType}:`, e);
		throw new Error(`Failed to get AI response: ${e instanceof Error ? e.message : 'Unknown error'}`);
	}
}

/**
 * 生成聊天摘要
 * @param env Worker 环境变量
 * @param messages 消息列表
 * @returns 聊天摘要
 */
export async function getSummary(env: Env, messages: MessageRecord[]): Promise<string> {
	return getAIResponse(env, messages, 'summarizeChat');
}

/**
 * 回答有关聊天记录的问题
 * @param env Worker 环境变量
 * @param messages 消息列表
 * @param question 用户问题
 * @returns AI 对问题的回答
 */
export async function answerQuestion(env: Env, messages: MessageRecord[], question: string): Promise<string> {
	return getAIResponse(env, messages, 'answerQuestion', question);
}
