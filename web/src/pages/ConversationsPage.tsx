/**
 * 对话列表页
 *
 * 【交互】
 * - 新建对话（可选标题）；
 * - 标签筛选 chips（多标签 AND 语义，与后端一致）；
 * - 每张对话卡片：进入聊天、改标题（行内编辑）、删除（确认）、标签添加/移除；
 * - 顶部提供「群组」入口与登出。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import type { Conversation } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';

export default function ConversationsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState('');

  /**
   * 加载对话列表（携带当前标签筛选条件）
   */
  const load = useCallback(async () => {
    try {
      const query = filterTags.map((t) => `tag=${encodeURIComponent(t)}`).join('&');
      const res = await api<{ conversations: Conversation[] }>(
        `/conversations${query ? `?${query}` : ''}`,
      );
      setConversations(res.conversations);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    }
  }, [filterTags]);

  useEffect(() => {
    void load();
  }, [load]);

  // 从当前列表推导全部标签（用于筛选 chips 展示）
  const allTags = Array.from(new Set(conversations.flatMap((c) => c.tags.map((t) => t.name))));

  /**
   * 切换标签筛选（多选，AND 语义）
   *
   * @param tag 标签名
   */
  const toggleFilter = (tag: string) => {
    setFilterTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  /**
   * 新建对话
   */
  const createConversation = async () => {
    setError('');
    try {
      await api('/conversations', { method: 'POST', body: { title: newTitle || undefined } });
      setNewTitle('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    }
  };

  /**
   * 修改标题
   *
   * @param id    对话 id
   * @param title 新标题
   */
  const renameConversation = async (id: string, title: string) => {
    await api(`/conversations/${id}`, { method: 'PATCH', body: { title } });
    await load();
  };

  /**
   * 删除对话（浏览器确认后调用后端，级联删除消息与标签）
   *
   * @param id 对话 id
   */
  const deleteConversation = async (id: string) => {
    if (!window.confirm('确定删除该对话及其全部消息吗？')) return;
    await api(`/conversations/${id}`, { method: 'DELETE' });
    await load();
  };

  /**
   * 添加标签
   *
   * @param id   对话 id
   * @param name 标签名
   */
  const addTag = async (id: string, name: string) => {
    if (!name.trim()) return;
    await api(`/conversations/${id}/tags`, { method: 'POST', body: { name: name.trim() } });
    await load();
  };

  /**
   * 移除标签
   *
   * @param id    对话 id
   * @param tagId 标签 id
   */
  const removeTag = async (id: string, tagId: string) => {
    await api(`/conversations/${id}/tags/${tagId}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2 style={{ margin: 0 }}>我的对话</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="secondary" onClick={() => navigate('/groups')}>
            群组
          </button>
          <button className="secondary" onClick={logout}>
            退出（{user?.username}）
          </button>
        </div>
      </div>

      <div className="card">
        <div className="item-row">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="新对话标题（可选，缺省为「新对话」）"
            onKeyDown={(e) => e.key === 'Enter' && void createConversation()}
          />
          <button onClick={() => void createConversation()}>新建</button>
        </div>
      </div>

      {allTags.length > 0 && (
        <div className="filter-bar">
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
        </div>
      )}

      <div className="error-text">{error}</div>

      {conversations.length === 0 && (
        <div className="card item-meta">暂无对话，点击「新建」开始聊天。</div>
      )}

      {conversations.map((conversation) => (
        <div className="card" key={conversation.id}>
          <div className="item-row">
            <span
              className="item-title"
              onClick={() => navigate(`/conversations/${conversation.id}`)}
            >
              {conversation.title}
            </span>
            <span className="item-meta">{new Date(conversation.updatedAt).toLocaleString()}</span>
            <button
              className="secondary"
              onClick={() =>
                void renameConversation(
                  conversation.id,
                  window.prompt('新标题', conversation.title) ?? conversation.title,
                )
              }
            >
              改标题
            </button>
            <button className="danger" onClick={() => void deleteConversation(conversation.id)}>
              删除
            </button>
          </div>
          <div className="item-row" style={{ marginTop: 10 }}>
            {conversation.tags.map((tag) => (
              <span key={tag.id} className="tag">
                {tag.name}
                <span className="remove" onClick={() => void removeTag(conversation.id, tag.id)}>
                  ×
                </span>
              </span>
            ))}
            <input
              style={{ width: 120 }}
              placeholder="+标签"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void addTag(conversation.id, (e.target as HTMLInputElement).value);
                  (e.target as HTMLInputElement).value = '';
                }
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
