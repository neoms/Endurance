/**
 * 聊天页（个人对话）
 *
 * 【交互】
 * - 加载对话与历史消息（最近 50 条）；
 * - 发送消息：后端同步返回用户消息 + AI 回复，直接追加到列表；
 * - AI 失败（status=FAILED）展示错误标记与「重试」按钮（调用 retry 接口）。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import type { Conversation, Message, SendMessageResult } from '../api/types.js';

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  /**
   * 加载对话详情与历史消息
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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // 新消息到达时滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
    try {
      const result = await api<SendMessageResult>(`/conversations/${id}/messages`, {
        method: 'POST',
        body: { content: input.trim() },
      });
      setMessages((prev) => [
        ...prev,
        result.userMessage,
        ...(result.aiMessage ? [result.aiMessage] : []),
      ]);
      setInput('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '发送失败');
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
    <div className="page">
      <div className="page-header">
        <button className="secondary" onClick={() => navigate('/')}>
          ← 返回
        </button>
        <h3 style={{ margin: 0 }}>{conversation?.title ?? '对话'}</h3>
        <span />
      </div>

      <div className="card chat-window">
        <div className="chat-messages">
          {messages.map((message) => (
            <div key={message.id}>
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
                  message.content
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="error-text">{error}</div>
        <form className="chat-input" onSubmit={(e) => void send(e)}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(e);
              }
            }}
          />
          <button type="submit" disabled={sending || !input.trim()}>
            发送
          </button>
        </form>
      </div>
    </div>
  );
}
