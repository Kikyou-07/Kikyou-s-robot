'use strict';
let careSerial=0, candidateCache={};
let memoryInputResolve=null;
function askMemoryInput(title,note,value) {
  if(memoryInputResolve)finishMemoryInput(false);
  $('memoryInputTitle').textContent=title;$('memoryInputNote').textContent=note;
  $('memoryInputText').hidden=$('memoryInputLabel').hidden=value===null;
  $('memoryInputText').value=value ?? '';
  openModal('memoryInputModal');
  requestAnimationFrame(()=>{if(value!==null)$('memoryInputText').focus({preventScroll:true});});
  return new Promise(resolve=>{memoryInputResolve=resolve;});
}
function finishMemoryInput(accepted) {
  const value=$('memoryInputText').hidden ? true : $('memoryInputText').value.trim();
  if(accepted && !value){$('memoryInputText').focus();return;}
  const resolve=memoryInputResolve;memoryInputResolve=null;closeModal('memoryInputModal');resolve?.(accepted?value:null);
}
function memoryMessageTools(message) {
  if(message.role!=='user' || !Number.isInteger(message.id))return '';
  return `<div class="message-memory-tools"><button onclick="rememberMessage(${message.id})">记住这句</button><button onclick="excludeMessage(${message.id},${!message.memory_excluded})">${message.memory_excluded?'已设为不要记 · 撤销':'不要记这个'}</button></div>`;
}
async function loadCare() {
  const serial=++careSerial;
  try {
    const data=await api('/api/care'); if(serial!==careSerial)return;
    candidateCache=Object.fromEntries(data.candidates.map(item=>[item.id,item]));
    $('careStatus').textContent=data.jobs.some(j=>j.status==='running')?'正在后台整理；你发消息时会优先聊天。':data.jobs.some(j=>j.status==='queued')?'整理已排队，聊天空闲时继续。':data.jobs.some(j=>j.status==='waiting')?'待整理内容已保留，下一次聊天后继续。':data.jobs.some(j=>j.status==='failed')?'后台整理暂未完成，不影响聊天。下次聊天后会再尝试。':'';
    const markup=data.candidates.length ? '<h3>待确认的记忆</h3>'+data.candidates.map(item=>`<article class="memory candidate"><p>${esc(item.memory.content)}</p><p class="care-note">你曾说：${esc((item.evidence||[]).join('；'))}</p>${item.conflict?`<p class="care-note">已有记忆：${esc(item.conflict.content)}</p>`:''}<div class="memory-actions"><button onclick="reviewMemory(${item.id},true)">${item.conflict?'确认更新原记忆':'确认记住'}</button><button onclick="reviewMemory(${item.id},false)">不要记</button></div></article>`).join('') : '';
    if($('memoryCandidates').innerHTML!==markup)$('memoryCandidates').innerHTML=markup;
  }catch(_) { $('careStatus').textContent='记忆整理状态暂时无法读取。'; }
}
async function updateMessageMemory(id,payload) {
  const response=await fetch(`/api/messages/${id}/memory`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json();
  if(response.status===409 && data.conflict && payload.action==='remember') {
    if(!await askMemoryInput('确认更新原记忆',`已有相近记忆：\n${data.conflict.content}\n\n更新为：\n${payload.content}？`,null))return false;
    return updateMessageMemory(id,{...payload,replace_id:data.conflict.id});
  }
  if(!response.ok)throw Error(data.error || '操作失败');return true;
}
async function refreshMemoryMessage(id,excluded) {
  const message=shownMessages.find(m=>m.id===id);
  if(message){message.memory_excluded=excluded;const row=document.querySelector(`[data-mid="${id}"] .message-memory-tools`);if(row)row.outerHTML=memoryMessageTools(message);}
  loadMemories();
}
async function rememberMessage(id) {
  const message=shownMessages.find(m=>m.id===id);if(!message)return;
  const content=await askMemoryInput('记住这句','确认要记住的事实，可以改写后再保存。',message.content.slice(0,280));if(!content?.trim())return;
  if(content.trim().length>280){toast('请把记忆缩短到 280 字以内。');return;}
  try{if(await updateMessageMemory(id,{action:'remember',content:content.trim()})){refreshMemoryMessage(id,false);toast('已记住；重复内容不会新增。');}}catch(error){toast(error.message);}
}
async function excludeMessage(id,excluded) {
  try{await updateMessageMemory(id,{action:excluded?'exclude':'allow'});refreshMemoryMessage(id,excluded);toast(excluded?'这句不会被自动提取为长期记忆。聊天记录及已有记忆不变。':'已允许从这句提取记忆。');}catch(error){toast(error.message);}
}
async function reviewMemory(id,accept) {
  const item=candidateCache[id];if(!item)return;
  try{await api(`/api/memory-candidates/${id}`,{method:'POST',body:JSON.stringify({action:accept?'accept':'reject',replace_id:accept?item.conflict?.id:null})});loadMemories();toast(accept?'记忆已确认。':'不会再自动提出相同记忆。');}catch(error){toast(error.message);loadCare();}
}
document.addEventListener('DOMContentLoaded',()=>{loadCare();setInterval(()=>{if(!document.hidden)loadCare();},5000);});
