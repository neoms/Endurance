-- 群组消息增加幂等键（与个人对话消息的幂等设计一致）
-- 背景：群组发送没有幂等保护，前端重试/网络重发可能产生重复消息。
-- 增加 clientRequestId，并以 (groupId, clientRequestId) 复合唯一约束限定在群组内。
ALTER TABLE "group_messages" ADD COLUMN "clientRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "group_messages_groupId_clientRequestId_key" ON "group_messages"("groupId", "clientRequestId");
