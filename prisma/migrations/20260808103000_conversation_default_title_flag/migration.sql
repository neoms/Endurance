-- 为对话增加「是否为默认标题」标记
-- 背景：原先判断默认标题靠「标题字符串是否等于『新对话』」，用户手动把标题改回
-- 「新对话」后，下一条消息会再次覆盖标题。增加 isDefaultTitle 标记后，
-- 只有标记为默认标题的对话才会被首条用户消息自动替换标题。
ALTER TABLE "conversations" ADD COLUMN "isDefaultTitle" BOOLEAN NOT NULL DEFAULT true;
