'use strict';
const streamWatches = new Set();
const runStorage = 'kikyouGeneration';
function rememberRun(run) { try { sessionStorage.setItem(runStorage, JSON.stringify({id:run.id,session_id:run.session_id})); } catch (_) {} }
function forgetRun() { try { sessionStorage.removeItem(runStorage); } catch (_) {} }
function generationMarkup(message) {
  if (!message.generation_id) return '';
  const state = message.generation_status;
  const label = {running:'正在回复…',stopping:'正在停止…',stopped:'已停止 · 回复未完成',failed:'本次回复未完成'}[state] || '';
  return `<div class="generation-status">${esc(label)}${message.generation_error ? `<p>${esc(message.generation_error)}</p>` : ''}${message.can_retry ? `<button type="button" onclick="retryGeneration('${esc(message.generation_id)}')">重新生成</button>` : ''}</div>`;
}
function updateSendState() {
  const busy = Boolean(requestInFlight);
  $('send').disabled = creatingSession || (!busy && loadingView);
  $('send').classList.toggle('is-generating',busy);
  $('send').innerHTML = busy ? '<span class="stop-square" aria-hidden="true"></span>' : icon('arrow');
  $('send').setAttribute('aria-label',busy ? '停止生成' : '发送消息');
  $('send').title = busy ? '停止本次生成' : '发送（⌘ Enter）';
}
function runMessage(run) {
  return {id:'generation-'+run.id,role:'assistant',content:run.content || '',reasoning_content:run.reasoning || '',
    created_at:new Date().toISOString(),generation_id:run.id,generation_status:run.status,generation_error:run.error,
    can_retry:['failed','stopped'].includes(run.status) && !!run.user_id,attachments:[]};
}
function paintRun(run) {
  if (active !== run.session_id || loadingView) return;
  hideThinking();
  const position = capturePosition();
  let row = document.querySelector(`[data-mid="generation-${run.id}"]`);
  const message = runMessage(run);
  if (!row) {
    $('messages').classList.remove('is-empty'); $('messageList').querySelector('.welcome-hero')?.remove();
    $('messageList').insertAdjacentHTML('beforeend',messageBubble(message));
    row = document.querySelector(`[data-mid="generation-${run.id}"]`);
  }
  let text = row.querySelector('.message-text');
  if (!text) { text=document.createElement('div'); text.className='message-text'; row.querySelector('.bubble').prepend(text); }
  text.textContent = run.content || '';
  let details = row.querySelector('.reasoning-details');
  if (run.reasoning && !details) {
    details=document.createElement('details'); details.className='reasoning-details';
    details.innerHTML='<summary>查看思考过程</summary><div class="reasoning-body"></div>'; row.querySelector('.bubble').prepend(details);
  }
  if (details) details.querySelector('.reasoning-body').textContent=run.reasoning || '';
  row.querySelector('.generation-status')?.remove(); row.querySelector('.bubble').insertAdjacentHTML('beforeend',generationMarkup(message));
  const index=shownMessages.findIndex(item=>item.id===message.id);
  if(index<0) shownMessages.push(message); else shownMessages[index]=message;
  restorePosition(position);
}
async function refreshRunHistory(run) {
  if(active!==run.session_id || loadingView) return;
  const serial=viewRequest, position=capturePosition();
  try {
    const data=await api(`/api/sessions/${run.session_id}/messages`);
    if(active===run.session_id && serial===viewRequest) {renderMessages(data.messages,position);updateTitle(data.session.title);}
  } catch(error) {toast(error.message);}
}
async function finishRun(run) {
  if(requestInFlight?.runId===run.id) requestInFlight=null;
  forgetRun(); updateSendState();
  await refreshRunHistory(run);
  if(active===run.session_id && !followLatest) {unreadReply=true;updateJumpButton();}
  announce(run.status==='complete'?'桔梗回复了':run.status==='stopped'?'已停止生成':'本次回复未完成');
  loadSessions(); loadMemories();
}
async function watchGeneration(run) {
  if(streamWatches.has(run.id)) return;
  streamWatches.add(run.id); rememberRun(run);
  requestInFlight={id:run.session_id,runId:run.id}; updateSendState();
  let latest=run;
  try {
    const response=await fetch(`/api/generations/${run.id}/events`);
    if(!response.ok || !response.body) throw Error('回复连接暂时中断');
    const reader=response.body.getReader(), decoder=new TextDecoder();let buffer='';
    try {
      while(true) {
        const {done,value}=await reader.read();buffer+=decoder.decode(value || new Uint8Array(),{stream:!done});
        let newline;
        while((newline=buffer.indexOf('\n'))>=0) {
          const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
          latest=JSON.parse(line);paintRun(latest);
        }
        if(['complete','failed','stopped'].includes(latest.status)) {await reader.cancel();await finishRun(latest);return;}
        if(done) throw Error('回复连接暂时中断');
      }
    } finally {reader.releaseLock();}
  } catch(error) {
    // Reconnecting reads the existing job; it never starts another paid generation.
    try {
      const status=await api(`/api/generations/${run.id}`);
      latest=status;
      paintRun(status);
      if(['complete','failed','stopped'].includes(status.status)) {await finishRun(status);return;}
    } catch(_) {}
    toast('连接暂时中断。点击“重新连接”查看同一次回复，不会重新请求模型。');
    if(active===run.session_id) {
      paintRun(latest);
      const row=document.querySelector(`[data-mid="generation-${run.id}"] .generation-status`);
      if(row)row.innerHTML=`连接已中断 <button onclick="reconnectGeneration('${run.id}',${run.session_id})">重新连接</button>`;
    }
  } finally {streamWatches.delete(run.id);}
}
function resumeStreamFromHistory(messages) {
  const message=messages.find(item=>['running','stopping'].includes(item.generation_status));
  const sessionId=active;
  if(message) queueMicrotask(()=>watchGeneration({id:message.generation_id,session_id:sessionId}));
}
async function reconnectGeneration(id,sessionId) {
  const run=await api(`/api/generations/${id}`).catch(error=>{toast(error.message);return null;});
  if(run) watchGeneration(run);
}
async function stopGeneration() {
  const current=requestInFlight;if(!current?.runId)return;
  $('send').disabled=true;
  try {const run=await api(`/api/generations/${current.runId}/stop`,{method:'POST',body:'{}'});paintRun(run);if(!streamWatches.has(run.id))watchGeneration(run);}
  catch(error){toast(error.message);}finally{updateSendState();}
}
async function submitRun(url,options,id,requestId) {
  rememberRun({id:requestId,session_id:id});
  try {return await api(url,options);}
  catch(error) {
    // Resolve an uncertain start by its client-generated id before allowing another send.
    try {const response=await fetch(`/api/generations/${requestId}`);if(response.ok)return await response.json();if(response.status===404){forgetRun();throw error;}}
    catch(recoveryError){if(recoveryError===error)throw error;}
    requestInFlight={id,runId:requestId};updateSendState();
    throw Error('暂时无法确认发送结果，请恢复连接后刷新页面，不要重复发送。');
  }
}
async function sendMessage(event) {
  event.preventDefault();
  if(requestInFlight){await stopGeneration();return;}
  if(creatingSession || loadingView)return;
  const text=$('message').value.trim(),items=pendingAttachments.slice();if(!text&&!items.length)return;
  creatingSession=true;updateSendState();closeQuickMenu();
  let id=active;
  try {
    if(!id){const session=await api('/api/sessions',{method:'POST',body:'{}'});id=session.id;if(active===null){active=id;updateTitle(session.title);drafts.delete(null);}}
    const requestId=crypto.randomUUID(),form=new FormData();form.append('content',text);form.append('stream','1');form.append('request_id',requestId);
    items.forEach(item=>form.append('attachments',item.file,item.file.name));
    const run=await submitRun(`/api/sessions/${id}/messages`,{method:'POST',headers:{},body:form},id,requestId);
    if(active===id){pendingAttachments=[];$('message').value='';drafts.delete(id);renderAttachmentTray();resizeComposer();
      renderMessages([...shownMessages,{id:'pending-'+requestId,role:'user',content:text,attachments:items.map(item=>({name:item.file.name,kind:item.kind,size:item.file.size,localUrl:item.localUrl})),created_at:new Date().toISOString()}]);jumpToNewestMessage(false);}
    watchGeneration(run).finally(()=>items.forEach(revokeAttachment));
  }catch(error){toast(error.message);}finally{creatingSession=false;updateSendState();}
}
async function retryGeneration(previousId) {
  if(requestInFlight || creatingSession){toast('请等当前回复结束后再重试。');return;}
  const id=active,requestId=crypto.randomUUID();creatingSession=true;updateSendState();
  try {
    const run=await submitRun(`/api/generations/${previousId}/retry`,{method:'POST',body:JSON.stringify({request_id:requestId})},id,requestId);
    if(active===id){const position=capturePosition();renderMessages(shownMessages.filter(item=>item.generation_id!==previousId),position);}
    watchGeneration(run);
  }catch(error){toast(error.message);}finally{creatingSession=false;updateSendState();}
}
document.addEventListener('DOMContentLoaded',async()=>{
  let saved;try{saved=JSON.parse(sessionStorage.getItem(runStorage)||'null');}catch(_){}
  if(saved){try{const response=await fetch(`/api/generations/${saved.id}`);if(response.status===404){forgetRun();return;}const run=await response.json();if(['running','stopping'].includes(run.status))watchGeneration(run);else forgetRun();}catch(_){toast('上一条回复的状态暂时无法读取，请检查本机连接。');}}
});
