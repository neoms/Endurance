-- 幂等键复合唯一约束改造
-- 背景：clientRequestId 原先为全局唯一，查找时不限定对话/用户，
-- 导致用户 B 复用用户 A 的幂等键时泄露 A 的消息且 B 的消息不落库。
-- 改为 (conversationId, clientRequestId) 复合唯一：配合对话所有权校验，
-- 幂等键天然按用户隔离。

-- DropIndex
DROP INDEX "messages_clientRequestId_key";

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversationId_clientRequestId_key" ON "messages"("conversationId", "clientRequestId");
