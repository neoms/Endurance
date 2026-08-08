/**
 * 群组详情/群聊页
 *
 * 【交互】
 * - 左侧：群组信息（成员管理、机器人管理、离开群组）；
 * - 左侧（创建者）：群组设置（名称/响应策略/每轮回复上限，保存调 PATCH）；
 * - 右侧：群聊窗口（人类/机器人发言，发送消息触发机器人回复）；
 * - 成员可离开群组；创建者可添加/移除成员与机器人。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import type { Bot, Group, GroupMessage, SendGroupMessageResult } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import MentionText from '../components/MentionText.js';

/**
 * 计算光标处「正在输入的 @提及」（未闭合的 @token）
 *
 * @param text  输入框当前完整文本
 * @param caret 光标位置（selectionStart）
 * @returns { start, query } | null
 *   - start：@ 符号在文本中的下标（替换时从这里截断）；
 *   - query：@ 之后的已输入前缀（可为空串，表示刚输入 @ 还没打字）；
 *   - null：光标前没有正在输入的 @（例如 @ 前是空白、已输入完名称后跟空格，
 *     或 @ 前是字母数字——邮箱 a@b.com 不算提及，与后端解析规则一致）。
 */
function getActiveMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  // 从光标处向前匹配「非字母数字/下划线（或行首）@ 名称前缀$」：
  // - [^\s@，。！？!?；;：:]* 允许前缀为空（刚输入 @）或部分名称；
  // - 前面的字符类排除邮箱场景（a@b.com 中 @ 前是字母 a，不满足）。
  const match = /(^|[^a-zA-Z0-9_])@([^\s@，。！？!?；;：:]*)$/.exec(before);
  if (!match) {
    return null;
  }
  return { start: match.index + (match[1]?.length ?? 0), query: match[2] ?? '' };
}

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
  // 消息输入框 DOM 引用（@提及补全需要按光标位置插入文本并重新聚焦）
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 当前待发送消息的幂等键：发送失败后保留，重试同一条消息时后端去重；
  // 发送成功或用户修改输入后清空（幂等键只对同一条消息有效）
  const requestIdRef = useRef<string | null>(null);
  // @提及补全状态：mentionQuery 非 null 表示正在输入 @（值为 @ 后的前缀，可为空串）
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  // 候选列表中当前高亮的项（配合 ↑/↓ 键盘导航）
  const [mentionIndex, setMentionIndex] = useState(0);

  const isOwner = user !== null && group?.creatorId === user.id;

  /**
   * @提及补全候选：当前群组成员（用户名）+ 群组机器人（名称），按前缀过滤。
   * 说明：候选与后端校验规则一一对应——真人按用户名、机器人按名称，
   * 因此这里列出的每一项都能被后端正确解析（@ 真人合法但不触发逻辑）。
   */
  const mentionCandidates = useMemo(() => {
    if (!group || mentionQuery === null) {
      return [];
    }
    const q = mentionQuery.toLowerCase();
    const members = group.members
      // 候选列表不包含当前登录用户自己（@ 自己没有意义）
      .filter((m) => m.userId !== user?.id)
      .filter((m) => q === '' || m.username.toLowerCase().includes(q))
      .map((m) => ({
        key: `user:${m.userId}`,
        label: m.username,
        sub: m.displayName,
        kind: 'user' as const,
      }));
    const bots = group.bots
      .filter((b) => q === '' || b.name.toLowerCase().includes(q))
      .map((b) => ({
        key: `bot:${b.id}`,
        label: b.name,
        sub: '机器人',
        kind: 'bot' as const,
      }));
    return [...members, ...bots];
  }, [group, mentionQuery, user?.id]);

  // 查询条件变化时把键盘高亮重置到第一项
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

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

  /**
   * 机器人 id → 名称映射（兜底用）
   *
   * 优先从「当前群组机器人」里找，其次从「全量机器人列表」找
   * （机器人被移出群组后仍存在于全量列表，历史消息能显示原名）；
   * 正常路径下后端已在消息里返回 senderName，这里仅兜底。
   */
  const botNameById = (botId: string | null): string => {
    if (!botId) return '机器人';
    const bot = group?.bots.find((b) => b.id === botId) ?? bots.find((b) => b.id === botId);
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
   * 从候选列表中选择 @ 对象：用「@名称 」替换光标处未闭合的 @token
   *
   * @param candidate 被选中的候选（真人用户名或机器人名称）
   * 逻辑：定位光标前的 @ 起始位置 → 保留 @ 之前与光标之后的内容 →
   * 插入「@label 」→ 关闭候选列表并把光标移到插入文本末尾。
   */
  const selectMention = (candidate: {
    key: string;
    label: string;
    sub: string;
    kind: 'user' | 'bot';
  }) => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    const caret = el.selectionStart ?? input.length;
    const active = getActiveMention(input, caret);
    if (!active) {
      return;
    }
    const inserted = `@${candidate.label} `;
    const next = input.slice(0, active.start) + inserted + input.slice(caret);
    setInput(next);
    setMentionQuery(null);
    // 内容变化 → 幂等键失效（与手动输入一致）
    requestIdRef.current = null;
    // 光标移动到插入文本之后并保持聚焦，方便继续输入
    requestAnimationFrame(() => {
      el.focus();
      const pos = active.start + inserted.length;
      el.setSelectionRange(pos, pos);
    });
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
            {messages.map((message) => {
              // 仅「当前登录用户」自己发的消息靠右显示「我」；
              // 其他人（含其他真人）的消息一律靠左并显示发言者名字
              const isMine = message.senderType === 'HUMAN' && message.userId === user?.id;
              // 发言者展示名：优先用后端随消息返回的 senderName（历史消息不因
              // 成员离开/机器人移除而丢失名字），机器人消息再兜底查机器人列表
              const senderName =
                message.senderType === 'HUMAN'
                  ? (message.senderName ?? '用户')
                  : (message.senderName ?? botNameById(message.botId));
              return (
                <div key={message.id} className={`message-row ${isMine ? 'user' : 'bot'}`}>
                  {/* 非自己发的消息：头像在左（真人灰底 / 机器人绿底，首字占位） */}
                  {!isMine && (
                    <div
                      className={`avatar-sm ${message.senderType === 'HUMAN' ? 'other' : 'bot'}`}
                    >
                      {senderName.slice(0, 1)}
                    </div>
                  )}
                  <div className="message-content">
                    {/* 自己的消息显示用户名而不是「我」 */}
                    <div className="message-author">
                      {isMine ? (user?.username ?? '我') : senderName}
                    </div>
                    <div
                      className={`bubble ${
                        isMine ? 'user' : message.senderType === 'HUMAN' ? 'other' : 'bot'
                      }`}
                    >
                      <MentionText text={message.content} />
                    </div>
                  </div>
                  {/* 自己的消息：头像在右 */}
                  {isMine && (
                    <div className="avatar-sm user">
                      {user?.username?.slice(0, 1).toUpperCase() ?? '我'}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </div>
        <div className="chat-input-wrap">
          <div className="error-text">{error}</div>
          <div className="mention-picker-wrap">
            {/* @提及补全候选列表：输入 @ 且存在候选时弹出（悬浮于输入框上方） */}
            {mentionQuery !== null && (
              <div className="mention-picker" onMouseDown={(e) => e.preventDefault()}>
                {mentionCandidates.length === 0 ? (
                  <div className="mention-picker-empty">没有匹配的用户或机器人</div>
                ) : (
                  mentionCandidates.map((candidate, index) => (
                    <button
                      key={candidate.key}
                      type="button"
                      className={`mention-option ${index === mentionIndex ? 'active' : ''}`}
                      onClick={() => selectMention(candidate)}
                    >
                      <span className="mention-option-avatar">
                        {candidate.label.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="mention-option-label">@{candidate.label}</span>
                      <span className="mention-option-sub">{candidate.sub}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            <form className="chat-input" onSubmit={(e) => void send(e)}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  const value = e.target.value;
                  setInput(value);
                  // 输入内容变化 → 清空幂等键（新内容必须使用新键）
                  requestIdRef.current = null;
                  // 根据光标位置实时计算 @提及补全：正在输入 @ 时弹出候选列表
                  const caret = e.target.selectionStart ?? value.length;
                  const active = getActiveMention(value, caret);
                  setMentionQuery(active ? active.query : null);
                }}
                placeholder="发送消息，可 @机器人名 / @用户名…"
                onKeyDown={(e) => {
                  // 中文输入法组合状态（选字上屏）不参与补全与发送
                  if (e.nativeEvent.isComposing) {
                    return;
                  }
                  // @补全打开时：↑/↓ 切换候选、回车选中、Esc 关闭
                  if (mentionQuery !== null && mentionCandidates.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setMentionIndex((i) => (i + 1) % mentionCandidates.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setMentionIndex(
                        (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length,
                      );
                      return;
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      selectMention(mentionCandidates[mentionIndex] ?? mentionCandidates[0]!);
                      return;
                    }
                  }
                  if (e.key === 'Escape') {
                    setMentionQuery(null);
                    return;
                  }
                  // 普通回车（非 Shift+Enter）发送消息
                  if (e.key === 'Enter' && !e.shiftKey) {
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
