/**
 * 群组详情/群聊页
 *
 * 【交互】
 * - 左侧：群组信息（成员管理、机器人管理、离开群组）；
 * - 右侧：群聊窗口（人类/机器人发言，发送消息触发机器人回复）；
 * - 成员可离开群组；创建者可添加/移除成员与机器人。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import type { Bot, Group, GroupMessage, SendGroupMessageResult } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';

export default function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [group, setGroup] = useState<Group | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [addUserId, setAddUserId] = useState('');
  const [addBotId, setAddBotId] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const isOwner = user !== null && group?.creatorId === user.id;

  /**
   * 加载群组详情、可用机器人与最近历史消息（默认返回最近 50 条，升序）
   */
  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [groupRes, botsRes, messagesRes] = await Promise.all([
        api<{ group: Group }>(`/groups/${id}`),
        api<{ bots: Bot[] }>('/bots'),
        api<{ messages: GroupMessage[] }>(`/groups/${id}/messages?limit=50`),
      ]);
      setGroup(groupRes.group);
      setBots(botsRes.bots);
      setMessages(messagesRes.messages);
      setHasMore(messagesRes.messages.length === 50);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 加载更早的群组历史消息（before = 当前最早一条消息的 id，结果前插）
   */
  const loadOlder = async () => {
    if (!id || messages.length === 0 || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const first = messages[0]!;
      const res = await api<{ messages: GroupMessage[] }>(
        `/groups/${id}/messages?before=${encodeURIComponent(first.id)}&limit=50`,
      );
      setMessages((prev) => [...res.messages, ...prev]);
      setHasMore(res.messages.length === 50);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载更早消息失败');
    } finally {
      setLoadingMore(false);
    }
  };

  // 仅当消息追加在末尾（发送新消息）时滚动到底部；加载更早消息（前插）时不滚动
  const prevFirstId = useRef<string | null>(null);
  useEffect(() => {
    const firstId = messages[0]?.id ?? null;
    if (prevFirstId.current !== null && firstId === prevFirstId.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevFirstId.current = firstId;
  }, [messages]);

  /** 机器人 id → 名称映射（渲染消息时显示发言者） */
  const botNameById = (botId: string | null): string => {
    const bot = group?.bots.find((b) => b.id === botId);
    return bot?.name ?? '机器人';
  };

  /**
   * 发送群组消息：追加人类消息与机器人回复
   *
   * @param e 表单提交事件
   */
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!id || !input.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const result = await api<SendGroupMessageResult>(`/groups/${id}/messages`, {
        method: 'POST',
        body: { content: input.trim() },
      });
      setMessages((prev) => [...prev, result.userMessage, ...result.botMessages]);
      setInput('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  /**
   * 添加成员（创建者）
   */
  const addMember = async () => {
    if (!id || !addUserId.trim()) return;
    try {
      await api(`/groups/${id}/members`, { method: 'POST', body: { userId: addUserId.trim() } });
      setAddUserId('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '添加失败');
    }
  };

  /**
   * 移除成员（创建者；不能移除创建者本人）
   *
   * @param userId 成员用户 id
   */
  const removeMember = async (userId: string) => {
    if (!id) return;
    await api(`/groups/${id}/members/${userId}`, { method: 'DELETE' });
    await load();
  };

  /**
   * 添加机器人（创建者）
   */
  const addBot = async () => {
    if (!id || !addBotId) return;
    await api(`/groups/${id}/bots`, { method: 'POST', body: { botId: addBotId } });
    setAddBotId('');
    await load();
  };

  /**
   * 移除机器人（创建者；至少保留 1 个）
   *
   * @param botId 机器人 id
   */
  const removeBot = async (botId: string) => {
    if (!id) return;
    await api(`/groups/${id}/bots/${botId}`, { method: 'DELETE' });
    await load();
  };

  /**
   * 离开群组（创建者不可离开，由后端 403 拦截）
   */
  const leave = async () => {
    if (!id) return;
    await api(`/groups/${id}/members/me`, { method: 'DELETE' });
    navigate('/groups');
  };

  return (
    <div className="page">
      <div className="page-header">
        <button className="secondary" onClick={() => navigate('/groups')}>
          ← 返回
        </button>
        <h3 style={{ margin: 0 }}>{group?.name ?? '群组'}</h3>
        <button className="danger" onClick={() => void leave()}>
          离开群组
        </button>
      </div>

      <div className="error-text">{error}</div>

      <div className="grid-2">
        <div>
          <div className="card">
            <h4 style={{ marginTop: 0 }}>成员（{group?.members.length ?? 0}）</h4>
            {group?.members.map((member) => (
              <div className="member-row" key={member.userId}>
                <span>
                  {member.displayName} <span className="role-badge">{member.role}</span>
                </span>
                {isOwner && member.role !== 'OWNER' && (
                  <button className="secondary" onClick={() => void removeMember(member.userId)}>
                    移除
                  </button>
                )}
              </div>
            ))}
            {isOwner && (
              <div className="item-row" style={{ marginTop: 10 }}>
                <input
                  value={addUserId}
                  onChange={(e) => setAddUserId(e.target.value)}
                  placeholder="用户 id"
                />
                <button className="secondary" onClick={() => void addMember()}>
                  添加
                </button>
              </div>
            )}
          </div>

          <div className="card">
            <h4 style={{ marginTop: 0 }}>机器人（{group?.bots.length ?? 0}）</h4>
            {group?.bots.map((bot) => (
              <div className="bot-row" key={bot.id}>
                <span>{bot.name}</span>
                {isOwner && (
                  <button className="secondary" onClick={() => void removeBot(bot.id)}>
                    移除
                  </button>
                )}
              </div>
            ))}
            {isOwner && (
              <div className="item-row" style={{ marginTop: 10 }}>
                <select value={addBotId} onChange={(e) => setAddBotId(e.target.value)}>
                  <option value="">选择机器人…</option>
                  {bots
                    .filter((b) => !group?.bots.some((gb) => gb.id === b.id))
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                </select>
                <button className="secondary" onClick={() => void addBot()}>
                  添加
                </button>
              </div>
            )}
            <div className="item-meta" style={{ marginTop: 8 }}>
              策略：{group?.responseMode} · 每轮上限：{group?.maxConsecutiveBotReplies}
            </div>
          </div>
        </div>

        <div className="card chat-window">
          <div className="chat-messages">
            {hasMore && (
              <div className="center" style={{ padding: 8 }}>
                <button
                  className="secondary"
                  onClick={() => void loadOlder()}
                  disabled={loadingMore}
                >
                  {loadingMore ? '加载中…' : '加载更早消息'}
                </button>
              </div>
            )}
            {messages.map((message) => (
              <div key={message.id}>
                <div className={`bubble ${message.senderType === 'HUMAN' ? 'user' : 'bot'}`}>
                  {message.senderType === 'BOT' && (
                    <div className="item-meta">{botNameById(message.botId)}</div>
                  )}
                  {message.content}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <form className="chat-input" onSubmit={(e) => void send(e)}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="发送消息，机器人将按策略回复…"
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
    </div>
  );
}
