/**
 * 欢迎页（空状态，参照 ChatGPT 网页版）
 *
 * 【交互】
 * - 仅展示品牌问候语与引导文案（纯静态页，不承载业务逻辑）；
 * - 新对话统一通过左侧边栏「新建对话」创建，欢迎页不再内置建议卡片，
 *   避免与「新建对话」流程重复。
 */

export default function WelcomePage() {
  return (
    <div className="welcome">
      <div className="welcome-title">Endurance Chat</div>
      <div className="welcome-sub">开始一个新对话，或从左侧选择历史对话</div>
    </div>
  );
}
