let usagePoll=null;
const usageNames={chat:'聊天',title:'标题整理',summary:'摘要整理',memory:'记忆整理'};
const usageStates={running:'进行中',complete:'完成',stopped:'已停止',failed:'失败',interrupted:'重启中断'};
const usageNumber=value=>value===null||value===undefined?'未知':Number(value).toLocaleString('zh-CN');
async function openUsage(){
  $('usageDay').value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  openModal('usageModal');await loadUsage();
  clearInterval(usagePoll);usagePoll=setInterval(()=>{
    if($('usageModal').hidden){clearInterval(usagePoll);return;}
    if(!document.hidden&&!$('usageContent').contains(document.activeElement))loadUsage();
  },10000);
}
async function loadUsage(){
  const day=$('usageDay').value;
  try{
    const data=await api('/api/usage?day='+encodeURIComponent(day));
    if($('usageDay').value!==day)return;
    const input=data.groups.reduce((n,g)=>n+g.input_tokens,0),output=data.groups.reduce((n,g)=>n+g.output_tokens,0),unknown=data.groups.reduce((n,g)=>n+g.unknown,0);
    $('usageSummary').textContent=`${data.requests} 次请求 · 聊天 ${data.chat} · 后台 ${data.background} ｜ 已返回：输入 ${usageNumber(input)} / 输出 ${usageNumber(output)} Token ｜ ${unknown} 次用量不完整`;
    $('usageContent').innerHTML=data.groups.length?data.groups.map(g=>`<section class="settings-card"><h3>${esc(g.model)} · ${esc(g.provider)}</h3><p>${g.requests} 次请求；已返回输入 ${usageNumber(g.input_tokens)}，输出 ${usageNumber(g.output_tokens)} Token</p><p>已返回的思考明细 ${usageNumber(g.reasoning_tokens)} Token（包含在输出内）；${g.reasoning_unknown} 次未提供思考明细。</p><p>${g.unknown} 次用量不完整；已计价 ${g.priced} 次：${g.priced?'约 ¥'+g.cost.toFixed(6):'未估算'}${g.priced<g.requests?'（部分估算）':''}</p><form onsubmit="event.preventDefault();saveUsagePrice(this)" data-key="${g.price_key}"><div class="provider-parameter-grid"><label class="provider-field"><span>输入单价（元 / 百万 Token）</span><input name="input_rate" aria-label="${esc(g.model)} 输入单价" type="number" min="0" max="1000000" step="any" required value="${g.price?g.price.input_rate:''}" placeholder="未设置"></label><label class="provider-field"><span>输出单价（元 / 百万 Token）</span><input name="output_rate" aria-label="${esc(g.model)} 输出单价" type="number" min="0" max="1000000" step="any" required value="${g.price?g.price.output_rate:''}" placeholder="未设置"></label></div><button type="submit">保存此模型单价</button></form></section>`).join(''):'<p class="empty">这一天还没有 API 请求记录。开始记录之前的用量无法补回。</p>';
    $('usageRows').innerHTML=data.recent.map(r=>`<tr><td>${esc(r.time.slice(11,19))}<br>${esc(usageNames[r.purpose]||r.purpose)}</td><td>${esc(r.model)}<br>${esc(usageStates[r.status]||r.status)}${r.session_id?' · 会话 #'+r.session_id:''}</td><td>${usageNumber(r.input_tokens)}</td><td>${usageNumber(r.output_tokens)}</td><td>${usageNumber(r.reasoning_tokens)}</td><td>${r.cost===null?'未估算':'¥'+r.cost.toFixed(6)}</td></tr>`).join('');
  }catch(error){$('usageSummary').textContent=error.message;}
}
async function saveUsagePrice(form){
  const button=form.querySelector('button');button.disabled=true;
  try{
    await api('/api/usage/prices',{method:'PUT',body:JSON.stringify({price_key:form.dataset.key,input_rate:form.elements.input_rate.value,output_rate:form.elements.output_rate.value})});
    await loadUsage();toast('单价已保存，估算已更新');
  }catch(error){toast(error.message)}finally{button.disabled=false;}
}
