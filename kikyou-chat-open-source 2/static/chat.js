'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
let active = null, sessionTimer, memoryTimer, sessionCache = [], memoryCache = {};
let sessionRequest = 0, memoryRequest = 0, viewRequest = 0, loadingView = false;
let batchMode = false, batchBusy = false, editingSession = null, shownMessages = [];
let requestInFlight = null, creatingSession = false, followLatest = true, unreadReply = false;
const selectedSessions = new Set(), drafts = new Map(), scrollPositions = new Map(), failedReplies = new Map();
const narrowScreen = matchMedia('(max-width: 1100px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const mobileSides = {left: false, right: false};
const modalStack = [];
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem('kikyouAppearance') || '{}') || {}; } catch (_) {}
if (typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
if (prefs.artTheme !== 'silver-cat-v1') {
  prefs.color='mist'; prefs.artTheme='silver-cat-v1';
  try { localStorage.setItem('kikyouAppearance',JSON.stringify(prefs)); } catch (_) {}
}
const themes = [
  ['mist','雾蓝','#7799ad','#a1c3d6'], ['silver','银灰','#899ca5','#b1c3cc'],
  ['blush','浅樱','#c99598','#e0b4b5'], ['bell','铃铛金','#ad965b','#d3bd84'],
  ['lavender','薰衣草','#9a8fd6','#b9adff'], ['mint','薄荷','#72ad9a','#91c9b7'],
  ['peach','蜜桃','#dc977f','#efa990'], ['sky','晴空','#7ca7d8','#9abbe2'],
  ['cream','奶油','#c3a25c','#dec27e'], ['blue','Google 蓝','#1a73e8','#8ab4f8'],
  ['red','Google 红','#d93025','#f28b82'], ['yellow','Google 黄','#f9ab00','#fdd663'],
  ['green','Google 绿','#188038','#81c995'], ['purple','紫色','#9334e6','#c58af9'],
  ['gold','Chrome 棕金','#b06000','#e6a33d']
];

async function api(url, options = {}) {
  let response;
  try { response = await fetch(url, {headers: {'Content-Type': 'application/json'}, ...options}); }
  catch (_) { throw Error('无法连接本机服务，请检查桔梗启动窗口是否仍在运行。'); }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || `操作未完成（${response.status}）`);
  return data;
}
function toast(message) {
  const notice = document.createElement('div');
  notice.className = 'notice'; notice.textContent = message;
  $('notices').append(notice);
  setTimeout(() => notice.remove(), 4500);
}
function announce(message) { $('liveStatus').textContent = message; }
function savePrefs() {
  try { localStorage.setItem('kikyouAppearance', JSON.stringify(prefs)); }
  catch (_) { toast('浏览器暂时无法保存外观，当前设置仍然有效。'); }
}
function renderPalettes() {
  const swatch = theme => `<button class="swatch" data-color="${theme[0]}" style="--swatch:${theme[2]}" title="${theme[1]}" aria-label="${theme[1]}" onclick="setColor('${theme[0]}')"></button>`;
  $('macaronPalette').innerHTML = themes.slice(0,4).map(swatch).join('');
  $('classicPalette').innerHTML = themes.slice(4).map(swatch).join('');
}
function sideIsOpen(side) {
  return narrowScreen.matches ? mobileSides[side] : !(prefs[side + 'Hidden'] ?? (side === 'right'));
}
function applyPrefs() {
  const mode = prefs.mode === 'dark' ? 'dark' : 'light';
  const color = String(prefs.color || 'mist').replace(/^(macaron-|google-|chrome-)/, '');
  const theme = themes.find(item => item[0] === color) || themes[0];
  document.documentElement.dataset.mode = mode;
  document.documentElement.dataset.wallpaper = prefs.wallpaper==='quiet' ? 'quiet' : 'art';
  document.querySelectorAll('button[data-wallpaper]').forEach(button=>{const selected=button.dataset.wallpaper===document.documentElement.dataset.wallpaper;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',selected);});
  document.documentElement.style.setProperty('--accent', theme[mode === 'dark' ? 3 : 2]);
  document.querySelectorAll('button[data-mode]').forEach(button => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', selected);
  });
  document.querySelectorAll('button[data-color]').forEach(button => {
    const selected = button.dataset.color === theme[0];
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', selected);
  });
  for (const side of ['left','right']) {
    const open = sideIsOpen(side), panel = $(side === 'left' ? 'sessionPanel' : 'memoryPanel');
    $('app').classList.toggle(side + '-hidden', !open);
    panel.inert = !open; panel.setAttribute('aria-hidden', !open);
    $(side + 'Toggle').setAttribute('aria-expanded', open);
  }
  $('sideScrim').hidden = !narrowScreen.matches || (!mobileSides.left && !mobileSides.right);
}
function setMode(mode) { prefs.mode = mode; savePrefs(); applyPrefs(); }
function setColor(color) { prefs.color = color; savePrefs(); applyPrefs(); }
function setWallpaper(wallpaper) { prefs.wallpaper=wallpaper;savePrefs();applyPrefs(); }
function welcomeAction(action) {
  if(action==='history'){if(!sideIsOpen('left'))toggleSide('left');$('sessionSearch').focus({preventScroll:true});return;}
  if(!$('message').value.trim()){$('message').value='今天想和你聊聊…';resizeComposer();}
  $('message').focus({preventScroll:true});
}
function capturePosition() {
  const box = $('messages'), top = box.getBoundingClientRect().top;
  const row = [...$('messageList').querySelectorAll('[data-mid]')].find(item => item.getBoundingClientRect().bottom > top + 4);
  return {bottom: followLatest, top: box.scrollTop, id: row?.dataset.mid, offset: row ? row.getBoundingClientRect().top - top : 0};
}
function restorePosition(position) {
  if (!position || position.bottom) { jumpToNewestMessage(false); return; }
  followLatest = false;
  const box = $('messages');
  const row = [...$('messageList').querySelectorAll('[data-mid]')].find(item => item.dataset.mid === position.id);
  box.scrollTop = row ? box.scrollTop + row.getBoundingClientRect().top - box.getBoundingClientRect().top - position.offset : position.top;
  updateJumpButton();
}
function toggleSide(side) {
  const position = capturePosition(), sessionId = active;
  if (narrowScreen.matches) {
    const open = !mobileSides[side]; mobileSides.left = mobileSides.right = false; mobileSides[side] = open;
  } else { prefs[side + 'Hidden'] = sideIsOpen(side); savePrefs(); }
  applyPrefs();
  setTimeout(() => { if (active === sessionId) restorePosition(position); }, reducedMotion.matches ? 0 : 250);
}
function closeMobileSides() { mobileSides.left = mobileSides.right = false; applyPrefs(); }

/* Dialogs share one focus stack; the top dialog is the only interactive layer. */
function syncModalLayers() {
  const top = modalStack.at(-1);
  $('app').inert = Boolean(top);
  modalStack.forEach((entry, index) => {
    const element = $(entry.id), under = entry !== top;
    element.inert = under; element.classList.toggle('is-underlay', under);
    element.style.zIndex = 30 + index;
    element.setAttribute('aria-hidden', under);
  });
}
function openModal(id) {
  if (modalStack.some(item => item.id === id)) return;
  closeQuickMenu();
  modalStack.push({id, opener: document.activeElement});
  const element = $(id); element.hidden = false;
  syncModalLayers();
  requestAnimationFrame(() => {
    if (modalStack.at(-1)?.id !== id) return;
    const target = element.querySelector('button:not(:disabled),input:not(:disabled),select:not(:disabled),[role="dialog"]');
    target?.focus({preventScroll:true});
  });
}
function closeModal(id) {
  if (id==='memoryInputModal' && typeof memoryInputResolve==='function') { finishMemoryInput(false); return; }
  const index = modalStack.findIndex(item => item.id === id);
  if (index < 0) return;
  const removed = modalStack.splice(index);
  removed.forEach(entry => { const element = $(entry.id); element.hidden = true; element.inert = false; element.setAttribute('aria-hidden','true'); });
  syncModalLayers();
  const opener = removed[0].opener;
  if (opener?.isConnected && !opener.closest('[hidden]')) opener.focus({preventScroll:true});
}
function closeTopModal() {
  const id = modalStack.at(-1)?.id;
  if (id === 'providerModal') closeProviderDialog();
  else if (id === 'generationModal') closeGenerationDialog();
  else if (id) closeModal(id);
}
function toggleSettings(force) {
  const open = typeof force === 'boolean' ? force : $('settingsModal').hidden;
  if (open) openModal('settingsModal'); else closeModal('settingsModal');
}
function showInfo(title, content) { $('infoTitle').textContent = title; $('infoBody').textContent = content; openModal('infoModal'); }
function toggleQuickMenu() {
  const open = $('quickMenu').hidden;
  $('quickMenu').hidden = !open; $('quickMenuButton').setAttribute('aria-expanded', open);
  if (open) $('quickMenu').querySelector('button').focus();
}
function closeQuickMenu() { $('quickMenu').hidden = true; $('quickMenuButton').setAttribute('aria-expanded', 'false'); }
async function menuAction(action) {
  closeQuickMenu();
  if (action === 'reload-persona') { await reloadActivePersona(); return; }
  if (!active) { showInfo('会话摘要','开始聊天后，这里会整理这段对话的近期内容。'); return; }
  const id = active;
  try { const data = await api(`/api/sessions/${id}/summary`); if (id === active) showInfo('会话摘要', data.summary || '这段对话还没有生成摘要，多聊几轮后再来看看。'); }
  catch (error) { toast(error.message); }
}

/* Session list: grouping uses the latest message, not the creation sequence. */
function parseDate(value) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? null : date; }
function dayGroup(value) {
  const date = parseDate(value); if (!date) return '更早';
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(), nowDay = Date.UTC(today.getFullYear(),today.getMonth(),today.getDate());
  const distance = Math.floor((nowDay-day)/86400000);
  return distance <= 0 ? '今天' : distance === 1 ? '昨天' : distance < 7 ? '近 7 天' : distance < 30 ? '近 30 天' : '更早';
}
function shortDate(value) { const date = parseDate(value); return date ? `${date.getMonth()+1}月${date.getDate()}日` : ''; }
function renderSessionList() {
  const box = $('sessions'), oldScroll = box.scrollTop;
  if (!sessionCache.length) {
    box.innerHTML = `<div class="empty small">${$('sessionSearch').value.trim() ? '没有找到这段对话<br>试试聊天里出现过的词' : '还没有历史会话<br>聊点什么，让这里热闹起来'}</div>`;
  } else {
    let group = '';
    box.innerHTML = sessionCache.map(session => {
      const next = dayGroup(session.latest_at || session.started_at);
      const heading = next !== group ? `<h2 class="session-group-label">${next}</h2>` : ''; group = next;
      const selected = selectedSessions.has(session.id);
      const check = batchMode ? `<input class="session-check" type="checkbox" aria-label="选择 ${esc(session.title)}" ${selected ? 'checked' : ''} onchange="toggleSelectedSession(${session.id},this.checked)">` : '';
      return `${heading}<div class="session-row ${session.id===active ? 'active' : ''}" data-session="${session.id}">${check}<button class="session" ${session.id===active ? 'aria-current="page"' : ''} title="${esc(session.title)}" onclick="selectSession(${session.id})"><strong>${esc(session.title)}</strong><small>${session.message_count} 条消息 · ${shortDate(session.latest_at || session.started_at)}</small></button>${batchMode ? '' : `<button class="icon-btn session-rename" title="重命名" aria-label="重命名 ${esc(session.title)}" onclick="renameSessionInline(${session.id})">${icon('edit')}</button>`}</div>`;
    }).join('');
  }
  box.scrollTop = oldScroll; updateBatchToolbar();
}
async function loadSessions() {
  const serial = ++sessionRequest;
  try {
    const list = await api('/api/sessions?q=' + encodeURIComponent($('sessionSearch').value.trim()));
    if (serial !== sessionRequest) return;
    sessionCache = list;
    // Let the inline editor finish before repainting its row.
    if (editingSession === null) renderSessionList();
  } catch (error) {
    if (serial !== sessionRequest) return;
    $('sessions').innerHTML = `<div class="empty small">${esc(error.message)}<br><button onclick="loadSessions()">重新加载</button></div>`;
  }
}
function debounceSessions() { clearTimeout(sessionTimer); sessionTimer = setTimeout(loadSessions, 220); }
function stashDraft() {
  drafts.set(active, {text:$('message').value, attachments:pendingAttachments});
  if (!loadingView) scrollPositions.set(active, capturePosition());
}
function restoreDraft() {
  const draft = drafts.get(active);
  $('message').value = draft?.text || ''; pendingAttachments = draft?.attachments || [];
  renderAttachmentTray(); resizeComposer(); updateSendState();
}
function updateTitle(title = '新对话') {
  $('chatTitle').textContent = title; $('chatTitle').title = title;
  document.title = active ? `${title} · 桔梗` : '桔梗';
  $('exportButton').disabled = !active;
}
async function selectSession(id) {
  if (id === active && !loadingView) { closeMobileSides(); return; }
  stashDraft(); active = id; loadingView = true; followLatest = true; unreadReply = false;
  const serial = ++viewRequest;
  updateTitle(sessionCache.find(item => item.id === id)?.title || '正在打开…');
  restoreDraft(); renderSessionList(); closeQuickMenu(); closeMobileSides();
  $('messages').classList.remove('is-empty'); $('messages').setAttribute('aria-busy','true');
  $('messageList').innerHTML = '<div class="chat-loading">正在翻开这段对话…<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  $('jumpLatest').hidden = true;
  try {
    const data = await api(`/api/sessions/${id}/messages`);
    if (serial !== viewRequest || active !== id) return;
    updateTitle(data.session.title); loadingView = false;
    renderMessages(data.messages, scrollPositions.get(id));
    announce('已打开：' + data.session.title);
  } catch (error) {
    if (serial !== viewRequest || active !== id) return;
    loadingView = true;
    $('messageList').innerHTML = `<div class="empty">${esc(error.message)}<br><button onclick="retryCurrentSession()">重新加载</button></div>`;
  } finally {
    if (serial === viewRequest) { $('messages').setAttribute('aria-busy','false'); updateSendState(); }
  }
}
function retryCurrentSession() { loadingView = true; selectSession(active); }
function newSession() {
  stashDraft(); active = null; ++viewRequest; loadingView = false; unreadReply = false;
  updateTitle(); restoreDraft(); renderMessages([], scrollPositions.get(null));
  renderSessionList(); closeQuickMenu(); closeMobileSides();
  $('message').focus({preventScroll:true});
}
function renameSessionInline(id) {
  if (editingSession !== null || batchBusy) return;
  const session = sessionCache.find(item => item.id === id), row = document.querySelector(`[data-session="${id}"]`);
  if (!session || !row) return;
  editingSession = id;
  const input = document.createElement('input'); input.className = 'rename-input'; input.value = session.title;
  input.setAttribute('aria-label','新的会话标题'); input.title = 'Enter 保存，Esc 取消'; input.maxLength = 120;
  row.replaceChildren(input); input.focus(); input.select();
  let finished = false;
  const finish = async save => {
    if (finished) return; finished = true;
    const title = input.value.trim(); input.disabled = true;
    try {
      if (save && title && title !== session.title) {
        const result = await api(`/api/sessions/${id}`,{method:'PATCH',body:JSON.stringify({title})});
        Object.assign(session, result); if (active === id) updateTitle(result.title); toast('会话已重命名');
      } else if (save && !title) toast('标题不能为空，已保留原来的名字。');
    } catch (error) { toast(error.message); }
    finally { editingSession = null; renderSessionList(); document.querySelector(`[data-session="${id}"] .session`)?.focus({preventScroll:true}); }
  };
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(event.key === 'Enter'); }
  });
  input.addEventListener('blur', () => finish(true));
}
function toggleBatchMode() { if (batchBusy) return; batchMode = !batchMode; if (!batchMode) selectedSessions.clear(); renderSessionList(); }
function toggleSelectedSession(id, selected) { if (selected) selectedSessions.add(id); else selectedSessions.delete(id); updateBatchToolbar(); }
function updateBatchToolbar() {
  $('batchToolbar').hidden = !batchMode; $('batchToggle').setAttribute('aria-pressed',batchMode);
  $('batchCount').textContent = `已选 ${selectedSessions.size} 项`;
  $('batchExport').disabled = $('batchDelete').disabled = batchBusy || !selectedSessions.size;
  $('selectAllButton').disabled = batchBusy || !sessionCache.length;
  $('selectAllButton').textContent = sessionCache.length && sessionCache.every(item => selectedSessions.has(item.id)) ? '取消全选' : '全选结果';
}
function selectAllSessions() {
  const all = sessionCache.every(item => selectedSessions.has(item.id));
  sessionCache.forEach(item => all ? selectedSessions.delete(item.id) : selectedSessions.add(item.id)); renderSessionList();
}
async function exportSelectedSessions() {
  if (!selectedSessions.size || batchBusy) return;
  batchBusy = true; updateBatchToolbar();
  try { const result = await api('/api/sessions/batch/export',{method:'POST',body:JSON.stringify({ids:[...selectedSessions]})}); showInfo('已导出会话',result.exported.map(item => item.path).join('\n\n')); }
  catch (error) { toast(error.message); }
  finally { batchBusy = false; updateBatchToolbar(); }
}
async function deleteSelectedSessions() {
  if (!selectedSessions.size || batchBusy) return;
  const ids = [...selectedSessions];
  if (requestInFlight && ids.includes(requestInFlight.id)) { toast('这段对话还在等待回复，请稍后再删除。'); return; }
  if (!confirm(`删除选中的 ${ids.length} 段会话及其中的全部消息？此操作不可撤销，长期记忆不受影响。`)) return;
  batchBusy = true; updateBatchToolbar();
  try {
    const result = await api('/api/sessions/batch/delete',{method:'POST',body:JSON.stringify({ids})});
    if (result.deleted.includes(active)) { newSession(); }
    for (const id of result.deleted) {
      drafts.get(id)?.attachments.forEach(revokeAttachment); drafts.delete(id); scrollPositions.delete(id); failedReplies.delete(id); selectedSessions.delete(id);
    }
    await loadSessions(); toast(`已删除 ${result.deleted.length} 段会话`);
  } catch (error) { toast(error.message); }
  finally { batchBusy = false; updateBatchToolbar(); }
}
async function exportCurrent() {
  if (!active) return;
  try { const result = await api(`/api/sessions/${active}/export`,{method:'POST',body:'{}'}); showInfo('会话已导出',result.path); }
  catch (error) { toast(error.message); }
}

