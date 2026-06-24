import { useState, useEffect, useCallback, useRef } from "react";
import { db } from "./firebase";
import { ref, onValue, set, get } from "firebase/database";

// ============================================================
// CONSTANTS
// ============================================================
const NORMAL_CAMELS = ["red", "blue", "green", "yellow", "purple"];
const CRAZY_CAMELS = ["white", "black"];
const ALL_CAMELS = [...NORMAL_CAMELS, ...CRAZY_CAMELS];

const CAMEL_EMOJI = {
  red: "🔴", blue: "🔵", green: "🟢", yellow: "🟡", purple: "🟣",
  white: "⬜", black: "⬛",
};
const CAMEL_JP = {
  red: "赤", blue: "青", green: "緑", yellow: "黄", purple: "紫",
  white: "白", black: "黒",
};

const TRACK_LENGTH = 16;
const STARTING_COINS = 3;
const LEG_BET_TILES = [5, 3, 2, 2];
const RACE_BET_PAYOUTS = [8, 5, 3, 2, 1];
const DB_KEY = "camelup_game";

// ============================================================
// GAME LOGIC
// ============================================================
function initGame(players) {
  const positions = {};
  const stacks = {};
  NORMAL_CAMELS.forEach((c, i) => {
    positions[c] = i;
    if (!stacks[i]) stacks[i] = [];
    stacks[i].push(c);
  });
  const crazySqs = [TRACK_LENGTH - 1, TRACK_LENGTH - 2];
  CRAZY_CAMELS.forEach((c, i) => {
    const sq = crazySqs[i];
    positions[c] = sq;
    if (!stacks[sq]) stacks[sq] = [];
    stacks[sq].push(c);
  });
  return {
    phase: "playing", turn: 0, players,
    coins: Object.fromEntries(players.map((p) => [p, STARTING_COINS])),
    positions, stacks,
    legBets: {}, raceBets: { win: [], lose: [] },
    usedDice: [], crazyDiceUsed: false,
    log: ["🏁 レース開始！"], winner: null,
  };
}

function rollDice(state) {
  const remainingNormal = NORMAL_CAMELS.filter((c) => !state.usedDice.includes(c));
  const canCrazy = !state.crazyDiceUsed;
  const pool = [];
  remainingNormal.forEach((c) => pool.push({ type: "normal", camel: c }));
  if (canCrazy) pool.push({ type: "crazy" });
  if (pool.length === 0) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const steps = Math.floor(Math.random() * 3) + 1;
  if (pick.type === "crazy") {
    const camel = CRAZY_CAMELS[Math.floor(Math.random() * 2)];
    return { camel, steps, isCrazy: true };
  }
  return { camel: pick.camel, steps, isCrazy: false };
}

function moveCamel(state, camel, steps, crazy) {
  const ns = JSON.parse(JSON.stringify(state));
  const fromSq = ns.positions[camel];
  const toSq = crazy ? fromSq - steps : fromSq + steps;
  const fromStack = ns.stacks[fromSq] || [];
  const camelIdx = fromStack.indexOf(camel);
  if (camelIdx === -1) return ns;
  const movers = fromStack.slice(camelIdx);
  ns.stacks[fromSq] = fromStack.slice(0, camelIdx);
  if (ns.stacks[fromSq].length === 0) delete ns.stacks[fromSq];
  if (!crazy && toSq >= TRACK_LENGTH) {
    ns.winner = camel; ns.phase = "finished";
    ns.log.unshift(`🏆 ${CAMEL_JP[camel]}ラクダがゴール！`);
    _scoreRaceBets(ns);
  } else if (crazy && toSq < 0) {
    const maxSq = Math.max(...Object.keys(ns.stacks).map(Number));
    if (!ns.stacks[maxSq]) ns.stacks[maxSq] = [];
    ns.stacks[maxSq] = [...movers, ...ns.stacks[maxSq]];
    movers.forEach((m) => { ns.positions[m] = maxSq; });
  } else {
    if (!ns.stacks[toSq]) ns.stacks[toSq] = [];
    if (crazy) {
      ns.stacks[toSq] = [...movers, ...ns.stacks[toSq]];
    } else {
      ns.stacks[toSq] = [...ns.stacks[toSq], ...movers];
    }
    movers.forEach((m) => { ns.positions[m] = toSq; });
  }
  return ns;
}

