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

/* Repair only an unambiguous envelope. MVU still validates and executes the patch. */
function repairDlhMvuPatchEnvelope(text, previousState) {
 if (typeof text !== 'string') return null;
 const tags = [...text.matchAll(/<(\/?)(UpdateVariable|JSONPatch)\s*>/gi)];
 const names = tags.map(tag => (tag[1] + tag[2]).toLowerCase()).join(' ');
 const full = 'updatevariable jsonpatch /jsonpatch /updatevariable';
 const innerMissing = names === 'updatevariable jsonpatch /updatevariable';
 const outerMissing = names === 'updatevariable jsonpatch /jsonpatch';
 if (names !== full && !innerMissing && !outerMissing) return null;
 const end = tag => tag.index + tag[0].length;
 if (outerMissing && text.slice(end(tags[2])).trim()) return null;
 if (names === full && text.slice(end(tags[2]), tags[3].index).trim()) return null;
 const start = end(tags[1]), original = text.slice(start, tags[2].index);
 let payload = original.replace(/^(\s*)\x60{3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\x60{3}(\s*)$/i,'$1$2$3');
 // Match complete JSON strings first, so punctuation in a value stays literal.
 payload = payload.replace(/"(?:\\[\s\S]|[^"\\])*"|,(?=\s*[}\]])/g, (token,i) => {
  if (token !== ',') return token;
  let j=i-1;
  while (j>=0 && /\s/.test(payload[j])) j--;
  return j>=0 && !'[{:,'.includes(payload[j]) ? '' : token;
 });
 let rows;
 try { rows = JSON.parse(payload); } catch { return null; }
 if (!Array.isArray(rows)) return null;
 const edits = new Map(), touches = [];
 const rootNames = ['世界','主角','登场人物','剧情线','战斗状态','系统接入','十大恶人榜'];
 function path(value,index,key) {
  if (typeof value !== 'string') return null;
  let p=value;
  if (!p.startsWith('/')) {
   if (!rootNames.includes(p.split('/')[0]) || !p.includes('/') || /[.[\]]/.test(p)) return null;
   p='/'+p; edits.set(index+':'+key,p);
  }
  const parts=p.slice(1).split('/');
  if (parts.some(k=>!k || /~(?![01])/.test(k) || ['__proto__','prototype','constructor'].includes(k))) return null;
  touches.push({p,index});
  return parts.map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~'));
 }
 for (const [index,c] of rows.entries()) {
  if (!c || typeof c!=='object' || Array.isArray(c)) return null;
  const op=c.op;
  const keys=op==='move'?['op','from','to']:op==='remove'?['op','path']:['op','path','value'];
  if (!['move','remove','delta','replace','insert','add'].includes(op) ||
      Object.keys(c).length!==keys.length || !keys.every(k=>Object.hasOwn(c,k))) return null;
  if (op==='move') {
   if (!path(c.from,index,'from') || !path(c.to,index,'to')) return null;
   continue;
  }
  const parts=path(c.path,index,'path');
  if (!parts || (op==='delta' && !Number.isFinite(c.value))) return null;
  if (op==='add') {
   let parent=previousState;
   // Only named, missing members of an existing object have unambiguous insert semantics.
   if (parts.length<2 || parts.some(k=>k==='-' || /^\d+$|[.[\]]/.test(k))) return null;
   for (const k of parts.slice(0,-1)) {
    if (!parent || typeof parent!=='object' || Array.isArray(parent) || !Object.hasOwn(parent,k)) return null;
    parent=parent[k];
   }
   if (!parent || typeof parent!=='object' || Array.isArray(parent) || Object.hasOwn(parent,parts.at(-1))) return null;
   edits.set(index+':op','insert');
  }
 }
 for (const {p,index} of touches) {
  if (rows[index].op==='add' && touches.some(other=>other.index!==index &&
      (other.p===p || other.p.startsWith(p+'/') || p.startsWith(other.p+'/')))) return null;
 }
 if (!edits.size && payload===original && names===full) return null;
 // Replace only the edited string tokens, preserving number literals and whitespace.
 let depth=0,index=-1,key='',invalid=false;
 const stack=[];
 payload=payload.replace(/"(?:\\[\s\S]|[^"\\])*"|[[\]{}]/g,(token,offset)=>{
  if (token==='[' || token==='{') {
   if (depth===1 && token==='{') index++;
   stack.push(new Set()); depth++; return token;
  }
  if (token===']' || token==='}') { stack.pop(); depth--; return token; }
  let j=offset+token.length;
  while (j<payload.length && /\s/.test(payload[j])) j++;
  if (payload[j]===':') {
   const field=JSON.parse(token),fields=stack.at(-1);
   if (fields.has(field)) invalid=true;
   fields.add(field); if (depth===2) key=field;
  } else if (depth===2 && edits.has(index+':'+key)) return JSON.stringify(edits.get(index+':'+key));
  return token;
 });
 if (invalid) return null;
 const suffix=innerMissing?'</JSONPatch>\n'+text.slice(tags[2].index):
   outerMissing?tags[2][0]+'\n</UpdateVariable>'+text.slice(end(tags[2])):text.slice(tags[2].index);
 return text.slice(0,start)+payload+suffix;
}

