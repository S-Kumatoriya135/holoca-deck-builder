/* ============================================================
   hOCG rules engine — Phase 1 (vanilla) + Phase 2 (effect DSL)
   Works in Node (module.exports) and browser (window.HoloEngine).
   ============================================================ */
(function () {
  'use strict';
  const COLORS = ['白', '緑', '赤', '青', '紫', '黄'];

  /* ---------- card analysis ---------- */
  function parseArt(a) {
    const line = a.split('\n')[0];
    const m = line.match(/^((?:\[[^\]]*\])+)/);
    const cost = { any: 0, colors: {}, total: 0 };
    if (m) {
      (m[1].match(/\[[^\]]*\]/g) || []).forEach((t) => {
        const v = t.slice(1, -1);
        if (v === '◇' || v === '◆') { cost.any++; cost.total++; }
        else if (COLORS.includes(v)) { cost.colors[v] = (cost.colors[v] || 0) + 1; cost.total++; }
      });
    }
    const rest = (m ? line.slice(m[1].length) : line).replace(/\[[^\]]*\]/g, ' ');
    const nums = (rest.match(/\d+/g) || []).map(Number);
    return { cost, power: nums.length ? nums[nums.length - 1] : 0 };
  }
  // NOTE: arts kept in ORIGINAL printed order (not sorted) so DSL effects.arts[i]
  // (indexed top-to-bottom as printed) lines up with this array.
  function analyzeCard(c, fx) {
    const arts = (c.tx && c.tx.a || []).map(parseArt);
    const baton = (c.bt || '').split('').filter((ch) => ch === '◇' || ch === '◆').length;
    return { arts, baton, fx: fx || null };
  }

  /* ---------- cheer payment ---------- */
  function canPay(cost, cheer) {
    const pool = {};
    cheer.forEach((c) => (pool[c] = (pool[c] || 0) + 1));
    for (const col in cost.colors) { if ((pool[col] || 0) < cost.colors[col]) return false; pool[col] -= cost.colors[col]; }
    let rem = 0; for (const k in pool) rem += pool[k];
    return rem >= cost.any;
  }
  function effCost(art, holo) {
    const reduce = (holo && holo.costReduce) || 0;
    if (!reduce) return art.cost;
    const c = { any: Math.max(0, art.cost.any - reduce), colors: art.cost.colors, total: Math.max(0, art.cost.total - reduce) };
    return c;
  }
  function bestArt(holo, DB) {
    const entry = DB.get(holo.card.n);
    const arts = entry.arts;
    let best = null, bestIdx = -1;
    arts.forEach((art, i) => {
      if (canPay(effCost(art, holo), holo.cheer)) {
        const power = art.power + (holo.buffArt || 0);
        if (!best || power > best.power) { best = { power, idx: i, base: art }; bestIdx = i; }
      }
    });
    return best;
  }
  function topArtPower(card, DB) {
    const e = DB.get(card.n); if (!e) return 0;
    const a = e.arts; return a.length ? Math.max(...a.map((x) => x.power)) : 0;
  }
  function fxOf(DB, n) { const e = DB.get(n); return (e && e.fx) || null; }

  /* ---------- rng ---------- */
  function mulberry32(seed) { return function () { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function shuffle(arr, rnd) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

  /* ---------- build player from a deck object ---------- */
  function expand(store, DB) { const out = []; for (const n in store) { const c = DB.get(n); for (let i = 0; i < store[n]; i++) out.push(c); } return out; }
  let HOLO_ID = 1;
  function makeHolo(card) {
    return {
      id: HOLO_ID++, card, dmg: 0, cheer: [], rested: false, playedTurn: -1, bloomedTurn: -1,
      attachments: [], buffArt: 0, costReduce: 0,
    };
  }

  function newPlayer(deckObj, DB, rnd, name) {
    const oshi = DB.get(deckObj.oshi);
    const p = {
      name: name || (deckObj.name || 'Player'),
      oshiCard: oshi,
      deck: shuffle(expand(deckObj.main, DB), rnd),
      cheerDeck: shuffle(expand(deckObj.cheer, DB), rnd),
      hand: [], center: null, back: [], collab: null, archive: [], holoPower: [],
      life: oshi.lf || 5, usedCollab: false, lost: false, lostReason: null,
      usedTurn: new Set(), usedGame: new Set(), limitedUsedTurn: false,
    };
    return p;
  }

  /* ================= Effect DSL interpreter ================= */
  function pickLowestHpTarget(list) {
    // prefer near-lethal (would KO), else lowest remaining HP
    let best = null, bestRem = Infinity;
    list.forEach((h) => { const rem = (h.card.hp || 0) - h.dmg; if (rem < bestRem) { bestRem = rem; best = h; } });
    return best;
  }
  function pickTopAttacker(list, DB) {
    let best = null, bestPow = -1;
    list.forEach((h) => { const p = topArtPower(h.card, DB) + (h.buffArt || 0); if (p > bestPow) { bestPow = p; best = h; } });
    return best;
  }
  function pickMostDamaged(list) {
    let best = null, bestDmg = -1;
    list.forEach((h) => { if (h.dmg > bestDmg) { bestDmg = h.dmg; best = h; } });
    return best;
  }
  function resolveTargets(kind, ctx) {
    const { game, me, op, self } = ctx;
    switch (kind) {
      case 'self': return self ? [self] : [];
      case 'center': return me.center ? [me.center] : [];
      case 'collab': return me.collab ? [me.collab] : [];
      case 'allSelf': return game.allHolos(me);
      case 'allOpponent': return game.allHolos(op);
      case 'opponentCenter': return op.center ? [op.center] : [];
      case 'chosenOpponent': { const t = pickLowestHpTarget(game.allHolos(op)); return t ? [t] : []; }
      case 'chosenSelf': { const t = pickTopAttacker(game.allHolos(me), game.DB); return t ? [t] : []; }
      case 'mostDamagedSelf': { const t = pickMostDamaged(game.allHolos(me)); return t ? [t] : []; }
      case 'backStage': return me.back.slice();
      case 'backOpponent': return op.back.slice();
      case 'collabOpponent': return op.collab ? [op.collab] : [];
      case 'chosenBackOpponent': { const t = pickLowestHpTarget(op.back); return t ? [t] : []; }
      case 'allField': return game.allHolos(me).concat(game.allHolos(op));
      default: return [];
    }
  }
  function checkCondition(cond, ctx) {
    if (!cond) return true;
    const { self, me, op } = ctx;
    if (cond.colorEquals && !(self && self.card.c && self.card.c.includes(cond.colorEquals))) return false;
    if (cond.tagIncludes && !(self && self.card.tg && self.card.tg.includes(cond.tagIncludes))) return false;
    if (cond.nameEquals && !(self && self.card.nm === cond.nameEquals)) return false;
    if (cond.hpAtMost != null && !(self && ((self.card.hp || 0) - self.dmg) <= cond.hpAtMost)) return false;
    if (cond.lifeAtMost != null && !(me.life <= cond.lifeAtMost)) return false;
    if (cond.handSizeAtLeast != null && !(me.hand.length >= cond.handSizeAtLeast)) return false;
    return true;
  }
  function matchesFilter(card, filter) {
    if (!filter) return true;
    if (filter.cardType && card.t !== filter.cardType) return false;
    if (filter.nameIncludes && !(card.nm || '').includes(filter.nameIncludes)) return false;
    if (filter.tag && !(card.tg || []).includes(filter.tag)) return false;
    if (filter.bloomLevel && card.bl !== filter.bloomLevel) return false;
    if (filter.color && !(card.c || []).includes(filter.color)) return false;
    return true;
  }

  function runActions(actions, ctx) {
    if (!actions) return;
    for (const a of actions) runAction(a, ctx);
  }
  function runAction(a, ctx) {
    const { game, me, op, rnd } = ctx;
    switch (a.op) {
      case 'draw': game.draw(me, a.n); break;
      case 'reveal': {
        const n = Math.min(a.n, me.deck.length);
        const seen = me.deck.splice(0, n);
        const match = seen.filter((c) => matchesFilter(c, a.filter));
        const take = match.slice(0, a.keep);
        take.forEach((c) => me.hand.push(c));
        const rest = seen.filter((c) => !take.includes(c));
        me.deck = rest.concat(me.deck); // return remaining to top, deck order preserved
        if (take.length) game.push('', `${me.name}: 効果でカードを${take.length}枚手札に加えた`);
        break;
      }
      case 'buffArt': {
        const targets = resolveTargets(a.target, ctx);
        targets.forEach((h) => { h.buffArt = (h.buffArt || 0) + a.amount; });
        break;
      }
      case 'specialDamage': {
        const targets = resolveTargets(a.target, ctx);
        targets.forEach((h) => {
          const holderP = game.allHolos(me).includes(h) ? me : op;
          h.dmg += a.amount;
          game.push('', `${holderP.name}: ${h.card.nm} に特殊ダメージ${a.amount}`);
          if (h === holderP.center && h.dmg >= (h.card.hp || 0)) game.downCenter(holderP, holderP === me ? op : me);
        });
        break;
      }
      case 'heal': {
        const targets = resolveTargets(a.target, ctx);
        targets.forEach((h) => { h.dmg = a.amount === 'full' ? 0 : Math.max(0, h.dmg - a.amount); });
        break;
      }
      case 'dice': {
        const roll = 1 + Math.floor(rnd() * 6);
        const key = String(roll);
        const branch = (a.then && (a.then[key] || (roll % 2 === 0 ? a.then.even : a.then.odd) ||
          Object.keys(a.then).find((k) => k.startsWith('>=') && roll >= Number(k.slice(2))) && a.then[Object.keys(a.then).find((k) => k.startsWith('>=') && roll >= Number(k.slice(2)))]));
        game.push('', `${me.name}: サイコロ${roll}`);
        if (branch) runActions(branch, ctx);
        break;
      }
      case 'attachCheer': {
        const targets = resolveTargets(a.target, ctx);
        if (targets.length && me.cheerDeck.length) {
          const t = targets[0];
          for (let i = 0; i < (a.n || 1) && me.cheerDeck.length; i++) {
            const ch = me.cheerDeck.shift();
            t.cheer.push((ch.c && ch.c[0]) || '無');
          }
          game.push('', `${me.name}: 効果で${t.card.nm} にエール${a.n || 1}枚`);
        }
        break;
      }
      case 'costReduce': {
        const targets = resolveTargets(a.target, ctx);
        targets.forEach((h) => { h.costReduce = (h.costReduce || 0) + (a.amount || 1); });
        break;
      }
      case 'archiveSelf': { if (ctx.self) archiveHolo(game, me, ctx.self); break; }
      case 'shuffleDeck': shuffle(me.deck, rnd); break;
      case 'lifeChange': me.life = Math.max(0, me.life + a.delta); break;
      case 'if': { if (checkCondition(a.cond, ctx)) runActions(a.then, ctx); else if (a.else) runActions(a.else, ctx); break; }
      case 'returnToHand': {
        const targets = resolveTargets(a.target, ctx);
        targets.forEach((h) => {
          const owner = game.allHolos(me).includes(h) ? me : op;
          if (owner.center === h) { owner.center = null; }
          else if (owner.collab === h) { owner.collab = null; }
          else { const bi = owner.back.indexOf(h); if (bi >= 0) owner.back.splice(bi, 1); }
          owner.hand.push(h.card);
          game.push('', `${owner.name}: ${h.card.nm} を手札に戻した`);
          if (!owner.center && owner.back.length) {
            const pr = owner.back.sort((x, y) => topArtPower(y.card, game.DB) - topArtPower(x.card, game.DB))[0];
            owner.back.splice(owner.back.indexOf(pr), 1); owner.center = pr;
          }
        });
        break;
      }
      case 'sendToArchive': {
        const targets = resolveTargets(a.target, ctx);
        targets.forEach((h) => {
          const owner = game.allHolos(me).includes(h) ? me : op;
          for (let i = 0; i < (a.n || 1) && h.cheer.length; i++) {
            owner.archive.push({ t: 'cheer', c: [h.cheer.pop()] });
          }
          game.push('', `${owner.name}: ${h.card.nm} からエール${a.n || 1}枚をアーカイブ`);
        });
        break;
      }
      case 'moveCheer': {
        const from = resolveTargets(a.from || a.target, ctx);
        const to = resolveTargets(a.to || 'self', ctx);
        if (from.length && to.length && from[0].cheer.length) {
          const col = from[0].cheer.pop();
          to[0].cheer.push(col);
          game.push('', `${me.name}: エールを${from[0].card.nm}→${to[0].card.nm}に付け替え`);
        }
        break;
      }
      case 'powerDown': {
        const targets = resolveTargets(a.target, ctx);
        targets.forEach((h) => { h.buffArt = (h.buffArt || 0) - (a.amount || 0); });
        break;
      }
      case 'search': {
        const n = Math.min(a.n || 1, me.deck.length);
        const match = me.deck.filter((c) => matchesFilter(c, a.filter));
        const take = match.slice(0, n);
        take.forEach((c) => { me.hand.push(c); me.deck.splice(me.deck.indexOf(c), 1); });
        if (take.length) { shuffle(me.deck, rnd); game.push('', `${me.name}: デッキから${take.length}枚サーチ`); }
        break;
      }
      default: break;
    }
  }
  function archiveHolo(game, p, holo) {
    if (p.center === holo) p.center = null;
    if (p.collab === holo) p.collab = null;
    const bi = p.back.indexOf(holo); if (bi >= 0) p.back.splice(bi, 1);
    p.archive.push(holo.card);
  }

  function abilityKey(cardN, part) { return cardN + ':' + part; }
  function canUse(p, key, once) {
    if (!once) return true;
    if (once === 'turn') return !p.usedTurn.has(key);
    if (once === 'game') return !p.usedGame.has(key);
    return true;
  }
  function markUsed(p, key, once) {
    if (once === 'turn') p.usedTurn.add(key);
    if (once === 'game') p.usedGame.add(key);
  }
  function tryRunAbility(game, me, op, ability, key, self, rnd) {
    if (!ability) return false;
    if (!canUse(me, key, ability.once)) return false;
    const ctx = { game, me, op, self, rnd };
    if (!checkCondition(ability.condition, ctx)) return false;
    markUsed(me, key, ability.once);
    runActions(ability.do, ctx);
    return true;
  }

  /* --- Interactive (generator) versions for search/reveal player choice --- */
  function* runActionsInteractive(actions, ctx) {
    if (!actions) return;
    for (const a of actions) yield* runActionInteractive(a, ctx);
  }
  function* runActionInteractive(a, ctx) {
    const { game, me, op, rnd } = ctx;
    switch (a.op) {
      case 'search': {
        const n = Math.min(a.n || 1, me.deck.length);
        const match = me.deck.filter((c) => matchesFilter(c, a.filter));
        if (!match.length) break;
        if (n === 1 && match.length === 1) {
          // Only one option — auto-select
          me.hand.push(match[0]); me.deck.splice(me.deck.indexOf(match[0]), 1);
          shuffle(me.deck, rnd);
          game.push('', `${me.name}: デッキから${match[0].nm}をサーチ`);
        } else {
          // Yield decision for player to pick
          const candidates = match.slice(0, 10).map((c, i) => ({ idx: i, card: c }));
          const picks = [];
          for (let i = 0; i < n && candidates.length; i++) {
            const remaining = candidates.filter((c) => !picks.includes(c.idx));
            if (!remaining.length) break;
            const choice = yield { type: 'deckSearch', player: me === game.A ? 'A' : 'B', candidates: remaining.map((c) => ({ idx: c.idx, nm: c.card.nm, t: c.card.t, bl: c.card.bl })), count: n - i, prompt: `山札から${n - i}枚選択してください` };
            if (choice != null && choice >= 0 && choice < candidates.length) {
              picks.push(choice);
            } else if (remaining.length) {
              picks.push(remaining[0].idx);
            }
          }
          picks.forEach((pi) => {
            const c = candidates[pi].card;
            me.hand.push(c); me.deck.splice(me.deck.indexOf(c), 1);
          });
          if (picks.length) { shuffle(me.deck, rnd); game.push('', `${me.name}: デッキから${picks.length}枚サーチ`); }
        }
        break;
      }
      case 'reveal': {
        const n = Math.min(a.n, me.deck.length);
        const seen = me.deck.splice(0, n);
        const match = seen.filter((c) => matchesFilter(c, a.filter));
        if (match.length <= (a.keep || 1)) {
          // Auto-select all matching
          const take = match.slice(0, a.keep || 1);
          take.forEach((c) => me.hand.push(c));
          const rest = seen.filter((c) => !take.includes(c));
          me.deck = rest.concat(me.deck);
          if (take.length) game.push('', `${me.name}: 効果でカードを${take.length}枚手札に加えた`);
        } else {
          // Let player choose which to keep
          const candidates = match.map((c, i) => ({ idx: i, nm: c.nm, t: c.t, bl: c.bl }));
          const picks = [];
          const keep = a.keep || 1;
          for (let i = 0; i < keep && candidates.length; i++) {
            const remaining = candidates.filter((c) => !picks.includes(c.idx));
            if (!remaining.length) break;
            const choice = yield { type: 'revealChoice', player: me === game.A ? 'A' : 'B', candidates: remaining, count: keep - i, prompt: `公開されたカードから${keep - i}枚選択` };
            if (choice != null && choice >= 0 && choice < candidates.length) {
              picks.push(choice);
            } else if (remaining.length) {
              picks.push(remaining[0].idx);
            }
          }
          const take = picks.map((pi) => match[pi]);
          take.forEach((c) => me.hand.push(c));
          const rest = seen.filter((c) => !take.includes(c));
          me.deck = rest.concat(me.deck);
          if (take.length) game.push('', `${me.name}: 効果でカードを${take.length}枚手札に加えた`);
        }
        break;
      }
      default:
        // For all other ops, delegate to the non-interactive version
        runAction(a, ctx);
        break;
    }
  }
  function* tryRunAbilityInteractive(game, me, op, ability, key, self, rnd) {
    if (!ability) return false;
    if (!canUse(me, key, ability.once)) return false;
    const ctx = { game, me, op, self, rnd };
    if (!checkCondition(ability.condition, ctx)) return false;
    markUsed(me, key, ability.once);
    yield* runActionsInteractive(ability.do, ctx);
    return true;
  }

  /* ---------- game ---------- */
  function Game(deckA, deckB, DB, opts) {
    opts = opts || {};
    this.DB = DB;
    // 各プレイヤー専用の乱数ストリームを持たせる（共有ストリームだと消費順序に
    // 由来する統計的な偏り＝先攻/後攻のスロット差が生じるため、独立させる）
    const baseSeed = (opts.seed == null ? (Math.random() * 1e9) | 0 : opts.seed);
    this.rndA = mulberry32(baseSeed ^ 0x9E3779B1);
    this.rndB = mulberry32(baseSeed ^ 0x517CC1B7);
    this.rndSys = mulberry32(baseSeed ^ 0x2545F491);
    this.log = [];
    this.doLog = !!opts.log;
    this.effectsOn = opts.effects !== false; // Phase 2 effects default ON
    this.A = newPlayer(deckA, DB, this.rndA, opts.nameA || deckA.name || 'A');
    this.B = newPlayer(deckB, DB, this.rndB, opts.nameB || deckB.name || 'B');
    this.first = this.rndSys() < 0.5 ? 'A' : 'B';
    this.turn = 0;
  }
  Game.prototype.rndFor = function (p) { return p === this.A ? this.rndA : this.rndB; };
  Game.prototype.push = function (cls, t) { if (this.doLog) this.log.push({ cls, t }); };

  Game.prototype.holosOnStage = function (p) { const a = []; if (p.center) a.push(p.center); if (p.collab) a.push(p.collab); return a.concat(p.back); };
  Game.prototype.allHolos = function (p) { return this.holosOnStage(p); };

  Game.prototype.draw = function (p, n) {
    for (let i = 0; i < n; i++) { if (!p.deck.length) { p.lost = true; p.lostReason = 'デッキ切れ'; return; } p.hand.push(p.deck.shift()); }
  };
  Game.prototype.downCenter = function (op, me) {
    const downed = op.center;
    // onDowned trigger before archiving (card + attachments)
    if (this.effectsOn) {
      const fx = fxOf(this.DB, downed.card.n);
      if (fx && fx.keywords) {
        fx.keywords.filter((k) => k.trigger === 'onDowned').forEach((k, i) => {
          tryRunAbility(this, op, me, k, abilityKey(downed.card.n, 'kwDown' + i), downed, this.rndFor(op));
        });
      }
      if (downed.attachments) {
        downed.attachments.forEach((att) => {
          const afx = fxOf(this.DB, att.n);
          if (afx && afx.keywords) {
            afx.keywords.filter((k) => k.trigger === 'onDowned').forEach((k, i) => {
              tryRunAbility(this, op, me, k, abilityKey(att.n, 'attDown' + i), downed, this.rndFor(op));
            });
          }
        });
      }
    }
    op.archive.push(downed.card);
    downed.cheer.forEach((c) => op.archive.push({ t: 'cheer', c: [c] }));
    op.center = null;
    if (op.lifeCards && op.lifeCards.length > 0) {
      const lifeCheer = op.lifeCards.pop();
      op.life = op.lifeCards.length;
      const col = (lifeCheer.c && lifeCheer.c[0]) || '無';
      this.push('ko', `　⤷ ${op.name} のホロメンがダウン！ ライフ -1（残り${op.life}）`);
      // Attach life cheer to a holomen on the field
      const candidates = this.allHolos(op);
      if (candidates.length) {
        let target = candidates[0];
        for (const h of candidates) {
          const arts = this.DB.get(h.card.n).arts;
          if (arts.length && !canPay(effCost(arts[arts.length - 1], h), h.cheer)) { target = h; break; }
        }
        target.cheer.push(col);
        this.push('', `　${op.name}: ライフから${target.card.nm} に ${col}エール`);
      }
    } else {
      op.life = 0;
      op.lost = true; op.lostReason = 'ライフ0でダウン';
      this.push('ko', `　⤷ ${op.name} のホロメンがダウン！ ライフ0 → 敗北`);
      return;
    }
    if (op.back.length) {
      const promote = op.back.sort((a, b) => topArtPower(b.card, this.DB) - topArtPower(a.card, this.DB))[0];
      op.back.splice(op.back.indexOf(promote), 1); op.center = promote;
      this.push('', `　${op.name}: ${promote.card.nm} がセンターへ`);
    } else if (op.collab) {
      op.center = op.collab; op.collab = null;
    } else {
      op.lost = true; op.lostReason = 'ホロメン全滅';
    }
  };

  Game.prototype.setup = function () {
    for (const p of [this.A, this.B]) {
      const rnd = this.rndFor(p);
      let tries = 0;
      do {
        p.hand.forEach((c) => p.deck.push(c)); p.hand = [];
        if (tries > 0) shuffle(p.deck, rnd);
        this.draw(p, 7); tries++;
      } while (tries < 4 && !p.hand.some((c) => c.t === 'holomen' && c.bl === 'Debut'));

      const debuts = p.hand.filter((c) => c.t === 'holomen' && c.bl === 'Debut')
        .sort((a, b) => topArtPower(b, this.DB) - topArtPower(a, this.DB) || (b.hp || 0) - (a.hp || 0));
      if (!debuts.length) { p.lost = true; p.lostReason = 'Debut不在'; continue; }
      const center = debuts[0];
      p.center = makeHolo(center); p.center.playedTurn = 0;
      p.hand.splice(p.hand.indexOf(center), 1);
      for (let i = 1; i < debuts.length && p.back.length < 3; i++) {
        const c = debuts[i]; p.back.push(Object.assign(makeHolo(c), { playedTurn: 0 })); p.hand.splice(p.hand.indexOf(c), 1);
      }
      p.lifeCards = p.cheerDeck.splice(0, p.life);
    }
    this.push('', `先攻: ${this[this.first].name}`);
  };

  Game.prototype.attachCheer = function (p, turnNo) {
    if (!p.cheerDeck.length) return;
    const cheer = p.cheerDeck.shift();
    const col = (cheer.c && cheer.c[0]) || '無';
    const candidates = [p.center, p.collab, ...p.back].filter(Boolean);
    if (!candidates.length) return;
    let target = null, bestScore = -1;
    for (const h of candidates) {
      const arts = this.DB.get(h.card.n).arts;
      if (!arts.length) continue;
      const top = arts.reduce((best, a) => (a.power > (best ? best.power : -1) ? a : best), null);
      if (!top) continue;
      let score = 0;
      if (!canPay(effCost(top, h), h.cheer)) {
        score += 100; // needs cheer to attack
        const needs = effCost(top, h).colors;
        if (needs[col]) score += 50; // color match bonus
      }
      if (h === p.center) score += 10; // prefer center
      if (score > bestScore) { bestScore = score; target = h; }
    }
    if (!target) target = p.center || candidates[0];
    target.cheer.push(col);
    this.push('', `${p.name}: ${target.card.nm} に ${col}エール`);
  };

  // ---- Phase 2: oshi skill / SP oshi skill (manual, AI-triggered) ----
  Game.prototype.tryOshiSkills = function (p, op) {
    if (!this.effectsOn) return;
    const fx = fxOf(this.DB, p.oshiCard.n);
    if (!fx) return;
    const rnd = this.rndFor(p);
    const payHolopower = (n) => {
      if (!n) return true;
      if (p.deck.length <= n + 5) return false;
      for (let i = 0; i < n; i++) p.holoPower.push(p.deck.shift());
      return true;
    };
    // AI: evaluate whether to use oshi skill based on cost/benefit
    const shouldUseOshi = (skill) => {
      const cost = (skill.cost && skill.cost.holopower) || 0;
      if (cost >= 5 && p.deck.length < 20) return false;
      if (cost >= 3 && p.deck.length < 12) return false;
      const ops = skill.do || [];
      const hasBuff = ops.some((a) => a.op === 'buffArt');
      if (hasBuff && !p.center) return false;
      return true;
    };
    // AI: SP is game-once — save for impactful moments
    const shouldUseSP = (skill) => {
      const cost = (skill.cost && skill.cost.holopower) || 0;
      if (p.deck.length <= cost + 8) return false;
      const ops = skill.do || [];
      const hasDamage = ops.some((a) => a.op === 'specialDamage');
      if (hasDamage && op.center) {
        const opHp = (op.center.card.hp || 0) - op.center.dmg;
        const dmg = ops.filter((a) => a.op === 'specialDamage').reduce((s, a) => s + (a.amount || 0), 0);
        if (opHp > dmg * 2) return false; // save if enemy is too healthy
      }
      const hasBuff = ops.some((a) => a.op === 'buffArt');
      if (hasBuff && !p.center) return false;
      if (hasBuff && p.center) {
        const art = bestArt(p.center, this.DB);
        if (!art) return false; // no art to buff
      }
      if (this.turn < 4 && cost >= 3) return false; // save expensive SP for later
      return true;
    };
    if (fx.oshi && canUse(p, abilityKey(p.oshiCard.n, 'oshi'), 'turn') && shouldUseOshi(fx.oshi)) {
      const cost = (fx.oshi.cost && fx.oshi.cost.holopower) || 0;
      if (payHolopower(cost)) {
        const used = tryRunAbility(this, p, op, fx.oshi, abilityKey(p.oshiCard.n, 'oshi'), p.center, rnd);
        if (used) this.push('', `${p.name}: 推しスキル「${fx.oshi.name || ''}」`);
      }
    }
    if (fx.sp && canUse(p, abilityKey(p.oshiCard.n, 'sp'), 'game') && shouldUseSP(fx.sp)) {
      const cost = (fx.sp.cost && fx.sp.cost.holopower) || 0;
      if (payHolopower(cost)) {
        const used = tryRunAbility(this, p, op, fx.sp, abilityKey(p.oshiCard.n, 'sp'), p.center, rnd);
        if (used) this.push('', `${p.name}: SP推しスキル「${fx.sp.name || ''}」`);
      }
    }
  };

  // ---- Phase 2: play support cards from hand ----
  Game.prototype.playSupportCards = function (p, op, turnNo, opts) {
    if (!this.effectsOn) return;
    const rnd = this.rndFor(p);
    const noLimited = opts && opts.noLimited;
    // Sort supports: draw/reveal first, then buffs, then others
    const supPriority = (c) => {
      const fx = fxOf(this.DB, c.n);
      if (!fx || !fx.ability || !fx.ability.do) return 50;
      const ops = fx.ability.do.map((a) => a.op);
      if (ops.includes('draw') || ops.includes('reveal') || ops.includes('search')) return 10;
      if (ops.includes('buffArt') || ops.includes('attachCheer')) return 20;
      return 40;
    };
    const sups = p.hand.filter((c) => c.t === 'support').sort((a, b) => supPriority(a) - supPriority(b));
    const nonSups = p.hand.filter((c) => c.t !== 'support');
    p.hand = nonSups.concat(sups);
    let guard = 0;
    while (guard++ < 8) {
      const idx = p.hand.findIndex((c) => c.t === 'support');
      if (idx < 0) break;
      const card = p.hand[idx];
      const fx = fxOf(this.DB, card.n);
      const isLimited = !!(card.ltd);
      if (isLimited && (p.limitedUsedTurn || noLimited)) { break; } // no LIMITED on first player's first turn
      if (!fx || !fx.ability) { break; } // no known effect: don't blindly play (avoid wasting an unknown card)
      const key = abilityKey(card.n, 'sup');
      if (!canUse(p, key, fx.ability.once || 'turn')) { p.hand.splice(idx, 1); p.hand.push(card); if (p.hand.length === 1) break; continue; }
      const ctx = { game: this, me: p, op, self: p.center, rnd };
      if (!checkCondition(fx.ability.condition, ctx)) { break; }
      // Tool/Mascot/Fan: attach instead of archiving
      if (card.st === 'ツール' || card.st === 'マスコット' || card.st === 'ファン') {
        const targets = this.allHolos(p).filter((h) => !fx.attachFilter || matchesFilter(h.card, fx.attachFilter));
        const already = targets.find((h) => h.attachments.some((a) => a.n === card.n) && card.st === 'ファン');
        const host = pickTopAttacker(targets.filter((h) => !(card.st !== 'ファン' && h.attachments.some((a2) => a2.st === card.st))), this.DB);
        if (!host) { break; }
        host.attachments.push(card);
        p.hand.splice(idx, 1);
        markUsed(p, key, 'game');
        this.push('', `${p.name}: ${host.card.nm} に〈${card.nm}〉を付けた`);
      } else {
        p.hand.splice(idx, 1);
        markUsed(p, key, fx.ability.once || 'turn');
        if (isLimited) p.limitedUsedTurn = true;
        runActions(fx.ability.do, ctx);
        p.archive.push(card);
        this.push('', `${p.name}: 〈${card.nm}〉を使用`);
      }
    }
  };

  Game.prototype.applyAttachmentStatics = function (holo) {
    let hp = holo.card.hp || 0, artBonus = 0, costReduce = 0;
    holo.attachments.forEach((att) => {
      const fx = fxOf(this.DB, att.n);
      if (!fx || !fx.static) return;
      fx.static.forEach((s) => {
        if (s.mod === 'hp') hp += s.amount;
        if (s.mod === 'artPower') artBonus += s.amount;
        if (s.mod === 'artCost') costReduce += s.amount;
      });
    });
    return { hp, artBonus, costReduce };
  };

  Game.prototype.mainPhase = function (p, turnNo, op, opts) {
    const noBloom = opts && opts.noBloom;
    const noLimited = opts && opts.noLimited;
    const tryBloom = (holo) => {
      if (noBloom) return; // Both players cannot bloom on their first turn
      if (!holo || holo.playedTurn === turnNo) return;
      const next = holo.card.bl === 'Debut' ? '1st' : holo.card.bl === '1st' ? '2nd' : null;
      if (!next) return;
      const idx = p.hand.findIndex((c) => c.t === 'holomen' && c.nm === holo.card.nm && c.bl === next);
      if (idx < 0) return;
      const prevCard = holo.card;
      const bl = p.hand.splice(idx, 1)[0];
      holo.card = bl; holo.bloomedTurn = turnNo;
      this.push('', `${p.name}: ${bl.nm} に ブルーム(${next})`);
      if (this.effectsOn) {
        // Gift trigger: check if the previous (material) card had Gift
        const prevFx = fxOf(this.DB, prevCard.n);
        if (prevFx && prevFx.keywords) {
          prevFx.keywords.filter((k) => k.trigger === 'onGift').forEach((k, i) => {
            tryRunAbility(this, p, op, k, abilityKey(prevCard.n, 'gift' + i), holo, this.rndFor(p));
            this.push('', `${p.name}: ${prevCard.nm} のギフト効果`);
          });
        }
        // onBloom trigger on the new card
        const fx = fxOf(this.DB, bl.n);
        if (fx && fx.keywords) {
          fx.keywords.filter((k) => k.trigger === 'onBloom').forEach((k, i) => {
            tryRunAbility(this, p, op, k, abilityKey(bl.n, 'kwB' + i), holo, this.rndFor(p));
          });
        }
        // onBloom triggers from attachments
        if (holo.attachments) {
          holo.attachments.forEach((att) => {
            const afx = fxOf(this.DB, att.n);
            if (afx && afx.keywords) {
              afx.keywords.filter((k) => k.trigger === 'onBloom').forEach((k, i) => {
                tryRunAbility(this, p, op, k, abilityKey(att.n, 'attB' + i), holo, this.rndFor(p));
              });
            }
          });
        }
      }
    };
    tryBloom(p.center); tryBloom(p.collab); p.back.forEach(tryBloom);

    while (p.back.length + (p.collab ? 1 : 0) < 5) {
      const idx = p.hand.findIndex((c) => c.t === 'holomen' && c.bl === 'Debut');
      if (idx < 0) break;
      const c = p.hand.splice(idx, 1)[0];
      p.back.push(Object.assign(makeHolo(c), { playedTurn: turnNo }));
      this.push('', `${p.name}: ${c.nm} をバックに出す`);
      if (p.back.length >= 3) break;
    }

    if (this.effectsOn) this.playSupportCards(p, op, turnNo, { noLimited: noLimited });

    if (!p.collab && !p.usedCollab && p.back.length) {
      const collabScore = (h) => {
        let s = topArtPower(h.card, this.DB);
        if (this.effectsOn) {
          const fx = fxOf(this.DB, h.card.n);
          if (fx && fx.keywords && fx.keywords.some((k) => k.trigger === 'onCollab')) s += 30;
        }
        return s;
      };
      const cand = p.back.filter((h) => !h.rested && h.playedTurn !== turnNo)
        .sort((a, b) => collabScore(b) - collabScore(a))[0];
      if (cand && (topArtPower(cand.card, this.DB) > 0 || collabScore(cand) > 0)) {
        p.back.splice(p.back.indexOf(cand), 1); p.collab = cand; p.usedCollab = true;
        this.push('', `${p.name}: ${cand.card.nm} をコラボ`);
        if (this.effectsOn) {
          const fx = fxOf(this.DB, cand.card.n);
          if (fx && fx.keywords) {
            fx.keywords.filter((k) => k.trigger === 'onCollab').forEach((k, i) => {
              tryRunAbility(this, p, op, k, abilityKey(cand.card.n, 'kwC' + i), cand, this.rndFor(p));
            });
          }
        }
      }
    }

    if (this.effectsOn) this.tryOshiSkills(p, op);

    const centerArt = p.center ? bestArt(p.center, this.DB) : null;
    const shouldBaton = (center) => {
      if (!center) return false;
      const need = this.DB.get(center.card.n).baton;
      if (center.cheer.length < need || !p.back.length) return false;
      if (!centerArt) return true; // can't attack → baton
      // baton if center is near death and a healthier replacement exists
      const hp = (center.card.hp || 0);
      const remaining = hp - center.dmg;
      if (remaining <= hp * 0.3 && remaining > 0) {
        const better = p.back.find((h) => !h.rested && h.dmg < (h.card.hp || 0) * 0.5 && topArtPower(h.card, this.DB) >= topArtPower(center.card, this.DB) * 0.7);
        if (better) return true;
      }
      return false;
    };
    if (p.center && shouldBaton(p.center)) {
      const need = this.DB.get(p.center.card.n).baton;
      const better = p.back.filter((h) => !h.rested).sort((a, b) => topArtPower(b.card, this.DB) - topArtPower(a.card, this.DB))[0];
      if (better && (topArtPower(better.card, this.DB) > 0 || !centerArt)) {
        for (let i = 0; i < need; i++) p.archive.push({ t: 'cheer', c: [p.center.cheer.pop()] });
        p.back.splice(p.back.indexOf(better), 1);
        const old = p.center; p.center = better; p.back.push(old);
        this.push('', `${p.name}: バトンタッチ → ${better.card.nm} がセンター`);
      }
    }
  };

  Game.prototype.performArt = function (attacker, me, op, turnNo) {
    const art = bestArt(attacker, this.DB);
    if (!art) return;
    if (!op.center) return;
    const attStatic = this.effectsOn ? this.applyAttachmentStatics(attacker) : { artBonus: 0 };
    const dmg = art.power + attStatic.artBonus;
    op.center.dmg += dmg;
    const cls = me === this.A ? 'ta' : 'tb';
    this.push(cls, `T${turnNo} ${me.name}: ${attacker.card.nm} → ${op.center.card.nm} に ${dmg}`);

    if (this.effectsOn) {
      const fx = fxOf(this.DB, attacker.card.n);
      if (fx && fx.arts && fx.arts[art.idx]) {
        tryRunAbility(this, me, op, fx.arts[art.idx], abilityKey(attacker.card.n, 'art' + art.idx), attacker, this.rndFor(me));
      }
      if (op.center) {
        const defFx = fxOf(this.DB, op.center.card.n);
        if (defFx && defFx.keywords) {
          defFx.keywords.filter((k) => k.trigger === 'onDamageTaken').forEach((k, i) => {
            if (op.center) tryRunAbility(this, op, me, k, abilityKey(op.center.card.n, 'kwD' + i), op.center, this.rndFor(op));
          });
        }
      }
    }

    if (op.center && op.center.dmg >= ((op.center.card.hp || 0) + (this.effectsOn ? this.applyAttachmentStatics(op.center).hp - (op.center.card.hp || 0) : 0))) {
      this.downCenter(op, me);
    }
  };

  Game.prototype.takeTurn = function (who) {
    const me = this[who], op = who === 'A' ? this.B : this.A;
    if (me.lost || op.lost) return;
    this.turn++;
    const turnNo = this.turn;
    const isFirstPlayer = (who === this.first);
    const isMyFirstTurn = !me._hadTurn; // first turn for this player
    me._hadTurn = true;
    const isFirstPlayerFirstTurn = isMyFirstTurn && isFirstPlayer;
    const isAnyFirstTurn = isMyFirstTurn;
    // Reset step: skipped on both players' first turn (official rules)
    if (!isAnyFirstTurn) {
      if (me.collab) { me.back.push(me.collab); me.collab = null; }
      this.allHolos(me).forEach((h) => { h.rested = false; h.buffArt = 0; h.costReduce = 0; });
    }
    me.usedCollab = false; me.usedTurn.clear(); me.limitedUsedTurn = false;
    this.draw(me, 1);
    if (me.lost) return;
    this.attachCheer(me, turnNo);
    this.mainPhase(me, turnNo, op, { noBloom: isAnyFirstTurn, noLimited: isFirstPlayerFirstTurn });
    // Performance step: skipped on first player's first turn only
    if (!isFirstPlayerFirstTurn) {
      if (me.center) this.performArt(me.center, me, op, turnNo);
      if (op.lost) return;
      if (me.collab) this.performArt(me.collab, me, op, turnNo);
    }
    if (me.collab) me.collab.rested = true;
  };

  Game.prototype.play = function (maxTurns) {
    this.setup();
    if (this.A.lost && this.B.lost) return this.finish(this.rndSys() < 0.5 ? 'A' : 'B');
    if (this.A.lost) return this.finish('B');
    if (this.B.lost) return this.finish('A');
    const order = this.first === 'A' ? ['A', 'B'] : ['B', 'A'];
    let idx = 0;
    while (this.turn < (maxTurns || 60)) {
      const who = order[idx % 2];
      this.takeTurn(who);
      const other = who === 'A' ? 'B' : 'A';
      if (this[other].lost) return this.finish(who);
      if (this[who].lost) return this.finish(other);
      idx++;
    }
    let w;
    if (this.A.life > this.B.life) w = 'A';
    else if (this.B.life > this.A.life) w = 'B';
    else w = this.rndSys() < 0.5 ? 'A' : 'B';
    this.push('', '規定ターン到達：ライフ優勢で判定');
    return this.finish(w, true);
  };
  Game.prototype.finish = function (winner, timeout) {
    const wName = this[winner].name;
    this.push(winner === 'A' ? 'ta' : 'tb', `★ ${wName} の勝ち（${this.turn}ターン${timeout ? '・時間切れ' : ''}）`);
    return { winner, turns: this.turn, log: this.log, reason: this[winner === 'A' ? 'B' : 'A'].lostReason };
  };

  /* ================= Interactive (generator-based) game loop ================= */

  /* --- AI decision helpers (extracted from inline heuristics) --- */
  function aiPickCheerTarget(candidates, cheerColor, game) {
    let target = null, bestScore = -1;
    for (const h of candidates) {
      const arts = game.DB.get(h.card.n).arts;
      if (!arts.length) continue;
      const top = arts.reduce((best, a) => (a.power > (best ? best.power : -1) ? a : best), null);
      if (!top) continue;
      let score = 0;
      if (!canPay(effCost(top, h), h.cheer)) {
        score += 100;
        const needs = effCost(top, h).colors;
        if (needs[cheerColor]) score += 50;
      }
      if (game.allHolos(game.A).includes(h) ? h === game.A.center : h === game.B.center) score += 10;
      if (score > bestScore) { bestScore = score; target = h; }
    }
    return target || candidates[0];
  }

  function aiPickLifeCheerTarget(candidates, game) {
    for (const h of candidates) {
      const arts = game.DB.get(h.card.n).arts;
      if (arts.length && !canPay(effCost(arts[arts.length - 1], h), h.cheer)) return h;
    }
    return candidates[0];
  }

  function aiPickSetupCenter(debuts, game) {
    return debuts.sort((a, b) => topArtPower(b, game.DB) - topArtPower(a, game.DB) || (b.hp || 0) - (a.hp || 0))[0];
  }

  function aiPickSetupBack(debuts, game) {
    return debuts.sort((a, b) => topArtPower(b, game.DB) - topArtPower(a, game.DB) || (b.hp || 0) - (a.hp || 0)).slice(0, 3);
  }

  function aiPickPromoteCenter(backHolos, game) {
    return backHolos.sort((a, b) => topArtPower(b.card, game.DB) - topArtPower(a.card, game.DB))[0];
  }

  function aiGetMainActions(p, op, turnNo, game, opts) {
    const actions = [];
    const allH = game.allHolos(p);
    const noBloom = opts && opts.noBloom;
    const noLimited = opts && opts.noLimited;
    // Bloom options (blocked on both players' first turn)
    if (!noBloom) {
      for (const holo of allH) {
        if (!holo || holo.playedTurn === turnNo) continue;
        const next = holo.card.bl === 'Debut' ? '1st' : holo.card.bl === '1st' ? '2nd' : null;
        if (!next) continue;
        const idx = p.hand.findIndex((c) => c.t === 'holomen' && c.nm === holo.card.nm && c.bl === next);
        if (idx >= 0) actions.push({ act: 'bloom', holoId: holo.id, handIdx: idx, label: `ブルーム: ${holo.card.nm} → ${next}` });
      }
    }
    // Place Debut
    if (p.back.length + (p.collab ? 1 : 0) < 5) {
      p.hand.forEach((c, i) => {
        if (c.t === 'holomen' && c.bl === 'Debut') {
          actions.push({ act: 'placeDebut', handIdx: i, label: `ステージに出す: ${c.nm}` });
        }
      });
    }
    // Support cards (LIMITED blocked on first player's first turn)
    if (game.effectsOn) {
      p.hand.forEach((c, i) => {
        if (c.t !== 'support') return;
        const fx = fxOf(game.DB, c.n);
        const isLimited = !!(c.ltd);
        if (isLimited && (p.limitedUsedTurn || noLimited)) return;
        if (!fx || !fx.ability) return;
        const key = abilityKey(c.n, 'sup');
        if (!canUse(p, key, fx.ability.once || 'turn')) return;
        actions.push({ act: 'playSupport', handIdx: i, label: `サポート使用: ${c.nm}` });
      });
    }
    // Collab
    if (!p.collab && !p.usedCollab) {
      p.back.filter((h) => !h.rested && h.playedTurn !== turnNo).forEach((h) => {
        actions.push({ act: 'collab', holoId: h.id, label: `コラボ: ${h.card.nm}` });
      });
    }
    // Oshi skill
    if (game.effectsOn) {
      const fx = fxOf(game.DB, p.oshiCard.n);
      if (fx && fx.oshi && canUse(p, abilityKey(p.oshiCard.n, 'oshi'), 'turn') && p.deck.length > ((fx.oshi.cost && fx.oshi.cost.holopower) || 0) + 5) {
        actions.push({ act: 'oshiSkill', label: `推しスキル: ${fx.oshi.name || ''}`, cost: (fx.oshi.cost && fx.oshi.cost.holopower) || 0 });
      }
      if (fx && fx.sp && canUse(p, abilityKey(p.oshiCard.n, 'sp'), 'game') && p.deck.length > ((fx.sp.cost && fx.sp.cost.holopower) || 0) + 5) {
        actions.push({ act: 'spSkill', label: `SP推しスキル: ${fx.sp.name || ''}`, cost: (fx.sp.cost && fx.sp.cost.holopower) || 0 });
      }
    }
    // Baton touch
    if (p.center && p.back.length) {
      const need = game.DB.get(p.center.card.n).baton;
      if (p.center.cheer.length >= need) {
        p.back.filter((h) => !h.rested).forEach((h) => {
          actions.push({ act: 'baton', holoId: h.id, label: `バトンタッチ: → ${h.card.nm}`, cost: need });
        });
      }
    }
    return actions;
  }

  function aiPickMainAction(actions, p, op, game) {
    // Priority: bloom > place debut (up to 3) > support > collab > oshi > baton > end
    const priority = { bloom: 1, placeDebut: 2, playSupport: 3, collab: 4, oshiSkill: 5, spSkill: 6, baton: 7 };
    const sorted = actions.filter((a) => a.act !== 'endMain').sort((a, b) => (priority[a.act] || 99) - (priority[b.act] || 99));
    if (!sorted.length) return { act: 'endMain' };

    const pick = sorted[0];
    // Limit debut placement to 3 back
    if (pick.act === 'placeDebut' && p.back.length >= 3) {
      const nonDebut = sorted.filter((a) => a.act !== 'placeDebut');
      return nonDebut.length ? nonDebut[0] : { act: 'endMain' };
    }
    // Baton touch: only if center can't attack or is near death
    if (pick.act === 'baton') {
      const art = bestArt(p.center, game.DB);
      const hp = (p.center.card.hp || 0);
      const remaining = hp - p.center.dmg;
      if (art && remaining > hp * 0.3) return { act: 'endMain' };
    }
    // SP skill: save for later turns
    if (pick.act === 'spSkill') {
      const fx = fxOf(game.DB, p.oshiCard.n);
      if (fx && fx.sp) {
        const cost = (fx.sp.cost && fx.sp.cost.holopower) || 0;
        if (p.deck.length <= cost + 8) return { act: 'endMain' };
        if (game.turn < 4 && cost >= 3) {
          const nonSP = sorted.filter((a) => a.act !== 'spSkill');
          return nonSP.length ? nonSP[0] : { act: 'endMain' };
        }
      }
    }
    // Oshi skill: check AI heuristic
    if (pick.act === 'oshiSkill') {
      const fx = fxOf(game.DB, p.oshiCard.n);
      if (fx && fx.oshi) {
        const cost = (fx.oshi.cost && fx.oshi.cost.holopower) || 0;
        if (cost >= 3 && p.deck.length < 12) return { act: 'endMain' };
        const ops = fx.oshi.do || [];
        if (ops.some((a) => a.op === 'buffArt') && !p.center) {
          const nonOshi = sorted.filter((a) => a.act !== 'oshiSkill');
          return nonOshi.length ? nonOshi[0] : { act: 'endMain' };
        }
      }
    }
    return pick;
  }

  function aiPickArt(holo, game) {
    const art = bestArt(holo, game.DB);
    return art ? art.idx : -1;
  }

  /* --- aiResolve: given a decision object, return AI's choice --- */
  function aiResolve(decision, game) {
    const p = game[decision.player];
    const op = decision.player === 'A' ? game.B : game.A;
    switch (decision.type) {
      case 'mulligan': {
        const hand = decision.hand.map((n) => game.DB.get(n)).filter(Boolean);
        const hasDebut = hand.some((c) => c.t === 'holomen' && c.bl === 'Debut');
        const debutCount = hand.filter((c) => c.t === 'holomen' && c.bl === 'Debut').length;
        if (!hasDebut) return 'yes';
        if (debutCount <= 1 && hand.length >= 7) return 'yes';
        return 'no';
      }
      case 'setupCenter': return aiPickSetupCenter(decision.candidates, game).n;
      case 'setupBack': return aiPickSetupBack(decision.candidates, game).map((c) => c.n);
      case 'cheerTarget': return aiPickCheerTarget(decision.candidates, decision.cheerColor, game).id;
      case 'lifeCheerTarget': return aiPickLifeCheerTarget(decision.candidates, game).id;
      case 'promoteCenter': return aiPickPromoteCenter(decision.candidates, game).id;
      case 'mainAction': return aiPickMainAction(decision.actions, p, op, game);
      case 'artChoice': {
        const ai = aiPickArt(decision.holo, game);
        return ai >= 0 ? ai : (decision.arts.length ? decision.arts[decision.arts.length - 1].idx : 'skip');
      }
      case 'supportTarget': {
        const t = pickTopAttacker(decision.candidates, game.DB);
        return t ? t.id : decision.candidates[0].id;
      }
      case 'deckSearch': {
        // AI picks the first candidate
        return decision.candidates.length ? decision.candidates[0].idx : 0;
      }
      case 'revealChoice': {
        // AI picks the first candidate
        return decision.candidates.length ? decision.candidates[0].idx : 0;
      }
      default: return null;
    }
  }

  /* --- snapshot: serialize visible game state for UI rendering --- */
  function snapshot(game) {
    const snapHolo = (h) => h ? {
      id: h.id, n: h.card.n, nm: h.card.nm, hp: h.card.hp || 0, dmg: h.dmg,
      bl: h.card.bl, cheer: h.cheer.slice(), rested: h.rested,
      colors: h.card.c || [], tags: h.card.tg || [],
      buffArt: h.buffArt || 0, img: h.card.img,
      attachments: (h.attachments || []).map((a) => ({ n: a.n, nm: a.nm })),
    } : null;
    const snapP = (p, hideHand) => ({
      name: p.name, life: p.life, deckCount: p.deck.length,
      cheerDeckCount: p.cheerDeck.length, archiveCount: p.archive.length,
      holoPowerCount: p.holoPower.length,
      oshi: { n: p.oshiCard.n, nm: p.oshiCard.nm, lf: p.oshiCard.lf, img: p.oshiCard.img, c: p.oshiCard.c },
      center: snapHolo(p.center), collab: snapHolo(p.collab),
      back: p.back.map(snapHolo),
      hand: hideHand ? p.hand.length : p.hand.map((c) => ({ n: c.n, nm: c.nm, t: c.t, bl: c.bl, hp: c.hp, c: c.c, img: c.img, st: c.st, ltd: c.ltd })),
      lost: p.lost, lostReason: p.lostReason,
    });
    return {
      turn: game.turn, phase: game._phase || '',
      A: snapP(game.A, false), B: snapP(game.B, false),
      log: game.log.slice(-50),
    };
  }

  /* --- Interactive game loop (generator) --- */
  Game.prototype.setupInteractive = function* () {
    for (const p of [this.A, this.B]) {
      const rnd = this.rndFor(p);
      let tries = 0;
      do {
        p.hand.forEach((c) => p.deck.push(c)); p.hand = [];
        if (tries > 0) shuffle(p.deck, rnd);
        this.draw(p, 7); tries++;
      } while (tries < 4 && !p.hand.some((c) => c.t === 'holomen' && c.bl === 'Debut'));

      const debuts = p.hand.filter((c) => c.t === 'holomen' && c.bl === 'Debut');
      if (!debuts.length) { p.lost = true; p.lostReason = 'Debut不在'; continue; }

      const who = p === this.A ? 'A' : 'B';
      // Mulligan: ask player if they want to redraw (once)
      const mulliganChoice = yield { type: 'mulligan', player: who, hand: p.hand.map((c) => c.n), prompt: '手札を引き直しますか？（1回のみ）' };
      if (mulliganChoice === 'yes') {
        p.hand.forEach((c) => p.deck.push(c)); p.hand = [];
        shuffle(p.deck, rnd);
        this.draw(p, 7);
        this.push(p.name, '手札を引き直しました');
      }

      const debuts2 = p.hand.filter((c) => c.t === 'holomen' && c.bl === 'Debut');
      if (!debuts2.length) { p.lost = true; p.lostReason = 'Debut不在(引き直し後)'; continue; }

      // Choose center
      const centerChoice = yield { type: 'setupCenter', player: who, candidates: debuts2, prompt: 'センターに出すDebutホロメンを選択' };
      const center = debuts2.find((c) => c.n === centerChoice) || debuts2[0];
      p.center = makeHolo(center); p.center.playedTurn = 0;
      p.hand.splice(p.hand.indexOf(center), 1);

      // Choose back stage (up to 3)
      const remainDebuts = p.hand.filter((c) => c.t === 'holomen' && c.bl === 'Debut');
      if (remainDebuts.length) {
        const backChoice = yield { type: 'setupBack', player: who, candidates: remainDebuts, prompt: 'バックステージに出すDebutホロメンを選択（最大3枚）' };
        const backNums = Array.isArray(backChoice) ? backChoice : [backChoice];
        for (const bn of backNums.slice(0, 3)) {
          const bc = p.hand.find((c) => c.n === bn && c.t === 'holomen' && c.bl === 'Debut');
          if (bc) { p.back.push(Object.assign(makeHolo(bc), { playedTurn: 0 })); p.hand.splice(p.hand.indexOf(bc), 1); }
        }
      }
      p.lifeCards = p.cheerDeck.splice(0, p.life);
    }
    this.push('', `先攻: ${this[this.first].name}`);
    yield { type: 'event', event: 'setupDone', msg: `先攻: ${this[this.first].name}` };
  };

  Game.prototype.attachCheerInteractive = function* (p) {
    if (!p.cheerDeck.length) return;
    const cheer = p.cheerDeck.shift();
    const col = (cheer.c && cheer.c[0]) || '無';
    const candidates = [p.center, p.collab, ...p.back].filter(Boolean);
    if (!candidates.length) return;
    const who = p === this.A ? 'A' : 'B';
    const choice = yield { type: 'cheerTarget', player: who, candidates, cheerColor: col, prompt: `${col}エールを付けるホロメンを選択` };
    const target = candidates.find((h) => h.id === choice) || candidates[0];
    target.cheer.push(col);
    this.push('', `${p.name}: ${target.card.nm} に ${col}エール`);
  };

  Game.prototype.downCenterInteractive = function* (op, me) {
    const downed = op.center;
    if (this.effectsOn) {
      const fx = fxOf(this.DB, downed.card.n);
      if (fx && fx.keywords) {
        fx.keywords.filter((k) => k.trigger === 'onDowned').forEach((k, i) => {
          tryRunAbility(this, op, me, k, abilityKey(downed.card.n, 'kwDown' + i), downed, this.rndFor(op));
        });
      }
      if (downed.attachments) {
        downed.attachments.forEach((att) => {
          const afx = fxOf(this.DB, att.n);
          if (afx && afx.keywords) {
            afx.keywords.filter((k) => k.trigger === 'onDowned').forEach((k, i) => {
              tryRunAbility(this, op, me, k, abilityKey(att.n, 'attDown' + i), downed, this.rndFor(op));
            });
          }
        });
      }
    }
    op.archive.push(downed.card);
    downed.cheer.forEach((c) => op.archive.push({ t: 'cheer', c: [c] }));
    op.center = null;
    const opWho = op === this.A ? 'A' : 'B';
    if (op.lifeCards && op.lifeCards.length > 0) {
      const lifeCheer = op.lifeCards.pop();
      op.life = op.lifeCards.length;
      const col = (lifeCheer.c && lifeCheer.c[0]) || '無';
      this.push('ko', `　⤷ ${op.name} のホロメンがダウン！ ライフ -1（残り${op.life}）`);
      yield { type: 'event', event: 'downed', msg: `${downed.card.nm} がダウン！` };
      const candidates = this.allHolos(op);
      if (candidates.length) {
        const lifeChoice = yield { type: 'lifeCheerTarget', player: opWho, candidates, cheerColor: col, prompt: `ライフから${col}エールを付けるホロメンを選択` };
        const target = candidates.find((h) => h.id === lifeChoice) || candidates[0];
        target.cheer.push(col);
        this.push('', `　${op.name}: ライフから${target.card.nm} に ${col}エール`);
      }
    } else {
      op.life = 0; op.lost = true; op.lostReason = 'ライフ0でダウン';
      this.push('ko', `　⤷ ${op.name} のホロメンがダウン！ ライフ0 → 敗北`);
      return;
    }
    if (op.back.length) {
      const promoteChoice = yield { type: 'promoteCenter', player: opWho, candidates: op.back, prompt: 'センターに出すホロメンを選択' };
      const promote = op.back.find((h) => h.id === promoteChoice) || op.back[0];
      op.back.splice(op.back.indexOf(promote), 1); op.center = promote;
      this.push('', `　${op.name}: ${promote.card.nm} がセンターへ`);
    } else if (op.collab) {
      op.center = op.collab; op.collab = null;
    } else {
      op.lost = true; op.lostReason = 'ホロメン全滅';
    }
  };

  Game.prototype.executeMainAction = function* (p, op, action) {
    const rnd = this.rndFor(p);
    const who = p === this.A ? 'A' : 'B';
    switch (action.act) {
      case 'bloom': {
        const holo = this.allHolos(p).find((h) => h.id === action.holoId);
        if (!holo) break;
        const bl = p.hand[action.handIdx];
        if (!bl) break;
        const prevCard = holo.card;
        p.hand.splice(action.handIdx, 1);
        holo.card = bl; holo.bloomedTurn = this.turn;
        this.push('', `${p.name}: ${bl.nm} に ブルーム(${bl.bl})`);
        yield { type: 'event', event: 'bloom', player: who, holoId: holo.id, name: bl.nm, level: bl.bl };
        if (this.effectsOn) {
          const prevFx = fxOf(this.DB, prevCard.n);
          if (prevFx && prevFx.keywords) {
            const giftKws = prevFx.keywords.filter((k) => k.trigger === 'onGift');
            for (let i = 0; i < giftKws.length; i++) {
              yield* tryRunAbilityInteractive(this, p, op, giftKws[i], abilityKey(prevCard.n, 'gift' + i), holo, rnd);
              this.push('', `${p.name}: ${prevCard.nm} のギフト効果`);
            }
          }
          const fx = fxOf(this.DB, bl.n);
          if (fx && fx.keywords) {
            const bloomKws = fx.keywords.filter((k) => k.trigger === 'onBloom');
            for (let i = 0; i < bloomKws.length; i++) {
              yield* tryRunAbilityInteractive(this, p, op, bloomKws[i], abilityKey(bl.n, 'kwB' + i), holo, rnd);
            }
          }
          if (holo.attachments) {
            for (const att of holo.attachments) {
              const afx = fxOf(this.DB, att.n);
              if (afx && afx.keywords) {
                const attBloomKws = afx.keywords.filter((k) => k.trigger === 'onBloom');
                for (let i = 0; i < attBloomKws.length; i++) {
                  yield* tryRunAbilityInteractive(this, p, op, attBloomKws[i], abilityKey(att.n, 'attB' + i), holo, rnd);
                }
              }
            }
          }
        }
        break;
      }
      case 'placeDebut': {
        const c = p.hand[action.handIdx];
        if (!c) break;
        p.hand.splice(action.handIdx, 1);
        p.back.push(Object.assign(makeHolo(c), { playedTurn: this.turn }));
        this.push('', `${p.name}: ${c.nm} をバックに出す`);
        break;
      }
      case 'playSupport': {
        const card = p.hand[action.handIdx];
        if (!card) break;
        const fx = fxOf(this.DB, card.n);
        if (!fx || !fx.ability) break;
        const key = abilityKey(card.n, 'sup');
        const isLimited = !!(card.ltd);
        if (card.st === 'ツール' || card.st === 'マスコット' || card.st === 'ファン') {
          const targets = this.allHolos(p).filter((h) => !fx.attachFilter || matchesFilter(h.card, fx.attachFilter));
          if (targets.length) {
            let host;
            if (targets.length === 1) {
              host = targets[0];
            } else {
              const attachChoice = yield { type: 'supportTarget', player: who, candidates: targets, prompt: `${card.nm} を付けるホロメンを選択` };
              host = targets.find((h) => h.id === attachChoice) || targets[0];
            }
            host.attachments.push(card);
            p.hand.splice(action.handIdx, 1);
            markUsed(p, key, 'game');
            this.push('', `${p.name}: ${host.card.nm} に〈${card.nm}〉を付けた`);
          }
        } else {
          p.hand.splice(action.handIdx, 1);
          markUsed(p, key, fx.ability.once || 'turn');
          if (isLimited) p.limitedUsedTurn = true;
          const ctx = { game: this, me: p, op, self: p.center, rnd };
          yield* runActionsInteractive(fx.ability.do, ctx);
          p.archive.push(card);
          this.push('', `${p.name}: 〈${card.nm}〉を使用`);
          yield { type: 'event', event: 'supportUsed', player: who, name: card.nm };
        }
        break;
      }
      case 'collab': {
        const cand = p.back.find((h) => h.id === action.holoId);
        if (!cand) break;
        p.back.splice(p.back.indexOf(cand), 1); p.collab = cand; p.usedCollab = true;
        this.push('', `${p.name}: ${cand.card.nm} をコラボ`);
        yield { type: 'event', event: 'collab', player: who, holoId: cand.id, name: cand.card.nm };
        if (this.effectsOn) {
          const fx = fxOf(this.DB, cand.card.n);
          if (fx && fx.keywords) {
            const collabKws = fx.keywords.filter((k) => k.trigger === 'onCollab');
            for (let i = 0; i < collabKws.length; i++) {
              yield* tryRunAbilityInteractive(this, p, op, collabKws[i], abilityKey(cand.card.n, 'kwC' + i), cand, rnd);
            }
          }
        }
        break;
      }
      case 'oshiSkill': {
        const fx = fxOf(this.DB, p.oshiCard.n);
        if (!fx || !fx.oshi) break;
        const cost = (fx.oshi.cost && fx.oshi.cost.holopower) || 0;
        for (let i = 0; i < cost && p.deck.length; i++) p.holoPower.push(p.deck.shift());
        yield* tryRunAbilityInteractive(this, p, op, fx.oshi, abilityKey(p.oshiCard.n, 'oshi'), p.center, rnd);
        this.push('', `${p.name}: 推しスキル「${fx.oshi.name || ''}」`);
        break;
      }
      case 'spSkill': {
        const fx = fxOf(this.DB, p.oshiCard.n);
        if (!fx || !fx.sp) break;
        const cost = (fx.sp.cost && fx.sp.cost.holopower) || 0;
        for (let i = 0; i < cost && p.deck.length; i++) p.holoPower.push(p.deck.shift());
        yield* tryRunAbilityInteractive(this, p, op, fx.sp, abilityKey(p.oshiCard.n, 'sp'), p.center, rnd);
        this.push('', `${p.name}: SP推しスキル「${fx.sp.name || ''}」`);
        break;
      }
      case 'baton': {
        const better = p.back.find((h) => h.id === action.holoId);
        if (!better) break;
        const need = this.DB.get(p.center.card.n).baton;
        for (let i = 0; i < need; i++) p.archive.push({ t: 'cheer', c: [p.center.cheer.pop()] });
        p.back.splice(p.back.indexOf(better), 1);
        const old = p.center; p.center = better; p.back.push(old);
        this.push('', `${p.name}: バトンタッチ → ${better.card.nm} がセンター`);
        break;
      }
    }
  };

  Game.prototype.performArtInteractive = function* (attacker, me, op) {
    const who = me === this.A ? 'A' : 'B';
    if (!op.center) return;
    const entry = this.DB.get(attacker.card.n);
    const payableArts = entry.arts.map((art, i) => ({ art, idx: i })).filter(({ art }) => canPay(effCost(art, attacker), attacker.cheer));
    if (!payableArts.length) return;

    // Let the player choose an art or skip
    const artChoice = yield {
      type: 'artChoice', player: who, holo: attacker,
      arts: payableArts.map(({ art, idx }) => ({ idx, power: art.power + (attacker.buffArt || 0), cost: art.cost })),
      prompt: `${attacker.card.nm} のアーツを選択`
    };
    if (artChoice === 'skip') return;
    const artIdx = artChoice >= 0 ? artChoice : payableArts[payableArts.length - 1].idx;
    const art = entry.arts[artIdx];
    if (!art) return;

    const attStatic = this.effectsOn ? this.applyAttachmentStatics(attacker) : { artBonus: 0 };
    const dmg = art.power + (attacker.buffArt || 0) + attStatic.artBonus;
    const targetNm = op.center.card.nm;
    op.center.dmg += dmg;
    const cls = me === this.A ? 'ta' : 'tb';
    this.push(cls, `T${this.turn} ${me.name}: ${attacker.card.nm} → ${targetNm} に ${dmg}`);
    yield { type: 'event', event: 'artHit', attacker: attacker.id, target: op.center.id, dmg, attackerName: attacker.card.nm, targetName: targetNm, player: who };

    if (this.effectsOn) {
      const fx = fxOf(this.DB, attacker.card.n);
      if (fx && fx.arts && fx.arts[artIdx]) {
        tryRunAbility(this, me, op, fx.arts[artIdx], abilityKey(attacker.card.n, 'art' + artIdx), attacker, this.rndFor(me));
      }
      if (op.center) {
        const defFx = fxOf(this.DB, op.center.card.n);
        if (defFx && defFx.keywords) {
          defFx.keywords.filter((k) => k.trigger === 'onDamageTaken').forEach((k, i) => {
            if (op.center) tryRunAbility(this, op, me, k, abilityKey(op.center.card.n, 'kwD' + i), op.center, this.rndFor(op));
          });
        }
      }
    }

    if (op.center && op.center.dmg >= ((op.center.card.hp || 0) + (this.effectsOn ? this.applyAttachmentStatics(op.center).hp - (op.center.card.hp || 0) : 0))) {
      yield* this.downCenterInteractive(op, me);
    }
    yield { type: 'event', event: 'artDone' };
  };

  Game.prototype.takeTurnInteractive = function* (who) {
    const me = this[who], op = who === 'A' ? this.B : this.A;
    if (me.lost || op.lost) return;
    this.turn++;
    const isFirstPlayer = (who === this.first);
    const isMyFirstTurn = !me._hadTurn; // first turn for this player
    me._hadTurn = true;
    const isFirstPlayerFirstTurn = isMyFirstTurn && isFirstPlayer;
    const isAnyFirstTurn = isMyFirstTurn;

    // Reset step: skipped on both players' first turn (official rules)
    this._phase = 'reset';
    if (!isAnyFirstTurn) {
      if (me.collab) { me.back.push(me.collab); me.collab = null; }
      this.allHolos(me).forEach((h) => { h.rested = false; h.buffArt = 0; h.costReduce = 0; });
    }
    me.usedCollab = false; me.usedTurn.clear(); me.limitedUsedTurn = false;

    // Draw step: both players draw on their first turn (official rules)
    this._phase = 'draw';
    this.draw(me, 1); yield { type: 'event', event: 'draw', player: who };
    if (me.lost) return;

    // Cheer step: both players attach cheer on their first turn
    this._phase = 'cheer';
    yield* this.attachCheerInteractive(me);
    yield { type: 'event', event: 'cheerDone' };

    // Main phase: bloom blocked on both T1, LIMITED blocked on first player T1
    this._phase = 'main';
    let mainGuard = 0;
    while (mainGuard++ < 30) {
      const actions = aiGetMainActions(me, op, this.turn, this, { noBloom: isAnyFirstTurn, noLimited: isFirstPlayerFirstTurn });
      if (!actions.length) break;
      actions.push({ act: 'endMain', label: 'メインフェイズ終了' });
      const choice = yield { type: 'mainAction', player: who, actions, prompt: 'メインフェイズ：アクションを選択' };
      if (!choice || choice.act === 'endMain') break;
      yield* this.executeMainAction(me, op, choice);
      if (me.lost || op.lost) return;
    }

    // Performance step: skipped on first player's first turn only
    this._phase = 'art';
    if (!isFirstPlayerFirstTurn) {
      if (me.center && !me.lost && !op.lost) {
        yield* this.performArtInteractive(me.center, me, op);
      }
      if (op.lost || me.lost) return;
      if (me.collab && !me.lost && !op.lost) {
        yield* this.performArtInteractive(me.collab, me, op);
      }
    }
    if (me.collab) me.collab.rested = true;
    this._phase = '';
  };

  Game.prototype.playInteractive = function* (maxTurns) {
    yield* this.setupInteractive();
    if (this.A.lost && this.B.lost) return this.finish(this.rndSys() < 0.5 ? 'A' : 'B');
    if (this.A.lost) return this.finish('B');
    if (this.B.lost) return this.finish('A');
    const order = this.first === 'A' ? ['A', 'B'] : ['B', 'A'];
    let idx = 0;
    while (this.turn < (maxTurns || 60)) {
      const who = order[idx % 2];
      yield { type: 'event', event: 'turnStart', player: who, turn: this.turn + 1 };
      yield* this.takeTurnInteractive(who);
      const other = who === 'A' ? 'B' : 'A';
      if (this[other].lost) return this.finish(who);
      if (this[who].lost) return this.finish(other);
      idx++;
    }
    let w;
    if (this.A.life > this.B.life) w = 'A';
    else if (this.B.life > this.A.life) w = 'B';
    else w = this.rndSys() < 0.5 ? 'A' : 'B';
    this.push('', '規定ターン到達：ライフ優勢で判定');
    return this.finish(w, true);
  };

  /* --- BattleDriver: runs the generator, dispatches to AI or human --- */
  function BattleDriver(game, humanPlayer, callbacks) {
    this.game = game;
    this.humanPlayer = humanPlayer; // 'A', 'B', or null (AI vs AI watch mode)
    this.onState = callbacks.onState || function () {};
    this.onDecision = callbacks.onDecision || function () {};
    this.onEnd = callbacks.onEnd || function () {};
    this.onLog = callbacks.onLog || function () {};
    this._resolve = null;
    this._running = false;
    this._paused = false;
    this.aiDelay = callbacks.aiDelay || 400;
  }
  BattleDriver.prototype.submitChoice = function (choice) {
    if (this._resolve) { const r = this._resolve; this._resolve = null; r(choice); }
  };
  BattleDriver.prototype.run = async function (maxTurns) {
    this._running = true;
    const gen = this.game.playInteractive(maxTurns);
    let result = gen.next();
    while (!result.done && this._running) {
      const d = result.value;
      if (d.type === 'event') {
        this.onLog(d);
        this.onState(snapshot(this.game));
        const animEvents = { turnStart: 1, downed: 1.5, artHit: 2.2, bloom: 1.2, collab: 0.8, supportUsed: 0.8 };
        const mult = animEvents[d.event];
        if (mult) {
          await new Promise((r) => setTimeout(r, Math.floor(this.aiDelay * mult)));
        }
        result = gen.next();
      } else if (this.humanPlayer && d.player === this.humanPlayer) {
        this.onState(snapshot(this.game));
        const choice = await new Promise((resolve) => { this._resolve = resolve; this.onDecision(d); });
        result = gen.next(choice);
      } else {
        // AI resolves
        if (this.aiDelay > 0) await new Promise((r) => setTimeout(r, Math.floor(this.aiDelay * (0.5 + Math.random() * 0.5))));
        const choice = aiResolve(d, this.game);
        this.onState(snapshot(this.game));
        result = gen.next(choice);
      }
    }
    if (result.done) {
      this.onState(snapshot(this.game));
      this.onEnd(result.value);
    }
    this._running = false;
  };
  BattleDriver.prototype.stop = function () { this._running = false; };

  /* ---------- public API ---------- */
  function buildDB(cards, effects) {
    const m = new Map();
    cards.forEach((c) => m.set(c.n, Object.assign({}, c, analyzeCard(c, effects ? effects[c.n] : null))));
    return m;
  }

  function playGame(deckA, deckB, DB, opts) { return new Game(deckA, deckB, DB, opts).play(opts && opts.maxTurns); }

  function simulate(deckA, deckB, DB, games, opts) {
    let wa = 0, wb = 0, tsum = 0;
    const reasons = {};
    const half = Math.floor(games / 2);
    for (let i = 0; i < games; i++) {
      const swap = i < half;
      const r = swap
        ? new Game(deckB, deckA, DB, opts || {}).play()
        : new Game(deckA, deckB, DB, opts || {}).play();
      const winnerIsDeckA = swap ? r.winner === 'B' : r.winner === 'A';
      if (winnerIsDeckA) wa++; else wb++;
      tsum += r.turns;
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
    return { wa, wb, games, avgTurn: (tsum / games), reasons };
  }

  function createInteractiveGame(deckA, deckB, DB, opts) {
    return new Game(deckA, deckB, DB, Object.assign({ log: true, effects: true }, opts || {}));
  }

  const api = { buildDB, playGame, simulate, analyzeCard, parseArt, canPay, createInteractiveGame, BattleDriver, snapshot, aiResolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HoloEngine = api;
})();