function _scoreRaceBets(ns) {
  const normalRanked = [...NORMAL_CAMELS].sort((a, b) => {
    const pa = ns.positions[a] ?? 0, pb = ns.positions[b] ?? 0;
    if (pa !== pb) return pb - pa;
    const sa = ns.stacks[pa] || [], sb = ns.stacks[pb] || [];
    return sb.indexOf(b) - sa.indexOf(a);
  });
  const leader = normalRanked[0];
  const last = normalRanked[normalRanked.length - 1];
  let winIdx = 0;
  ns.raceBets.win.forEach(({ player, camel }) => {
    const gain = camel === leader ? RACE_BET_PAYOUTS[Math.min(winIdx++, RACE_BET_PAYOUTS.length - 1)] : -1;
    ns.coins[player] = (ns.coins[player] || 0) + gain;
    ns.log.unshift(`🏆 ${player}: 優勝ベット ${gain > 0 ? "+" : ""}${gain}コイン`);
  });
  let loseIdx = 0;
  ns.raceBets.lose.forEach(({ player, camel }) => {
    const gain = camel === last ? RACE_BET_PAYOUTS[Math.min(loseIdx++, RACE_BET_PAYOUTS.length - 1)] : -1;
    ns.coins[player] = (ns.coins[player] || 0) + gain;
    ns.log.unshift(`🏁 ${player}: 最下位ベット ${gain > 0 ? "+" : ""}${gain}コイン`);
  });
}

function scoreEndOfLeg(state) {
  const ns = JSON.parse(JSON.stringify(state));
  const ranked = [...NORMAL_CAMELS].sort((a, b) => {
    const pa = ns.positions[a] ?? 0, pb = ns.positions[b] ?? 0;
    if (pa !== pb) return pb - pa;
    const sa = ns.stacks[pa] || [], sb = ns.stacks[pb] || [];
    return sb.indexOf(b) - sa.indexOf(a);
  });
  NORMAL_CAMELS.forEach((camel) => {
    const bets = ns.legBets[camel] || [];
    bets.forEach(({ player, tile }, idx) => {
      const rank = ranked.indexOf(camel);
      const gain = rank === 0 ? (LEG_BET_TILES[idx] ?? 2) : rank === 1 ? 1 : -1;
      ns.coins[player] = (ns.coins[player] || 0) + gain;
      ns.log.unshift(`💰 ${player}: ${CAMEL_JP[camel]}レッグベット ${gain > 0 ? "+" : ""}${gain}コイン`);
    });
  });
  ns.usedDice = [];
  ns.crazyDiceUsed = false;
  ns.legBets = {};
  ns.log.unshift("🎲 新しいレッグ開始！");
  return ns;
}

// ============================================================
// PALETTE
// ============================================================
const palette = {
  darkSand: "#C4A24A", dusk: "#1A1035", night: "#0D0820",
  accent: "#FF6B35", gold: "#FFD700",
  cardBg: "rgba(255,255,255,0.08)", cardBorder: "rgba(255,215,0,0.25)",
};

const PLAYER_COLORS = [
  { bg: "rgba(100,180,255,0.18)", border: "rgba(100,180,255,0.5)", text: "#64B4FF" },
  { bg: "rgba(255,160,80,0.18)",  border: "rgba(255,160,80,0.5)",  text: "#FFA050" },
  { bg: "rgba(120,220,120,0.18)", border: "rgba(120,220,120,0.5)", text: "#78DC78" },
  { bg: "rgba(220,120,220,0.18)", border: "rgba(220,120,220,0.5)", text: "#DC78DC" },
  { bg: "rgba(255,220,80,0.18)",  border: "rgba(255,220,80,0.5)",  text: "#FFDC50" },
  { bg: "rgba(80,220,220,0.18)",  border: "rgba(80,220,220,0.5)",  text: "#50DCDC" },
  { bg: "rgba(255,100,150,0.18)", border: "rgba(255,100,150,0.5)", text: "#FF6496" },
  { bg: "rgba(180,140,255,0.18)", border: "rgba(180,140,255,0.5)", text: "#B48CFF" },
];

// ============================================================
// COMPONENTS
// ============================================================
function CamelStack({ stack }) {
  return (
    <div style={{ display: "flex", flexDirection: "column-reverse", alignItems: "center" }}>
      {(stack || []).map((c, i) => (
        <div key={c} style={{ fontSize: i === stack.length - 1 ? 18 : 14, transform: `translateY(${i * -2}px)`, textShadow: "0 2px 4px rgba(0,0,0,0.6)", lineHeight: 1 }}>
          {CAMEL_EMOJI[c]}
        </div>
      ))}
    </div>
  );
}

