/**
 * 消息文本渲染组件：高亮 @提及
 *
 * 【说明】
 * 用与后端一致的切词规则（@ 后跟非空白/非常用标点，且前面不是字母数字，
 * 避免把邮箱 a@b.com 误判为提及）把文本拆成普通片段与 @提及片段；
 * @提及以 .mention 样式高亮显示。
 * 纯展示组件：不负责校验被 @ 对象是否在群组内（校验由后端发送接口完成）。
 *
 * @param text 消息原始文本
 * @returns React 片段（@提及高亮后的富文本）
 */
export default function MentionText({ text }: { text: string }) {
  // 拆分后数组为「普通文本 / @提及 / 普通文本 …」交替结构。
  // 注意：必须用「捕获分组」把整个匹配包起来，否则 split 会把匹配到的 @提及
  // 当作分隔符直接丢弃（正是之前气泡里 @用户名 消失的原因）。
  const parts = text.split(/((?<![a-zA-Z0-9_])@[^\s@，。！？!?；;：:]+)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('@') ? (
          <span key={index} className="mention">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