function createDlhMvuEnvelopeHandler(api){
 return async function normalize(messageId){
  const id=Number(messageId);if(!Number.isSafeInteger(id)||id<0||id!==Number(api.lastId()))return;
  const context=api.context(),before=(await api.messages(id))?.at(-1);
  if(!before||before.role!=='assistant')return;
  const repaired=repairDlhMvuPatchEnvelope(before.message,api.previousState?.(id));if(repaired===null)return;
  const current=(await api.messages(id))?.at(-1);
  if(context!==api.context()||id!==Number(api.lastId())||!current||current.role!=='assistant'||current.message!==before.message||current.swipe_id!==before.swipe_id)return;
  await api.setMessages([{message_id:id,message:repaired}],{refresh:'none'});
  api.notice?.('[龙虎录] 已整理变量块格式，交由 MVU 正常处理');
 };
}
if(typeof eventMakeFirst==='function'&&typeof tavern_events!=='undefined'){
 const handler=createDlhMvuEnvelopeHandler({previousState:id=>{const row=SillyTavern.chat?.[id-1],v=row?.variables?.[row.swipe_id??0];return v?.schema!==undefined?v.stat_data:undefined;},lastId:()=>getLastMessageId(),context:()=>SillyTavern.getCurrentChatId(),messages:id=>getChatMessages(id),setMessages:(rows,options)=>setChatMessages(rows,options),notice:text=>console.info(text)});
 eventMakeFirst(tavern_events.MESSAGE_RECEIVED,handler);
}

/* MVU parses a reply against an earlier selected message, never against the
 * reply it is about to replace. A late init can instead land on reply #2. */

function dlhSeedShadowOpening(sd){
 const h=sd?.主角,basic=h?.基础信息,world=sd?.世界;
 if(!basic||!world||h.十影先天||world.开局预设||world.当前地点!=='待定'||(Number(world.游戏累计时辰)||0)>0||!['未知','',undefined].includes(basic.姓名))return false;
 const known=(h.武学与意境面板||={}).掌握武学||={};
 if(Object.keys(known).length)return false;
 h.十影先天='十影神子';
 world.开局预设='十影神子';world.当前地点='禹州·阳洛城';
 known.十种影法术={类型:'奇门',评级:'先天',熟练度:'皮毛',特殊效果:'先天自带；玉犬初始可召唤，其他式神通过调伏取得。'};
 return true;
}

function createDlhOpeningBaseline(api) {
  const active = m => m?.variables?.[m.swipe_id ?? 0];
  function opening() {
    const chat = api.chat();
    if (!Array.isArray(chat) || chat.length < 2 || chat.length > 3) return;
    if (!['【大凉烟云传】','【大凉龙虎传】'].includes(chat[0]?.mes) || chat[0].is_user || !chat[1]?.is_user || chat[2]?.is_user) return;
    // Partial existing MVU data needs diagnosis. Never replace it with defaults.
    if (chat.slice(0, 2).some(m => {
      const v = active(m);
      return v && ['stat_data', 'schema', 'initialized_lorebooks'].some(k => k in v);
    })) return;
    return chat;
  }
  let pending;
  async function prepare() {
    const activeChat=api.chat(),openingGreeting=activeChat?.[0],openingUser=activeChat?.[1];
    const marker=/^\[OOC:\s*-开局预设:\s*十影神子\s+-初始档案:\s*玩家扮演/u;
    const shadow=activeChat?.length>=2&&activeChat.length<=3&&/^【(?:大凉烟云传|大凉龙虎传)】(?:\s*<StatusPlaceHolderImpl\s*\/>)*\s*$/u.test(openingGreeting?.mes)&&!openingGreeting?.is_user&&openingUser?.is_user&&!activeChat[2]?.is_user&&marker.test(openingUser.mes);
    if(shadow&&active(openingGreeting)?.stat_data){
      const ctx=api.context(),swipe=openingGreeting.swipe_id??0;
      const valid=()=>ctx===api.context()&&api.chat()===activeChat&&activeChat[0]===openingGreeting&&activeChat[1]===openingUser&&(openingGreeting.swipe_id??0)===swipe;
      let changed=false;
      const grant=v=>{if(valid()&&dlhSeedShadowOpening(v.stat_data))changed=true;return v;};
      if(active(openingGreeting).stat_data.主角?.十影先天!=='十影神子')await api.update(grant);
      // MESSAGE_SENT normally copies the greeting into the user snapshot after
      // this hook. A resumed opening may already have emitted that snapshot.
      if(valid()&&active(openingGreeting).stat_data.主角?.十影先天==='十影神子'&&active(openingUser)?.stat_data&&active(openingUser).stat_data.主角?.十影先天!=='十影神子'&&api.updateUser)await api.updateUser(grant);
      return changed;
    }
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
    if(shadow)dlhSeedShadowOpening(seed.stat_data);
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
      update:fn=>updateVariablesWith(fn,{type:'message',message_id:0}),
      updateUser:fn=>updateVariablesWith(fn,{type:'message',message_id:1})
    });
    for (const event of [tavern_events.MESSAGE_SENT,tavern_events.MESSAGE_RECEIVED,tavern_events.GENERATION_STARTED,tavern_events.CHAT_CHANGED]) {
      if(event) eventMakeFirst(event,ensure);
    }
    await ensure();
  })().catch(e=>console.warn('[龙虎录] 开局变量基准未接入',e.message));
}
