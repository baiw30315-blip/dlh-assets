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

/* MVU parses a reply against an earlier selected message, never against the
 * reply it is about to replace. A late init can instead land on reply #2. */
function createDlhOpeningBaseline(api) {
  const active = m => m?.variables?.[m.swipe_id ?? 0];
  function opening() {
    const chat = api.chat();
    if (!Array.isArray(chat) || chat.length < 2 || chat.length > 3) return;
    if (chat[0]?.mes !== '【大凉龙虎传】' || chat[0].is_user || !chat[1]?.is_user || chat[2]?.is_user) return;
    // Partial existing MVU data needs diagnosis. Never replace it with defaults.
    if (chat.slice(0, 2).some(m => {
      const v = active(m);
      return v && ['stat_data', 'schema', 'initialized_lorebooks'].some(k => k in v);
    })) return;
    return chat;
  }
  let pending;
  async function prepare() {
    const chat = opening();
    if (!chat) return false;
    const ctx = api.context(), greeting = chat[0], user = chat[1], swipe = greeting.swipe_id ?? 0;
    const primary = api.primary();
    if (!primary) return false;
    const seed = {stat_data:{}, display_data:{}, delta_data:{}, schema:{type:'object',properties:{}}, initialized_lorebooks:{}};
    if (!await api.init(seed) || !Object.hasOwn(seed.initialized_lorebooks, primary) ||
        !seed.stat_data?.世界 || !seed.stat_data?.主角?.基础信息) return false;
    function valid() {
      return ctx === api.context() && primary === api.primary() && opening() === chat &&
        chat[0] === greeting && chat[1] === user && (greeting.swipe_id ?? 0) === swipe;
    }
    if (!valid()) return false;
    await api.update(v => valid() ? Object.assign(v, seed) : v);
    return true;
  }
  return function ensure() {
    if (!pending) pending = prepare().catch(e => console.warn('[龙虎录] 开局基准未就绪', e.message)).finally(() => {pending=null;});
    return pending;
  };
}
if (typeof eventMakeFirst==='function' && typeof waitGlobalInitialized==='function') {
  (async () => {
    await waitGlobalInitialized('Mvu');
    const ensure=createDlhOpeningBaseline({
      chat:()=>SillyTavern.chat, context:()=>SillyTavern.getCurrentChatId(),
      primary:()=>getCharWorldbookNames('current').primary,
      init:seed=>Mvu.reloadInitVar(seed),
      update:fn=>updateVariablesWith(fn,{type:'message',message_id:0})
    });
    for (const event of [tavern_events.MESSAGE_SENT,tavern_events.MESSAGE_RECEIVED,tavern_events.GENERATION_STARTED,tavern_events.CHAT_CHANGED]) {
      if(event) eventMakeFirst(event,ensure);
    }
    await ensure();
  })().catch(e=>console.warn('[龙虎录] 开局变量基准未接入',e.message));
}
