/**
 * 群组引导页（主区域 /groups）
 *
 * 【说明】
 * 群组创建已统一收进左侧边栏的「＋ 新建群组」悬浮框，本页只做引导提示：
 * - 点击左侧「＋ 新建群组」打开悬浮框填写创建；
 * - 或从左侧群组列表选择已有群组进入群聊。
 */
export default function GroupsPage() {
  return (
    <div className="welcome">
      <div className="welcome-title">群组对话</div>
      <div className="welcome-sub">点击左侧「＋ 新建群组」创建群组，或从左侧列表选择已有群组。</div>
    </div>
  );
}
