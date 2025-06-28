// src/types.ts

/**
 * 数据库中消息记录的结构
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
