/**
 * 欢迎页（空状态，参照 ChatGPT 网页版）
 *
 * 【交互】
 * - 展示品牌问候语与建议问题卡片；
 * - 点击建议卡片：自动创建对话并发送该条消息（首条消息会成为对话标题），
 *   然后进入聊天页。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import type { Conversation } from '../api/types.js';

// 建议问题列表（点击后直接发起新对话）
const SUGGESTIONS = [
  '帮我制定一个一周学习 TypeScript 的计划',
  '用通俗的语言解释什么是数据库索引',
  '写一个带防抖的搜索输入组件',
  '如何设计一个多机器人群聊的防死循环机制？',
];

export default function WelcomePage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /**
   * 从建议卡片发起对话
   *
   * @param text 建议消息内容
   * 逻辑：创建默认标题对话 → 立即发送该消息（触发 AI 回复并生成标题）→ 跳转聊天页。
   */
  const startFromSuggestion = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const conv = await api<{ conversation: Conversation }>('/conversations', {
        method: 'POST',
        body: {},
      });
      await api(`/conversations/${conv.conversation.id}/messages`, {
        method: 'POST',
        body: { content: text },
      });
      navigate(`/conversations/${conv.conversation.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '发起对话失败');
      setBusy(false);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-title">Endurance Chat</div>
      <div className="welcome-sub">开始一个新对话，或从左侧选择历史对话</div>
      <div className="error-text">{error}</div>
      <div className="suggestion-grid">
        {SUGGESTIONS.map((text) => (
          <div
            key={text}
            className="suggestion-card"
            onClick={() => void startFromSuggestion(text)}
          >
            {text}
          </div>
        ))}
      </div>
      {busy && <div className="center-load">正在创建对话…</div>}
    </div>
  );
}
