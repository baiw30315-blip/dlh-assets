/* Narrow adaptation of the supplied snapshot-ownership fix.
 * No history compression, old-pin deletion, state projection or reward replay.
 */
function createDlhSnapshotOwnerGuard(getContext) {
  const pending=new Map();let removed=0;
  const active=m=>m?.variables?.[m.swipe_id||0];
  const scope=c=>String(c?.getCurrentChatId?.()??c?.chatId??'');
  function before(id,event) {
    const c=getContext(),m=c?.chat?.[id];if(!Number.isInteger(id)||!m||!scope(c))return;
    let previous;for(let n=id-1;n>=0;n--)if(active(c.chat[n])!=null){previous=active(c.chat[n]);break;}
    pending.set(event+'/'+id,{chat:c.chat,scope:scope(c),message:m,swipe:m.swipe_id||0,wasPinned:active(m)?.snapshot===true,previousPinned:previous?.snapshot===true});
  }
  function after(id,event) {
    const key=event+'/'+id,p=pending.get(key);pending.delete(key);const c=getContext(),m=c?.chat?.[id];
    if(!p||p.chat!==c?.chat||p.scope!==scope(c)||p.message!==m||p.swipe!==(m.swipe_id||0))return false;
    const v=active(m);
    if(!p.wasPinned&&p.previousPinned&&v?.snapshot===true){delete v.snapshot;removed++;return true;}
    return false;
  }
  return {before,after,reset(){pending.clear();},status:()=>({removed,pending:pending.size})};
}
if(typeof module==='object'&&module.exports)module.exports={createDlhSnapshotOwnerGuard};

// Script candidate: registration is inert outside the host, and does not scan
// or rewrite existing historical flags whose ownership cannot be established.
(function registerDlhSnapshotOwnerGuard(){
  if(typeof window==='undefined'||typeof eventMakeFirst!=='function'||typeof eventMakeLast!=='function'||typeof tavern_events==='undefined')return;
  const host=window.parent||window,getContext=()=>{const ctx=host.SillyTavern?.getContext?.()||window.SillyTavern?.getContext?.();return String(ctx?.characters?.[ctx.characterId]?.name||'').includes('大凉龙虎传')?ctx:undefined;};
  const c=getContext(),name=c?.characters?.[c.characterId]?.name;
  if(typeof name!=='string'||!name.includes('大凉龙虎传'))return;
  host.__dlhSnapshotOwnerGuard?.destroy?.();const guard=createDlhSnapshotOwnerGuard(getContext),stops=[];
  function listen(first,event,fn){if(!event)return;const handle=(first?eventMakeFirst:eventMakeLast)(event,fn);stops.push(()=>typeof eventRemoveListener==='function'?eventRemoveListener(event,fn):handle?.stop?.());}
  for(const name of ['MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_SWIPED']){
    const event=tavern_events[name];listen(true,event,id=>guard.before(id,name));
    listen(false,event,async id=>{if(guard.after(id,name)){const current=getContext();await current?.saveChat?.();}});
  }
  listen(true,tavern_events.CHAT_CHANGED,()=>guard.reset());
  const destroy=()=>{for(const stop of stops.splice(0))stop();guard.reset();};host.__dlhSnapshotOwnerGuard={...guard,destroy};window.addEventListener('pagehide',destroy,{once:true});
})();
