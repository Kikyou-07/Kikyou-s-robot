let providerStatus=null,generationDraft=null,generationActiveTarget='local',personaStatus=null;
const generationFallback={local:{temperature:.65,top_p:.8,max_tokens:768},api:{temperature:.65,top_p:.8,max_tokens:512}};
const apiGenerationPresets={
  economy:{temperature:.55,top_p:.75,max_tokens:320},
  balanced:{temperature:.65,top_p:.8,max_tokens:512},
  precise:{temperature:.25,top_p:.6,max_tokens:512},
  creative:{temperature:.9,top_p:.92,max_tokens:768},
};
function copyGeneration(generation){
  const result=JSON.parse(JSON.stringify(generationFallback));
  for(const target of ['local','api']){
    const profile=generation&&generation[target];
    if(profile&&typeof profile==='object')Object.assign(result[target],profile);
  }
  return result;
}
function applyProviderStatus(status){
  providerStatus=status;
  const local=$('providerLocal'),remote=$('providerApi'),state=$('providerState');
  if(!local||!remote||!state)return;
  local.classList.toggle('active',status.mode==='local');
  remote.classList.toggle('active',status.mode==='api');
  const label=status.api.provider==='qwen'?'阿里云百炼 · 千问':'API';
  const options=[];if(status.api.thinking_enabled)options.push('思考开');if(status.api.web_search_enabled)options.push('联网开');
  const suffix=options.length?' · '+options.join('、'):'';
  const profile=status.generation&&status.generation[status.mode],limit=profile?' · 回复上限 '+profile.max_tokens+' Token':'';
  if(status.mode==='api')state.textContent='当前：'+label+' · '+(status.api.model||'未选择模型')+suffix+limit;
  else state.textContent=(status.api.configured?'当前：本地 Qwen · 已保存 '+label+' · '+status.api.model:'当前：本地 Qwen')+limit;
}
async function loadProvider(){
  try{applyProviderStatus(await api('/api/provider'))}
  catch(error){const state=$('providerState');if(state)state.textContent='模型设置暂时无法读取'}
}
function applyPersonaStatus(status){
  personaStatus=status;
  const state=$('personaState');
  if(!state)return;
  document.querySelectorAll('[data-persona]').forEach(button=>{
    const selected=button.dataset.persona===status.active;
    button.classList.toggle('active',selected);button.setAttribute('aria-pressed',selected);
  });
  state.textContent='当前：'+(status.active_label||'原版桔梗')+' · '+(status.active_description||'');
}
async function loadPersonas(){
  try{applyPersonaStatus(await api('/api/personas'))}
  catch(error){const state=$('personaState');if(state)state.textContent='角色卡设置暂时无法读取'}
}
async function switchPersona(id){
  try{
    const status=await api('/api/persona',{method:'PUT',body:JSON.stringify({id})});
    applyPersonaStatus(status);toast('已切换为'+status.active_label+'，下一句开始生效');
  }catch(error){toast(error.message)}
}
async function reloadActivePersona(){
  try{
    const status=await api('/api/persona/reload',{method:'POST',body:'{}'});
    applyPersonaStatus(status);toast(status.message);
  }catch(error){toast(error.message)}
}
async function switchProvider(mode){
  if(!providerStatus)await loadProvider();
  if(mode==='api'&&(!providerStatus||!providerStatus.api.configured)){
    openProviderDialog();toast('先填写 API 地址、模型名和 Key');return;
  }
  try{const status=await api('/api/provider',{method:'PUT',body:JSON.stringify({mode})});applyProviderStatus(status);toast(mode==='api'?'已切换到 API':'已切换到本地 Qwen')}
  catch(error){toast(error.message)}
}
function openProviderDialog(){
  const status=providerStatus;
  const unconfigured=!status||!status.api.configured;
  $('apiProvider').value=unconfigured?'qwen':(status.api.provider||'qwen');
  if(status){$('apiBaseUrl').value=status.api.base_url||'';$('apiModel').value=status.api.model||'';$('apiThinking').checked=!!status.api.thinking_enabled;$('apiWebSearch').checked=!!status.api.web_search_enabled;}
  else{$('apiThinking').checked=false;$('apiWebSearch').checked=false;}
  const profile=copyGeneration(status&&status.generation).api;
  $('apiTemperature').value=profile.temperature;$('apiTopP').value=profile.top_p;$('apiMaxTokens').value=profile.max_tokens;
  $('apiKeyStatus').textContent=status&&status.api.configured
    ?'已保存一个 Key。这里留空会保留原 Key；输入新值才会替换。已保存的原文永不回显到网页。'
    :'尚未保存 Key。Key 会写入这台 Mac 的本地配置文件，不会出现在聊天记录中。';
  $('apiKey').type='password';$('apiKeyVisibility').textContent='显示';$('apiKeyVisibility').setAttribute('aria-label','显示 API Key');
  applyProviderPreset();
  updateApiGenerationPreview();
  $('apiKey').value='';openModal('providerModal');
  setTimeout(()=>$('apiBaseUrl').focus(),0);
}
function applyProviderPreset(){
  const isQwen=$('apiProvider').value==='qwen',base=$('apiBaseUrl'),model=$('apiModel'),help=$('providerHelp'),providerTip=$('apiProviderTip'),modelTip=$('apiModelTip');
  for(const id of ['apiThinking','apiWebSearch']){$(id).disabled=!isQwen;$(id).closest('.provider-toggle').classList.toggle('disabled',!isQwen);}
  if(isQwen){
    if(!base.value||base.value==='https://api.openai.com/v1')base.value='https://dashscope.aliyuncs.com/compatible-mode/v1';
    if(!model.value)model.value='qwen3.7-plus';
    model.setAttribute('list','qwenModelOptions');model.placeholder='例如 qwen3.7-plus';
    providerTip.textContent='使用百炼的 OpenAI 兼容接口，并可传递千问的思考与联网开关。';
    modelTip.textContent='填写控制台中的模型 ID；下拉内容只是方便输入的示例，不代表账户一定已开通。';
    help.textContent='思考与联网是否可用、是否产生额外费用，以所选模型和百炼账户规则为准。遇到兼容错误时可先关闭两个开关。';
  }else{
    if(!base.value||base.value==='https://dashscope.aliyuncs.com/compatible-mode/v1')base.value='https://api.openai.com/v1';
    model.removeAttribute('list');model.placeholder='例如服务商文档中的模型 ID';
    providerTip.textContent='适用于实现了 OpenAI Chat Completions 格式的服务；不代表所有扩展能力都兼容。';
    modelTip.textContent='请原样填写服务商文档或控制台给出的模型 ID，注意大小写、版本和地域后缀。';
    help.textContent='通用兼容模式只发送标准聊天参数，思考与联网开关已停用。图片等附件能力取决于服务商实现。';
  }
  updateApiEndpointPreview();
}
function updateApiEndpointPreview(){
  const node=$('apiEndpointPreview'),raw=$('apiBaseUrl').value.trim();
  if(!raw){node.textContent='实际请求地址：请先填写 Base URL';return;}
  const base=raw.replace(/\/+$/,'');
  node.textContent='实际请求地址：'+(base.endsWith('/chat/completions')?base:base+'/chat/completions');
}
function toggleApiKeyVisibility(){
  const input=$('apiKey'),button=$('apiKeyVisibility'),show=input.type==='password';
  input.type=show?'text':'password';button.textContent=show?'隐藏':'显示';button.setAttribute('aria-label',(show?'隐藏':'显示')+' API Key');
}
function apiGenerationValues(){
  return {temperature:Number($('apiTemperature').value),top_p:Number($('apiTopP').value),max_tokens:Number($('apiMaxTokens').value)};
}
function validApiGeneration(profile){
  return Number.isFinite(profile.temperature)&&profile.temperature>=0&&profile.temperature<=1.5
    &&Number.isFinite(profile.top_p)&&profile.top_p>=.01&&profile.top_p<=1
    &&Number.isInteger(profile.max_tokens)&&profile.max_tokens>=64&&profile.max_tokens<=4096;
}
function updateApiGenerationPreview(){
  const profile=apiGenerationValues(),node=$('apiGenerationPreview');
  document.querySelectorAll('[data-api-preset]').forEach(button=>{
    const preset=apiGenerationPresets[button.dataset.apiPreset];
    button.classList.toggle('active',validApiGeneration(profile)&&Object.keys(preset).every(key=>profile[key]===preset[key]));
  });
  if(!validApiGeneration(profile)){node.textContent='请检查范围：温度 0–1.5、Top P 0.01–1、最大输出 64–4096。';node.classList.add('invalid');return;}
  node.classList.remove('invalid');
  const tone=profile.temperature<=.35?'表达更稳定':profile.temperature<=.75?'自然、适合日常聊天':'变化更丰富',focus=profile.top_p<=.65?'候选范围较集中':profile.top_p<=.9?'候选范围均衡':'候选范围很宽',length=profile.max_tokens<=384?'偏短回复':profile.max_tokens<=768?'中等长度回复':'允许较长回复';
  node.textContent=`当前组合：${tone} · ${focus} · ${length}。实际长度与用量仍由问题、模型和服务商决定。`;
}
function applyApiGenerationPreset(name){
  const profile=apiGenerationPresets[name];if(!profile)return;
  $('apiTemperature').value=profile.temperature;$('apiTopP').value=profile.top_p;$('apiMaxTokens').value=profile.max_tokens;updateApiGenerationPreview();
}
function closeProviderDialog(){
  closeModal('providerModal');$('apiKey').value='';$('apiKey').type='password';
}
function renderGenerationFields(){
  const profile=generationDraft[generationActiveTarget];
  $('generationTemperature').value=profile.temperature;
  $('generationTopP').value=profile.top_p;
  $('generationMaxTokens').value=profile.max_tokens;
  const help=$('generationHelp');
  help.innerHTML=generationActiveTarget==='api'
    ?'<strong>API 节省重点：</strong>最大回复长度是单轮输出的上限。日常聊天可先用 350～512；需要长文时再临时提高。'
    :'<strong>本地模型：</strong>这套参数只影响本地 Qwen，不会改变 API 用量。温度越高，措辞越活一些；Top P 越高，变化越多。';
}
function captureGenerationFields(showError=true){
  if(!generationDraft)return true;
  const temperature=Number($('generationTemperature').value),topP=Number($('generationTopP').value),maxTokens=Number($('generationMaxTokens').value);
  const valid=Number.isFinite(temperature)&&temperature>=0&&temperature<=1.5&&Number.isFinite(topP)&&topP>=.01&&topP<=1&&Number.isInteger(maxTokens)&&maxTokens>=64&&maxTokens<=4096;
  if(!valid){if(showError)toast('请检查参数：温度 0–1.5、Top P 0.01–1、回复长度 64–4096');return false;}
  generationDraft[generationActiveTarget]={temperature,top_p:topP,max_tokens:maxTokens};
  return true;
}
async function openGenerationDialog(){
  if(!providerStatus)await loadProvider();
  if(!providerStatus){toast('参数设置暂时无法读取');return;}
  generationDraft=copyGeneration(providerStatus.generation);
  generationActiveTarget=providerStatus.mode==='api'?'api':'local';
  $('generationTarget').value=generationActiveTarget;renderGenerationFields();
  openModal('generationModal');
  setTimeout(()=>$('generationTemperature').focus(),0);
}
function switchGenerationTarget(){
  const next=$('generationTarget').value;
  if(next===generationActiveTarget)return;
  if(!captureGenerationFields()){$('generationTarget').value=generationActiveTarget;return;}
  generationActiveTarget=next;renderGenerationFields();
}
function closeGenerationDialog(){
  closeModal('generationModal');generationDraft=null;
}
async function saveGeneration(){
  if(!captureGenerationFields())return;
  const button=$('saveGenerationButton');button.disabled=true;button.textContent='保存中…';
  try{const status=await api('/api/provider',{method:'PUT',body:JSON.stringify({generation:generationDraft})});applyProviderStatus(status);closeGenerationDialog();toast('两套回复参数已保存')}
  catch(error){toast(error.message)}
  finally{button.disabled=false;button.textContent='保存参数';}
}
async function saveProvider(){
  const provider=$('apiProvider').value,baseUrl=$('apiBaseUrl').value.trim(),modelName=$('apiModel').value.trim(),apiKey=$('apiKey').value.trim();
  if(!baseUrl||!modelName){toast('请填写 API 地址和模型名');return;}
  const apiProfile=apiGenerationValues();if(!validApiGeneration(apiProfile)){toast('请检查 API 回复参数的范围');return;}
  if(!apiKey&&(!providerStatus||!providerStatus.api.configured)){toast('第一次连接时请填写 API Key');return;}
  const apiSettings={provider,base_url:baseUrl,model:modelName,thinking_enabled:provider==='qwen'&&$('apiThinking').checked,web_search_enabled:provider==='qwen'&&$('apiWebSearch').checked};if(apiKey)apiSettings.api_key=apiKey;
  const button=$('saveProviderButton');button.disabled=true;button.textContent='保存中…';
  try{const status=await api('/api/provider',{method:'PUT',body:JSON.stringify({mode:'api',api:apiSettings,generation:{api:apiProfile}})});applyProviderStatus(status);closeProviderDialog();toast('API 连接与回复参数已保存')}
  catch(error){toast(error.message)}
  finally{button.disabled=false;button.textContent='保存并启用';}
}
