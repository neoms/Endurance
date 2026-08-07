/**
 * 群组列表/创建页
 *
 * 【交互】
 * - 展示我参与的群组（成员数、机器人名）；
 * - 创建群组表单：名称、响应策略、防循环上限、勾选机器人（至少 1 个）；
 * - 点击群组进入详情/群聊页。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import type { Bot, Group } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';

export default function GroupsPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [groups, setGroups] = useState<Group[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [name, setName] = useState('');
  const [responseMode, setResponseMode] = useState<'ALL_BOTS' | 'RANDOM_ONE' | 'CONTENT_ROUTED'>(
    'ALL_BOTS',
  );
  const [selectedBots, setSelectedBots] = useState<string[]>([]);
  const [error, setError] = useState('');

  /**
   * 加载我参与的群组与可用机器人
   */
  const load = useCallback(async () => {
    try {
      const [groupsRes, botsRes] = await Promise.all([
        api<{ groups: Group[] }>('/groups'),
        api<{ bots: Bot[] }>('/bots'),
      ]);
      setGroups(groupsRes.groups);
      setBots(botsRes.bots);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 创建群组
   *
   * @param e 表单提交事件
   */
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (selectedBots.length === 0) {
      setError('请至少选择一个机器人');
      return;
    }
    try {
      const res = await api<{ group: Group }>('/groups', {
        method: 'POST',
        body: { name, botIds: selectedBots, responseMode },
      });
      navigate(`/groups/${res.group.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    }
  };

  /**
   * 切换机器人勾选（至少保留一个的校验在提交时执行）
   *
   * @param botId 机器人 id
   */
  const toggleBot = (botId: string) => {
    setSelectedBots((prev) =>
      prev.includes(botId) ? prev.filter((b) => b !== botId) : [...prev, botId],
    );
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2 style={{ margin: 0 }}>我的群组</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="secondary" onClick={() => navigate('/')}>
            对话
          </button>
          <button className="secondary" onClick={logout}>
            退出
          </button>
        </div>
      </div>

      <form className="card" onSubmit={(e) => void create(e)}>
        <div className="field">
          <label htmlFor="groupName">群组名称</label>
          <input id="groupName" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="responseMode">机器人响应策略</label>
          <select
            id="responseMode"
            value={responseMode}
            onChange={(e) => setResponseMode(e.target.value as typeof responseMode)}
          >
            <option value="ALL_BOTS">全部机器人回复</option>
            <option value="RANDOM_ONE">随机一个回复</option>
            <option value="CONTENT_ROUTED">按内容路由</option>
          </select>
        </div>
        <div className="field">
          <label>选择机器人（至少 1 个）</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {bots.map((bot) => (
              <button
                key={bot.id}
                type="button"
                className={selectedBots.includes(bot.id) ? '' : 'secondary'}
                onClick={() => toggleBot(bot.id)}
              >
                {bot.name}
              </button>
            ))}
          </div>
        </div>
        <div className="error-text">{error}</div>
        <button type="submit">创建群组</button>
      </form>

      {groups.length === 0 && (
        <div className="card item-meta">暂无群组，创建第一个群组开始群聊。</div>
      )}
      {groups.map((group) => (
        <div
          className="card item-row"
          key={group.id}
          onClick={() => navigate(`/groups/${group.id}`)}
        >
          <span className="item-title">{group.name}</span>
          <span className="item-meta">
            {group.members.length} 位成员 · {group.bots.map((b) => b.name).join('、')} ·{' '}
            {group.responseMode}
          </span>
        </div>
      ))}
    </div>
  );
}
