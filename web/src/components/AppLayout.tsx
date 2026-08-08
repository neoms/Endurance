/**
 * 应用主布局（参照 ChatGPT 网页版）
 *
 * 【区域划分】
 * - 左侧边栏：品牌 + 新建对话、对话/群组切换、历史列表（对话含标签筛选与标签管理）、
 *   底部用户区（头像/用户名/登出）；
 * - 主区域：由子路由渲染（欢迎页 / 聊天页 / 群组页）。
 *
 * 【数据刷新策略】
 * 边栏在路由变化与自身操作（新建/改名/删除/标签）后刷新列表；
 * 主区域内的操作（如发送首条消息改标题）会在下一次导航时同步到边栏。
 */
import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import type { Bot, Conversation, Group } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';

// 边栏悬浮框的四种形态（判别联合，便于按 kind 渲染不同表单）
type SidebarModal =
  | { kind: 'tag'; conversation: Conversation; value: string }
  | { kind: 'rename'; conversation: Conversation; value: string }
  | {
      kind: 'new-group';
      name: string;
      responseMode: 'ALL_BOTS' | 'RANDOM_ONE' | 'CONTENT_ROUTED';
      maxReplies: number;
      botIds: string[];
      bots: Bot[];
    };

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // 边栏状态：当前标签页（对话/群组）与移动端展开状态
  // 桌面（≥768px）默认展开；窄屏默认收起（由左上角按钮展开）
  const [tab, setTab] = useState<'conversations' | 'groups'>(() =>
    location.pathname.startsWith('/groups') ? 'groups' : 'conversations',
  );
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);

  // 对话列表与标签
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [filterTags, setFilterTags] = useState<string[]>([]);
  // 群组列表
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState('');
  // 三点菜单：当前展开菜单的对话 id（null 表示全部收起）
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  // 悬浮框：新建群组/加标签/重命名（null 表示关闭；新建对话直接创建不弹框）
  const [modal, setModal] = useState<SidebarModal | null>(null);
  // 悬浮框内的错误提示（如「请至少选择一个机器人」显示在框内而非侧边栏底部）
  const [modalError, setModalError] = useState('');

  /**
   * 加载对话列表（携带当前标签筛选条件），并推导标签全集
   */
  const loadConversations = useCallback(async () => {
    try {
      const query = filterTags.map((t) => `tag=${encodeURIComponent(t)}`).join('&');
      const res = await api<{ conversations: Conversation[] }>(
        `/conversations${query ? `?${query}` : ''}`,
      );
      setConversations(res.conversations);
      // 标签全集：无筛选时直接复用本次结果；有筛选时额外拉取全量列表推导，
      // 保证筛选 chips 始终展示用户全部标签。
      let tagSource = res;
      if (filterTags.length > 0) {
        tagSource = await api<{ conversations: Conversation[] }>('/conversations');
      }
      setAllTags(
        Array.from(new Set(tagSource.conversations.flatMap((c) => c.tags.map((t) => t.name)))),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载对话失败');
    }
  }, [filterTags]);

  /**
   * 加载我参与的群组列表
   */
  const loadGroups = useCallback(async () => {
    try {
      const res = await api<{ groups: Group[] }>('/groups');
      setGroups(res.groups);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载群组失败');
    }
  }, []);

  // 路由变化时：同步标签页并刷新两个列表（新建/删除等操作后导航回来会同步）
  useEffect(() => {
    setTab(location.pathname.startsWith('/groups') ? 'groups' : 'conversations');
    // 路由切换时仅重置移动端收起状态，桌面端保持展开
    setSidebarOpen((open) => (window.innerWidth >= 768 ? true : open));
    void loadConversations();
    void loadGroups();
  }, [location.pathname, loadConversations, loadGroups]);

  // 当前选中的对话/群组 id（用于列表高亮）
  const activeConversationId = location.pathname.startsWith('/conversations/')
    ? location.pathname.split('/')[2]
    : undefined;
  const activeGroupId = location.pathname.startsWith('/groups/')
    ? location.pathname.split('/')[2]
    : undefined;

  /**
   * 修改对话标题
   *
   * @param id    对话 id
   * @param title 新标题
   */
  const renameConversation = async (id: string, title: string) => {
    try {
      await api(`/conversations/${id}`, { method: 'PATCH', body: { title } });
      await loadConversations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '修改标题失败');
    }
  };

  /**
   * 删除对话（先经 window.confirm 二次确认；正在查看时回到欢迎页）
   *
   * @param id 对话 id
   */
  const deleteConversation = async (id: string) => {
    if (!window.confirm('确定删除该对话及其全部消息吗？此操作不可恢复。')) return;
    try {
      await api(`/conversations/${id}`, { method: 'DELETE' });
      // 若正在查看该对话，删除后回到欢迎页
      if (activeConversationId === id) {
        navigate('/');
      }
      await loadConversations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    }
  };

  /**
   * 为对话添加标签（成功后刷新列表）
   *
   * @param id   对话 id
   * @param name 标签名
   */
  const addTag = async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await api(`/conversations/${id}/tags`, { method: 'POST', body: { name: trimmed } });
      await loadConversations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '添加标签失败');
    }
  };

  /**
   * 提交悬浮框：新建对话 / 新建群组 / 加标签 / 重命名
   *
   * 说明：按 modal.kind 分发到对应接口，成功后关闭悬浮框并刷新列表/跳转。
   */
  const submitModal = async () => {
    if (!modal) return;
    try {
      switch (modal.kind) {
        case 'tag': {
          const value = modal.value.trim();
          if (!value) return;
          await addTag(modal.conversation.id, value);
          break;
        }
        case 'rename': {
          const value = modal.value.trim();
          if (!value) return;
          await renameConversation(modal.conversation.id, value);
          break;
        }
        case 'new-group': {
          if (modal.botIds.length === 0) {
            // 错误显示在悬浮框内部（modalError 渲染在 .modal 顶部）
            setModalError('请至少选择一个机器人');
            return;
          }
          const res = await api<{ group: Group }>('/groups', {
            method: 'POST',
            body: {
              name: modal.name.trim(),
              responseMode: modal.responseMode,
              maxConsecutiveBotReplies: modal.maxReplies,
              botIds: modal.botIds,
            },
          });
          navigate(`/groups/${res.group.id}`);
          await loadGroups();
          break;
        }
      }
      setModal(null);
      setModalError('');
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : '保存失败');
    }
  };

  /**
   * 打开「添加标签」悬浮框（同时收起三点菜单）
   *
   * @param conversation 目标对话
   */
  const openTagModal = (conversation: Conversation) => {
    setMenuOpenId(null);
    setModalError('');
    setModal({ kind: 'tag', conversation, value: '' });
  };

  /**
   * 打开「重命名对话」悬浮框（预填当前标题）
   *
   * @param conversation 目标对话
   */
  const openRenameModal = (conversation: Conversation) => {
    setMenuOpenId(null);
    setModalError('');
    setModal({ kind: 'rename', conversation, value: conversation.title });
  };

  /**
   * 新建对话：直接创建默认标题「新对话」的对话并进入聊天，
   * 标题由用户第一条消息自动替换；主动重命名才走悬浮框。
   */
  const createConversation = async () => {
    try {
      const res = await api<{ conversation: Conversation }>('/conversations', {
        method: 'POST',
        body: {},
      });
      navigate(`/conversations/${res.conversation.id}`);
      await loadConversations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建对话失败');
    }
  };

  /**
   * 打开「新建群组」悬浮框（先拉取可用机器人列表供勾选）
   */
  const openNewGroupModal = async () => {
    try {
      const res = await api<{ bots: Bot[] }>('/bots');
      setModalError('');
      setModal({
        kind: 'new-group',
        name: '',
        responseMode: 'ALL_BOTS',
        maxReplies: 3,
        botIds: [],
        bots: res.bots,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载机器人失败');
    }
  };

  /**
   * 关闭悬浮框（同时清空框内错误提示）
   */
  const closeModal = () => {
    setModal(null);
    setModalError('');
  };

  /**
   * 移除对话标签
   *
   * @param id    对话 id
   * @param tagId 标签 id
   */
  const removeTag = async (id: string, tagId: string) => {
    try {
      await api(`/conversations/${id}/tags/${tagId}`, { method: 'DELETE' });
      await loadConversations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '移除标签失败');
    }
  };

  /** 切换标签筛选（多选 AND 语义） */
  const toggleFilter = (tag: string) => {
    setFilterTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  return (
    <div className="app-layout">
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
        {/* 三点菜单的透明遮罩：点击菜单外任意位置收起菜单 */}
        {menuOpenId && <div className="menu-backdrop" onClick={() => setMenuOpenId(null)} />}
        <div className="sidebar-header">
          {/* 顶部：对话/群组 Tab 切换 */}
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${tab === 'conversations' ? 'active' : ''}`}
              onClick={() => navigate('/')}
            >
              对话
            </button>
            <button
              className={`sidebar-tab ${tab === 'groups' ? 'active' : ''}`}
              onClick={() => navigate('/groups')}
            >
              群组
            </button>
          </div>
          {/* Tab 下方：对应的「新建」按钮（点击弹出悬浮框填写） */}
          {tab === 'conversations' ? (
            <button className="new-chat-btn" onClick={() => void createConversation()}>
              ＋ 新建对话
            </button>
          ) : (
            <button className="new-chat-btn" onClick={() => void openNewGroupModal()}>
              ＋ 新建群组
            </button>
          )}
        </div>

        {tab === 'conversations' && (
          <>
            {/* 标签选择区域：带边框区域框与说明文字 */}
            <div className="sidebar-filter">
              <div className="sidebar-filter-label">标签筛选</div>
              <div className="sidebar-filter-chips">
                <button
                  className={`filter-chip ${filterTags.length === 0 ? 'active' : ''}`}
                  onClick={() => setFilterTags([])}
                >
                  全部
                </button>
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    className={`filter-chip ${filterTags.includes(tag) ? 'active' : ''}`}
                    onClick={() => toggleFilter(tag)}
                  >
                    {tag}
                  </button>
                ))}
                {allTags.length === 0 && (
                  <span className="sidebar-filter-empty">暂无标签，可在对话菜单中添加</span>
                )}
              </div>
            </div>
            <div className="sidebar-list">
              {conversations.length === 0 && (
                <div className="center-load">暂无对话，点击「新建对话」开始。</div>
              )}
              {conversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`sidebar-item ${activeConversationId === conversation.id ? 'active' : ''}`}
                  onClick={() => navigate(`/conversations/${conversation.id}`)}
                >
                  <div className="sidebar-item-title">{conversation.title}</div>
                  {conversation.tags.length > 0 && (
                    <div className="sidebar-item-tags">
                      {conversation.tags.map((tag) => (
                        <span key={tag.id} className="tag">
                          {tag.name}
                          <span
                            className="remove"
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeTag(conversation.id, tag.id);
                            }}
                          >
                            ×
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  {/* 三点菜单按钮：点击展开「加标签/重命名/删除」 */}
                  <div className="sidebar-item-actions">
                    <button
                      className="icon-btn"
                      title="更多操作"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId((prev) =>
                          prev === conversation.id ? null : conversation.id,
                        );
                      }}
                    >
                      ⋮
                    </button>
                  </div>
                  {/* 三点下拉菜单 */}
                  {menuOpenId === conversation.id && (
                    <div className="sidebar-menu" onClick={(e) => e.stopPropagation()}>
                      <button type="button" onClick={() => openTagModal(conversation)}>
                        加标签
                      </button>
                      <button type="button" onClick={() => openRenameModal(conversation)}>
                        重命名
                      </button>
                      <button
                        type="button"
                        className="menu-danger"
                        onClick={() => {
                          setMenuOpenId(null);
                          void deleteConversation(conversation.id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'groups' && (
          <div className="sidebar-list">
            {groups.length === 0 && (
              <div className="center-load">暂无群组，在主区域创建第一个群组。</div>
            )}
            {groups.map((group) => (
              <div
                key={group.id}
                className={`sidebar-item ${activeGroupId === group.id ? 'active' : ''}`}
                onClick={() => navigate(`/groups/${group.id}`)}
              >
                <div className="sidebar-item-title">{group.name}</div>
                <div className="item-meta">
                  {group.members.length} 位成员 · {group.bots.map((b) => b.name).join('、')}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <div className="sidebar-error">{error}</div>}

        <div className="sidebar-footer">
          <div className="avatar">{(user?.displayName ?? 'U').slice(0, 1).toUpperCase()}</div>
          <div className="sidebar-user">
            <div className="sidebar-user-name">{user?.displayName}</div>
          </div>
          <button className="secondary" onClick={logout}>
            登出
          </button>
        </div>
      </aside>

      <main className="main">
        <button className="sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)}>
          {sidebarOpen ? '×' : '☰'}
        </button>
        <Outlet />
      </main>

      {/* 边栏悬浮框：新建群组 / 加标签 / 重命名 */}
      {modal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div
            className={`modal ${modal.kind === 'new-group' ? 'modal-wide' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 悬浮框内部错误提示（如「请至少选择一个机器人」） */}
            <div className="error-text">{modalError}</div>
            {/* 加标签 */}
            {modal.kind === 'tag' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitModal();
                }}
              >
                <h4 style={{ marginTop: 0 }}>添加标签</h4>
                <input
                  autoFocus
                  value={modal.value}
                  onChange={(e) => setModal({ ...modal, value: e.target.value })}
                  placeholder="输入标签名，如：工作"
                />
                <div className="modal-actions">
                  <button type="button" className="secondary" onClick={closeModal}>
                    取消
                  </button>
                  <button type="submit" disabled={!modal.value.trim()}>
                    确定
                  </button>
                </div>
              </form>
            )}
            {/* 重命名对话 */}
            {modal.kind === 'rename' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitModal();
                }}
              >
                <h4 style={{ marginTop: 0 }}>重命名对话</h4>
                <input
                  autoFocus
                  value={modal.value}
                  onChange={(e) => setModal({ ...modal, value: e.target.value })}
                  placeholder="输入新标题"
                />
                <div className="modal-actions">
                  <button type="button" className="secondary" onClick={closeModal}>
                    取消
                  </button>
                  <button type="submit" disabled={!modal.value.trim()}>
                    确定
                  </button>
                </div>
              </form>
            )}
            {/* 新建群组 */}
            {modal.kind === 'new-group' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitModal();
                }}
              >
                <h4 style={{ marginTop: 0 }}>新建群组</h4>
                <div className="field">
                  <label htmlFor="newGroupName">群组名称</label>
                  <input
                    id="newGroupName"
                    autoFocus
                    value={modal.name}
                    onChange={(e) => setModal({ ...modal, name: e.target.value })}
                    placeholder="如：技术讨论群"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="newGroupMode">响应策略</label>
                  <select
                    id="newGroupMode"
                    value={modal.responseMode}
                    onChange={(e) =>
                      setModal({
                        ...modal,
                        responseMode: e.target.value as typeof modal.responseMode,
                      })
                    }
                  >
                    <option value="ALL_BOTS">全部机器人回复</option>
                    <option value="RANDOM_ONE">随机一个回复</option>
                    <option value="CONTENT_ROUTED">按内容路由</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="newGroupMax">每轮回复上限（1-10，防循环）</label>
                  <input
                    id="newGroupMax"
                    type="number"
                    min={1}
                    max={10}
                    value={modal.maxReplies}
                    onChange={(e) => setModal({ ...modal, maxReplies: Number(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>选择机器人（至少 1 个）</label>
                  <div className="bot-toggle-row">
                    {modal.bots.map((bot) => (
                      <button
                        key={bot.id}
                        type="button"
                        className={modal.botIds.includes(bot.id) ? '' : 'secondary'}
                        onClick={() =>
                          setModal((prev) =>
                            prev && prev.kind === 'new-group'
                              ? {
                                  ...prev,
                                  botIds: prev.botIds.includes(bot.id)
                                    ? prev.botIds.filter((b) => b !== bot.id)
                                    : [...prev.botIds, bot.id],
                                }
                              : prev,
                          )
                        }
                      >
                        {bot.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="modal-actions">
                  <button type="button" className="secondary" onClick={closeModal}>
                    取消
                  </button>
                  <button type="submit" disabled={!modal.name.trim()}>
                    创建
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
