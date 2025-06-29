// src/db.ts

import type { MessageRecord } from './types'; // 我们将把类型定义也移出来
import { getMessageLink } from './utils/telegram';

/**
 * 将一条消息记录插入或替换到数据库中。
 * @param db D1Database 实例
 * @param message 消息对象
 */
export async function saveMessage(
	db: D1Database,
	message: Omit<MessageRecord, 'id' | 'groupName'> & { groupName?: string },
): Promise<void> {
	const { groupId, timeStamp, userName, content, messageId } = message;
	const id = getMessageLink({ groupId: groupId, messageId: messageId });
	const groupName = message.groupName || 'anonymous';

	try {
		await db
			.prepare(
				'INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)',
			)
			.bind(id, groupId, timeStamp, userName, content, messageId, groupName)
			.run();
	} catch (e) {
		console.error('Failed to save message:', e);
	}
}

/**
 * 根据消息数量获取一个群组的消息记录。
 * @param db D1Database 实例
 * @param groupId 群组ID
 * @param limit 消息数量
 */
export async function getMessagesByCount(db: D1Database, groupId: number, limit: number): Promise<MessageRecord[]> {
	const { results } = await db
		.prepare(
			`
        WITH latest_n AS (
            SELECT * FROM Messages
            WHERE groupId = ?1
            ORDER BY timeStamp DESC
            LIMIT ?2
        )
        SELECT * FROM latest_n
        ORDER BY timeStamp ASC
        `,
		)
		.bind(groupId, Math.min(limit, 4000)) // 增加一个保护，防止查询过多
		.all<MessageRecord>();
	return results || [];
}

/**
 * 根据时间范围获取一个群组的消息记录。
 * @param db D1Database 实例
 * @param groupId 群组ID
 * @param hours 小时数
 */
export async function getMessagesByHours(db: D1Database, groupId: number, hours: number): Promise<MessageRecord[]> {
	const since = Date.now() - hours * 60 * 60 * 1000;
	const { results } = await db
		.prepare(
			`
        SELECT *
        FROM Messages
        WHERE groupId = ?1 AND timeStamp >= ?2
        ORDER BY timeStamp ASC
        `,
		)
		.bind(groupId, since)
		.all<MessageRecord>();
	return results || [];
}

/**
 * (新增) 根据关键词搜索消息。
 * @param db D1Database 实例
 * @param groupId 群组ID
 * @param searchTerm 搜索词 (支持 GLOB)
 */
export async function searchMessages(db: D1Database, groupId: number, searchTerm: string): Promise<MessageRecord[]> {
	const { results } = await db
		.prepare(
			`
        SELECT * FROM Messages
        WHERE groupId = ?1 AND content GLOB ?2
        ORDER BY timeStamp DESC
        LIMIT 2000
        `,
		)
		.bind(groupId, searchTerm)
		.all<MessageRecord>();
	return results || [];
}

/**
 * 获取所有在过去24小时内消息数超过阈值的活跃群组。
 * @param db D1Database 实例
 * @param threshold 消息数阈值
 */
export async function getActiveGroups(db: D1Database, threshold: number): Promise<{ groupId: number; message_count: number }[]> {
	const twentyFourHoursAgo = Date.now() - 24 * 3600 * 1000;
	const { results } = await db
		.prepare(
			`
        WITH MessageCounts AS (
            SELECT
                groupId,
                COUNT(*) as message_count
            FROM Messages
            WHERE timeStamp >= ?1
            GROUP BY groupId
        )
        SELECT groupId, message_count
        FROM MessageCounts
        WHERE message_count > ?2
        ORDER BY message_count DESC;
        `,
		)
		.bind(twentyFourHoursAgo, threshold)
		.all<{ groupId: number; message_count: number }>();
	return results || [];
}

/**
 * 清理每个群组中超过数量阈值的旧消息。
 * @param db D1Database 实例
 * @param threshold 消息保留数量上限
 */
export async function cleanupOldMessages(db: D1Database, threshold: number): Promise<void> {
	try {
		await db
			.prepare(
				`
            DELETE FROM Messages
            WHERE id IN (
                SELECT id
                FROM (
                    SELECT
                        id,
                        ROW_NUMBER() OVER (
                            PARTITION BY groupId
                            ORDER BY timeStamp DESC
                        ) as row_num
                    FROM Messages
                ) ranked
                WHERE row_num > ?1
            );`,
			)
			.bind(threshold)
			.run();
		console.log('Successfully cleaned up old messages.');
	} catch (e) {
		console.error('Failed to clean up old messages:', e);
	}
}

/**
 * 清理超过保留期限的旧图片消息。
 * @param db D1Database 实例
 * @param retentionPeriodMs 图片保留毫秒数
 */
export async function cleanupOldImages(db: D1Database, retentionPeriodMs: number): Promise<void> {
	// 定义2天的毫秒数，更具可读性
	const cutoffTimestamp = Date.now() - retentionPeriodMs;
	try {
		await db
			.prepare(
				`
            DELETE
            FROM Messages
            WHERE timeStamp < ?1 AND content LIKE 'data:image/jpeg;base64,%'`,
			)
			.bind(cutoffTimestamp) // 使用计算好的时间戳
			.run();
		console.log('Successfully cleaned up old images.');
	} catch (e) {
		console.error('Failed to clean up old images:', e);
	}
}
