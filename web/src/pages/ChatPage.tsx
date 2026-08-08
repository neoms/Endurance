/**
 * 聊天页（个人对话）
 *
 * 【交互】
 * - 首屏加载最近 50 条历史消息，顶部「加载更早」按钮用 before 游标翻页取更早消息；
 * - 发送消息：走 SSE 流式接口（?stream=true），用户消息先落库返回，
 *   AI 回复以 ai_delta 增量逐块渲染（打字机效果），完成后以 ai_done 固化；
 * - 发送携带 clientRequestId 幂等键：失败重试同一条消息不会产生重复消息；
 * - AI 失败（status=FAILED）展示错误标记与「重试」按钮（调用 retry 接口）。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';

import { api, ApiError, apiStream } from '../api/client.js';
import type { Conversation, Message } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import MentionText from '../components/MentionText.js';

// 默认标题截断长度：与后端 message.service 的 MAX_TITLE_LENGTH 保持一致，
// 首条消息用作标题时超长截断（避免侧边栏被长标题撑爆）
const MAX_TITLE_LENGTH = 30;

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // 流式进行中的 AI 回复文本：非 null 时在消息列表尾部渲染「打字中」气泡
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  // 当前待发送消息的幂等键：发送失败后保留，重试同一条消息时后端去重；
  // 发送成功或用户修改输入后清空（幂等键只对同一条消息有效）
  const requestIdRef = useRef<string | null>(null);

  /**
   * 加载对话详情与最近历史消息（默认返回最近 50 条，升序）
   */
  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [conv, history] = await Promise.all([
        api<{ conversation: Conversation }>(`/conversations/${id}`),
        api<{ messages: Message[] }>(`/conversations/${id}/messages?limit=50`),
      ]);
      setConversation(conv.conversation);
      setMessages(history.messages);
      // 恰好取满一页时无法确定是否还有更早的消息，先假设有；加载更多返回空时再置 false
      setHasMore(history.messages.length === 50);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 加载更早的历史消息（before = 当前最早一条消息的 id）
   *
   * 说明：结果会前插到消息列表头部；若返回不足一页，说明没有更早消息了。
   */
  const loadOlder = async () => {
    if (!id || messages.length === 0 || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const first = messages[0]!;
      const res = await api<{ messages: Message[] }>(
        `/conversations/${id}/messages?before=${encodeURIComponent(first.id)}&limit=50`,
      );
      setMessages((prev) => [...res.messages, ...prev]);
      setHasMore(res.messages.length === 50);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载更早消息失败');
    } finally {
      setLoadingMore(false);
    }
  };

  // 仅当「消息追加在末尾」（首条 id 不变，如发送新消息）时滚动到底部；
  // 加载更早消息（前插）时不滚动，避免打断用户阅读位置。
  const prevFirstId = useRef<string | null>(null);
  useEffect(() => {
    const firstId = messages[0]?.id ?? null;
    if (prevFirstId.current !== null && firstId === prevFirstId.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevFirstId.current = firstId;
  }, [messages]);

  // 流式增量到达时持续滚动到底部，保持「最新内容可见」
  useEffect(() => {
    if (streamingText !== null) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamingText]);

  /**
   * 发送消息：追加用户消息与 AI 回复
   *
   * @param e 表单提交事件
   */
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!id || !input.trim() || sending) return;
    setSending(true);
    setError('');
    // 立即显示空的「打字中」气泡；后续 ai_delta 逐块填充
    setStreamingText('');
    // 失败重试复用同一幂等键（后端返回首次结果）；首次发送生成新键
    const requestId = requestIdRef.current ?? crypto.randomUUID();
    requestIdRef.current = requestId;
    try {
      // SSE 流式发送：user_message 追加用户气泡，ai_delta 增量渲染，
      // ai_done/ai_error 把最终消息固化进列表并关闭「打字中」气泡
      await apiStream(
        `/conversations/${id}/messages`,
        { content: input.trim(), clientRequestId: requestId },
        {
          user_message: (data) => {
            const message = (data as { message: Message }).message;
            setMessages((prev) => [...prev, message]);
            // 默认标题对话：首条用户消息立即成为标题（与后端替换规则一致：
            // 仅当 isDefaultTitle=true 且从未手动改过才替换），并同步给侧边栏列表
            setConversation((prev) => {
              if (!prev || !prev.isDefaultTitle) {
                return prev;
              }
              const title =
                message.content.length > MAX_TITLE_LENGTH
                  ? `${message.content.slice(0, MAX_TITLE_LENGTH)}…`
                  : message.content;
              return { ...prev, title, isDefaultTitle: false };
            });
            // 通知侧边栏重新拉取对话列表（标题已变化，立即同步显示）
            window.dispatchEvent(new Event('conversation-updated'));
          },
          ai_delta: (data) => {
            const delta = (data as { delta: string }).delta;
            setStreamingText((prev) => (prev ?? '') + delta);
          },
          ai_done: (data) => {
            const message = (data as { message: Message }).message;
            setMessages((prev) => [...prev, message]);
            setStreamingText(null);
          },
          ai_error: (data) => {
            // 失败占位消息（FAILED）：与普通消息一样展示错误与重试按钮
            const message = (data as { message: Message }).message;
            setMessages((prev) => [...prev, message]);
            setStreamingText(null);
          },
          error: (data) => {
            // 前置校验失败（如对话不存在）：展示错误并关闭「打字中」气泡
            const err = (data as { error?: { message?: string } }).error;
            setError(err?.message ?? '发送失败');
            setStreamingText(null);
          },
        },
      );
      setInput('');
      requestIdRef.current = null;
    } catch (err) {
      // 保留幂等键：用户重试同一条消息时不会产生重复消息
      setError(err instanceof ApiError ? err.message : '发送失败');
      setStreamingText(null);
    } finally {
      setSending(false);
    }
  };

  /**
   * 重试失败的 AI 消息
   *
   * @param messageId 失败的 AI 消息 id
   */
  const retry = async (messageId: string) => {
    try {
      const res = await api<{ aiMessage: Message }>(`/messages/${messageId}/retry`, {
        method: 'POST',
      });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? res.aiMessage : m)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '重试失败');
    }
  };

  return (
    <>
      <div className="chat-header">{conversation?.title ?? '对话'}</div>
      <div className="chat-messages">
        <div className="chat-scroll">
          {hasMore && (
            <div className="center-load">
              <button className="secondary" onClick={() => void loadOlder()} disabled={loadingMore}>
                {loadingMore ? '加载中…' : '加载更早消息'}
              </button>
            </div>
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              className={`message-row ${message.senderType === 'HUMAN' ? 'user' : 'bot'}`}
            >
              {/* NPC 消息：头像在左 */}
              {message.senderType === 'BOT' && <div className="avatar-sm bot">AI</div>}
              <div className="message-content">
                <div className="message-author">
                  {/* 自己的消息显示用户名而不是「我」，便于多端对照发言者 */}
                  {message.senderType === 'HUMAN' ? (user?.username ?? '我') : 'AI 助手'}
                </div>
                <div
                  className={`bubble ${message.senderType === 'HUMAN' ? 'user' : 'bot'} ${
                    message.status === 'FAILED' ? 'failed' : ''
                  }`}
                >
                  {message.status === 'FAILED' ? (
                    <>
                      <div>AI 回复失败（{message.errorCode ?? '未知错误'}）</div>
                      <button
                        className="secondary"
                        style={{ marginTop: 8 }}
                        onClick={() => void retry(message.id)}
                      >
                        重试
                      </button>
                    </>
                  ) : (
                    <MentionText text={message.content} />
                  )}
                </div>
              </div>
              {/* 用户消息：头像在右 */}
              {message.senderType === 'HUMAN' && (
                <div className="avatar-sm user">
                  {user?.username?.slice(0, 1).toUpperCase() ?? '我'}
                </div>
              )}
            </div>
          ))}
          {/* 流式进行中的 AI 气泡：增量文本 + 闪烁光标 */}
          {streamingText !== null && (
            <div className="message-row bot">
              <div className="avatar-sm bot">AI</div>
              <div className="message-content">
                <div className="message-author">AI 助手</div>
                <div className="bubble bot streaming">
                  <MentionText text={streamingText} />
                  <span className="streaming-cursor">▍</span>
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="chat-input-wrap">
        <div className="error-text">{error}</div>
        <form className="chat-input" onSubmit={(e) => void send(e)}>
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // 输入内容变化 → 清空幂等键（新内容必须使用新键）
              requestIdRef.current = null;
            }}
            placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
            onKeyDown={(e) => {
              // isComposing：中文输入法按回车「上屏」时不触发发送，避免发出不完整的输入内容
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(e);
              }
            }}
          />
          <button type="submit" className="send-btn" disabled={sending || !input.trim()}>
            ➤
          </button>
        </form>
      </div>
    </>
  );
}
