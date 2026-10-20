// 我的觀念筆記本: concept cards the child saved (from re-teaching, chats,
// unit cards), grouped by unit, printable before a test.
import { del, get } from '../api.js';
import { $$, confirmBox, esc, html, icon, rich } from '../ui.js';
import { visualHtml } from '../visuals.js';
import { bindSpeak, speakButton } from '../speech.js';

const SRC = { reteach: '換方法解說', chat: '和小老師討論', concept: '觀念圖解', manual: '自己寫的' };

export async function render(main) {
  const notes = await get('/api/notes');
  const groups = {};
  notes.forEach((n) => (groups[`${n.subject}｜${n.unit || '其他'}`] ||= []).push(n));
  const texts = {};
  html(main, `
  <div class="page-head"><a href="#/me" class="back" aria-label="返回">${icon('back', 22)}</a>
    <div class="grow"><h1>我的觀念筆記本</h1><div class="sub">收藏有幫助的解說和自己整理的觀念，考前翻一翻</div></div>
    ${notes.length ? `<button class="btn ghost sm" onclick="window.print()">${icon('print', 16)} 列印</button>` : ''}</div>
  ${notes.length ? Object.entries(groups).map(([g, ns]) => `<div class="label" style="margin-top:12px">${esc(g)}</div>
    ${ns.map((n) => {
      const c = n.content || {};
      texts[n.id] = [n.title, c.misconception, c.correct_idea, (c.steps || []).join('。'), c.remember].filter(Boolean).join('。');
      return `<div class="card note">
        <div class="row nowrap"><b style="flex:1;font-size:17px">${rich(n.title)}</b>${speakButton(n.id)}
          <button class="icon-btn" data-del="${n.id}" aria-label="刪除">${icon('trash', 16)}</button></div>
        <div class="small muted">${SRC[n.source] || ''}・${n.created_at.slice(0, 10)}${n.question_id ? `・<a class="tap" href="#/q/${n.question_id}">看原題</a>` : ''}</div>
        ${c.misconception ? `<div style="margin-top:8px;color:var(--bad)">${rich(c.misconception)}</div>` : ''}
        ${c.correct_idea ? `<div style="margin-top:6px">${rich(c.correct_idea)}</div>` : ''}
        ${c.steps && c.steps.length ? `<ol class="steps" style="margin-top:6px">${c.steps.map((x) => `<li>${rich(x)}</li>`).join('')}</ol>` : ''}
        ${c.visual ? visualHtml(c.visual) : ''}
        ${c.remember ? `<div class="card tight" style="margin:8px 0 0;background:var(--warm-soft);border:0"><b>記住：</b>${rich(c.remember)}</div>` : ''}
        ${c.example ? `<div class="small" style="margin-top:6px">例：${rich(c.example)}</div>` : ''}
      </div>`;
    }).join('')}`).join('')
    : `<div class="empty">還沒有筆記。<br><span class="small">在「換個方法解說」按「收藏」，或和 AI 小老師討論後按「整理成我的觀念筆記」。</span></div>`}`);
  bindSpeak(main, texts);
  $$('[data-del]', main).forEach((b) => b.onclick = async () => {
    if (!await confirmBox('刪除這張筆記？', '刪除', true)) return;
    await del(`/api/notes/${b.dataset.del}`);
    render(main);
  });
}
