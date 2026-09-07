let pendingAttachments=[];
const attachmentLimit=4,attachmentMaxBytes=12*1024*1024,attachmentTotalBytes=24*1024*1024;
function attachmentSize(bytes){
  if(bytes<1024*1024)return Math.max(1,Math.round(bytes/1024))+' KB';
  return (bytes/1024/1024).toFixed(bytes>=10*1024*1024?0:1)+' MB';
}
function attachmentKind(file){
  const name=(file.name||'').toLowerCase();
  if((file.type||'').startsWith('image/'))return 'image';
  return name.endsWith('.pdf')?'pdf':'document';
}
function attachmentMarkup(items){
  return (items||[]).map(item=>{
    const name=item.name||item.original_name||'附件',kind=item.kind||'document',size=item.byte_size||item.size||0;
    const imageUrl=item.url||item.localUrl||'';
    if(kind==='image'&&imageUrl)return `<a class="chat-image" href="${esc(imageUrl)}" target="_blank" rel="noopener" title="打开 ${esc(name)}"><img src="${esc(imageUrl)}" alt="${esc(name)}" loading="lazy"></a>`;
    const fileUrl=item.download_url||item.url||item.localUrl||'#';
    const label=kind==='pdf'?'PDF':'文件';
    return `<a class="attachment-file" href="${esc(fileUrl)}" ${fileUrl==='#'?'':'download'}><span class="attachment-file-icon">${label}</span><span><strong>${esc(name)}</strong><small>${size?attachmentSize(size):'附件'}</small></span></a>`;
  }).join('');
}
function visibleMessageText(content,attachments){
  const text=String(content||'');
  return attachments&&attachments.length&&/^（已发送附件：.*）$/.test(text.trim())?'':text;
}
function renderAttachmentTray(){
  const tray=$('attachmentTray');if(!tray)return;
  tray.hidden=!pendingAttachments.length;
  tray.innerHTML=pendingAttachments.map((item,index)=>{
    const image=item.kind==='image'&&item.localUrl?`<img src="${esc(item.localUrl)}" alt="">`:`<span class="attachment-badge">${item.kind==='pdf'?'PDF':'文件'}</span>`;
    return `<div class="attachment-chip">${image}<span><strong>${esc(item.file.name)}</strong><small>${attachmentSize(item.file.size)}</small></span><button type="button" class="attachment-remove" aria-label="移除 ${esc(item.file.name)}" onclick="removePendingAttachment(${index})">×</button></div>`;
  }).join('');
}
function revokeAttachment(item){if(item&&item.localUrl)URL.revokeObjectURL(item.localUrl)}
window.removePendingAttachment=function(index){
  const removed=pendingAttachments.splice(index,1)[0];revokeAttachment(removed);renderAttachmentTray();
};
function addPendingFiles(files){
  const incoming=[...files].filter(file=>file&&file.name);
  if(!incoming.length)return;
  for(const file of incoming){
    if(pendingAttachments.length>=attachmentLimit){toast(`一次最多添加 ${attachmentLimit} 个附件`);break;}
    if(file.size>attachmentMaxBytes){toast(`${file.name} 超过 12 MB，未添加`);continue;}
    const total=pendingAttachments.reduce((sum,item)=>sum+item.file.size,0)+file.size;
    if(total>attachmentTotalBytes){toast('附件总大小请控制在 24 MB 以内');break;}
    const kind=attachmentKind(file);
    pendingAttachments.push({file,kind,localUrl:kind==='image'?URL.createObjectURL(file):''});
  }
  renderAttachmentTray();
}
window.chooseAttachments=function(){closeQuickMenu();$('attachmentInput').click()};
function bindAttachments(){
  const input=$('attachmentInput'),composer=document.querySelector('.composer'),message=$('message');
  if(!input||!composer)return;
  input.addEventListener('change',()=>{addPendingFiles(input.files);input.value=''});
  composer.addEventListener('dragover',event=>{event.preventDefault();composer.classList.add('dragging')});
  composer.addEventListener('dragleave',event=>{if(!composer.contains(event.relatedTarget))composer.classList.remove('dragging')});
  composer.addEventListener('drop',event=>{event.preventDefault();composer.classList.remove('dragging');addPendingFiles(event.dataTransfer.files)});
  message.addEventListener('paste',event=>{const files=event.clipboardData&&event.clipboardData.files;if(files&&files.length){event.preventDefault();addPendingFiles(files)}});
}
async function multipartApi(url,form){
  const response=await fetch(url,{method:'POST',body:form});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'操作失败');
  return data;
}
