// 注入预算管理（酒馆助手脚本）v3 —— 会话基线快照版
// 目标：token 紧张时【临时】让出低优先级条目的额度，回落即还原；
//       核心条目永不禁用；且【绝不打乱作者的开关】——不擅自开启任何"本该关闭"的条目。
//
// 版本沿革与踩过的坑：
//   v1：只靠内存标志 + 回落判断。在超限状态下关掉的条目会被持久化写进世界书，
//       页面重载后仍停在 disabled → 表现为"世界书条目被永久关闭"。
//   v2：加了"加载即强制复原"，解决了永久关闭；但复原是【一律开启】——
//       作者手动关掉某条受管条目后，会被脚本重新打开，等于抹掉作者的选择。
//   v3：改为【基线快照】。首次运行把每个受管条目的 enabled 记下来当基线；
//       此后所有"复原"都只回到基线值：
//         · 基线为"关"的条目 → 永不擅自打开
//         · 基线为"开"的条目 → 只在超限时临时关，回落即按基线还原
//       快照存在会话内（内存），并尝试写入聊天元数据以增强跨刷新稳健性；
//       若环境不支持写元数据，则纯内存运行，功能不受影响。
//
// 说明：本脚本只使用 getCharWorldbookNames / getWorldbook / updateWorldbookWith /
//       getTokenCountAsync / eventOn 这几个卡内其它脚本已在用的 API。
$(() => {
  // 核心条目：任何情况下不参与禁用
  const 核心关键词 = ['剧情与扮演核心准则', '战斗规则', '后台思维链', '剧情线调度', 'NPC境界同步成长', 'NPC好感度系统', '境界突破推演', '剧情线/'];
  // 低优先级按需规则：token 紧张时优先让位（"用到才需要"的规则，非每轮必需）
  const 低优先级关键词 = [
    '随机江湖武学生成规则', '武林盛会运作规则', '中小型势力生成规则', '随机江湖人物生成规则',
    '谈婚论嫁规则', '驯兽宠物规则', '百艺系统规则', '经济系统', '通缉追杀', '伤病暗疾',
    '江湖绰号系统', '武学评级与兵器评级', '天地人三榜', '奇遇获取与挑战规则', '武林声望与说书人规则',
    '海神娘娘庙会', '百艺大会', '群侠大会', '论武会', '试剑会', '道门法会', '锦州诗剑会',
    '少年英雄会', '南北武道大会', '开宗立派规则', '门派事务管理规则', '门派内部晋升规则',
    '势力演变规则'
  ];
  // 占用阈值：聊天 token 不含预设与世界书注入，故留足余量
  const 阈值 = 0.85;
  // 快照在聊天元数据里的键名
  const 快照键 = 'inject_budget_baseline';

  function 上下文() {
    try {
      if (typeof SillyTavern === 'undefined') return null;
      return typeof SillyTavern.getContext === 'function' ? SillyTavern.getContext() : SillyTavern;
    } catch (e) {
      return null;
    }
  }
  async function 估算占用() {
    try {
      const ctx = 上下文();
      if (!ctx || !ctx.maxContext || typeof ctx.getTokenCountAsync !== 'function') return null;
      const 聊天文本 = (ctx.chat || []).map(m => (m && m.mes) || '').join('\n');
      const 采样 = 聊天文本.slice(-ctx.maxContext * 2);
      const used = await ctx.getTokenCountAsync(采样);
      return { used, limit: ctx.maxContext };
    } catch (e) {
      return null;
    }
  }
  const 受管 = (名) => !核心关键词.some(k => 名.includes(k)) && 低优先级关键词.some(k => 名.includes(k));

  /* ── 基线快照 ── */
  let 基线 = null;   // { 条目名: true/false }
  function 读聊天快照() {
    try {
      const ctx = 上下文();
      const meta = ctx && ctx.chatMetadata;
      const 存 = meta && meta[快照键];
      return (存 && 存.表 && typeof 存.表 === 'object') ? 存.表 : null;
    } catch (e) { return null; }
  }
  function 写聊天快照(表) {
    try {
      const ctx = 上下文();
      if (ctx && ctx.chatMetadata) ctx.chatMetadata[快照键] = { 表 };
    } catch (e) { /* 不支持则忽略，纯内存运行 */ }
  }
  async function 建基线() {
    if (基线) return 基线;
    const 存 = 读聊天快照();
    if (存) { 基线 = 存; return 基线; }
    const 新基线 = {};
    try {
      const books = getCharWorldbookNames('current');
      const 书名单 = [books.primary, ...(books.additional || [])].filter(Boolean);
      for (const 书名 of 书名单) {
        const list = await getWorldbook(书名);
        (list || []).forEach(e => {
          const 名 = e.name || e.comment || '';
          if (受管(名)) 新基线[名] = (e.enabled !== false);
        });
      }
    } catch (e) {
      console.error('[注入预算] 建基线失败，本轮不做预算管理', e);
      基线 = {};
      return 基线;
    }
    基线 = 新基线;
    写聊天快照(新基线);
    const 关着的 = Object.keys(新基线).filter(k => !新基线[k]);
    console.log('[注入预算] 已建立会话基线：受管 ' + Object.keys(新基线).length + ' 条，'
      + '其中基线为关闭的 ' + 关着的.length + ' 条（这些永不擅自打开）');
    return 基线;
  }
  /* 某条目"本该是"的状态：有基线按基线，无基线保持原样 */
  function 基线值(名, 当前) {
    if (基线 && Object.prototype.hasOwnProperty.call(基线, 名)) return 基线[名];
    return 当前;
  }

  /* 复原：把受管条目拉回【基线值】（不是一律开启） */
  async function 复原() {
    try {
      await 建基线();
      if(!Object.keys(基线||{}).length)return;
      const books = getCharWorldbookNames('current');
      const 书名单 = [books.primary, ...(books.additional || [])].filter(Boolean);
      let 变更 = 0;
      for (const 书名 of 书名单) {
        await updateWorldbookWith(书名, entries =>
          entries.map(e => {
            const 名 = e.name || e.comment || '';
            if (!受管(名)) return e;
            const 该 = 基线值(名, e.enabled !== false);
            if ((e.enabled !== false) === 该) return e;
            变更++;
            return { ...e, enabled: 该 };
          }),
        );
      }
      if (变更 > 0) console.log('[注入预算] 已按基线复原 ' + 变更 + ' 条');
    } catch (e) {
      console.error('[注入预算] 复原失败（已忽略，不影响游戏）', e);
    }
  }

  async function 管理() {
    const t = await 估算占用();
    if (!t) return;
    const 超限 = t.used > t.limit * 阈值;
    let 变更 = 0;
    try {
      await 建基线();
      if(!Object.keys(基线||{}).length)return;
      const books = getCharWorldbookNames('current');
      const 书名单 = [books.primary, ...(books.additional || [])].filter(Boolean);
      for (const 书名 of 书名单) {
        await updateWorldbookWith(书名, entries =>
          entries.map(e => {
            const 名 = e.name || e.comment || '';
            if (!受管(名)) return e;                 // 核心与非受管条目：永不触碰
            const 基线开 = 基线值(名, e.enabled !== false);
            if (!基线开) return e;                   // 基线就是关的：永不擅自打开
            const 目标状态 = !超限;                   // 超限→临时关；回落→回基线（开）
            if ((e.enabled !== false) === 目标状态) return e;
            变更++;
            return { ...e, enabled: 目标状态 };
          }),
        );
      }
      if (变更 > 0) {
        console.log('[注入预算] ' + (超限
          ? '上下文紧张，临时让出低优先级条目 ' + 变更 + ' 条（回落即按基线复原）'
          : '上下文恢复，已按基线还原 ' + 变更 + ' 条'));
      }
    } catch (e) {
      console.error('[注入预算] 世界书切换失败（已忽略，不影响游戏）', e);
    }
  }

  // ① 每次加载先按基线复原一次
  复原().then(管理);
  // ② 每轮 AI 回复后重算
  eventOn(tavern_events.MESSAGE_RECEIVED, () => { 管理(); });
  // ③ 切换聊天时再复原一次
  eventOn(tavern_events.CHAT_CHANGED, () => { 基线 = null; 读基线后复原(); });
  function 读基线后复原() { 复原(); }
});