/* Reading state is explicit: a reply cannot drag a reader away from old text. */
function messageBubble(message) {
  const attachments = message.attachments || [], content = visibleMessageText(message.content, attachments);
  const who = message.role === 'user' ? '你' : '桔梗';
  const date = parseDate(message.created_at), time = date ? date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : '刚刚';
  const reasoning = message.role === 'assistant' ? String(message.reasoning_content || '').trim() : '';
  const thought = reasoning ? `<details class="reasoning-details"><summary>查看思考过程</summary><div class="reasoning-body">${esc(reasoning)}</div></details>` : '';
  return `<article class="message-row ${message.role==='user' ? 'user' : 'assistant'}" data-mid="${esc(message.id)}" tabindex="0" aria-label="${who} · ${esc(time)}"><div class="bubble">${thought}${content ? `<div class="message-text">${esc(content)}</div>` : ''}${attachments.length ? `<div class="bubble-attachments">${attachmentMarkup(attachments)}</div>` : ''}${typeof generationMarkup === 'function' ? generationMarkup(message) : ''}</div><div class="message-meta">${who} · <time datetime="${esc(message.created_at || '')}">${esc(time)}</time></div>${typeof memoryMessageTools==='function' ? memoryMessageTools(message) : ''}</article>`;
}
function welcomeMarkup() {
  return `<section class="welcome-hero"><div class="welcome-copy"><span class="welcome-kicker">KIKYOU · OUR LITTLE DAYS</span><h2>回来啦，<br>今天想和我分享些啥呢</h2><span class="face">(◍•ᴗ•◍)</span><p>琐碎的小事，也可以慢慢说。<br>我会在这里，认真听你讲。</p><div class="welcome-shortcuts"><button onclick="welcomeAction('chat')">${icon('spark')}聊聊今天</button><button onclick="welcomeAction('history')">${icon('sidebar')}翻翻旧时光</button></div></div><div class="portrait-card" aria-hidden="true"><div class="portrait-window"><img src="/static/theme-placeholder.svg" alt="" decoding="async"></div><span class="portrait-orbit">${icon('spark')}</span><div class="portrait-caption"><span>JUST BETWEEN US</span><span>✧</span></div></div></section>`;
}
function renderMessages(messages, position) {
  shownMessages = messages;
  if (typeof resumeStreamFromHistory === 'function') resumeStreamFromHistory(messages);
  let previousDate = null;
  $('messages').classList.toggle('is-empty', !messages.length && !loadingView);
  $('messageList').innerHTML = messages.length ? messages.map(message => {
    const date = parseDate(message.created_at);
    const divider = date && (!previousDate || date.toDateString() !== previousDate.toDateString() || date - previousDate >= 30*60000)
      ? `<div class="date-divider">${shortDate(message.created_at)} · ${date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</div>` : '';
    previousDate = date; return divider + messageBubble(message);
  }).join('') : welcomeMarkup();
  if (requestInFlight?.id === active) showThinking();
  if (failedReplies.has(active)) appendFailure(failedReplies.get(active));
  restorePosition(position);
  const current = active, serial = viewRequest;
  requestAnimationFrame(() => { if (current === active && serial === viewRequest) restorePosition(position); });
}
function showThinking() {
  if ($('thinking')) return;
  $('messageList').insertAdjacentHTML('beforeend','<div class="thinking" id="thinking" role="status"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>桔梗正在想怎么回应你…</div>');
}
function hideThinking() { $('thinking')?.remove(); }
function appendFailure(error) {
  $('messageList').insertAdjacentHTML('beforeend',`<div class="message-error" role="alert">本次回复未完成\n${esc(error)}<small>可以调整连接设置，或切换到本地模型后继续。原有聊天仍然保留。</small></div>`);
}
function updateJumpButton() {
  const box = $('messages');
  $('jumpLatest').hidden = loadingView || box.scrollHeight - box.clientHeight < 80 || followLatest;
  $('jumpLabel').textContent = unreadReply ? '有新回复 · 回到最新' : '回到最新';
}
function jumpToNewestMessage(smooth = false) {
  followLatest = true; unreadReply = false;
  const box = $('messages');
  box.scrollTo({top:box.scrollHeight,behavior:smooth && !reducedMotion.matches ? 'smooth' : 'instant'});
  updateJumpButton();
}
function resizeComposer() {
  const input = $('message'); input.style.height = '40px';
  input.style.height = `${Math.min(136,Math.max(40,input.scrollHeight))}px`;
  if (followLatest) requestAnimationFrame(() => jumpToNewestMessage(false));
}
/* Existing memory tools stay available in the secondary workspace. */
async function loadMemories() {
  if (typeof loadCare==='function') loadCare();
  const serial = ++memoryRequest;
  try {
    const list = await api('/api/memories?q='+encodeURIComponent($('memorySearch').value.trim()));
    if (serial !== memoryRequest) return;
    memoryCache = Object.fromEntries(list.map(item => [item.id,item]));
    $('memories').innerHTML = list.length ? list.map(item => `<article class="memory"><span class="tag">#${item.id} · ${esc(item.category)} · ${item.importance}/10</span><p>${esc(item.content)}</p><div class="memory-actions"><button onclick="editMemory(${item.id})">编辑</button><button class="danger" onclick="deleteMemory(${item.id})">删除</button></div></article>`).join('') : `<div class="empty small">${$('memorySearch').value.trim() ? '没有找到相关记忆' : '值得记住的事，会慢慢留在这里。'}</div>`;
  } catch (error) { if (serial === memoryRequest) $('memories').innerHTML = `<div class="empty small">${esc(error.message)}<br><button onclick="loadMemories()">重新加载</button></div>`; }
}
function debounceMemories() { clearTimeout(memoryTimer); memoryTimer = setTimeout(loadMemories,220); }
async function editMemory(id) {
  if (!memoryCache[id]) return;
  const content = await askMemoryInput('这条记错了','填写正确的记忆内容，旧版本会保留在修改记录中。',memoryCache[id].content); if (!content?.trim()) return;
  try { await api(`/api/memories/${id}`,{method:'PATCH',body:JSON.stringify({content})}); loadMemories(); toast('记忆已更新'); }
  catch (error) { toast(error.message); }
}
async function deleteMemory(id) {
  if (!await askMemoryInput('不要再记这条','删除这条长期记忆，并阻止自动整理再次提出相同内容？聊天记录仍会保留。',null)) return;
  try { await api(`/api/memories/${id}`,{method:'DELETE'}); loadMemories(); toast('记忆已删除'); }
  catch (error) { toast(error.message); }
}
async function runRecall() {
  const query = $('recallInput').value.trim(); if (!query) return;
  $('recallButton').disabled = true;
  try { const list = await api('/api/recall',{method:'POST',body:JSON.stringify({query})}); $('recall').innerHTML = list.length ? list.map(item => `<div class="recall-item"><b>#${item.id} · ${esc(item.score)}</b><br><small>语义 ${esc(item.semantic)} · 关键词 ${esc(item.keywords.join('、') || '无')}</small><br>${esc(item.content)}</div>`).join('') : '<div class="empty small">没有相关记忆</div>'; }
  catch (error) { toast(error.message); }
  finally { $('recallButton').disabled = false; }
}