function Track({ stacks }) {
  return (
    <div style={{ overflowX: "auto", paddingBottom: 6 }}>
      <div style={{ display: "flex", gap: 3, minWidth: TRACK_LENGTH * 50 }}>
        {Array.from({ length: TRACK_LENGTH }).map((_, i) => {
          const isGoal = i === TRACK_LENGTH - 1;
          const isStart = i === 0;
          const sq = stacks[i] || [];
          return (
            <div key={i} style={{
              width: 46, minHeight: 70, borderRadius: 7,
              background: isGoal ? "linear-gradient(135deg,#FFD700,#FF6B35)" : isStart ? "rgba(100,200,255,0.1)" : i % 2 === 0 ? "rgba(232,201,122,0.13)" : "rgba(232,201,122,0.07)",
              border: isGoal ? "2px solid #FFD700" : isStart ? "1px solid rgba(100,200,255,0.3)" : "1px solid rgba(232,201,122,0.18)",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end",
              padding: "4px 2px", position: "relative", flexShrink: 0,
            }}>
              <div style={{ position: "absolute", top: 3, fontSize: 9, fontWeight: 700, color: isGoal ? "#0D0820" : "rgba(255,255,255,0.35)" }}>
                {isGoal ? "🏁" : i + 1}
              </div>
              <CamelStack stack={sq} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LegBetPanel({ state, currentPlayer, onBet }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      {NORMAL_CAMELS.map((camel) => {
        const bets = state.legBets[camel] || [];
        const takenCount = bets.length;
        const myBets = bets.filter((b) => b.player === currentPlayer).length;
        const nextTile = LEG_BET_TILES[takenCount] ?? null;
        return (
          <div key={camel} style={{ background: palette.cardBg, border: `1px solid ${palette.cardBorder}`, borderRadius: 12, padding: "10px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 70 }}>
            <span style={{ fontSize: 26 }}>{CAMEL_EMOJI[camel]}</span>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{CAMEL_JP[camel]}</span>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "center" }}>
              {LEG_BET_TILES.map((tile, idx) => {
                const taken = idx < takenCount;
                const isNext = idx === takenCount;
                return (
                  <div key={idx} style={{ fontSize: 11, fontWeight: 700, color: taken ? "rgba(255,255,255,0.2)" : isNext ? palette.gold : "rgba(255,255,255,0.5)", background: taken ? "rgba(255,255,255,0.04)" : isNext ? "rgba(255,215,0,0.15)" : "rgba(255,255,255,0.07)", borderRadius: 5, padding: "2px 5px", textDecoration: taken ? "line-through" : "none" }}>+{tile}</div>
                );
              })}
            </div>
            {myBets > 0 && <div style={{ fontSize: 10, color: palette.gold }}>自分: {myBets}枚</div>}
            <button disabled={!nextTile} onClick={() => nextTile && onBet(camel)} style={{ padding: "5px 12px", borderRadius: 8, border: `1px solid ${nextTile ? palette.cardBorder : "rgba(255,255,255,0.08)"}`, background: nextTile ? "rgba(255,215,0,0.12)" : "transparent", color: nextTile ? "white" : "rgba(255,255,255,0.25)", cursor: nextTile ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 700 }}>
              {nextTile ? `ベット +${nextTile}` : "完売"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [screen, setScreen] = useState("lobby");
  const [playerName, setPlayerName] = useState("");
  const [myName, setMyName] = useState("");
  const [game, setGame] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpTab, setHelpTab] = useState(0);
  const gameRef = useRef(null);

  // ── Firebase リアルタイム同期 ─────────────────────────────
  useEffect(() => {
    const dbRef = ref(db, DB_KEY);
    const unsub = onValue(dbRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setGame(data);
        gameRef.current = data;
        setScreen((s) => s === "lobby" && data ? "game" : s);
      }
    });
    return () => unsub();
  }, []);

  const saveGame = async (g) => {
    gameRef.current = g;
    await set(ref(db, DB_KEY), g);
  };

  // ── Join ────────────────────────────────────────────────
  const joinGame = async () => {
    if (!playerName.trim()) return;
    const name = playerName.trim();
    setMyName(name);
    const latest = gameRef.current;
    let playerList = latest?.players || [];
    if (!playerList.includes(name)) playerList = [...playerList, name];
    let current = latest ? { ...latest, players: playerList } : initGame(playerList);
    if (!current.coins[name]) current.coins[name] = STARTING_COINS;
    await saveGame(current);
    setScreen("game");
  };

  // ── Act（最新データを取得してから更新）─────────────────────
  const act = async (fn) => {
    const snapshot = await get(ref(db, DB_KEY));
    const latest = snapshot.val() || gameRef.current;
    const newGame = fn(latest);
    newGame.turn = (newGame.turn || 0) + 1;
    await saveGame(newGame);
  };

  const handleRoll = () => act((g) => {
    const result = rollDice(g);
    if (!result) return g;
    const { camel, steps, isCrazy: crazy } = result;
    let ns = JSON.parse(JSON.stringify(g));
    ns.log.unshift(`🎲 ${CAMEL_JP[camel]}（${crazy ? "逆走" : "前進"}）に${steps}が出た！`);
    if (crazy) { ns.crazyDiceUsed = true; } else { ns.usedDice = [...(ns.usedDice || []), camel]; }
    ns = moveCamel(ns, camel, steps, crazy);
    ns.coins[myName] = (ns.coins[myName] || 0) + 1;
    if (ns.phase !== "finished") {
      const totalUsed = ns.usedDice.length + (ns.crazyDiceUsed ? 1 : 0);
      if (totalUsed >= 5) ns = scoreEndOfLeg(ns);
    }
    return ns;
  });

  const handleLegBet = (camel) => act((g) => {
    const ns = JSON.parse(JSON.stringify(g));
    if (!ns.legBets[camel]) ns.legBets[camel] = [];
    const tile = LEG_BET_TILES[ns.legBets[camel].length];
    if (!tile) return g;
    ns.legBets[camel].push({ player: myName, tile });
    ns.log.unshift(`📋 ${myName}が${CAMEL_JP[camel]}にベット（+${tile}）`);
    return ns;
  });

  const handleRaceBet = (type, camel) => act((g) => {
    const ns = JSON.parse(JSON.stringify(g));
    ns.raceBets[type].push({ player: myName, camel });
    ns.log.unshift(`🏅 ${myName}が${CAMEL_JP[camel]}の${type === "win" ? "優勝" : "最下位"}に賭けた`);
    return ns;
  });

  const resetGame = async () => {
    const players = game?.players || [myName];
    await saveGame(initGame(players));
  };

  // ── LOBBY ─────────────────────────────────────────────────
  if (screen === "lobby") {
    return (
      <div style={{ minHeight: "100vh", background: `linear-gradient(170deg, ${palette.night} 0%, #1a0d40 50%, ${palette.dusk} 100%)`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI', sans-serif", color: "white", padding: 24, gap: 32 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 60, marginBottom: 8 }}>🐪🏜️🐪</div>
          <h1 style={{ fontSize: 40, fontWeight: 900, letterSpacing: "-1px", margin: 0, background: `linear-gradient(90deg, ${palette.gold}, ${palette.accent})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>キャメルアップ</h1>
          <p style={{ color: "rgba(255,255,255,0.45)", marginTop: 8, fontSize: 13 }}>白・黒逆走ラクダ対応版 ／ 友人と同じURLを開いてプレイ！</p>
        </div>
        <div style={{ background: palette.cardBg, border: `1px solid ${palette.cardBorder}`, borderRadius: 16, padding: 28, width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 16 }}>
          <label style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>プレイヤー名</label>
          <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && joinGame()} placeholder="あなたの名前..." style={{ padding: "12px 16px", borderRadius: 10, border: `1px solid ${palette.cardBorder}`, background: "rgba(255,255,255,0.07)", color: "white", fontSize: 16, outline: "none" }} />
          <button onClick={joinGame} style={{ padding: "13px", borderRadius: 10, border: "none", background: `linear-gradient(90deg, ${palette.accent}, ${palette.darkSand})`, color: "white", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>🐪 ゲームに参加 / 開始</button>
          {game?.players?.length > 0 && <p style={{ textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.35)", margin: 0 }}>現在: {game.players.join(", ")}</p>}
        </div>
        <div style={{ background: "rgba(255,215,0,0.07)", border: "1px solid rgba(255,215,0,0.18)", borderRadius: 12, padding: "14px 20px", maxWidth: 360, fontSize: 13, color: "rgba(255,255,255,0.5)", lineHeight: 1.7, textAlign: "center" }}>
          💡 このページのURLを友人に共有するだけ！<br />同じURLから参加すれば自動で同期されます。
        </div>
      </div>
    );
  }

  if (!game) return <div style={{ color: "white", padding: 20 }}>読み込み中...</div>;

  const currentTurnPlayer = game.players[game.turn % game.players.length];
  const isMyTurn = currentTurnPlayer === myName;
  const remainingNormal = NORMAL_CAMELS.filter((c) => !(game.usedDice || []).includes(c));
  const crazyRemaining = !game.crazyDiceUsed;
  const rankedNormal = [...NORMAL_CAMELS].sort((a, b) => {
    const pa = game.positions[a] ?? 0, pb = game.positions[b] ?? 0;
    if (pa !== pb) return pb - pa;
    const sa = game.stacks[pa] || [], sb = game.stacks[pb] || [];
    return sb.indexOf(b) - sa.indexOf(a);
  });
  const playerColorMap = {};
  (game.players || []).forEach((p, i) => { playerColorMap[p] = PLAYER_COLORS[i % PLAYER_COLORS.length]; });

  const ss = { background: palette.cardBg, border: `1px solid ${palette.cardBorder}`, borderRadius: 14, padding: "16px 20px" };
  const tt = { fontSize: 10, fontWeight: 700, letterSpacing: "1.5px", color: "rgba(255,215,0,0.55)", textTransform: "uppercase", marginBottom: 12 };

  const PlayerChip = ({ player }) => {
    const col = playerColorMap[player] || PLAYER_COLORS[0];
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: col.bg, border: `1px solid ${col.border}`, borderRadius: 6, padding: "2px 7px", fontSize: 11, fontWeight: 700, color: col.text, whiteSpace: "nowrap" }}>
        {player === myName ? "★ " : ""}{player}
      </span>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(170deg, ${palette.night} 0%, #1a0d40 60%, ${palette.dusk} 100%)`, fontFamily: "'Segoe UI', sans-serif", color: "white", padding: "16px", display: "flex", flexDirection: "column", gap: 14, maxWidth: 740, margin: "0 auto" }}>

      {/* Help Modal */}
      {helpOpen && (
        <div onClick={() => setHelpOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "linear-gradient(160deg, #1a0d40 0%, #0d0820 100%)", border: "1px solid rgba(255,215,0,0.3)", borderRadius: 18, width: "100%", maxWidth: 480, maxHeight: "85vh", overflowY: "auto", padding: "24px 22px", boxShadow: "0 24px 60px rgba(0,0,0,0.7)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900, background: "linear-gradient(90deg,#FFD700,#FF6B35)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>📖 ゲームガイド</h3>
              <button onClick={() => setHelpOpen(false)} style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "4px 10px", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 16 }}>✕</button>
            </div>
            {(() => {
              const tabs = ["🎯 基本ルール", "🎲 ダイス", "📋 ベット", "🏆 得点"];
              const contents = [
                <div key="b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {[{ icon: "🐪", title: "ラクダは7頭", body: "通常ラクダ（赤・青・緑・黄・紫）が前進し、逆走ラクダ（白・黒）が後退します。" }, { icon: "📍", title: "スタック移動", body: "ラクダが別のラクダの上に着地すると、そのラクダより上の全員が一緒に移動します（ピギーバック）。" }, { icon: "🔄", title: "逆走ラクダの特殊ルール", body: "逆走ラクダが着地するとき、スタックの一番下に潜り込みます。マス1より前に出たら先頭スタックの下に入ります。" }, { icon: "🏁", title: "ゲーム終了", body: "いずれかの通常ラクダがマス16を超えた時点でレース終了。コインが最も多いプレイヤーの勝ちです。" }].map((t, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: "12px 14px" }}><span style={{ fontSize: 22, flexShrink: 0 }}>{t.icon}</span><div><div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: "rgba(255,215,0,0.9)" }}>{t.title}</div><div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.7 }}>{t.body}</div></div></div>
                  ))}
                </div>,
                <div key="d" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {[{ icon: "🎲", title: "ピラミッドを振る", body: "ターンに1回、ダイスを1つ引いてラクダを動かします。振ったプレイヤーは+1コインもらえます。" }, { icon: "🔴🔵🟢🟡🟣", title: "通常ダイス（5個）", body: "各色1個ずつ。1〜3マス前進。1レッグ中に各色1回だけ使われます。" }, { icon: "⬜⬛", title: "逆走ダイス（共通1個）", body: "白・黒ラクダで共通の1個。出目1〜3マスを逆走します。どちらが動くかはランダムです。" }, { icon: "✅", title: "レッグ終了", body: "計6個のうち5個使われるとレッグ終了（1個はピラミッドに残る）。ベット精算後リセットされます。" }].map((t, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: "12px 14px" }}><span style={{ fontSize: 20, flexShrink: 0 }}>{t.icon}</span><div><div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: "rgba(255,215,0,0.9)" }}>{t.title}</div><div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.7 }}>{t.body}</div></div></div>
                  ))}
                </div>,
                <div key="bet" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {[{ icon: "📋", title: "レッグベット", body: "このレッグの1位ラクダを予想。カードは+5・+3・+2・+2の4枚で先着順。同じ色に複数枚ベット可。" }, { icon: "🏆", title: "優勝ベット", body: "レース全体の最終1位を予想。先着順で報酬が変わります（最大+8）。外れは-1コイン。" }, { icon: "🏁", title: "最下位ベット", body: "レース全体の最終最下位を予想。優勝ベットと同じ先着順ルール。" }, { icon: "⚠️", title: "順番が大事", body: "優勝・最下位ベットは先に賭けるほど的中時の報酬が高い（8→5→3→2→1）。" }].map((t, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: "12px 14px" }}><span style={{ fontSize: 22, flexShrink: 0 }}>{t.icon}</span><div><div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: "rgba(255,215,0,0.9)" }}>{t.title}</div><div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.7 }}>{t.body}</div></div></div>
                  ))}
                </div>,
                <div key="sc" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: "rgba(255,215,0,0.9)" }}>🏆 優勝・最下位ベット（先着順）</div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: "rgba(255,255,255,0.75)" }}>
                      <thead><tr style={{ borderBottom: "1px solid rgba(255,255,255,0.15)" }}><th style={{ textAlign: "left", padding: "4px 8px", color: "rgba(255,215,0,0.7)" }}>ベット順</th><th style={{ textAlign: "center", padding: "4px 8px", color: "rgba(255,215,0,0.7)" }}>的中</th><th style={{ textAlign: "center", padding: "4px 8px", color: "rgba(255,215,0,0.7)" }}>外れ</th></tr></thead>
                      <tbody>{[["1番目", "+8", "-1"], ["2番目", "+5", "-1"], ["3番目", "+3", "-1"], ["4番目", "+2", "-1"], ["5番目以降", "+1", "-1"]].map((row, i) => (<tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: i === 0 ? "rgba(255,215,0,0.06)" : "transparent" }}>{row.map((cell, j) => (<td key={j} style={{ padding: "6px 8px", textAlign: j === 0 ? "left" : "center", color: j > 0 ? (cell.startsWith("+") ? "#7dea7d" : "#ff7d7d") : (i === 0 ? palette.gold : "inherit"), fontWeight: j > 0 || i === 0 ? 700 : 400 }}>{cell}</td>))}</tr>))}</tbody>
                    </table>
                  </div>
                  {[{ icon: "🎲", title: "ダイスを振る", body: "+1コイン（常時）" }, { icon: "🏆", title: "優勝/最下位ベット的中", body: "先着順で +8〜+1コイン" }, { icon: "❌", title: "外れ", body: "-1コイン" }].map((t, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: "10px 14px", alignItems: "center" }}><span style={{ fontSize: 20, flexShrink: 0 }}>{t.icon}</span><div style={{ flex: 1 }}><span style={{ fontWeight: 700, fontSize: 13, color: "rgba(255,215,0,0.9)" }}>{t.title}</span></div><span style={{ fontSize: 13, fontWeight: 700, color: t.body.startsWith("+") ? "#7dea7d" : t.body.startsWith("-") ? "#ff7d7d" : "white" }}>{t.body}</span></div>
                  ))}
                </div>,
              ];
              return (
                <div>
                  <div style={{ display: "flex", gap: 4, marginBottom: 16, overflowX: "auto" }}>
                    {tabs.map((label, i) => (
                      <button key={i} onClick={() => setHelpTab(i)} style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: helpTab === i ? "rgba(255,215,0,0.2)" : "rgba(255,255,255,0.06)", color: helpTab === i ? palette.gold : "rgba(255,255,255,0.5)", cursor: "pointer", fontSize: 12, fontWeight: helpTab === i ? 700 : 400, whiteSpace: "nowrap", borderBottom: helpTab === i ? `2px solid ${palette.gold}` : "2px solid transparent" }}>{label}</button>
                    ))}
                  </div>
                  {contents[helpTab]}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900, background: `linear-gradient(90deg, ${palette.gold}, ${palette.accent})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>🐪 キャメルアップ</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>👤 {myName || "観戦"}</span>
          <button onClick={() => setHelpOpen(true)} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.75)", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>❓ Tips</button>
          {game.phase === "finished" && <button onClick={resetGame} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,215,0,0.4)", background: "transparent", color: palette.gold, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>🔄 再戦</button>}
        </div>
      </div>

      {game.phase === "finished" && (
        <div style={{ background: "linear-gradient(90deg,#FFD700,#FF6B35)", borderRadius: 14, padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 44 }}>🏆</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#0D0820" }}>{CAMEL_JP[game.winner]}ラクダが優勝！</div>
        </div>
      )}

      {game.phase !== "finished" && (
        <div style={{ ...ss, padding: "12px 18px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>現在のターン</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: isMyTurn ? palette.gold : "white" }}>{isMyTurn ? "⭐ あなたのターン！" : `${currentTurnPlayer}のターン`}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 3 }}>残りダイス</div>
              <div style={{ fontSize: 18, lineHeight: 1 }}>{remainingNormal.map((c) => CAMEL_EMOJI[c]).join("")}{crazyRemaining && <span style={{ marginLeft: 4, opacity: 0.8 }}>⬜⬛</span>}</div>
            </div>
          </div>
        </div>
      )}

      <div style={ss}>
        <div style={tt}>🏜️ レーストラック</div>
        <Track stacks={game.stacks} />
        <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.35)", display: "flex", gap: 12 }}>
          <span>⬜ 白ラクダ（逆走）</span><span>⬛ 黒ラクダ（逆走）</span>
        </div>
      </div>

      <div style={ss}>
        <div style={tt}>🏅 通常ラクダ順位</div>
        <div style={{ display: "flex", gap: 10 }}>
          {rankedNormal.map((c, i) => (
            <div key={c} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: 10, color: i === 0 ? palette.gold : "rgba(255,255,255,0.4)", fontWeight: 700 }}>{i + 1}位</span>
              <span style={{ fontSize: 22 }}>{CAMEL_EMOJI[c]}</span>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{(game.positions[c] ?? 0) + 1}マス</span>
            </div>
          ))}
          <div style={{ width: 1, background: "rgba(255,255,255,0.1)", margin: "0 4px" }} />
          {CRAZY_CAMELS.map((c) => (
            <div key={c} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: 10, color: "rgba(180,180,255,0.6)", fontWeight: 700 }}>逆走</span>
              <span style={{ fontSize: 22 }}>{CAMEL_EMOJI[c]}</span>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{(game.positions[c] ?? 0) + 1}マス</span>
            </div>
          ))}
        </div>
      </div>

      {game.phase !== "finished" && isMyTurn && (
        <>
          <div style={ss}>
            <div style={tt}>🎲 ダイスを振る</div>
            <button onClick={handleRoll} style={{ width: "100%", padding: 14, borderRadius: 12, border: "none", background: `linear-gradient(90deg, ${palette.accent}, #e8534a)`, color: "white", fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 20px rgba(255,107,53,0.35)" }}>🎲 ピラミッドを振る（+1コイン）</button>
            <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.35)", textAlign: "center" }}>残りダイス 通常{remainingNormal.length}個＋{crazyRemaining ? "逆走1個" : "逆走0個"} ／ 計5個振るとレッグ終了</div>
          </div>

          <div style={ss}>
            <div style={tt}>📋 レッグベット（このレッグの1位予想）</div>
            <div style={{ marginBottom: 8, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>※ 同じ色に複数回ベット可。カードは先着順で報酬減。</div>
            <LegBetPanel state={game} currentPlayer={myName} onBet={handleLegBet} />
          </div>

          <div style={ss}>
            <div style={tt}>🏆 レースベット（総合予想）</div>
            <div style={{ marginBottom: 10, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>優勝予想（先着順 最大+8、外れ-1）</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              {NORMAL_CAMELS.map((c) => {
                const myCount = game.raceBets.win.filter((b) => b.player === myName && b.camel === c).length;
                return (
                  <button key={c} onClick={() => handleRaceBet("win", c)} style={{ padding: "8px 14px", borderRadius: 10, border: `1px solid ${myCount > 0 ? palette.gold : palette.cardBorder}`, background: myCount > 0 ? "rgba(255,215,0,0.12)" : palette.cardBg, color: "white", cursor: "pointer", fontSize: 18, position: "relative" }}>
                    {CAMEL_EMOJI[c]}
                    {myCount > 0 && <span style={{ position: "absolute", top: -5, right: -5, fontSize: 10, background: palette.gold, color: "#000", borderRadius: "50%", width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{myCount}</span>}
                  </button>
                );
              })}
            </div>
            <div style={{ marginBottom: 10, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>最下位予想（先着順 最大+8、外れ-1）</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {NORMAL_CAMELS.map((c) => {
                const myCount = game.raceBets.lose.filter((b) => b.player === myName && b.camel === c).length;
                return (
                  <button key={c} onClick={() => handleRaceBet("lose", c)} style={{ padding: "8px 14px", borderRadius: 10, border: `1px solid ${myCount > 0 ? "#ff6b6b" : palette.cardBorder}`, background: myCount > 0 ? "rgba(255,107,107,0.12)" : palette.cardBg, color: "white", cursor: "pointer", fontSize: 18, position: "relative" }}>
                    {CAMEL_EMOJI[c]}
                    {myCount > 0 && <span style={{ position: "absolute", top: -5, right: -5, fontSize: 10, background: "#ff6b6b", color: "#000", borderRadius: "50%", width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{myCount}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ベット一覧（全員） */}
      {(() => {
        const allLegBets = NORMAL_CAMELS.flatMap((camel) => (game.legBets[camel] || []).map((b, idx) => ({ ...b, camel, order: idx })));
        const allWinBets = game.raceBets.win;
        const allLoseBets = game.raceBets.lose;
        const hasAny = allLegBets.length > 0 || allWinBets.length > 0 || allLoseBets.length > 0;
        return (
          <div style={{ ...ss, border: "1px solid rgba(150,150,255,0.25)", background: "rgba(150,150,255,0.05)" }}>
            <div style={{ ...tt, color: "rgba(180,180,255,0.75)" }}>📌 ベット一覧（全員）</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {(game.players || []).map((p) => <PlayerChip key={p} player={p} />)}
            </div>
            {!hasAny ? (
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>まだ誰もベットしていません</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {allLegBets.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>📋 レッグベット</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {NORMAL_CAMELS.map((camel) => {
                        const bets = (game.legBets[camel] || []).map((b, idx) => ({ ...b, order: idx }));
                        if (bets.length === 0) return null;
                        return (
                          <div key={camel} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 18, flexShrink: 0 }}>{CAMEL_EMOJI[camel]}</span>
                            {bets.map((b, i) => { const col = playerColorMap[b.player] || PLAYER_COLORS[0]; return (<div key={i} style={{ display: "flex", alignItems: "center", gap: 4, background: col.bg, border: `1px solid ${col.border}`, borderRadius: 7, padding: "4px 9px" }}><span style={{ fontSize: 11, fontWeight: 700, color: col.text }}>{b.player === myName ? "★ " : ""}{b.player}</span><span style={{ fontSize: 12, fontWeight: 700, color: palette.gold }}>+{b.tile}</span></div>); })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {allWinBets.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>🏆 優勝ベット</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {allWinBets.map((b, i) => { const col = playerColorMap[b.player] || PLAYER_COLORS[0]; return (<div key={i} style={{ display: "flex", alignItems: "center", gap: 5, background: col.bg, border: `1px solid ${col.border}`, borderRadius: 8, padding: "5px 10px" }}><span style={{ fontSize: 17 }}>{CAMEL_EMOJI[b.camel]}</span><span style={{ fontSize: 11, fontWeight: 700, color: col.text }}>{b.player === myName ? "★ " : ""}{b.player}</span></div>); })}
                    </div>
                  </div>
                )}
                {allLoseBets.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>🏁 最下位ベット</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {allLoseBets.map((b, i) => { const col = playerColorMap[b.player] || PLAYER_COLORS[0]; return (<div key={i} style={{ display: "flex", alignItems: "center", gap: 5, background: col.bg, border: `1px solid ${col.border}`, borderRadius: 8, padding: "5px 10px" }}><span style={{ fontSize: 17 }}>{CAMEL_EMOJI[b.camel]}</span><span style={{ fontSize: 11, fontWeight: 700, color: col.text }}>{b.player === myName ? "★ " : ""}{b.player}</span></div>); })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      <div style={ss}>
        <div style={tt}>💰 コイン残高</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
          {(game.players || []).map((p) => (
            <div key={p} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <div style={{ fontSize: 12, color: p === myName ? palette.gold : "rgba(255,255,255,0.45)", fontWeight: p === myName ? 700 : 400 }}>{p}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: palette.gold }}>💰{game.coins[p] ?? 0}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={ss}>
        <div style={tt}>📜 ログ</div>
        <div style={{ maxHeight: 130, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
          {(game.log || []).slice(0, 18).map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: i === 0 ? "white" : "rgba(255,255,255,0.38)", padding: "2px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>{l}</div>
          ))}
        </div>
      </div>

      <button onClick={() => setScreen("lobby")} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: 10, color: "rgba(255,255,255,0.35)", cursor: "pointer", fontSize: 13 }}>← ロビーに戻る</button>
    </div>
  );
}
