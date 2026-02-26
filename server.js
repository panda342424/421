const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ============================================================
// HTTP — sert les fichiers statiques du dossier /public
// ============================================================
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.ico':'image/x-icon' };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        res.writeHead(200, {'Content-Type':'text/html'});
        res.end(d);
      });
      return;
    }
    res.writeHead(200, {'Content-Type': mime[ext] || 'text/plain'});
    res.end(data);
  });
});

// ============================================================
// WEBSOCKET
// ============================================================
const wss = new WebSocketServer({ server });

// Rooms en mémoire : { code → { room, gs, clients: Map<ws, {username,avatar}> } }
const ROOMS = {};

function broadcast(code, msg, excludeWs = null) {
  const r = ROOMS[code];
  if (!r) return;
  const data = JSON.stringify(msg);
  r.clients.forEach((info, ws) => {
    if (ws !== excludeWs && ws.readyState === 1) ws.send(data);
  });
}

function broadcastAll(code, msg) {
  broadcast(code, msg, null);
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ============================================================
// GAME LOGIC (identique au client mais côté serveur)
// ============================================================
const ORDERED_COMBOS = ["421","111","116","666","115","555","114","444","113","333","112","222","654","543","432","321","665","664","663","662","661","655","653","652","651","644","643","642","641","633","632","631","622","621","554","553","552","551","544","542","541","533","532","531","522","521","443","442","441","433","431","422","332","331","322","221"];
const SCORE_MAP = {"421":8,"111":7,"116":6,"666":6,"115":5,"555":5,"114":4,"444":4,"113":3,"333":3,"112":2,"222":2,"654":2,"543":2,"432":2,"321":2};
const COMBO_POWER={}, COMBO_SCORE={}, PERM_TO_KEY={};

function perms(s){ if(s.length<=1)return[s]; const r=new Set(); for(let i=0;i<s.length;i++){const rest=s.slice(0,i)+s.slice(i+1); for(const p of perms(rest))r.add(s[i]+p);} return[...r]; }
ORDERED_COMBOS.forEach((c,i)=>{ COMBO_POWER[c]=ORDERED_COMBOS.length-i; COMBO_SCORE[c]=SCORE_MAP[c]??1; perms(c).forEach(p=>{PERM_TO_KEY[p]=c;}); });
function normalizeCombo(dice){ const k=dice.join(''); return PERM_TO_KEY[k]||[...dice].sort((a,b)=>b-a).join(''); }
function getScore(c){ return COMBO_SCORE[c]??0; }
function getPower(c){ return COMBO_POWER[c]??0; }
function rollDie(){ return Math.ceil(Math.random()*6); }
function rollDice(){ return [rollDie(),rollDie(),rollDie()]; }

const BOT_NAMES  = ["RobotX","DiceBot","AlphaRoll","BetaThrow","GammaJet","DeltaDice"];
const BOT_AVATARS = ["🤖","🦾","⚙️","🎰","🔮","🎯"];

function createGS(players, totalTokens) {
  return {
    phase:1, players,
    stockTokens: totalTokens,
    p1Order: players.map((_,i)=>i),
    p1CurrentSlot: 0,
    p1RoundResults: [],
    p2ActivePlayers: [],
    p2CurrentSlot: 0,
    p2MaxRolls: 3,
    p2FirstDone: false,
    p2Rolls: {},
    p2RollsLeft: 3,
    p2KeptDice: [false,false,false],
    p2CurrentDice: null,
    currentDice: null,
    log: [
      {txt:"🎲 Partie lancée ! Phase 1 — Distribution", cls:"ev-resolve"},
      {txt:"📌 La pire combo du tour reçoit du stock la valeur de la meilleure", cls:""}
    ],
    finished: false,
    winners: [],
    losers: []
  };
}

function resolveP1Round(gs) {
  const results = gs.p1RoundResults;
  const valid = results.filter(r=>getPower(r.combo)>0);
  const anims = [];
  if(!valid.length){
    gs.log.push({txt:"⚪ Aucune combo valide",cls:""});
    gs.p1RoundResults=[]; gs.p1CurrentSlot=0;
    return anims;
  }
  const best  = results.reduce((a,r)=>getPower(r.combo)>getPower(a.combo)?r:a, results[0]);
  const worst = results.reduce((a,r)=>getPower(r.combo)<getPower(a.combo)?r:a, results[0]);
  if(best.playerIdx===worst.playerIdx){
    gs.log.push({txt:"🤝 Égalité — pas de distribution",cls:""});
  } else {
    const wp  = gs.players[worst.playerIdx];
    const val = getScore(best.combo);
    const give= Math.min(val, gs.stockTokens);
    wp.tokens += give; gs.stockTokens -= give;
    gs.log.push({txt:`💸 ${wp.avatar} ${wp.username} (pire: ${worst.combo}) ← ${give}🪙 stock (meilleure: ${best.combo})`, cls:"ev-money"});
    if(give>0) anims.push(`+${give}🪙 → ${wp.username}`);
    const wi = worst.playerIdx;
    gs.p1Order = [wi, ...gs.p1Order.filter(i=>i!==wi)];
  }
  gs.p1RoundResults=[]; gs.p1CurrentSlot=0;
  checkP1End(gs, anims);
  return anims;
}

function checkP1End(gs, anims=[]) {
  if(gs.stockTokens>0) return;
  gs.stockTokens=0;
  const winners   = gs.players.filter(p=>p.tokens===0);
  const remaining = gs.players.filter(p=>p.tokens>0);
  gs.log.push({txt:"--- 🎉 Stock épuisé ! Fin Phase 1 ---", cls:"ev-resolve"});
  if(winners.length) gs.log.push({txt:"🏆 "+winners.map(p=>`${p.avatar} ${p.username}`).join(", ")+" ont gagné !", cls:"ev-win"});
  if(!remaining.length){ gs.finished=true; gs.winners=winners.map(p=>p.username); }
  else if(remaining.length===1){
    gs.finished=true; gs.winners=winners.map(p=>p.username); gs.losers=[remaining[0].username];
    gs.log.push({txt:`💀 ${remaining[0].username} est seul avec des jetons — PERDU !`, cls:""});
  } else {
    gs.phase=2; gs.players=remaining;
    gs.p2ActivePlayers = gs.players.map((_,i)=>i).filter(i=>gs.players[i].tokens>0);
    gs.p2CurrentSlot=0; gs.p2MaxRolls=3; gs.p2FirstDone=false;
    gs.p2RollsLeft=3; gs.p2KeptDice=[false,false,false]; gs.p2CurrentDice=null; gs.p2Rolls={};
    gs.p2ActivePlayers.forEach(i=>{ gs.p2Rolls[i]={rolls:[],done:false}; });
    gs.log.push({txt:"--- ⚔️ Phase 2 : Affrontement ! ---", cls:"ev-resolve"});
    gs.log.push({txt:"Le 1er joueur définit le nombre de lancers. Garde des dés 🔒", cls:""});
  }
}

function resolveP2Turn(gs) {
  const active  = gs.p2ActivePlayers;
  const results = active.map(i=>({i, player:gs.players[i], power:gs.p2Rolls[i]?.finalPower??-1, combo:gs.p2Rolls[i]?.finalCombo??null}));
  const maxP = Math.max(...results.map(r=>r.power));
  const minP = Math.min(...results.map(r=>r.power));
  const anims = [];
  if(maxP===minP){
    gs.log.push({txt:"🤝 Égalité ! Chaque joueur relance 1 fois !", cls:""});
    gs.p2CurrentSlot=0; gs.p2RollsLeft=1; gs.p2KeptDice=[false,false,false]; gs.p2CurrentDice=null;
    active.forEach(i=>{ gs.p2Rolls[i]={rolls:[],done:false}; });
    return anims;
  }
  const best  = results.find(r=>r.power===maxP);
  const worst = results.find(r=>r.power===minP);
  const val      = getScore(best.combo);
  const transfer = Math.min(val, best.player.tokens);
  if(transfer>0){
    best.player.tokens -= transfer; worst.player.tokens += transfer;
    anims.push(`${transfer}🪙 : ${best.player.username} → ${worst.player.username}`);
    gs.log.push({txt:`💸 ${best.player.username} (${best.combo}=${val}🪙) → ${transfer}🪙 à ${worst.player.username} (${worst.combo})`, cls:"ev-money"});
  } else {
    gs.log.push({txt:`⚪ ${best.player.username} n'a aucun jeton à donner`, cls:""});
  }
  const total = gs.players.reduce((s,p)=>s+p.tokens, 0);
  const loser = gs.players.find(p=>p.tokens>=total&&total>0);
  if(loser){
    gs.finished=true; gs.losers=[loser.username];
    gs.winners=gs.players.filter(p=>p.username!==loser.username).map(p=>p.username);
    gs.log.push({txt:`💀 ${loser.username} a tous les jetons — PERDU !`, cls:""});
    return anims;
  }
  const wi = worst.i;
  const newActive = gs.players.map((_,i)=>i).filter(i=>gs.players[i].tokens>0);
  const reordered = [wi, ...newActive.filter(i=>i!==wi)];
  gs.p2ActivePlayers=reordered; gs.p2CurrentSlot=0; gs.p2MaxRolls=3; gs.p2FirstDone=false;
  gs.p2RollsLeft=3; gs.p2KeptDice=[false,false,false]; gs.p2CurrentDice=null; gs.p2Rolls={};
  reordered.forEach(i=>{ gs.p2Rolls[i]={rolls:[],done:false}; });
  const rem = gs.players.filter(p=>p.tokens>0);
  if(rem.length<=1){
    if(rem.length===1){ gs.finished=true; gs.losers=[rem[0].username]; gs.winners=gs.players.filter(p=>p.username!==rem[0].username).map(p=>p.username); }
    else { gs.finished=true; gs.winners=gs.players.map(p=>p.username); }
  } else { gs.log.push({txt:"--- 🔄 Nouveau tour ---", cls:"ev-resolve"}); }
  return anims;
}

function finishP2Player(gs) {
  const playerIdx = gs.p2ActivePlayers[gs.p2CurrentSlot];
  const player    = gs.players[playerIdx];
  const p2r       = gs.p2Rolls[playerIdx];
  const isFirst   = gs.p2CurrentSlot===0;
  p2r.done=true; p2r.finalCombo=p2r.lastCombo??null; p2r.finalPower=p2r.lastPower??-1;
  gs.p2KeptDice=[false,false,false]; gs.p2CurrentDice=null;
  if(isFirst){
    gs.p2MaxRolls=p2r.rolls.length; gs.p2FirstDone=true;
    gs.log.push({txt:`  ✅ ${player.username} s'arrête — retenu : ${p2r.finalCombo} (${getScore(p2r.finalCombo)}🪙). Autres : ${gs.p2MaxRolls} lancer(s).`, cls:"ev-done"});
  } else {
    gs.log.push({txt:`  ✅ ${player.username} — retenu : ${p2r.finalCombo} (${getScore(p2r.finalCombo)}🪙)`, cls:"ev-done"});
  }
  const next = gs.p2CurrentSlot+1;
  if(next < gs.p2ActivePlayers.length){
    gs.p2CurrentSlot=next; gs.p2RollsLeft=gs.p2MaxRolls; gs.p2KeptDice=[false,false,false];
  } else {
    gs.log.push({txt:"〔 Résolution du tour 〕", cls:"ev-resolve"});
    return resolveP2Turn(gs);
  }
  return [];
}

function applyRoll(gs) {
  const anims = [];
  if(gs.phase===1){
    const playerIdx = gs.p1Order[gs.p1CurrentSlot];
    const player    = gs.players[playerIdx];
    const dice  = rollDice();
    const combo = normalizeCombo(dice);
    gs.currentDice = dice;
    gs.log.push({txt:`${player.avatar} ${player.username} : [${dice.join('-')}] → ${combo}${getScore(combo)>0?` (${getScore(combo)}🪙)`:''}`, cls:""});
    if(combo==='221'){
      const gift=Math.min(1,gs.stockTokens);
      if(gift>0){ player.tokens+=gift; gs.stockTokens-=gift; gs.log.push({txt:`  🎁 ${player.username} fait 122 ! +1 jeton cadeau`, cls:"ev-gift"}); anims.push(`🎁 +1 → ${player.username}`); }
    }
    gs.p1RoundResults.push({playerIdx, dice, combo});
    if(gs.p1RoundResults.length >= gs.players.length){
      gs.log.push({txt:"〔 Résolution du tour 〕", cls:"ev-resolve"});
      anims.push(...resolveP1Round(gs));
    } else { gs.p1CurrentSlot++; }
  } else {
    const playerIdx = gs.p2ActivePlayers[gs.p2CurrentSlot];
    const player    = gs.players[playerIdx];
    const p2r       = gs.p2Rolls[playerIdx];
    const kept      = gs.p2KeptDice;
    const isFirst   = gs.p2CurrentSlot===0;
    let dice;
    if(gs.p2CurrentDice && p2r.rolls.length>0){ dice=gs.p2CurrentDice.map((d,i)=>kept[i]?d:rollDie()); }
    else { dice=rollDice(); }
    gs.p2CurrentDice=dice;
    const combo=normalizeCombo(dice); const power=getPower(combo);
    p2r.lastCombo=combo; p2r.lastPower=power;
    p2r.rolls.push({dice:[...dice], combo});
    gs.p2RollsLeft--;
    const keptStr = kept.some(k=>k) ? ' 🔒'+kept.map((k,i)=>k?dice[i]:'').filter(Boolean).join(',') : '';
    gs.log.push({txt:`${player.avatar} ${player.username} [${p2r.rolls.length}/${isFirst?'?':gs.p2MaxRolls}] : [${dice.join('-')}]${keptStr} → ${combo}${getScore(combo)>0?` (${getScore(combo)}🪙)`:''}`, cls:""});
    gs.currentDice=dice;
    if(gs.p2RollsLeft<=0){ anims.push(...finishP2Player(gs)); }
  }
  return anims;
}

function applyStop(gs) {
  if(gs.phase!==2) return [];
  const playerIdx = gs.p2ActivePlayers[gs.p2CurrentSlot];
  const p2r = gs.p2Rolls[playerIdx];
  if(!p2r || p2r.rolls.length===0 || p2r.done) return [];
  return finishP2Player(gs);
}

function currentPlayerName(gs) {
  const idx = gs.phase===1 ? gs.p1Order[gs.p1CurrentSlot] : gs.p2ActivePlayers?.[gs.p2CurrentSlot];
  return gs.players[idx]?.username ?? null;
}

// ============================================================
// BOT SCHEDULER
// ============================================================
const BOT_TIMERS = {};
function scheduleBot(code) {
  if(BOT_TIMERS[code]) { clearTimeout(BOT_TIMERS[code]); delete BOT_TIMERS[code]; }
  const r = ROOMS[code];
  if(!r || !r.gs || r.gs.finished) return;
  const gs = r.gs;
  const idx = gs.phase===1 ? gs.p1Order[gs.p1CurrentSlot] : gs.p2ActivePlayers?.[gs.p2CurrentSlot];
  const cp = gs.players[idx];
  if(!cp?.isBot) return;
  const delay = gs.phase===2 ? 850 : 1000;
  BOT_TIMERS[code] = setTimeout(() => {
    const r2 = ROOMS[code];
    if(!r2||!r2.gs||r2.gs.finished) return;
    const gs2 = r2.gs;
    const idx2 = gs2.phase===1 ? gs2.p1Order[gs2.p1CurrentSlot] : gs2.p2ActivePlayers?.[gs2.p2CurrentSlot];
    const cp2 = gs2.players[idx2];
    if(!cp2?.isBot) return;
    let anims = [];
    if(gs2.phase===2){
      const p2r = gs2.p2Rolls[idx2];
      if(!p2r) return;
      const hasDice = gs2.p2CurrentDice && p2r.rolls.length>0;
      const curCombo = hasDice ? normalizeCombo(gs2.p2CurrentDice) : null;
      const curPower = curCombo ? getPower(curCombo) : 0;
      const isFirst  = gs2.p2CurrentSlot===0;
      const rollsDone= p2r.rolls.length;
      const shouldStop = hasDice && (
        curPower>=getPower('321') ||
        (isFirst && rollsDone>=2 && curPower>=getPower('221')) ||
        (!isFirst && rollsDone>=gs2.p2MaxRolls)
      );
      if(shouldStop && rollsDone>0){ anims = applyStop(gs2); }
      else {
        if(hasDice){
          const dice=gs2.p2CurrentDice;
          const ones=dice.filter(d=>d===1).length;
          let kept=[false,false,false];
          if(ones>=2){let k=0;kept=dice.map(d=>{if(d===1&&k<2){k++;return true;}return false;});}
          else if(ones===1&&curPower>=getPower('221')){kept=dice.map(d=>d===1);}
          gs2.p2KeptDice=kept;
        }
        anims = applyRoll(gs2);
      }
    } else {
      anims = applyRoll(gs2);
    }
    broadcastAll(code, {type:'STATE', gs:gs2, anims});
    scheduleBot(code);
  }, delay);
}

// ============================================================
// WEBSOCKET HANDLERS
// ============================================================
wss.on('connection', (ws) => {
  let clientCode = null;
  let clientUsername = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    // ---- CREATE ----
    if(msg.type==='CREATE'){
      const code = msg.code;
      const room = {
        code, host: msg.username,
        maxPlayers: msg.maxPlayers,
        totalTokens: msg.totalTokens,
        players: [{username:msg.username, avatar:msg.avatar, isBot:false}],
        status: 'waiting'
      };
      ROOMS[code] = { room, gs:null, clients: new Map() };
      ROOMS[code].clients.set(ws, {username:msg.username, avatar:msg.avatar});
      clientCode = code; clientUsername = msg.username;
      send(ws, {type:'ROOM_UPDATE', room});
    }

    // ---- JOIN ----
    else if(msg.type==='JOIN'){
      const r = ROOMS[msg.code];
      if(!r){ send(ws, {type:'ERROR', msg:'Salon introuvable'}); return; }
      if(r.room.status!=='waiting'){ send(ws, {type:'ERROR', msg:'Partie déjà commencée'}); return; }
      if(r.room.players.length>=r.room.maxPlayers){ send(ws, {type:'ERROR', msg:'Salon plein'}); return; }
      const already = r.room.players.find(p=>p.username===msg.username);
      if(!already) r.room.players.push({username:msg.username, avatar:msg.avatar, isBot:false});
      r.clients.set(ws, {username:msg.username, avatar:msg.avatar});
      clientCode=msg.code; clientUsername=msg.username;
      // Envoyer l'état courant au nouveau joueur
      send(ws, {type:'ROOM_UPDATE', room:r.room});
      // Prévenir tout le monde
      broadcastAll(msg.code, {type:'ROOM_UPDATE', room:r.room});
    }

    // ---- ADD BOT ----
    else if(msg.type==='ADD_BOT'){
      const r = ROOMS[msg.code];
      if(!r||r.room.host!==msg.username) return;
      if(r.room.players.length>=r.room.maxPlayers){ send(ws,{type:'ERROR',msg:'Salon plein'}); return; }
      const idx = r.room.players.filter(p=>p.isBot).length % BOT_NAMES.length;
      r.room.players.push({username:BOT_NAMES[idx], avatar:BOT_AVATARS[idx], isBot:true});
      broadcastAll(msg.code, {type:'ROOM_UPDATE', room:r.room});
    }

    // ---- START ----
    else if(msg.type==='START'){
      const r = ROOMS[msg.code];
      if(!r||r.room.host!==msg.username) return;
      if(r.room.players.length<2){ send(ws,{type:'ERROR',msg:'Minimum 2 joueurs'}); return; }
      const players = r.room.players.map(p=>({...p, tokens:0}));
      r.gs = createGS(players, r.room.totalTokens);
      r.room.status = 'playing';
      broadcastAll(msg.code, {type:'STATE', gs:r.gs, anims:[]});
      scheduleBot(msg.code);
    }

    // ---- ROLL ----
    else if(msg.type==='ROLL'){
      const r = ROOMS[msg.code];
      if(!r||!r.gs||r.gs.finished) return;
      const cpName = currentPlayerName(r.gs);
      if(cpName!==msg.username) return; // pas ton tour
      const anims = applyRoll(r.gs);
      broadcastAll(msg.code, {type:'STATE', gs:r.gs, anims});
      scheduleBot(msg.code);
    }

    // ---- STOP ----
    else if(msg.type==='STOP'){
      const r = ROOMS[msg.code];
      if(!r||!r.gs||r.gs.finished||r.gs.phase!==2) return;
      const cpName = currentPlayerName(r.gs);
      if(cpName!==msg.username) return;
      const anims = applyStop(r.gs);
      broadcastAll(msg.code, {type:'STATE', gs:r.gs, anims});
      scheduleBot(msg.code);
    }

    // ---- KEEP ----
    else if(msg.type==='KEEP'){
      const r = ROOMS[msg.code];
      if(!r||!r.gs||r.gs.finished||r.gs.phase!==2) return;
      const cpName = currentPlayerName(r.gs);
      if(cpName!==msg.username) return;
      r.gs.p2KeptDice[msg.idx] = !r.gs.p2KeptDice[msg.idx];
      broadcastAll(msg.code, {type:'STATE', gs:r.gs, anims:[]});
    }

    // ---- LEAVE ----
    else if(msg.type==='LEAVE'){
      handleLeave(ws, msg.code, msg.username);
    }
  });

  ws.on('close', () => {
    if(clientCode) handleLeave(ws, clientCode, clientUsername);
  });
});

function handleLeave(ws, code, username) {
  const r = ROOMS[code];
  if(!r) return;
  r.clients.delete(ws);
  // Si plus personne → supprimer le salon
  if(r.clients.size===0){
    if(BOT_TIMERS[code]){ clearTimeout(BOT_TIMERS[code]); delete BOT_TIMERS[code]; }
    delete ROOMS[code];
    return;
  }
  // Si c'était le host et partie pas commencée → supprimer
  if(username===r.room.host && r.room.status==='waiting'){
    broadcastAll(code, {type:'ERROR', msg:"L'hôte a quitté le salon"});
    if(BOT_TIMERS[code]){ clearTimeout(BOT_TIMERS[code]); delete BOT_TIMERS[code]; }
    delete ROOMS[code];
    return;
  }
  // Enlever le joueur de la liste si partie pas commencée
  if(r.room.status==='waiting'){
    r.room.players = r.room.players.filter(p=>p.username!==username);
    broadcastAll(code, {type:'ROOM_UPDATE', room:r.room});
  }
}

server.listen(PORT, () => {
  console.log(`✅ Serveur 421 démarré sur le port ${PORT}`);
});
