/**
 * 群组详情/群聊页
 *
 * 【交互】
 * - 左侧：群组信息（成员管理、机器人管理、离开群组）；
 * - 左侧（创建者）：群组设置（名称/响应策略/每轮回复上限，保存调 PATCH）；
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
  // 添加成员：按用户名（全局唯一、大小写敏感）精确匹配
  const [addUsername, setAddUsername] = useState('');
  const [addBotId, setAddBotId] = useState('');
  // 群组设置编辑表单（仅创建者可见）
  const [editName, setEditName] = useState('');
  const [editResponseMode, setEditResponseMode] = useState<
    'ALL_BOTS' | 'RANDOM_ONE' | 'CONTENT_ROUTED'
  >('ALL_BOTS');
  const [editMaxReplies, setEditMaxReplies] = useState(3);
  const [savingConfig, setSavingConfig] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 当前待发送消息的幂等键：发送失败后保留，重试同一条消息时后端去重；
  // 发送成功或用户修改输入后清空（幂等键只对同一条消息有效）
  const requestIdRef = useRef<string | null>(null);

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

  // 群组加载/更新后同步编辑表单（避免修改后显示旧值）
  useEffect(() => {
    if (group) {
      setEditName(group.name);
      setEditResponseMode(group.responseMode);
      setEditMaxReplies(group.maxConsecutiveBotReplies);
    }
  }, [group]);

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
    // 失败重试复用同一幂等键（后端返回首次轮次结果）；首次发送生成新键
    const requestId = requestIdRef.current ?? crypto.randomUUID();
    requestIdRef.current = requestId;
    try {
      const result = await api<SendGroupMessageResult>(`/groups/${id}/messages`, {
        method: 'POST',
        body: { content: input.trim(), clientRequestId: requestId },
      });
      setMessages((prev) => [...prev, result.userMessage, ...result.botMessages]);
      setInput('');
      requestIdRef.current = null;
    } catch (err) {
      // 保留幂等键：用户重试同一条消息时不会产生重复消息
      setError(err instanceof ApiError ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  /**
   * 添加成员（创建者）：按用户名精确匹配（大小写敏感），
   * 用户名由后端唯一索引保证全局唯一，无需前端猜测用户 id。
   */
  const addMember = async () => {
    if (!id || !addUsername.trim()) return;
    try {
      await api(`/groups/${id}/members`, {
        method: 'POST',
        body: { username: addUsername.trim() },
      });
      setAddUsername('');
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

  /**
   * 保存群组设置（仅创建者；后端越权返回 403）
   *
   * 说明：一次性提交名称/响应策略/每轮回复上限三个字段，
   * 与后端 PATCH /api/groups/:id 的校验规则一致（名称 1-50、上限 1-10）。
   */
  const saveConfig = async () => {
    if (!id || !editName.trim() || savingConfig) return;
    setSavingConfig(true);
    setError('');
    try {
      await api(`/groups/${id}`, {
        method: 'PATCH',
        body: {
          name: editName.trim(),
          responseMode: editResponseMode,
          maxConsecutiveBotReplies: editMaxReplies,
        },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="group-detail">
      {/* 群聊主区 */}
      <div className="group-chat">
        <div className="chat-header">{group?.name ?? '群组'}</div>
        <div className="chat-messages">
          <div className="chat-scroll">
            {hasMore && (
              <div className="center-load">
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
              <div
                key={message.id}
                className={`message-row ${message.senderType === 'HUMAN' ? 'user' : 'bot'}`}
              >
                {/* 机器人消息：头像在左（用机器人名首字占位） */}
                {message.senderType === 'BOT' && (
                  <div className="avatar-sm bot">{botNameById(message.botId).slice(0, 1)}</div>
                )}
                <div className="message-content">
                  <div className="message-author">
                    {message.senderType === 'HUMAN' ? '我' : botNameById(message.botId)}
                  </div>
                  <div className={`bubble ${message.senderType === 'HUMAN' ? 'user' : 'bot'}`}>
                    {message.content}
                  </div>
                </div>
                {/* 用户消息：头像在右 */}
                {message.senderType === 'HUMAN' && <div className="avatar-sm user">我</div>}
              </div>
            ))}
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
              placeholder="发送消息，机器人将按策略回复…"
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
      </div>

      {/* 群组信息侧栏 */}
      <aside className="group-info">
        <div className="card">
          <div className="card-title">成员（{group?.members.length ?? 0}）</div>
          {group?.members.map((member) => (
            <div className="member-row" key={member.userId}>
              <div className="member-avatar">
                {(member.displayName || member.username).slice(0, 1).toUpperCase()}
              </div>
              <div className="member-info">
                <div className="member-name">
                  {member.displayName} <span className="role-badge">{member.role}</span>
                </div>
                <div className="member-username">@{member.username}</div>
              </div>
              {isOwner && member.role !== 'OWNER' && (
                <button className="secondary" onClick={() => void removeMember(member.userId)}>
                  移除
                </button>
              )}
            </div>
          ))}
          {isOwner && (
            <div className="add-member-row">
              <input
                value={addUsername}
                onChange={(e) => setAddUsername(e.target.value)}
                placeholder="输入用户名添加（大小写敏感）"
                maxLength={32}
                onKeyDown={(e) => {
                  // 回车直接提交，减少操作步骤
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void addMember();
                  }
                }}
              />
              <button className="secondary" onClick={() => void addMember()}>
                添加
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">机器人（{group?.bots.length ?? 0}）</div>
          {group?.bots.map((bot) => (
            <div className="bot-row" key={bot.id}>
              <div className="bot-avatar">{bot.name.slice(0, 1)}</div>
              <div className="member-info">
                <div className="member-name">{bot.name}</div>
                <div className="member-username">{bot.personality}</div>
              </div>
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

        {isOwner && (
          <div className="card">
            <div className="card-title">群组设置</div>
            <div className="field">
              <label htmlFor="groupNameEdit">名称（1-50）</label>
              <input
                id="groupNameEdit"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={50}
              />
            </div>
            <div className="field">
              <label htmlFor="responseModeEdit">响应策略</label>
              <select
                id="responseModeEdit"
                value={editResponseMode}
                onChange={(e) => setEditResponseMode(e.target.value as typeof editResponseMode)}
              >
                <option value="ALL_BOTS">全部机器人回复</option>
                <option value="RANDOM_ONE">随机一个回复</option>
                <option value="CONTENT_ROUTED">按内容路由</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="maxRepliesEdit">每轮回复上限（1-10）</label>
              <input
                id="maxRepliesEdit"
                type="number"
                min={1}
                max={10}
                value={editMaxReplies}
                onChange={(e) => setEditMaxReplies(Number(e.target.value))}
              />
            </div>
            <button onClick={() => void saveConfig()} disabled={savingConfig || !editName.trim()}>
              {savingConfig ? '保存中…' : '保存设置'}
            </button>
          </div>
        )}

        <button className="danger" style={{ width: '100%' }} onClick={() => void leave()}>
          离开群组
        </button>
      </aside>
    </div>
  );
}
