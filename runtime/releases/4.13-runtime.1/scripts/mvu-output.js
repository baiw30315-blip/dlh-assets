/* Request-only mode guard. Never edits messages on disk or variable state. */
function createDlhMvuOutputGuard(api){
 const authorization='【MVU本轮变量执行请求】',notice='【当前请求：额外模型解析的正文阶段】\n本请求只负责叙事、对话、已触发的界面与战报承接。禁止输出变量更新分析、UpdateVariable、JSONPatch、变量工具调用或变量操作指令。其他世界书中的“登记、写入、更新、开战建档”在本阶段只表示应叙明相应事实；实际变量命令由后续解析请求执行，不省略开战、获得物品、修炼奖励等事实。历史回复中的变量块和预设中的通用变量示例不改变本阶段分工。';
 return async function guard(request){
  if(!Array.isArray(request?.messages))return;
  let mode=api.settings()?.更新方式||'随AI输出';
  try{
   const rows=await api.entries(),overrides=rows.filter(e=>String(e.comment||'').trim().toLowerCase()==='[config_override]');
   if(overrides.length===1){const d=JSON.parse(overrides[0].content);if(['随AI输出','额外模型解析'].includes(d.更新方式))mode=d.更新方式;}
  }catch(_){/* MVU falls back to user settings for unreadable overrides too. */}
  if(mode!=='额外模型解析'||api.duringExtra())return;
  // Parser requests carry the update-only world's authorization; never block them.
  if(request.messages.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.includes(authorization)))return;
  if(!request.messages.some(m=>m.role==='system'&&m.content===notice))request.messages.push({role:'system',content:notice});
 };
}
if(typeof eventOn==='function'&&typeof tavern_events!=='undefined'){
 (async()=>{
  await waitGlobalInitialized('Mvu');
  const guard=createDlhMvuOutputGuard({settings:()=>SillyTavern.extensionSettings?.mvu_settings,duringExtra:()=>Mvu.isDuringExtraAnalysis?.()===true,entries:async()=>{const name=getCharWorldbookNames('current').primary;return name?await getLorebookEntries(name):[];}});
  eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY,guard);
 })().catch(e=>console.warn('[龙虎录] MVU正文分工约束未注册：'+String(e.message||e)));
}

/* Repair one missing inner closing tag; MVU remains the only patch executor. */
function repairDlhMvuPatchEnvelope(text){
 if(typeof text!=='string')return null;
 const blocks=[...text.matchAll(/<UpdateVariable\s*>([\s\S]*?)<\/UpdateVariable\s*>/gi)];
 if(blocks.length!==1||[...text.matchAll(/<UpdateVariable\s*>/gi)].length!==1)return null;
 const block=blocks[0],body=block[1];
 if((body.match(/<JSONPatch\s*>/gi)||[]).length!==1||/<\/JSONPatch\s*>/i.test(body))return null;
 const open=/<JSONPatch\s*>/i.exec(body),payload=body.slice(open.index+open[0].length).trim();
 let commands;try{commands=JSON.parse(payload);}catch(_){return null;}
 if(!Array.isArray(commands)||!commands.every(c=>c&&typeof c==='object'&&!Array.isArray(c)&&['replace','delta','insert','remove','move'].includes(c.op)&&
   (c.op==='move'?typeof c.from==='string'&&typeof c.to==='string':typeof c.path==='string')))return null;
 const close=block.index+block[0].lastIndexOf('</');
 return text.slice(0,close)+'</JSONPatch>\n'+text.slice(close);
}
function createDlhMvuEnvelopeHandler(api){
 return async function normalize(messageId){
  const id=Number(messageId);if(!Number.isSafeInteger(id)||id<0||id!==Number(api.lastId()))return;
  const context=api.context(),before=(await api.messages(id))?.at(-1);
  if(!before||before.role!=='assistant')return;
  const repaired=repairDlhMvuPatchEnvelope(before.message);if(repaired===null)return;
  const current=(await api.messages(id))?.at(-1);
  if(context!==api.context()||id!==Number(api.lastId())||!current||current.role!=='assistant'||current.message!==before.message||current.swipe_id!==before.swipe_id)return;
  await api.setMessages([{message_id:id,message:repaired}],{refresh:'none'});
  api.notice?.('[龙虎录] 已补齐完整 JSONPatch 的结束标签，交由 MVU 正常处理');
 };
}
if(typeof eventMakeFirst==='function'&&typeof tavern_events!=='undefined'){
 const handler=createDlhMvuEnvelopeHandler({lastId:()=>getLastMessageId(),context:()=>SillyTavern.getCurrentChatId(),messages:id=>getChatMessages(id),setMessages:(rows,options)=>setChatMessages(rows,options),notice:text=>console.info(text)});
 eventMakeFirst(tavern_events.MESSAGE_RECEIVED,handler);
}