document.addEventListener('DOMContentLoaded', () => {
  renderPalettes(); applyPrefs(); bindAttachments(); renderAttachmentTray(); updateTitle(); renderMessages([]); updateSendState();
  loadSessions(); loadMemories(); loadProvider(); loadPersonas();
  $('messages').addEventListener('scroll', () => {
    const box = $('messages'); followLatest = box.scrollHeight - box.scrollTop - box.clientHeight < 70;
    if (followLatest) unreadReply = false; updateJumpButton();
  }, {passive:true});
  $('message').addEventListener('focus', () => { if (!loadingView) jumpToNewestMessage(false); });
  $('message').addEventListener('input', () => { jumpToNewestMessage(false); resizeComposer(); });
  $('message').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
  });
  $('recallInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) runRecall(); });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#quickMenu,#quickMenuButton')) closeQuickMenu(); });
  document.querySelectorAll('.modal-shell,.provider-modal').forEach(element => element.addEventListener('mousedown', event => { if (event.target === element && modalStack.at(-1)?.id === element.id) closeTopModal(); }));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (modalStack.length) closeTopModal();
      else if (!$('quickMenu').hidden) { closeQuickMenu(); $('quickMenuButton').focus(); }
      else if (narrowScreen.matches) closeMobileSides();
    }
    if (event.key === 'Tab' && modalStack.length) {
      const element = $(modalStack.at(-1).id);
      const items = [...element.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(item => item.getClientRects().length && !item.closest('[hidden]'));
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
  });
  new ResizeObserver(() => { if (followLatest && !loadingView) $('messages').scrollTop = $('messages').scrollHeight; updateJumpButton(); }).observe($('messageList'));
  narrowScreen.addEventListener('change', () => { mobileSides.left = mobileSides.right = false; applyPrefs(); });
  window.addEventListener('beforeunload', event => {
    if (requestInFlight) { event.preventDefault(); event.returnValue = ''; }
  });
});
