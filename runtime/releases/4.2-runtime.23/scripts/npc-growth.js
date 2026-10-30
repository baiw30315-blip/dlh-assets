// NPC 境界同步自动结算（酒馆助手脚本）
// 功能：剧情时间大幅流逝（月差≥3，约跨季）时，自动批量提升同档/低档 NPC 的小境界，
//       在 MVU 变量更新结束时直接写入 stat_data 并推进 世界.上次成长结算 锚点，
//       免除 AI 逐 NPC 手动写入的变量更新负担。
// 依赖：MVU 变量框架（Mvu）。API 不可用时静默降级（AI 可继续按《NPC境界同步成长规则》手动结算）。
$(() => {
  (async () => {
    await waitGlobalInitialized('Mvu');

    const 境界阶梯 = [
      '无修为', '一境锻骨', '二境筑基', '三境明气', '四境开窍',
      '五境八关_一关开', '五境八关_二关休', '五境八关_三关生', '五境八关_四关伤', '五境八关_五关杜',
      '五境八关_六关景', '五境八关_七关死', '五境八关_八关惊',
      '六关气海_初入', '六关气海_中凝', '六关气海_满盈',
      '七关气海_初入', '七关气海_中凝', '七关气海_满盈',
      '八关气海_初入', '八关气海_中凝', '八关气海_满盈',
      '七境抱丹', '八境破星', '九境宏愿'
    ];

    // 中文数字解析（1~99）：支持 元/正/冬/腊 等特殊写法
    function 中文数字(s) {
      if (typeof s !== 'string' || s.length === 0) return null;
      if (s === '元') return 1;
      const 单字 = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 正: 1, 冬: 11, 腊: 12 };
      if (s in 单字) return 单字[s];
      const 尾 = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
      let m = s.match(/^十([一二三四五六七八九])$/); // 十一~十九
      if (m) return 10 + 尾[m[1]];
      m = s.match(/^([一二三四五六七八九])十$/); // 二十~九十
      if (m) return 尾[m[1]] * 10;
      m = s.match(/^([一二三四五六七八九])十([一二三四五六七八九])$/); // 二十一~九十九
      if (m) return 尾[m[1]] * 10 + 尾[m[2]];
      return null;
    }

    // 解析「大凉更启X年Y月…」为累计月数；格式无法解析时返回 null
    function 解析月(t) {
      if (typeof t !== 'string') return null;
      const 年匹配 = t.match(/([元一二三四五六七八九十两]{1,3})年/);
      const 月匹配 = t.match(/([正一二三四五六七八九十冬腊两]{1,3})月/);
      if (!月匹配) return null;
      const 年 = 年匹配 ? 中文数字(年匹配[1]) : 1;
      const 月 = 中文数字(月匹配[1]);
      if (!年 || !月) return null;
      return 年 * 12 + 月;
    }

    function 档位(b) {
      if (typeof b !== 'string') return -1;
      return 境界阶梯.indexOf(b.trim().replace(/\s+/g, ''));
    }

    // 小境界内提升；不跨大境界（五境八关逐关推进、气海在关内 初入→中凝→满盈 推进；
    // 无修为~四境开窍跨大境界需铺垫、抱丹/破星/宏愿需机缘，均不自动提升）
    function 提升(档, 步数) {
      if (档 < 0) return null;
      const b = 境界阶梯[档];
      if (b.startsWith('五境八关')) {
        const 上限 = 境界阶梯.indexOf('五境八关_八关惊');
        return 境界阶梯[Math.min(档 + 步数, 上限)];
      }
      if (b.includes('气海')) {
        const 关内 = ['初入', '中凝', '满盈'];
        const 分割 = b.split('_');
        const 新阶段 = 关内[Math.min(关内.indexOf(分割[1]) + 步数, 2)];
        return 分割[0] + '_' + 新阶段;
      }
      return null;
    }

    // 在 MVU 变量更新结束时结算：直接修改 variables，由 MVU 统一写回楼层，避免读写竞争
    function 结算(variables) {
      try {
        const 当前 = _.get(variables, 'stat_data.世界.当前时间', '');
        const 上次 = _.get(variables, 'stat_data.世界.上次成长结算', '');
        if (!当前 || 当前 === 上次) return; // 时间未变 → 不结算
        const 当前月 = 解析月(当前);
        const 上次月 = 解析月(上次);
        if (当前月 === null || 上次月 === null) return; // 时间格式无法解析 → 不乱动
        const 月差 = 当前月 - 上次月;
        if (月差 < 3) return; // 时间流逝不足 → 不结算

        const 主角档 = 档位(_.get(variables, 'stat_data.主角.基础信息.武道境界', ''));
        const 步数 = 月差 >= 24 ? 2 : 1;
        let 更新数 = 0;
        for (const 栏 of ['内眷', '同门', '同道', '仇敌']) {
          const 人物 = _.get(variables, 'stat_data.登场人物.' + 栏) || {};
          for (const 名 of Object.keys(人物)) {
            const npc = 人物[名] || {};
            if (npc.生死 === '已死') continue; // 死亡档案保留原状，不参与时间补偿成长
            const 档 = 档位(npc.武道境界);
            if (档 < 0) continue;      // 境界未知/异常，跳过
            if (档 > 主角档) continue; // 只提升同档或低档 NPC（主角档为 -1 时全部跳过）
            const 新 = 提升(档, 步数);
            if (新 && 新 !== npc.武道境界) {
              npc.武道境界 = 新;
              更新数++;
            }
          }
        }
        // 无论是否有 NPC 更新，时间已流逝即推进锚点，避免重复结算同一时段
        _.set(variables, 'stat_data.世界.上次成长结算', 当前);
        console.log('[NPC成长] 结算完成：时间推进 ' + 月差 + ' 个月，更新 NPC ' + 更新数 + ' 名');
      } catch (e) {
        console.error('[NPC成长] 结算异常（已忽略，不影响游戏）', e);
      }
    }

    eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, variables => {
      结算(variables);
    });
  })();
});
