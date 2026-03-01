import { useState, useEffect, useRef, useCallback } from "react";
import { supabase, getUserId } from "./supabase.js";

// ─── SUPABASE SYNC ────────────────────────────────────────
const UID = getUserId();
let syncQueue = {};
let syncTimer = null;

// Дебаунс: копим изменения 1.5с, потом пишем одним запросом
function scheduleSyncKey(key, value) {
  if (!supabase) return;
  syncQueue[key] = value;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const batch = syncQueue;
    syncQueue = {};
    for (const [k, v] of Object.entries(batch)) {
      await supabase.from("vital_store").upsert(
        { user_id: UID, key: k, value: v, updated_at: new Date().toISOString() },
        { onConflict: "user_id,key" }
      );
    }
  }, 1500);
}

// Загрузить все данные с Supabase при старте
export async function loadFromSupabase() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("vital_store")
      .select("key, value")
      .eq("user_id", UID);
    if (error || !data) return null;
    const result = {};
    data.forEach(row => { result[row.key] = row.value; });
    return result;
  } catch { return null; }
}

// ─── LOCAL STORAGE HOOK (с авто-синхронизацией в Supabase) ──
function useLS(key, init) {
  const [val, setVal] = useState(() => {
    try { const s = localStorage.getItem(key); return s !== null ? JSON.parse(s) : init; }
    catch { return init; }
  });
  const set = useCallback((v) => {
    setVal(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      // Синхронизируем в Supabase (не блокируем UI)
      scheduleSyncKey(key, next);
      return next;
    });
  }, [key]);
  return [val, set];
}

// ─── THEMES ─────────────────────────────────────────────
const THEMES = {
  dark:  { bg:"#09090e", surface:"#111118", hi:"#1a1a26", border:"#1e1e2e", accent:"#00e5a0", blue:"#4a9eff", purple:"#9b59ff", red:"#ff4567", orange:"#ff8c42", yellow:"#ffd700", text:"#e8e8f0", muted:"#6b6b80", dim:"#2a2a3a" },
  grey:  { bg:"#161618", surface:"#202024", hi:"#2c2c32", border:"#363642", accent:"#00e5a0", blue:"#4a9eff", purple:"#9b59ff", red:"#ff4567", orange:"#ff8c42", yellow:"#ffd700", text:"#c8c8d8", muted:"#606075", dim:"#38383e" },
  light: { bg:"#f0f0f6", surface:"#ffffff", hi:"#eaeaf4", border:"#d8d8ea", accent:"#009f6e", blue:"#2272d0", purple:"#6d28d9", red:"#d4294a", orange:"#c05a0f", yellow:"#a0780a", text:"#181828", muted:"#8080a0", dim:"#e0e0ee" },
};

// ─── SCHEDULE LOGIC (kept for macro progress reference) ──
const WTYPES = ["A1","A2","B1","B2"];
function getSchedule(startDate, restDays = 1) {
  if (!startDate) return null;
  const R = Math.max(1, parseInt(restDays) || 1);
  const CYCLE = 1 + R;
  const MICRO = CYCLE * 4;
  const start = new Date(startDate); start.setHours(0,0,0,0);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.floor((today - start) / 86400000);
  if (diff < 0) return { status:"not_started", daysUntilStart: -diff };
  const dim = diff % MICRO;
  const isTrain = (d) => d % CYCLE === 0;
  const wType  = (d) => WTYPES[Math.floor(d / CYCLE) % 4];
  const nextIn = (d) => { let n=1; while(!isTrain((d+n)%MICRO)) n++; return n; };
  const trainToday    = isTrain(dim);
  const trainTomorrow = isTrain((dim+1) % MICRO);
  const microNum      = Math.floor(diff / MICRO) + 1;
  return {
    status: trainToday ? "train" : "rest",
    todayType: wType(dim), isTrainTomorrow: trainTomorrow,
    tomorrowType: wType((dim+1)%MICRO),
    restDaysLeft: trainToday ? 0 : CYCLE - (dim % CYCLE),
    nextTrainIn: trainToday ? 0 : nextIn(dim),
    microNum, diff, restDays: R, cycleLen: CYCLE, microLen: MICRO,
  };
}

// ─── NOTIFICATIONS ────────────────────────────────────────
async function requestNotifPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  return await Notification.requestPermission();
}
function showNotif(title, body, tag) {
  if (Notification.permission !== "granted") return;
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type:"SHOW_NOTIFICATION", title, body, tag });
  } else {
    new Notification(title, { body, icon: "/icon-192.png", tag });
  }
}

// ─── SOUND ────────────────────────────────────────────────
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine"; osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.6, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.8);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 2);
  } catch(e) {}
}

// Louder alarm for pill reminders — 3 sharp beeps
function playAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.70].forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "square"; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0, ctx.currentTime + offset);
      gain.gain.linearRampToValueAtTime(0.85, ctx.currentTime + offset + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.32);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.35);
    });
  } catch(e) {}
}

// ─── INITIAL DATA ─────────────────────────────────────────
const INIT_PILLS = [
  {id:1,name:"Урсофальк 250мг",time:"20:00",dose:"1 капс.",icon:"💊",color:"#4a9eff"},
  {id:2,name:"Цинк пиколинат 22мг",time:"12:00",dose:"1 табл.",icon:"🔵",color:"#00e5a0"},
  {id:3,name:"Железо (Феррум)",time:"09:00",dose:"1 табл.",icon:"🔴",color:"#ff4567"},
  {id:4,name:"B-комплекс",time:"09:00",dose:"1 капс.",icon:"🟡",color:"#ffd700"},
];

const INIT_EXAS = [
  {id:101,name:"Жим платформы",sets:3,reps:"12-15",pair:1,role:"low",gravitron:false,sup:false},
  {id:102,name:"Рычажная тяга сидя",sets:3,reps:"12-15",pair:1,role:"high",gravitron:false,sup:false},
  {id:103,name:"Сгибание ног в тренажёре",sets:3,reps:"12-15",pair:2,role:"low",gravitron:false,sup:false},
  {id:104,name:"Тяга верхнего блока узким хватом",sets:3,reps:"12-15",pair:2,role:"high",gravitron:false,sup:false},
  {id:105,name:"Разведение ног (абдуктор)",sets:3,reps:"15-20",pair:3,role:"low",gravitron:false,sup:false},
  {id:106,name:"Гравитрон — отжимания",sets:3,reps:"10-12",pair:3,role:"high",gravitron:true,sup:false},
  {id:107,name:"Подъём на носки сидя (икры)",sets:3,reps:"15-20",pair:4,role:"low",gravitron:false,sup:false},
  {id:108,name:"Подъём гантелей над головой (плечи)",sets:3,reps:"12-15",pair:4,role:"high",gravitron:false,sup:false},
];

const INIT_EXBS = [
  {id:201,name:"Разгибание ног в тренажёре",sets:3,reps:"12-15",pair:1,role:"low",gravitron:false,sup:false},
  {id:202,name:"Гравитрон — подтягивания",sets:3,reps:"8-10",pair:1,role:"high",gravitron:true,sup:false},
  {id:203,name:"Сведение ног (аддуктор)",sets:3,reps:"15-20",pair:2,role:"low",gravitron:false,sup:false},
  {id:204,name:"Тяга блока к поясу",sets:3,reps:"12-15",pair:2,role:"high",gravitron:false,sup:false},
  {id:205,name:"Гиперэкстензия",sets:3,reps:"12-15",pair:3,role:"low",gravitron:false,sup:false},
  {id:206,name:"Жим гантелей лёжа",sets:3,reps:"12-15",pair:3,role:"high",gravitron:false,sup:false},
  {id:207,name:"Подъём на носки сидя (икры)",sets:3,reps:"15-20",pair:4,role:"low",gravitron:false,sup:false},
  {id:208,name:"Разводка гантелей в стороны",sets:3,reps:"12-15",pair:4,role:"high",gravitron:false,sup:false},
];

const HIST_8W = [
  {date:"26дек",fat:22.1,mus:72.0,weight:70.2},{date:"02янв",fat:22.0,mus:72.1,weight:70.0},
  {date:"09янв",fat:21.8,mus:72.3,weight:69.9},{date:"16янв",fat:21.7,mus:72.5,weight:69.8},
  {date:"23янв",fat:21.6,mus:72.8,weight:69.7},{date:"30янв",fat:21.5,mus:73.0,weight:69.5},
  {date:"06фев",fat:21.5,mus:73.2,weight:69.4},{date:"16фев",fat:21.5,mus:73.2,weight:69.4},
];
const INIT_MACRO = [{
  id:1, name:"Зима 2026", desc:"Силовая база — зал", weeks:8, restDays:1,
  startDate:"2026-02-17",
  micros: Array.from({length:8},(_,i)=>({id:i+1,label:`М${i+1}`,done:false,current:i===0})),
}];

// ─── SWIPE BUTTON ─────────────────────────────────────────
function SwipeButton({onComplete, T}) {
  const [pos, setPos]     = useState(0);
  const [done, setDone]   = useState(false);
  const dragging          = useRef(false);
  const startX            = useRef(0);
  const containerW        = useRef(300);
  const ref               = useRef(null);
  const KNOB = 52;

  useEffect(()=>{
    if(ref.current) containerW.current = ref.current.offsetWidth - KNOB - 8;
  },[]);

  const limit = () => containerW.current;

  const onStart = e => {
    dragging.current = true;
    startX.current = e.touches ? e.touches[0].clientX : e.clientX;
  };
  const onMove = e => {
    if (!dragging.current) return;
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const dx = Math.max(0, Math.min(cx - startX.current, limit()));
    setPos(dx);
  };
  const onEnd = () => {
    dragging.current = false;
    if (pos >= limit() * 0.8) {
      setDone(true);
      setPos(limit());
      setTimeout(() => { onComplete(); setPos(0); setDone(false); }, 400);
    } else {
      setPos(0);
    }
  };

  return (
    <div ref={ref} style={{position:"relative",background:T.hi,border:`1.5px solid ${T.accent}50`,borderRadius:14,height:52,overflow:"hidden",userSelect:"none",touchAction:"none",cursor:"grab",marginTop:13}}
      onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd}
      onMouseDown={onStart} onMouseMove={onMove} onMouseUp={onEnd} onMouseLeave={onEnd}>
      <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:T.muted,fontFamily:"Space Mono",letterSpacing:1,pointerEvents:"none",paddingLeft:KNOB+8}}>
        {done ? "✓ СОХРАНЕНО!" : "← свайп вправо — сохранить →"}
      </div>
      <div style={{position:"absolute",left:4,top:4,width:KNOB,height:KNOB-8,borderRadius:10,background:done?T.blue:T.accent,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:"#000",fontWeight:700,transform:`translateX(${pos}px)`,transition:dragging.current?"none":"transform .3s ease",flexShrink:0}}>
        {done ? "✓" : "→"}
      </div>
    </div>
  );
}

// ─── COMPONENTS ──────────────────────────────────────────
const BodyChart = ({data,T}) => {
  const W=320,H=90,P=14;
  const fats=data.map(d=>d.fat), mus=data.map(d=>d.mus);
  const all=[...fats,...mus], mn=Math.min(...all)-0.5, mx=Math.max(...all)+0.5;
  const x=(i)=>P+(i/(Math.max(data.length-1,1)))*(W-P*2);
  const y=(v)=>H-P-18-((v-mn)/(mx-mn||1))*(H-P*2-18);
  const path=(vs)=>vs.map((v,i)=>`${i===0?"M":"L"}${x(i)},${y(v)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:90}}>
      <path d={path(mus)} stroke={T.accent} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      <path d={path(fats)} stroke={T.orange} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4,3"/>
      {data.map((d,i)=><text key={i} x={x(i)} y={H-2} textAnchor="middle" fontSize="7" fill={T.muted} fontFamily="Space Mono">{d.date}</text>)}
      {mus.map((v,i)=><circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill={T.accent}/>)}
      {fats.map((v,i)=><circle key={i} cx={x(i)} cy={y(v)} r="3" fill={T.orange}/>)}
    </svg>
  );
};

// Volume line chart for analytics
const VolumeChart = ({sessions, color, T}) => {
  if (!sessions || sessions.length < 2) {
    return <div style={{fontSize:11,color:T.muted,fontFamily:"Space Mono",padding:"10px 0",textAlign:"center"}}>Нужно минимум 2 тренировки</div>;
  }
  const W=310,H=75,P=10;
  const vals = sessions.map(s=>s.volume);
  const mn = Math.max(0, Math.min(...vals)*0.88);
  const mx = Math.max(...vals)*1.12 || 1;
  const x = i => P+(i/(sessions.length-1))*(W-P*2);
  const y = v => H-P-16-((v-mn)/(mx-mn||1))*(H-P*2-16);
  const pathD = vals.map((v,i)=>`${i===0?"M":"L"}${x(i)},${y(v)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:75}}>
      <path d={pathD} stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      {vals.map((v,i)=>(
        <g key={i}>
          <circle cx={x(i)} cy={y(v)} r="3.5" fill={color}/>
          <text x={x(i)} y={y(v)-7} textAnchor="middle" fontSize="8" fill={color} fontFamily="Space Mono" fontWeight="700">{v}</text>
        </g>
      ))}
      {sessions.map((s,i)=>(
        <text key={i} x={x(i)} y={H-1} textAnchor="middle" fontSize="7" fill={T.muted} fontFamily="Space Mono">{s.date.slice(5)}</text>
      ))}
    </svg>
  );
};

const Emblem = ({ac}) => (
  <svg width="34" height="34" viewBox="0 0 36 36" fill="none">
    <circle cx="18" cy="18" r="16" stroke={ac} strokeWidth="1.5"/>
    <polygon points="18,6 22,14 30,14 24,20 26,28 18,23 10,28 12,20 6,14 14,14" stroke={ac} strokeWidth="1.2" fill="none"/>
    <circle cx="18" cy="18" r="3" fill={ac}/>
  </svg>
);

function MacroModal({macro, onClose, onSave, T}) {
  const [name,  setName]  = useState(macro?.name      || "");
  const [desc,  setDesc]  = useState(macro?.desc      || "");
  const [weeks, setWeeks] = useState(macro?.weeks     || 8);
  const [rest,  setRest]  = useState(macro?.restDays  || 1);
  const [start, setStart] = useState(macro?.startDate || new Date().toISOString().slice(0,10));

  const fi = {width:"100%",background:T.hi,border:`1px solid ${T.border}`,borderRadius:12,padding:"11px 14px",color:T.text,fontSize:14,fontFamily:"Manrope,sans-serif",outline:"none",marginBottom:10};
  const Counter = ({label,val,setVal,min=1,max=30}) => (
    <div style={{flex:1}}>
      <div style={{fontSize:10,color:T.muted,fontFamily:"Space Mono",letterSpacing:1,marginBottom:6}}>{label}</div>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <button onClick={()=>setVal(v=>Math.max(min,v-1))} style={{width:32,height:32,borderRadius:8,border:`1px solid ${T.border}`,background:T.hi,color:T.muted,fontSize:16,cursor:"pointer",flexShrink:0}}>−</button>
        <div style={{flex:1,background:T.hi,border:`1px solid ${T.border}`,borderRadius:10,padding:"7px 4px",textAlign:"center",color:T.text,fontSize:20,fontWeight:800,fontFamily:"Space Mono"}}>{val}</div>
        <button onClick={()=>setVal(v=>Math.min(max,v+1))} style={{width:32,height:32,borderRadius:8,border:`1px solid ${T.accent}30`,background:`${T.accent}10`,color:T.accent,fontSize:16,cursor:"pointer",flexShrink:0}}>+</button>
      </div>
    </div>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.84)",backdropFilter:"blur(10px)",zIndex:200,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div style={{width:"100%",maxWidth:430,margin:"0 auto",background:T.surface,borderRadius:"24px 24px 0 0",border:`1px solid ${T.border}`,padding:"24px 20px 44px"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div style={{fontSize:16,fontWeight:800,color:T.text}}>{macro?"Редактировать":"Новый макроцикл"}</div>
          <button onClick={onClose} style={{background:T.hi,border:`1px solid ${T.border}`,borderRadius:8,padding:"5px 10px",color:T.muted,cursor:"pointer",fontFamily:"Space Mono",fontSize:11}}>✕</button>
        </div>
        <input placeholder="Название (напр. Весна 2026)" value={name} onChange={e=>setName(e.target.value)} style={fi}/>
        <input placeholder="Описание (напр. Силовая база)" value={desc} onChange={e=>setDesc(e.target.value)} style={fi}/>
        <div style={{fontSize:10,color:T.muted,fontFamily:"Space Mono",letterSpacing:1,marginBottom:6}}>ДАТА НАЧАЛА</div>
        <input type="date" value={start} onChange={e=>setStart(e.target.value)} style={{...fi,marginBottom:14}}/>
        <div style={{display:"flex",gap:12,marginBottom:12}}>
          <Counter label="НЕДЕЛЬ" val={weeks} setVal={setWeeks} min={4} max={24}/>
          <Counter label="ОТДЫХ (ДНЕЙ)" val={rest} setVal={setRest} min={1} max={5}/>
        </div>
        <div style={{background:T.hi,borderRadius:12,padding:"10px 14px",marginBottom:16,fontSize:12,color:T.muted,fontFamily:"Space Mono",lineHeight:1.8}}>
          <div>📅 Паттерн: тренировка + <strong style={{color:T.accent}}>{rest} дн. отдыха</strong></div>
          <div>🔁 1 микроцикл = 4 тренировки = <strong style={{color:T.blue}}>{(1+rest)*4} дней</strong></div>
          <div>📆 Итого тренировок: <strong style={{color:T.text}}>{weeks*4}</strong> за {weeks} нед.</div>
        </div>
        <button onClick={()=>onSave({name,desc,weeks,restDays:rest,startDate:start})}
          style={{width:"100%",background:T.accent,color:"#000",border:"none",borderRadius:14,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"Manrope"}}>
          Сохранить
        </button>
      </div>
    </div>
  );
}

function NotifPanel({pills, schedule, T, onClose}) {
  const [perm, setPerm] = useState(("Notification" in window) ? Notification.permission : "unsupported");
  const [swOk, setSwOk] = useState(false);
  useEffect(()=>{
    if("serviceWorker" in navigator) navigator.serviceWorker.ready.then(()=>setSwOk(true)).catch(()=>{});
  },[]);
  const enable = async () => {
    const p = await requestNotifPermission();
    setPerm(p);
    if(p==="granted") showNotif("✅ VITAL_OS","Уведомления включены!","welcome");
  };
  const permColor = perm==="granted"?"#00e5a0":perm==="denied"?"#ff4567":"#ff8c42";
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.84)",backdropFilter:"blur(10px)",zIndex:200,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div style={{width:"100%",maxWidth:430,margin:"0 auto",background:T.surface,borderRadius:"24px 24px 0 0",border:`1px solid ${T.border}`,padding:"24px 20px 44px"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div style={{fontSize:16,fontWeight:800}}>🔔 Уведомления</div>
          <button onClick={onClose} style={{background:T.hi,border:`1px solid ${T.border}`,borderRadius:8,padding:"5px 10px",color:T.muted,cursor:"pointer",fontSize:11,fontFamily:"Space Mono"}}>✕</button>
        </div>
        <div style={{background:`${permColor}10`,border:`1px solid ${permColor}30`,borderRadius:14,padding:"12px 14px",marginBottom:14}}>
          <div style={{fontSize:12,fontWeight:700,color:permColor,marginBottom:3}}>
            {perm==="granted"?"✓ Разрешено":perm==="denied"?"✗ Заблокировано":perm==="unsupported"?"⊘ Не поддерживается":"⚠ Не настроено"}
          </div>
          <div style={{fontSize:11,color:T.muted}}>Service Worker: {swOk?"✓ активен":"⏳ инициализация"}</div>
        </div>
        {perm==="default"&&<button onClick={enable} style={{width:"100%",background:T.accent,color:"#000",border:"none",borderRadius:14,padding:13,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"Manrope",marginBottom:10}}>Включить уведомления</button>}
        {perm==="denied"&&<div style={{background:`${T.red}10`,borderRadius:12,padding:"12px 14px",marginBottom:12,fontSize:12,color:T.red}}>Заблокировано. Настройки Chrome → Настройки сайтов → Уведомления.</div>}
        {perm==="granted"&&<button onClick={()=>{showNotif("🔔 Тест VITAL_OS","Уведомления работают! 💪","test");playAlarm();}} style={{width:"100%",background:T.hi,color:T.text,border:`1px solid ${T.border}`,borderRadius:14,padding:12,fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"Manrope",marginBottom:12}}>Отправить тестовое + звук</button>}
        <div style={{fontSize:11,color:T.muted,fontFamily:"Space Mono",letterSpacing:1,marginBottom:10}}>РАСПИСАНИЕ НАПОМИНАНИЙ</div>
        <div style={{display:"flex",flexDirection:"column",gap:7}}>
          <div style={{background:T.hi,borderRadius:11,padding:"10px 13px",border:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:13,fontWeight:600}}>🏋️ День тренировки</span>
            <span style={{fontSize:12,fontFamily:"Space Mono",color:T.accent}}>08:00</span>
          </div>
          {pills.map(p=>(
            <div key={p.id} style={{background:T.hi,borderRadius:11,padding:"10px 13px",border:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:13,fontWeight:600}}>{p.icon} {p.name}</span>
              <span style={{fontSize:12,fontFamily:"Space Mono",color:T.blue}}>{p.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── EXERCISE EDIT MODAL ──────────────────────────────────

// ─── CALENDAR VIEW COMPONENT ──────────────────────────────
function CalendarView({cal, setCal, T}) {
  const [viewDate, setViewDate] = useState(() => new Date());
  const year  = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthStr = viewDate.toLocaleDateString("ru-RU",{month:"long",year:"numeric"});

  const daysInMonth = new Date(year, month+1, 0).getDate();
  const firstDow    = new Date(year, month, 1).getDay();
  // Monday-first: 0=Mon ... 6=Sun
  const startOffset = firstDow === 0 ? 6 : firstDow - 1;

  const todayStr = new Date().toISOString().slice(0,10);

  const cycleDay = (dateStr) => {
    const cur = cal[dateStr];
    if (!cur)        return setCal(c=>({...c,[dateStr]:"A"}));
    if (cur==="A")   return setCal(c=>({...c,[dateStr]:"B"}));
    if (cur==="B")   return setCal(c=>({...c,[dateStr]:"rest"}));
    return setCal(c=>{ const n={...c}; delete n[dateStr]; return n; });
  };

  const cells = [];
  for (let i=0;i<startOffset;i++) cells.push(null);
  for (let d=1;d<=daysInMonth;d++) cells.push(d);

  const colorMap = {A:T.accent, B:T.blue, rest:T.muted};

  return (
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:16,padding:"12px 10px",marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9}}>
        <button onClick={()=>setViewDate(d=>new Date(d.getFullYear(),d.getMonth()-1,1))}
          style={{background:"none",border:`1px solid ${T.border}`,borderRadius:8,width:28,height:28,color:T.muted,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>‹</button>
        <div style={{fontSize:12,fontWeight:700,textTransform:"capitalize",color:T.text}}>{monthStr}</div>
        <button onClick={()=>setViewDate(d=>new Date(d.getFullYear(),d.getMonth()+1,1))}
          style={{background:"none",border:`1px solid ${T.border}`,borderRadius:8,width:28,height:28,color:T.muted,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>›</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:4}}>
        {["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map(d=>(
          <div key={d} style={{textAlign:"center",fontSize:8,color:T.muted,fontFamily:"Space Mono",padding:"2px 0"}}>{d}</div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2}}>
        {cells.map((d,i)=>{
          if (!d) return <div key={`e${i}`}/>;
          const dateStr=`${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
          const assigned=cal[dateStr];
          const isToday=dateStr===todayStr;
          const color=assigned?colorMap[assigned]:null;
          return (
            <div key={d} onClick={()=>cycleDay(dateStr)}
              style={{
                aspectRatio:"1",borderRadius:7,display:"flex",flexDirection:"column",
                alignItems:"center",justifyContent:"center",gap:0,
                cursor:"pointer",
                border:`1.5px solid ${isToday?(color||T.accent)+"90":color?`${color}35`:T.border}`,
                background:color?`${color}14`:isToday?`${T.accent}08`:"transparent",
                transition:"all .12s",
              }}>
              <span style={{fontSize:10,fontWeight:isToday?800:500,color:color||(isToday?T.accent:T.text),lineHeight:1.1}}>{d}</span>
              {assigned&&<span style={{fontSize:7,fontFamily:"Space Mono",color,lineHeight:1,marginTop:1}}>{assigned==="rest"?"—":assigned}</span>}
            </div>
          );
        })}
      </div>
      <div style={{display:"flex",gap:10,marginTop:8,alignItems:"center"}}>
        {[["A",T.accent,"Трен. А"],["B",T.blue,"Трен. Б"],["rest",T.muted,"Отдых"]].map(([k,c,l])=>(
          <div key={k} style={{display:"flex",alignItems:"center",gap:3,fontSize:9,color:T.muted,fontFamily:"Space Mono"}}>
            <div style={{width:7,height:7,borderRadius:2,background:c,opacity:.8}}/>
            {l}
          </div>
        ))}
        <div style={{fontSize:8,color:T.dim,fontFamily:"Space Mono",marginLeft:"auto"}}>тап — назначить</div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────
export default function App() {
  const [theme,    setThemeRaw] = useLS("vital_theme",   "dark");
  const [pills,    setPills]    = useLS("vital_pills",   INIT_PILLS);
  const [done,     setDone]     = useLS("vital_done",    []);
  const [wFill,    setWFill]    = useLS("vital_wfill",   false);
  const [wDrank,   setWDrank]   = useLS("vital_wdrank",  false);
  const [exsA,     setExsA]     = useLS("vital_exsA",    INIT_EXAS);
  const [exsB,     setExsB]     = useLS("vital_exsB",    INIT_EXBS);
  const [history,  setHistory]  = useLS("vital_history2",  []);
  const [macros,   setMacros]   = useLS("vital_macros",  INIT_MACRO);
  const [compWk,   setCompWk]   = useLS("vital_compwk",  0);
  const [bodyH,    setBodyH]    = useLS("vital_body",    [{date:"16фев",fat:21.5,mus:73.2,weight:69.4}]);
  const [userName, setUserName] = useLS("vital_name",    "Евгений");
  const [userGreet,setUserGreet]= useLS("vital_greet",   "На пути к лучшей версии себя");
  const [ava,      setAva]      = useLS("vital_ava",     null);
  const [sys,      setSys]      = useLS("vital_sys",     "120");
  const [dia,      setDia]      = useLS("vital_dia",     "80");
  // Calendar: { "YYYY-MM-DD": "A" | "B" | "rest" }
  const [cal,      setCal]      = useLS("vital_cal",     {});

  const T = THEMES[theme] || THEMES.dark;
  const setTheme = t => setThemeRaw(t);

  const [scr,      setScr]      = useState("home");
  const [openEx,   setOpenEx]   = useState(null);
  const [tSec,     setTSec]     = useState(90);
  const [tVal,     setTVal]     = useState(90);
  const [tRun,     setTRun]     = useState(false);
  const [np,       setNp]       = useState({name:"",time:"",dose:"",icon:"💊"});
  const [curSets,  setCurSets]  = useState({});
  const [wkDone,   setWkDone]   = useState(false);
  const [bodyExp,  setBodyExp]  = useState(false);
  const [showMM,   setShowMM]   = useState(false);
  const [editMac,  setEditMac]  = useState(null);
  const [showNP,   setShowNP]   = useState(false);
  const [newMeas,  setNewMeas]  = useState({fat:"",mus:"",weight:""});
  const [showExEdit, setShowExEdit] = useState(false);
  const [editTarget, setEditTarget] = useState("A");
  const [newExName,  setNewExName]  = useState("");
  const [dragI,    setDragI]    = useState(null);
  const [overI,    setOverI]    = useState(null);
  // Analytics: which type to show
  const [anType,   setAnType]   = useState("A");
  // Per-exercise analytics filter
  const [anEx,     setAnEx]     = useState(null);

  const tRef    = useRef(null);
  const fRef    = useRef(null);
  const impRef  = useRef(null);
  // Track notified pill alarms to avoid double-firing
  const notifRef = useRef({set: new Set(), date: ""});

  // ── SUPABASE: загрузка при старте ─────────────────────
  useEffect(()=>{
    loadFromSupabase().then(remote => {
      if (!remote) return; // Supabase недоступен — работаем с localStorage
      const keys = [
        ["vital_theme",    setThemeRaw],
        ["vital_pills",    setPills],
        ["vital_exsA",     setExsA],
        ["vital_exsB",     setExsB],
        ["vital_history2", setHistory],
        ["vital_macros",   setMacros],
        ["vital_compwk",   setCompWk],
        ["vital_body",     setBodyH],
        ["vital_name",     setUserName],
        ["vital_greet",    setUserGreet],
        ["vital_sys",      setSys],
        ["vital_dia",      setDia],
        ["vital_cal",      setCal],
      ];
      keys.forEach(([k, setter]) => {
        if (remote[k] !== undefined) {
          // Обновляем state и localStorage из Supabase
          try { localStorage.setItem(k, JSON.stringify(remote[k])); } catch {}
          setter(remote[k]);
        }
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timer
  useEffect(()=>{
    if(tRun) tRef.current=setInterval(()=>setTVal(v=>{
      if(v<=1){clearInterval(tRef.current);setTRun(false);playBeep();return 0;}
      return v-1;
    }),1000);
    else clearInterval(tRef.current);
    return()=>clearInterval(tRef.current);
  },[tRun]);

  // Reset done daily
  useEffect(()=>{
    const today=new Date().toDateString();
    const last=localStorage.getItem("vital_done_date");
    if(last!==today){setDone([]);localStorage.setItem("vital_done_date",today);}
  },[]);

  // Service worker
  useEffect(()=>{
    if("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(()=>{});
  },[]);

  // Notification + alarm interval — checks every 30s
  useEffect(()=>{
    if(Notification.permission!=="granted") return;
    const id=setInterval(()=>{
      const now=new Date();
      const hm=`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      const todayDate=now.toDateString();
      // Reset notif tracking on new day
      if(notifRef.current.date !== todayDate){
        notifRef.current = {set: new Set(), date: todayDate};
      }
      pills.forEach(p=>{
        const key=`${p.id}-${hm}`;
        if(p.time===hm && !notifRef.current.set.has(key)){
          notifRef.current.set.add(key);
          showNotif(`💊 ${p.name}`,`Время: ${p.dose}`,`pill-${p.id}-${hm}`);
          playAlarm();
        }
      });
      const todayStr2=now.toISOString().slice(0,10);
      const calType=cal[todayStr2];
      if(hm==="08:00" && (calType==="A"||calType==="B") && !notifRef.current.set.has("wk-08:00")){
        notifRef.current.set.add("wk-08:00");
        showNotif("🏋️ Тренировка сегодня!",`Тренировка ${calType} — вперёд!`,"wk-remind");
      }
    },30000);
    return()=>clearInterval(id);
  },[pills, cal]);

  const fmt=s=>`${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
  const wp=(wFill?50:0)+(wDrank?50:0);

  // TODAY TYPE: from calendar
  const todayStr = new Date().toISOString().slice(0,10);
  const calToday = cal[todayStr]; // "A" | "B" | "rest" | undefined
  // Map calendar value to workout type label
  const todayType = calToday === "A" ? "A" : calToday === "B" ? "B" : null;
  const isTypeA = !calToday || calToday === "A";
  const activeExs = isTypeA ? exsA : exsB;
  const setActiveExs = isTypeA ? setExsA : setExsB;

  // Keep schedule for macro/microcycle progress display
  const currentMacro=macros[macros.length-1];
  const schedule=getSchedule(currentMacro?.startDate,currentMacro?.restDays);
  const macroTotal=(currentMacro?.weeks||0)*4;
  const macroProgress=macroTotal>0?Math.min(100,Math.round((compWk/macroTotal)*100)):0;
  const microNum = Math.floor(compWk / 4) + 1;

  const lastBody=bodyH[bodyH.length-1]||{fat:21.5,mus:73.2,weight:69.4};
  const prevBody=bodyH[bodyH.length-2]||lastBody;
  const dFat=(lastBody.fat-prevBody.fat).toFixed(1);
  const dMus=(lastBody.mus-prevBody.mus).toFixed(1);

  // Gravitron effective weight
  const gravEff = (name, w) => {
    if (!name?.toLowerCase().includes("гравитрон")) return null;
    const bw = parseFloat(lastBody.weight) || 70;
    const cw = parseFloat(w) || 0;
    return Math.round(bw - cw);
  };

  // History filtered by SAME workout type prefix (A or B)
  const getExHistory=(exId, wType)=>{
    const prefix = wType ? wType[0] : "A";
    const src = history.filter(h => h.type?.startsWith(prefix));
    return src.filter(h=>h.sets&&h.sets[exId]).sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,2);
  };

  const completeWorkout=()=>{
    const entry={id:`w${Date.now()}`,date:new Date().toISOString().slice(0,10),type:todayType||"A",sets:{}};
    activeExs.forEach(ex=>{if(curSets[ex.id])entry.sets[ex.id]=curSets[ex.id];});
    setHistory(h=>[entry,...h]);
    const nc=compWk+1;
    setCompWk(nc);
    if(currentMacro){
      const dc=Math.floor(nc/4);
      setMacros(ms=>ms.map(m=>m.id!==currentMacro.id?m:{...m,micros:m.micros.map((mc,i)=>({...mc,done:i<dc,current:i===dc}))}));
    }
    setWkDone(true);setCurSets({});
    setTimeout(()=>setWkDone(false),3000);
  };

  const handleSet=(exId,si,field,val)=>{
    setCurSets(prev=>{
      const ed=prev[exId]?[...prev[exId]]:Array.from({length:8},()=>({w:"",r:"",rpe:""}));
      ed[si]={...(ed[si]||{w:"",r:"",rpe:""}), [field]:val};
      return{...prev,[exId]:ed};
    });
  };

  const saveMacro=data=>{
    const mc=data.weeks;
    const micros=Array.from({length:mc},(_,i)=>({id:i+1,label:`М${i+1}`,done:false,current:i===0}));
    if(editMac) setMacros(ms=>ms.map(m=>m.id===editMac.id?{...m,...data,micros}:m));
    else setMacros(ms=>[...ms,{id:Date.now(),...data,micros}]);
    setCompWk(0);setShowMM(false);setEditMac(null);
  };

  const saveMeasure=()=>{
    if(!newMeas.fat&&!newMeas.mus&&!newMeas.weight)return;
    const today=new Date().toLocaleDateString("ru",{day:"2-digit",month:"short"}).replace(" ","");
    const last=bodyH[bodyH.length-1]||{fat:21.5,mus:73.2,weight:69.4};
    setBodyH(h=>[...h,{date:today,fat:parseFloat(newMeas.fat)||last.fat,mus:parseFloat(newMeas.mus)||last.mus,weight:parseFloat(newMeas.weight)||last.weight}]);
    setNewMeas({fat:"",mus:"",weight:""});
  };

  // ── DRAG & DROP (unchanged) ──────────────────────────────
  const onDS  = (i)    => setDragI(i);
  const onDO  = (e, i) => { e.preventDefault(); setOverI(i); };
  const onDrp = (i)    => {
    if (dragI === null || dragI === i) { setDragI(null); setOverI(null); return; }
    const a = [...activeExs];
    const [m] = a.splice(dragI, 1);
    a.splice(i, 0, m);
    setActiveExs(a);
    setDragI(null); setOverI(null);
  };

  // ── SUPERSET TOGGLE (unchanged) ─────────────────────────
  const toggleSuperset = (exId) =>
    setActiveExs(e => e.map(x => x.id === exId ? { ...x, sup: !x.sup } : x));

  // ── INLINE EDIT ──────────────────────────────────────────
  const editExs    = editTarget === "A" ? exsA : exsB;
  const setEditExs = editTarget === "A" ? setExsA : setExsB;
  const delEditEx  = (id) => setEditExs(prev => prev.filter(e => e.id !== id));
  const editSets   = (id, delta) => setEditExs(prev => prev.map(e => e.id===id?{...e,sets:Math.max(1,Math.min(8,e.sets+delta))}:e));
  const editReps   = (id, val)   => setEditExs(prev => prev.map(e => e.id===id?{...e,reps:val}:e));
  const addEditEx  = () => {
    if (!newExName.trim()) return;
    const pairs = [...new Set(editExs.map(e=>e.pair))];
    const maxPair = pairs.length > 0 ? Math.max(...pairs) : 0;
    const lastPairExs = editExs.filter(e=>e.pair===maxPair);
    const hasLow = lastPairExs.some(e=>e.role==="low");
    const hasHigh = lastPairExs.some(e=>e.role==="high");
    const pair = (!hasLow || !hasHigh) ? maxPair : maxPair + 1;
    const role = !hasLow ? "low" : "high";
    setEditExs(prev=>[...prev,{id:Date.now(),name:newExName.trim(),sets:3,reps:"12-15",pair,role,gravitron:newExName.toLowerCase().includes("гравитрон"),sup:false}]);
    setNewExName("");
  };

  // ── FULL BACKUP / RESTORE ────────────────────────────────
  const ALL_KEYS = [
    "vital_theme","vital_pills","vital_done","vital_wfill","vital_wdrank",
    "vital_exsA","vital_exsB","vital_history2","vital_macros","vital_compwk",
    "vital_body","vital_name","vital_greet","vital_ava","vital_sys","vital_dia","vital_cal"
  ];
  const exportAll = () => {
    try {
      const data = {exported: new Date().toISOString()};
      ALL_KEYS.forEach(k=>{
        try { data[k] = JSON.parse(localStorage.getItem(k)); } catch {}
      });
      const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href=url; a.download=`vitalos_backup_${todayStr}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e){}
  };
  const importAll = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);

        // ── Detect OLD format: {"exported":"...","workouts":[...]} ──
        if (data.workouts && !data.vital_history2) {
          // Normalize: A1/A2 → A,  B1/B2 → B
          const normalized = data.workouts.map(w => ({
            ...w,
            type: w.type ? w.type[0] : "A",  // "A1" → "A", "B2" → "B"
          }));
          const existing = (() => {
            try { return JSON.parse(localStorage.getItem("vital_history2")||"[]"); } catch { return []; }
          })();
          // Merge: avoid duplicates by id
          const existingIds = new Set(existing.map(h=>h.id));
          const merged = [...existing, ...normalized.filter(w=>!existingIds.has(w.id))];
          localStorage.setItem("vital_history2", JSON.stringify(merged));
          alert(`✅ Импортировано ${normalized.length} тренировок (объединено с текущими)`);
          window.location.reload();
          return;
        }

        // ── New full-backup format ──
        ALL_KEYS.forEach(k=>{
          if (data[k] !== undefined) localStorage.setItem(k, JSON.stringify(data[k]));
        });
        window.location.reload();
      } catch { alert("Ошибка: неверный формат файла"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // ── ANALYTICS COMPUTATIONS ──────────────────────────────
  const bwForVol = parseFloat(lastBody.weight) || 70;

  const calcSessionVol = (session, exsList) => {
    let total = 0;
    exsList.forEach(ex => {
      const sets = (session.sets||{})[ex.id] || [];
      sets.forEach(st => {
        const w = parseFloat(st.w)||0, r = parseFloat(st.r)||0;
        if (!r) return;
        total += ex.gravitron ? Math.max(0, bwForVol - w) * r : w * r;
      });
    });
    return Math.round(total);
  };

  const calcAvgRpe = (session) => {
    const rpes = [];
    Object.values(session.sets||{}).forEach(sets =>
      sets.forEach(st => { if (st.rpe) rpes.push(parseFloat(st.rpe)); })
    );
    if (!rpes.length) return null;
    return (rpes.reduce((a,b)=>a+b,0)/rpes.length).toFixed(1);
  };

  const getAnSessions = (type) => {
    const exsList = type === "A" ? exsA : exsB;
    return history
      .filter(h => h.type?.startsWith(type))
      .sort((a,b) => new Date(a.date)-new Date(b.date))
      .slice(-12)
      .map(h => ({
        ...h,
        volume: calcSessionVol(h, exsList),
        avgRpe: calcAvgRpe(h),
      }));
  };

  // Check plateau: last 3 sessions — no volume growth at all
  const checkPlateau = (sessions) => {
    if (sessions.length < 3) return false;
    const last3 = sessions.slice(-3).map(s=>s.volume);
    return !(last3[1] > last3[0] || last3[2] > last3[1]);
  };

  // Per-exercise volume over last sessions
  const getExVolHistory = (exId, type) => {
    const ex = (type==="A"?exsA:exsB).find(e=>e.id===exId);
    return history
      .filter(h=>h.type?.startsWith(type) && h.sets?.[exId])
      .sort((a,b)=>new Date(a.date)-new Date(b.date))
      .slice(-8)
      .map(h=>{
        const sets = h.sets[exId]||[];
        let vol = 0;
        sets.forEach(st=>{
          const w=parseFloat(st.w)||0, r=parseFloat(st.r)||0;
          vol += ex?.gravitron ? Math.max(0,bwForVol-w)*r : w*r;
        });
        return {date:h.date, volume:Math.round(vol)};
      });
  };

  const anSessions = getAnSessions(anType);
  const anPlateau  = checkPlateau(anSessions);
  const anExsList  = anType==="A" ? exsA : exsB;

  const NAVS=[
    {id:"home",    icon:"⌂", lbl:"Главная"},
    {id:"workout", icon:"◈", lbl:"Трен."},
    {id:"body",    icon:"◉", lbl:"Тело"},
    {id:"analytics",icon:"▦",lbl:"Аналит."},
    {id:"profile", icon:"◎", lbl:"Профиль"}
  ];

  // ── CSS (unchanged) ─────────────────────────────────────
  const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Manrope:wght@400;500;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
html,body,#root{height:100%;background:${T.bg};}
body{color:${T.text};font-family:'Manrope',sans-serif;min-height:100vh;overscroll-behavior:none;}
.app{max-width:430px;margin:0 auto;min-height:100vh;background:${T.bg};position:relative;}
.noise{position:fixed;inset:0;opacity:.016;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");pointer-events:none;z-index:999;}
.hdr{padding:14px 16px 0;display:flex;justify-content:space-between;align-items:center;}
.logo{font-family:'Space Mono',monospace;font-size:11px;color:${T.accent};letter-spacing:2px;cursor:pointer;}
.ava{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,${T.accent}40,${T.blue}40);border:2px solid ${T.accent}60;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;flex-shrink:0;}
.ava img{width:100%;height:100%;object-fit:cover;}
.scroll{padding:12px 16px 105px;overflow-y:auto;-webkit-overflow-scrolling:touch;}
.sec{font-size:10px;color:${T.muted};letter-spacing:2px;text-transform:uppercase;font-family:'Space Mono',monospace;margin:16px 0 8px;}
.card{background:${T.surface};border:1px solid ${T.border};border-radius:16px;padding:14px;}
.r2{display:grid;grid-template-columns:1fr 1fr;gap:9px;}
.r3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px;}
.today{background:linear-gradient(135deg,${T.accent}14,${T.blue}06);border:1px solid ${T.accent}30;border-radius:18px;padding:16px;position:relative;overflow:hidden;margin-bottom:12px;}
.today::before{content:'';position:absolute;top:-40%;right:-10%;width:130px;height:130px;background:radial-gradient(circle,${T.accent}12,transparent 70%);pointer-events:none;}
.t-badge{font-size:10px;color:${T.accent};letter-spacing:2px;font-family:'Space Mono',monospace;margin-bottom:4px;}
.t-title{font-size:21px;font-weight:800;margin-bottom:2px;}
.t-sub{font-size:11px;color:${T.muted};margin-bottom:11px;}
.go-btn{display:inline-flex;align-items:center;gap:6px;background:${T.accent};color:#000;border:none;border-radius:11px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Manrope',sans-serif;transition:all .2s;}
.go-btn:hover{transform:scale(1.02);box-shadow:0 4px 18px ${T.accent}40;}
.sc{background:${T.surface};border:1px solid ${T.border};border-radius:14px;padding:12px;}
.sc-lbl{font-size:10px;color:${T.muted};letter-spacing:1px;text-transform:uppercase;font-family:'Space Mono',monospace;margin-bottom:3px;}
.sc-val{font-size:23px;font-weight:800;font-family:'Space Mono',monospace;line-height:1;}
.sc-unit{font-size:11px;color:${T.muted};font-family:'Manrope',sans-serif;font-weight:400;}
.deltas{display:flex;gap:5px;margin-top:4px;}
.d{font-size:10px;padding:2px 6px;border-radius:20px;font-family:'Space Mono',monospace;}
.du{background:${T.accent}15;color:${T.accent};}.dd{background:${T.red}15;color:${T.red};}.de{background:${T.dim};color:${T.muted};}
.w-card{background:${T.surface};border:1px solid ${T.border};border-radius:16px;padding:13px;}
.w-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.w-bar{height:4px;background:${T.dim};border-radius:3px;margin-bottom:10px;overflow:hidden;}
.w-fill{height:100%;background:linear-gradient(90deg,${T.blue},${T.accent});border-radius:3px;transition:width .4s ease;}
.w-btns{display:flex;gap:7px;}
.w-btn{flex:1;padding:8px 6px;border-radius:10px;border:1.5px solid ${T.border};background:transparent;color:${T.muted};font-size:11px;font-weight:600;cursor:pointer;font-family:'Manrope',sans-serif;transition:all .2s;text-align:center;}
.w-btn.on{border-color:${T.blue}60;background:${T.blue}18;color:${T.blue};}
.pill-list{display:flex;flex-direction:column;gap:6px;}
.pi{border-radius:13px;border:1.5px solid ${T.border};background:${T.surface};cursor:pointer;transition:border-color .3s,background .3s;}
.pi.done{border-color:${T.accent}40;background:${T.accent}06;}
.pi-inner{padding:11px 13px;display:flex;align-items:center;gap:10px;}
.pi-ico{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;transition:transform .5s;}
.pi.done .pi-ico{transform:rotateY(360deg);}
.pi-info{flex:1;}.pi-name{font-size:13px;font-weight:600;margin-bottom:1px;}
.pi-meta{font-size:10px;color:${T.muted};font-family:'Space Mono',monospace;}
.pi-dot{width:8px;height:8px;border-radius:50%;border:1.5px solid ${T.muted};display:inline-block;transition:all .3s;}
.pi.done .pi-dot{background:${T.accent};border-color:${T.accent};box-shadow:0 0 7px ${T.accent}60;}
.pi-txt{font-size:9px;color:${T.accent};font-family:'Space Mono',monospace;margin-top:2px;opacity:0;transition:opacity .3s;}
.pi.done .pi-txt{opacity:1;}
.macro-card{background:linear-gradient(135deg,${T.blue}12,${T.purple}06);border:1px solid ${T.blue}25;border-radius:16px;padding:14px;margin-bottom:11px;}
.macro-pb{height:5px;background:${T.dim};border-radius:3px;overflow:hidden;margin:4px 0 9px;}
.macro-pf{height:100%;background:linear-gradient(90deg,${T.blue},${T.accent});border-radius:3px;transition:width .5s;}
.micro-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;}
.mc{aspect-ratio:1;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;font-size:8px;font-family:'Space Mono',monospace;border:1px solid ${T.border};background:${T.surface};}
.mc.done{background:${T.accent}15;border-color:${T.accent}40;color:${T.accent};}
.mc.cur{background:${T.blue}15;border-color:${T.blue}50;color:${T.blue};box-shadow:0 0 8px ${T.blue}20;}
.mc.fut{color:${T.dim};}
.mc .mn{font-size:11px;font-weight:700;}
.wk-hdr{background:linear-gradient(135deg,${T.accent}12,transparent);border:1px solid ${T.accent}20;border-radius:16px;padding:14px;margin-bottom:11px;}
.wk-badge{display:inline-flex;align-items:center;gap:5px;background:${T.accent}12;border:1px solid ${T.accent}28;border-radius:20px;padding:3px 10px;font-size:9px;color:${T.accent};font-family:'Space Mono',monospace;margin-bottom:7px;}
.wk-title{font-size:22px;font-weight:800;margin-bottom:2px;}
.wk-sub{font-size:11px;color:${T.muted};}
.timer{background:${T.surface};border:1px solid ${T.accent}30;border-radius:16px;padding:14px;margin-bottom:10px;text-align:center;}
.t-lbl{font-size:9px;color:${T.accent};letter-spacing:2px;font-family:'Space Mono',monospace;margin-bottom:6px;}
.t-disp{font-family:'Space Mono',monospace;font-size:46px;font-weight:700;color:${T.accent};line-height:1;margin-bottom:11px;}
.t-btns{display:flex;gap:6px;justify-content:center;}
.tbtn{padding:8px 18px;border-radius:10px;border:none;font-size:12px;font-weight:700;cursor:pointer;font-family:'Manrope',sans-serif;transition:all .2s;}
.tbtn.s{background:${T.accent};color:#000;}.tbtn.p{background:${T.red}18;color:${T.red};border:1.5px solid ${T.red}40;}
.tbtn.r{background:${T.dim};color:${T.muted};}.tbtn:hover{transform:scale(1.03);}
.presets{display:flex;gap:5px;justify-content:center;margin-top:8px;}
.pre{padding:4px 10px;border-radius:20px;border:1px solid ${T.border};background:transparent;font-size:10px;color:${T.muted};cursor:pointer;font-family:'Space Mono',monospace;transition:all .15s;}
.pre:hover,.pre.on{border-color:${T.accent}50;color:${T.accent};}
.ex-list{display:flex;flex-direction:column;gap:7px;}
.ex{background:${T.surface};border:1.5px solid ${T.border};border-radius:13px;overflow:hidden;transition:all .2s;cursor:grab;}
.ex:active{cursor:grabbing;}
.ex.low{border-left:3px solid ${T.blue}60;}
.ex.high{border-left:3px solid ${T.accent}60;}
.ex.gravitron{border-left:3px solid ${T.orange}60;}
.ex.sup{border-color:${T.orange}50;}
.ex.dragging{opacity:.4;transform:scale(.98);}
.ex.over{border-color:${T.accent}60;background:${T.accent}06;}
.ex-sup-lbl{background:${T.orange}12;border-bottom:1px solid ${T.orange}20;padding:4px 12px;font-size:9px;color:${T.orange};font-family:'Space Mono',monospace;}
.ex-hdr{padding:10px 12px;display:flex;align-items:center;gap:8px;}
.ex-grip{font-size:14px;color:${T.dim};cursor:grab;flex-shrink:0;line-height:1;}
.ex-num{width:22px;height:22px;border-radius:6px;background:${T.hi};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:${T.muted};font-family:'Space Mono',monospace;flex-shrink:0;}
.ex-name{font-size:12px;font-weight:600;flex:1;cursor:pointer;}
.ex-info{font-size:10px;color:${T.muted};font-family:'Space Mono',monospace;}
.ex-acts{display:flex;gap:4px;align-items:center;}
.ex-btn{width:24px;height:24px;border-radius:6px;border:1px solid ${T.border};background:transparent;color:${T.muted};font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;}
.ex-btn:hover,.ex-btn.on{border-color:${T.accent}50;color:${T.accent};}
.ex-btn.sup{border-color:${T.orange}50;color:${T.orange};}
.ex-sets-ctrl{display:flex;align-items:center;gap:3px;}
.ex-sets-btn{width:18px;height:18px;border-radius:4px;border:1px solid ${T.border};background:transparent;color:${T.muted};font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.ex-sets-btn:hover{border-color:${T.accent}50;color:${T.accent};}
.ex-sets-val{font-size:11px;font-weight:700;font-family:'Space Mono',monospace;color:${T.text};min-width:14px;text-align:center;}
.ex-body{padding:0 12px 12px;}
.stbl{width:100%;border-collapse:collapse;}
.stbl th{font-size:9px;color:${T.muted};letter-spacing:1px;text-transform:uppercase;padding:4px 4px;text-align:left;font-family:'Space Mono',monospace;}
.stbl td{padding:4px 3px;}
.sinp{background:${T.hi};border:1px solid ${T.border};border-radius:7px;color:${T.text};font-size:13px;font-weight:700;font-family:'Space Mono',monospace;width:48px;padding:5px 3px;text-align:center;outline:none;transition:border-color .2s;}
.sinp:focus{border-color:${T.accent}60;}
.sinp.rpe{width:34px;font-size:11px;color:${T.purple};}
.sprev{font-size:10px;color:${T.muted};font-family:'Space Mono',monospace;}
.grav-eff{font-size:10px;color:${T.orange};font-family:'Space Mono',monospace;margin-left:2px;}
.vol-chip{display:inline-block;background:${T.accent}15;color:${T.accent};border-radius:5px;padding:2px 7px;font-size:10px;font-family:'Space Mono',monospace;margin-top:6px;}
.hist-block{background:${T.hi};border-radius:10px;padding:10px 12px;margin-top:9px;border:1px solid ${T.border};}
.hist-title{font-size:9px;color:${T.blue};letter-spacing:2px;font-family:'Space Mono',monospace;text-transform:uppercase;margin-bottom:9px;}
.hist-session{margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid ${T.border};}.hist-session:last-child{margin-bottom:0;padding-bottom:0;border-bottom:none;}
.hist-session-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}
.hist-date{font-size:10px;color:${T.muted};font-family:'Space Mono',monospace;}
.hist-vol{font-size:10px;font-weight:700;font-family:'Space Mono',monospace;color:${T.accent};}
.hist-row{display:flex;align-items:center;gap:6px;padding:3px 0;}
.hist-row-num{font-size:9px;color:${T.dim};font-family:'Space Mono',monospace;width:12px;flex-shrink:0;}
.hist-row-w{font-size:12px;font-weight:700;font-family:'Space Mono',monospace;color:${T.text};min-width:36px;}
.hist-row-x{font-size:10px;color:${T.dim};}
.hist-row-r{font-size:12px;font-weight:700;font-family:'Space Mono',monospace;color:${T.text};}
.hist-row-arr{font-size:10px;color:${T.dim};margin:0 2px;}
.hist-row-vol{font-size:10px;font-family:'Space Mono',monospace;color:${T.accent};margin-left:auto;}
.bp-row{display:flex;gap:8px;margin-bottom:13px;}
.bp-w{flex:1;background:${T.surface};border:1px solid ${T.border};border-radius:10px;padding:10px 11px;}
.bp-l{font-size:9px;color:${T.muted};letter-spacing:1px;text-transform:uppercase;font-family:'Space Mono',monospace;margin-bottom:3px;}
.bp-i{background:transparent;border:none;color:${T.text};font-size:19px;font-weight:800;font-family:'Space Mono',monospace;width:100%;outline:none;}
.bm{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;}
.bc{background:${T.surface};border:1px solid ${T.border};border-radius:13px;padding:12px;}
.bc-l{font-size:9px;color:${T.muted};letter-spacing:1px;text-transform:uppercase;font-family:'Space Mono',monospace;margin-bottom:3px;}
.bc-v{font-size:22px;font-weight:800;font-family:'Space Mono',monospace;line-height:1;}
.bc-u{font-size:11px;color:${T.muted};font-family:'Manrope',sans-serif;font-weight:400;}
.bc-d{font-size:10px;margin-top:3px;}
.ratio-bar{height:16px;border-radius:8px;overflow:hidden;display:flex;margin:8px 0;}
.r-fat{background:${T.orange};transition:width .5s;}.r-mus{background:${T.accent};flex:1;}
.pm-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}
.pm-item{display:flex;align-items:center;gap:8px;background:${T.surface};border:1px solid ${T.border};border-radius:12px;padding:10px 12px;}
.pm-del{width:24px;height:24px;border-radius:6px;border:1px solid ${T.red}30;background:${T.red}10;color:${T.red};font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.add-form{background:${T.surface};border:1.5px dashed ${T.border};border-radius:13px;padding:13px;margin-top:8px;}
.add-t{font-size:10px;color:${T.muted};font-family:'Space Mono',monospace;margin-bottom:10px;letter-spacing:1px;}
.f-row{display:flex;gap:6px;margin-bottom:8px;}
.fi{flex:1;min-width:0;background:${T.hi};border:1px solid ${T.border};border-radius:8px;padding:7px 10px;color:${T.text};font-size:12px;font-family:'Manrope',sans-serif;outline:none;}
.fi:focus{border-color:${T.accent}50;}
.fi-sm{width:80px;flex:none;background:${T.hi};border:1px solid ${T.border};border-radius:8px;padding:7px 10px;color:${T.text};font-size:12px;font-family:'Manrope',sans-serif;outline:none;}
.fi-sm:focus{border-color:${T.accent}50;}
.save{width:100%;background:${T.accent};color:#000;border:none;border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Manrope',sans-serif;margin-top:12px;transition:all .2s;}
.save:hover{box-shadow:0 4px 18px ${T.accent}40;transform:scale(1.01);}
.save.sec{background:${T.hi};color:${T.text};border:1.5px solid ${T.border};}
.div{height:1px;background:${T.border};margin:14px 0;}
.th-tog{display:flex;gap:4px;background:${T.hi};border:1px solid ${T.border};border-radius:10px;padding:3px;}
.th-btn{padding:4px 11px;border-radius:7px;border:none;font-size:11px;font-weight:600;cursor:pointer;font-family:'Space Mono',monospace;transition:all .2s;color:${T.muted};background:transparent;}
.th-btn.on{background:${T.surface};color:${T.text};box-shadow:0 2px 5px rgba(0,0,0,.2);}
.nav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:${T.surface}f4;backdrop-filter:blur(20px);border-top:1px solid ${T.border};display:flex;padding:8px 4px 20px;z-index:100;}
.nb{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px 2px;border:none;background:transparent;cursor:pointer;border-radius:10px;transition:all .15s;color:${T.muted};}
.nb.act{color:${T.accent};}.nb:hover:not(.act){color:${T.text};background:${T.hi};}
.ni{font-size:18px;line-height:1;}.nl{font-size:9px;letter-spacing:.5px;text-transform:uppercase;font-family:'Space Mono',monospace;font-weight:700;}
.done-banner{background:${T.accent};color:#000;border-radius:12px;padding:12px;text-align:center;font-weight:700;font-size:13px;margin-top:10px;animation:popIn .3s ease;}
.an-seg{display:flex;gap:0;background:${T.hi};border:1px solid ${T.border};border-radius:10px;overflow:hidden;margin-bottom:12px;}
.an-seg-btn{flex:1;padding:8px;border:none;background:transparent;color:${T.muted};font-size:12px;font-weight:600;cursor:pointer;font-family:'Manrope',sans-serif;transition:all .2s;}
.an-seg-btn.on{background:${T.surface};color:${T.text};box-shadow:inset 0 0 0 1.5px ${T.accent}40;}
.plateau-warn{background:${T.orange}12;border:1px solid ${T.orange}40;border-radius:13px;padding:12px 14px;margin-bottom:12px;}
.an-ex-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid ${T.border};cursor:pointer;}
.an-ex-row:last-child{border-bottom:none;}
@keyframes popIn{from{transform:scale(.9);opacity:0;}to{transform:scale(1);opacity:1;}}
`;

  // ─── RENDER ────────────────────────────────────────────
  return(
    <>
      <style>{CSS}</style>
      <div className="app">
        <div className="noise"/>
        {/* HEADER */}
        <div className="hdr">
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            <div className="logo" onClick={()=>setScr("home")}>VITAL_OS</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            <div className="th-tog">
              {[{k:"dark",l:"◑"},{k:"grey",l:"◔"},{k:"light",l:"○"}].map(({k,l})=>(
                <button key={k} className={`th-btn ${theme===k?"on":""}`} onClick={()=>setTheme(k)} title={k}>{l}</button>
              ))}
            </div>
            <button onClick={()=>setShowNP(true)} style={{width:30,height:30,borderRadius:8,border:`1px solid ${T.border}`,background:T.hi,color:Notification.permission==="granted"?T.accent:T.muted,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>🔔</button>
            <div className="ava" onClick={()=>setScr("profile")}>
              {ava?<img src={ava} alt=""/>:<Emblem ac={T.accent}/>}
            </div>
          </div>
        </div>

        <div className="scroll">

          {/* ── HOME ── */}
          {scr==="home"&&<>
            <div style={{margin:"14px 0 12px"}}>
              <div style={{fontSize:10,color:T.muted,letterSpacing:2,fontFamily:"Space Mono",marginBottom:2}}>
                {new Date().toLocaleDateString("ru-RU",{weekday:"long",day:"numeric",month:"long"})}
              </div>
              <div style={{fontSize:22,fontWeight:800}}>Привет, <span style={{color:T.accent}}>Евгений</span> 👋</div>
              <div style={{fontSize:11,color:T.muted,marginTop:2}}>{userGreet}</div>
            </div>

            {/* Today status from calendar */}
            <div style={{
              background:calToday==="A"?`${T.accent}0a`:calToday==="B"?`${T.blue}0a`:calToday==="rest"?`${T.dim}50`:`${T.border}40`,
              border:`1px solid ${calToday==="A"?T.accent+"25":calToday==="B"?T.blue+"25":T.border}`,
              borderRadius:14,padding:"12px 14px",marginBottom:12
            }}>
              <div style={{fontSize:10,color:calToday==="A"?T.accent:calToday==="B"?T.blue:T.muted,letterSpacing:2,fontFamily:"Space Mono",marginBottom:3}}>
                {calToday==="A"?"● ТРЕНИРОВКА А":calToday==="B"?"● ТРЕНИРОВКА Б":calToday==="rest"?"● ДЕНЬ ОТДЫХА":"● НЕ НАЗНАЧЕНО"}
              </div>
              <div style={{fontSize:18,fontWeight:800,color:calToday==="A"?T.accent:calToday==="B"?T.blue:T.text}}>
                {calToday==="A"?"Тренировка А — вперёд! 💪":calToday==="B"?"Тренировка Б — вперёд! 💪":calToday==="rest"?"Восстановление 😴":"Назначь тренировку ↓"}
              </div>
              {(calToday==="A"||calToday==="B")&&(
                <button className="go-btn" style={{marginTop:9}} onClick={()=>setScr("workout")}>▶ Начать тренировку</button>
              )}
            </div>

            {/* Calendar */}
            <div className="sec">Календарь тренировок</div>
            <CalendarView cal={cal} setCal={setCal} T={T}/>

            <div className="sec">Состав тела</div>
            <div className="r2" style={{marginBottom:8}}>
              <div className="sc"><div className="sc-lbl">Вес</div><div className="sc-val">{lastBody.weight}<span className="sc-unit"> кг</span></div></div>
              <div className="sc" style={{borderColor:T.orange+"30"}}>
                <div className="sc-lbl">Жир</div>
                <div className="sc-val" style={{color:T.orange}}>{lastBody.fat}<span className="sc-unit"> %</span></div>
                <div className="deltas"><span className={`d ${parseFloat(dFat)<=0?"du":"dd"}`}>{parseFloat(dFat)<=0?"↓":"↑"}{Math.abs(dFat)}</span></div>
              </div>
            </div>
            <div className="r2">
              <div className="sc" style={{borderColor:T.accent+"30"}}>
                <div className="sc-lbl">Мышцы</div>
                <div className="sc-val" style={{color:T.accent}}>{lastBody.mus}<span className="sc-unit"> %</span></div>
                <div className="deltas"><span className={`d ${parseFloat(dMus)>=0?"du":"dd"}`}>{parseFloat(dMus)>=0?"↑":"↓"}{Math.abs(dMus)}</span></div>
              </div>
              <div className="sc"><div className="sc-lbl">Тренировок</div><div className="sc-val" style={{color:T.blue}}>{compWk}</div></div>
            </div>

            <div className="sec">Вода сегодня</div>
            <div className="w-card">
              <div className="w-top">
                <div style={{fontSize:13,fontWeight:700}}>💧 Гидратация</div>
                <div style={{fontFamily:"Space Mono",fontSize:12,color:T.blue}}>{wp}%</div>
              </div>
              <div className="w-bar"><div className="w-fill" style={{width:`${wp}%`}}/></div>
              <div className="w-btns">
                <div className={`w-btn ${wFill?"on":""}`} onClick={()=>setWFill(v=>!v)}>{wFill?"✓ Налил":"Налил бутылку"}</div>
                <div className={`w-btn ${wDrank?"on":""}`} onClick={()=>setWDrank(v=>!v)}>{wDrank?"✓ Выпил":"Выпил бутылку"}</div>
              </div>
            </div>

            <div className="sec">Таблетки сегодня</div>
            <div className="pill-list">
              {pills.map(p=>(
                <div key={p.id} className={`pi ${done.includes(p.id)?"done":""}`} onClick={()=>setDone(d=>d.includes(p.id)?d.filter(x=>x!==p.id):[...d,p.id])}>
                  <div className="pi-inner">
                    <div className="pi-ico" style={{background:p.color+"20"}}>{p.icon}</div>
                    <div className="pi-info"><div className="pi-name">{p.name}</div><div className="pi-meta">{p.time} · {p.dose}</div></div>
                    <div style={{textAlign:"right"}}><div className="pi-dot"/><div className="pi-txt">принял ✓</div></div>
                  </div>
                </div>
              ))}
            </div>
          </>}

          {/* ── WORKOUT ── */}
          {scr==="workout"&&<>
            {currentMacro&&(
              <div className="macro-card">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:9}}>
                  <div>
                    <div style={{fontSize:10,color:T.blue,letterSpacing:2,fontFamily:"Space Mono",marginBottom:2}}>МАКРОЦИКЛ</div>
                    <div style={{fontSize:16,fontWeight:800}}>{currentMacro.name}</div>
                    <div style={{fontSize:10,color:T.muted,marginTop:1}}>{currentMacro.desc} · {currentMacro.weeks} нед.</div>
                  </div>
                  <button style={{background:T.hi,border:`1px solid ${T.border}`,borderRadius:9,padding:"5px 10px",fontSize:11,color:T.muted,cursor:"pointer",fontFamily:"Space Mono"}} onClick={()=>{setEditMac(currentMacro);setShowMM(true);}}>✎</button>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:T.muted,fontFamily:"Space Mono",marginBottom:3}}>
                  <span>Прогресс макроцикла</span>
                  <span style={{color:T.blue}}>{compWk}/{macroTotal} тр. ({macroProgress}%)</span>
                </div>
                <div className="macro-pb"><div className="macro-pf" style={{width:`${macroProgress}%`}}/></div>
                <div className="micro-grid">
                  {currentMacro.micros.map((mc,i)=>{
                    const mcDone = i < Math.floor(compWk/4);
                    const mcCur  = i === Math.floor(compWk/4);
                    return (
                      <div key={mc.id} className={`mc ${mcDone?"done":mcCur?"cur":"fut"}`}>
                        <div className="mn">{mc.id}</div>
                        <div>{mc.label}</div>
                        {mcDone&&<div>✓</div>}
                        {mcCur&&<div style={{fontSize:6}}>NOW</div>}
                      </div>
                    );
                  })}
                </div>
                <button className="save sec" style={{marginTop:9,fontSize:11,padding:"8px"}} onClick={()=>{setEditMac(null);setShowMM(true);}}>
                  + Новый макроцикл
                </button>
              </div>
            )}

            <div className="wk-hdr">
              <div className="wk-badge">● МК {microNum} · {todayType||"A"}</div>
              <div className="wk-title">Тренировка {todayType||"A"}</div>
              <div className="wk-sub">{isTypeA?"Верх/Низ — 4 пары суперсетов":"Верх/Низ — 4 пары суперсетов"}</div>
              <div style={{display:"flex",gap:7,marginTop:10}}>
                <button onClick={()=>setShowExEdit(v=>!v)}
                  style={{flex:1,padding:"6px",borderRadius:8,border:`1px solid ${showExEdit?T.orange+"60":T.purple+"30"}`,background:showExEdit?`${T.orange}12`:`${T.purple}08`,color:showExEdit?T.orange:T.purple,fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"Space Mono"}}>
                  {showExEdit?"✓ Готово":"✎ Редактировать"}
                </button>
              </div>
            </div>

            <div className="timer">
              <div className="t-lbl">ТАЙМЕР ОТДЫХА</div>
              <div className="t-disp" style={{color:tVal<=10&&tVal>0?T.red:T.accent}}>{fmt(tVal)}</div>
              <div className="t-btns">
                <button className="tbtn s" onClick={()=>setTRun(true)}>▶</button>
                <button className="tbtn p" onClick={()=>setTRun(false)}>⏸</button>
                <button className="tbtn r" onClick={()=>{setTRun(false);setTVal(tSec);}}>↺</button>
              </div>
              <div className="presets">
                {[60,90,120,180].map(s=><div key={s} className={`pre ${tSec===s?"on":""}`} onClick={()=>{setTSec(s);setTVal(s);setTRun(false);}}>{s}с</div>)}
              </div>
            </div>

            {/* Exercises flat list with drag & drop — unchanged */}
            <div className="ex-list">
              {activeExs.map((ex, i)=>{
                const hist = getExHistory(ex.id, todayType||"A");
                const cs = curSets[ex.id]||[];
                const vol = cs.reduce((s,st)=>s+(parseFloat(st.w)||0)*(parseFloat(st.r)||0),0);
                const isGrav = ex.gravitron;
                const exClass = isGrav ? "gravitron" : ex.role;
                return(
                  <div key={ex.id}
                    className={`ex ${exClass} ${ex.sup?"sup":""} ${dragI===i?"dragging":""} ${overI===i?"over":""}`}
                    draggable
                    onDragStart={()=>onDS(i)}
                    onDragOver={e=>onDO(e,i)}
                    onDrop={()=>onDrp(i)}
                    onDragLeave={()=>setOverI(null)}
                  >
                    {ex.sup&&<div className="ex-sup-lbl">◎ СУПЕРСЕТ</div>}
                    <div className="ex-hdr">
                      <span className="ex-grip">⠿</span>
                      <div className="ex-num">{String(i+1).padStart(2,"0")}</div>
                      <div className="ex-name" onClick={()=>setOpenEx(openEx===ex.id?null:ex.id)}>
                        {ex.name}
                      </div>
                      <div className="ex-acts">
                        <div className="ex-sets-ctrl">
                          <button className="ex-sets-btn" onClick={()=>setActiveExs(e=>e.map(x=>x.id===ex.id?{...x,sets:Math.max(1,x.sets-1)}:x))}>−</button>
                          <span className="ex-sets-val">{ex.sets}</span>
                          <button className="ex-sets-btn" onClick={()=>setActiveExs(e=>e.map(x=>x.id===ex.id?{...x,sets:Math.min(8,x.sets+1)}:x))}>+</button>
                        </div>
                        <div className="ex-info" style={{marginLeft:4}}>×{ex.reps}</div>
                        <button className={`ex-btn ${ex.sup?"sup":""}`} onClick={()=>toggleSuperset(ex.id)} title="Суперсет">⊕</button>
                        <button className={`ex-btn ${openEx===ex.id?"on":""}`} onClick={()=>setOpenEx(openEx===ex.id?null:ex.id)}>{openEx===ex.id?"▲":"▼"}</button>
                      </div>
                    </div>
                    {isGrav&&(
                      <div style={{padding:"0 12px 6px",fontSize:10,color:T.orange,fontFamily:"Space Mono"}}>
                        Эффективный подъём = {lastBody.weight} кг (вес) − вес стека
                      </div>
                    )}
                    {openEx===ex.id&&(
                      <div className="ex-body">
                        <table className="stbl">
                          <thead>
                            <tr>
                              <th>Под.</th>
                              <th>{isGrav?"Стек кг":"Вес кг"}</th>
                              <th>Повт.</th>
                              <th>RPE</th>
                              <th>{isGrav?"Подъём":"Объём"}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Array.from({length:ex.sets}).map((_,s)=>{
                              const w=cs[s]?.w||"",r=cs[s]?.r||"",rpe=cs[s]?.rpe||"";
                              const sv=(parseFloat(w)||0)*(parseFloat(r)||0);
                              const eff=gravEff(ex.name, w);
                              return(
                                <tr key={s}>
                                  <td style={{color:T.muted,fontFamily:"Space Mono",fontSize:10}}>{s+1}</td>
                                  <td><input className="sinp" type="number" placeholder="—" value={w} onChange={e=>handleSet(ex.id,s,"w",e.target.value)}/></td>
                                  <td><input className="sinp" type="number" placeholder="—" value={r} onChange={e=>handleSet(ex.id,s,"r",e.target.value)}/></td>
                                  <td>
                                    <input className="sinp rpe" type="number" placeholder="—" min="1" max="10" value={rpe} onChange={e=>handleSet(ex.id,s,"rpe",e.target.value)}
                                      style={{borderColor:rpe>=8?T.red+"60":rpe>=6?T.orange+"60":rpe?T.accent+"50":T.border}}
                                    />
                                  </td>
                                  <td>
                                    {isGrav
                                      ? <span className="grav-eff">{w?`↑${eff}кг`:"—"}</span>
                                      : <span className="sprev" style={{color:sv>0?T.accent:T.muted}}>{sv>0?`${sv}кг`:"—"}</span>
                                    }
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {(()=>{
                          const bw=parseFloat(lastBody.weight)||70;
                          const gravVol=cs.reduce((s,st)=>s+(parseFloat(st.w)?(bw-parseFloat(st.w))*(parseFloat(st.r)||0):0),0);
                          const rpes=cs.filter(st=>st.rpe).map(st=>parseFloat(st.rpe));
                          const avgRpe=rpes.length?(rpes.reduce((a,b)=>a+b,0)/rpes.length).toFixed(1):null;
                          return <>
                            {isGrav
                              ? gravVol>0&&<div className="vol-chip" style={{background:`${T.orange}15`,color:T.orange}}>Объём: {Math.round(gravVol)} кг</div>
                              : vol>0&&<div className="vol-chip">Объём: {Math.round(vol)} кг</div>
                            }
                            {avgRpe&&<div className="vol-chip" style={{background:`${T.purple}15`,color:T.purple,marginLeft:6}}>RPE: {avgRpe}</div>}
                          </>;
                        })()}
                        <div className="hist-block">
                          <div className="hist-title">
                            📊 Прошлые <span style={{background:`${T.accent}15`,color:T.accent,borderRadius:4,padding:"0 5px",fontSize:9}}>{(todayType||"A")[0]}</span>
                          </div>
                          {hist.length===0?(
                            <div style={{fontSize:10,color:T.muted,fontFamily:"Space Mono"}}>Нет истории — сегодня первый раз! 💪</div>
                          ):hist.map((h,hi)=>{
                            const sets=h.sets[ex.id]||[];
                            const bw=parseFloat(lastBody.weight)||70;
                            const hv=isGrav
                              ? sets.reduce((s,st)=>s+(parseFloat(st.w)?(bw-parseFloat(st.w))*(parseFloat(st.r)||0):0),0)
                              : sets.reduce((s,st)=>s+(parseFloat(st.w)||0)*(parseFloat(st.r)||0),0);
                            return(
                              <div key={hi} className="hist-session">
                                <div className="hist-session-hdr">
                                  <span className="hist-date">{h.date}</span>
                                  {hv>0&&<span className="hist-vol">{Math.round(hv)} кг</span>}
                                </div>
                                {sets.filter(st=>st.w&&st.r).map((st,si)=>{
                                  const w=parseFloat(st.w)||0;
                                  const r=parseFloat(st.r)||0;
                                  const sv=isGrav?Math.round((bw-w)*r):Math.round(w*r);
                                  const dispW=isGrav?`↑${Math.round(bw-w)}`:st.w;
                                  return(
                                    <div key={si} className="hist-row">
                                      <span className="hist-row-num">{si+1}.</span>
                                      <span className="hist-row-w">{dispW}кг</span>
                                      <span className="hist-row-x">×</span>
                                      <span className="hist-row-r">{st.r} повт</span>
                                      {st.rpe&&<span style={{fontSize:9,color:T.purple,fontFamily:"Space Mono",marginLeft:4}}>RPE{st.rpe}</span>}
                                      {sv>0&&<><span className="hist-row-arr">→</span><span className="hist-row-vol">{sv}кг</span></>}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* ── INLINE EDITOR ── */}
            {showExEdit&&(
              <div style={{background:T.surface,border:`1px solid ${T.orange}30`,borderRadius:16,padding:"14px 14px 16px",marginTop:4,marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:T.orange,fontFamily:"Space Mono",letterSpacing:1}}>✎ РЕДАКТОР</div>
                  <div style={{display:"flex",gap:5}}>
                    {["A","B"].map(t=>(
                      <button key={t} onClick={()=>setEditTarget(t)}
                        style={{padding:"4px 14px",borderRadius:8,border:`1.5px solid ${editTarget===t?(t==="A"?T.accent:T.blue):T.border}`,background:editTarget===t?(t==="A"?`${T.accent}12`:`${T.blue}12`):"transparent",color:editTarget===t?(t==="A"?T.accent:T.blue):T.muted,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"Space Mono"}}>
                        {t==="A"?"Тр. А":"Тр. Б"}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:12}}>
                  {editExs.map(ex=>(
                    <div key={ex.id} style={{background:T.hi,border:`1px solid ${ex.role==="low"?T.blue+"35":T.accent+"35"}`,borderRadius:11,padding:"9px 11px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
                        <div style={{fontSize:9,background:ex.role==="low"?T.blue+"18":T.accent+"18",color:ex.role==="low"?T.blue:T.accent,borderRadius:5,padding:"2px 6px",fontFamily:"Space Mono",flexShrink:0}}>
                          {ex.role==="low"?"НИЗ":"ВЕРХ"}
                        </div>
                        <div style={{flex:1,fontSize:12,fontWeight:600,color:T.text}}>{ex.name}</div>
                        <button onClick={()=>delEditEx(ex.id)}
                          style={{width:22,height:22,borderRadius:6,border:`1px solid ${T.red}30`,background:`${T.red}10`,color:T.red,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>✕</button>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:10,color:T.muted,fontFamily:"Space Mono"}}>Подх:</span>
                        <button onClick={()=>editSets(ex.id,-1)} style={{width:22,height:22,borderRadius:5,border:`1px solid ${T.border}`,background:T.surface,color:T.muted,fontSize:13,cursor:"pointer"}}>−</button>
                        <span style={{fontSize:13,fontWeight:800,fontFamily:"Space Mono",color:T.text,minWidth:14,textAlign:"center"}}>{ex.sets}</span>
                        <button onClick={()=>editSets(ex.id,1)} style={{width:22,height:22,borderRadius:5,border:`1px solid ${T.accent}30`,background:`${T.accent}10`,color:T.accent,fontSize:13,cursor:"pointer"}}>+</button>
                        <span style={{fontSize:10,color:T.muted,fontFamily:"Space Mono",marginLeft:6}}>Повт:</span>
                        <input value={ex.reps} onChange={e=>editReps(ex.id,e.target.value)}
                          style={{width:54,background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"3px 6px",color:T.text,fontSize:11,fontFamily:"Space Mono",outline:"none"}}/>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",gap:7}}>
                  <input value={newExName} onChange={e=>setNewExName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addEditEx()}
                    placeholder="Название нового упражнения..."
                    style={{flex:1,background:T.hi,border:`1px solid ${T.border}`,borderRadius:9,padding:"8px 11px",color:T.text,fontSize:12,fontFamily:"Manrope",outline:"none"}}/>
                  <button onClick={addEditEx}
                    style={{padding:"8px 14px",borderRadius:9,border:"none",background:T.accent,color:"#000",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"Manrope",flexShrink:0}}>+</button>
                </div>
              </div>
            )}

            {wkDone
              ? <div className="done-banner">🎉 Тренировка {todayType||"A"} сохранена!</div>
              : <SwipeButton onComplete={completeWorkout} T={T}/>
            }
          </>}

          {/* ── BODY ── */}
          {scr==="body"&&<>
            <div style={{margin:"14px 0 14px"}}>
              <div style={{fontSize:10,color:T.muted,letterSpacing:2,fontFamily:"Space Mono",marginBottom:2}}>СОСТАВ ТЕЛА</div>
              <div style={{fontSize:22,fontWeight:800}}>Динамика <span style={{color:T.accent}}>показателей</span></div>
            </div>
            <div className="bm">
              {[
                {l:"Вес",v:lastBody.weight,u:"кг",vc:T.text},
                {l:"Жир",v:lastBody.fat,u:"%",vc:T.orange,d:dFat,dC:parseFloat(dFat)<=0?T.accent:T.red},
                {l:"Мышцы",v:lastBody.mus,u:"%",vc:T.accent,d:dMus,dC:parseFloat(dMus)>=0?T.accent:T.red},
                {l:"Тренировок",v:compWk,u:"",vc:T.blue}
              ].map(({l,v,u,vc,d,dC})=>(
                <div key={l} className="bc">
                  <div className="bc-l">{l}</div>
                  <div className="bc-v" style={{color:vc}}>{v}{u&&<span className="bc-u"> {u}</span>}</div>
                  {d&&<div className="bc-d" style={{color:dC||T.muted}}>{parseFloat(d)>0?"+":""}{d}</div>}
                </div>
              ))}
            </div>

            <div className="card" style={{marginBottom:9,cursor:"pointer",borderColor:bodyExp?T.accent+"40":T.border,transition:"border-color .3s"}} onClick={()=>setBodyExp(v=>!v)}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
                <div style={{fontSize:13,fontWeight:700}}>Соотношение мышцы / жир</div>
                <div style={{fontSize:10,color:T.muted,fontFamily:"Space Mono"}}>{bodyExp?"скрыть ▲":"динамика ▼"}</div>
              </div>
              <div className="ratio-bar">
                <div className="r-fat" style={{width:`${lastBody.fat}%`}}/>
                <div className="r-mus"/>
              </div>
              <div style={{display:"flex",gap:12}}>
                <div style={{fontSize:11,color:T.muted}}><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:T.orange,marginRight:4,verticalAlign:"middle"}}/>Жир {lastBody.fat}%</div>
                <div style={{fontSize:11,color:T.muted}}><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:T.accent,marginRight:4,verticalAlign:"middle"}}/>Мышцы {lastBody.mus}%</div>
              </div>
              {bodyExp&&(
                <div style={{marginTop:12}} onClick={e=>e.stopPropagation()}>
                  <div style={{height:1,background:T.border,marginBottom:10}}/>
                  <BodyChart data={bodyH.length>1?bodyH:HIST_8W} T={T}/>
                </div>
              )}
            </div>

            <div className="sec">Давление</div>
            <div className="bp-row">
              <div className="bp-w"><div className="bp-l">Систолическое</div><input className="bp-i" type="number" value={sys} onChange={e=>setSys(e.target.value)}/></div>
              <div className="bp-w"><div className="bp-l">Диастолическое</div><input className="bp-i" type="number" value={dia} onChange={e=>setDia(e.target.value)}/></div>
            </div>
            <div style={{background:T.hi,borderRadius:10,padding:"8px 12px",marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
              <div style={{fontSize:18}}>
                {sys<120&&dia<80?"💚":sys<130&&dia<85?"🟡":sys<140&&dia<90?"🟠":"🔴"}
              </div>
              <div style={{fontSize:12,color:T.muted}}>
                {sys<120&&dia<80?"Отличное давление":sys<130&&dia<85?"Нормальное":sys<140&&dia<90?"Повышенное":"Высокое — следи"}
              </div>
              <div style={{marginLeft:"auto",fontFamily:"Space Mono",fontSize:14,fontWeight:700,color:sys>=140||dia>=90?T.red:T.accent}}>{sys}/{dia}</div>
            </div>

            <div className="sec">Добавить замер</div>
            <div className="r3" style={{marginBottom:9}}>
              {[{l:"Вес (кг)",k:"weight",ph:lastBody.weight},{l:"Жир (%)",k:"fat",ph:lastBody.fat},{l:"Мышцы (%)",k:"mus",ph:lastBody.mus}].map(({l,k,ph})=>(
                <div key={l} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:"10px 11px"}}>
                  <div style={{fontSize:9,color:T.muted,letterSpacing:1,textTransform:"uppercase",fontFamily:"Space Mono",marginBottom:3}}>{l}</div>
                  <input className="bp-i" style={{fontSize:17}} type="number" placeholder={String(ph)} value={newMeas[k]||""} onChange={e=>setNewMeas(m=>({...m,[k]:e.target.value}))}/>
                </div>
              ))}
            </div>
            <button className="save" onClick={saveMeasure}>Сохранить замер</button>
          </>}

          {/* ── ANALYTICS ── */}
          {scr==="analytics"&&<>
            <div style={{margin:"14px 0 10px"}}>
              <div style={{fontSize:10,color:T.muted,letterSpacing:2,fontFamily:"Space Mono",marginBottom:2}}>АНАЛИТИКА</div>
              <div style={{fontSize:22,fontWeight:800}}>Прогресс <span style={{color:T.accent}}>тренировок</span></div>
            </div>

            {/* Segment control A / B */}
            <div className="an-seg">
              {["A","B"].map(t=>(
                <button key={t} className={`an-seg-btn ${anType===t?"on":""}`} onClick={()=>{setAnType(t);setAnEx(null);}}>
                  Тренировка {t}
                </button>
              ))}
            </div>

            {/* Plateau warning */}
            {anPlateau&&(
              <div className="plateau-warn">
                <div style={{fontSize:12,fontWeight:800,color:T.orange,marginBottom:3}}>⚠ Плато!</div>
                <div style={{fontSize:11,color:T.muted,lineHeight:1.6}}>
                  Объём тренировки <strong style={{color:T.text}}>{anType}</strong> не растёт 3 сессии подряд.
                  Попробуй сменить вес, количество повторений или паттерн нагрузки.
                </div>
              </div>
            )}

            {/* Volume trend chart */}
            <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:14,padding:"13px",marginBottom:11}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:13,fontWeight:700}}>Тоннаж — Тренировка {anType}</div>
                <div style={{fontSize:10,color:T.muted,fontFamily:"Space Mono"}}>{anSessions.length} сессий</div>
              </div>
              <VolumeChart sessions={anSessions} color={anType==="A"?T.accent:T.blue} T={T}/>
            </div>

            {/* Summary stats */}
            {anSessions.length>0&&(()=>{
              const vols = anSessions.map(s=>s.volume).filter(v=>v>0);
              const maxVol = vols.length?Math.max(...vols):0;
              const lastVol = anSessions[anSessions.length-1]?.volume||0;
              const prevVol = anSessions[anSessions.length-2]?.volume||0;
              const delta   = lastVol - prevVol;
              const rpes    = anSessions.map(s=>s.avgRpe).filter(Boolean).map(Number);
              const avgRpe  = rpes.length?(rpes.reduce((a,b)=>a+b,0)/rpes.length).toFixed(1):null;
              return (
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:7,marginBottom:11}}>
                  {[
                    {l:"Рекорд",v:`${maxVol}`,u:"кг",c:T.accent},
                    {l:"Прирост",v:delta>=0?`+${delta}`:String(delta),u:"кг",c:delta>=0?T.accent:T.red},
                    {l:"Ср. RPE",v:avgRpe||"—",u:"",c:T.purple},
                  ].map(({l,v,u,c})=>(
                    <div key={l} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:11,padding:"10px 11px"}}>
                      <div style={{fontSize:9,color:T.muted,fontFamily:"Space Mono",letterSpacing:1,marginBottom:3,textTransform:"uppercase"}}>{l}</div>
                      <div style={{fontSize:18,fontWeight:800,fontFamily:"Space Mono",color:c}}>{v}<span style={{fontSize:10,color:T.muted,fontWeight:400}}> {u}</span></div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Last sessions list */}
            <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:14,padding:"12px",marginBottom:11}}>
              <div style={{fontSize:10,color:T.muted,fontFamily:"Space Mono",letterSpacing:2,marginBottom:9}}>ПОСЛЕДНИЕ СЕССИИ</div>
              {anSessions.length===0?(
                <div style={{fontSize:11,color:T.muted,textAlign:"center",padding:"10px 0"}}>Нет данных — проведи первую тренировку!</div>
              ):[...anSessions].reverse().slice(0,6).map((s,i)=>{
                const prevS = [...anSessions].reverse()[i+1];
                const diff  = prevS ? s.volume - prevS.volume : null;
                return (
                  <div key={s.id||i} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",borderBottom:`1px solid ${T.border}`}}>
                    <div style={{fontSize:10,color:T.muted,fontFamily:"Space Mono",width:60,flexShrink:0}}>{s.date}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:700,fontFamily:"Space Mono",color:T.text}}>{s.volume} <span style={{fontSize:10,color:T.muted}}>кг</span></div>
                      {s.avgRpe&&<div style={{fontSize:9,color:T.purple,fontFamily:"Space Mono"}}>RPE {s.avgRpe}</div>}
                    </div>
                    {diff!==null&&(
                      <div style={{fontSize:10,fontFamily:"Space Mono",color:diff>=0?T.accent:T.red,fontWeight:700}}>
                        {diff>=0?"+":""}{diff}кг
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Per-exercise breakdown */}
            <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:14,padding:"12px",marginBottom:11}}>
              <div style={{fontSize:10,color:T.muted,fontFamily:"Space Mono",letterSpacing:2,marginBottom:9}}>ПРОГРЕСС ПО УПРАЖНЕНИЯМ</div>
              {anExsList.map(ex=>{
                const exHist = getExVolHistory(ex.id, anType);
                const isOpen = anEx===ex.id;
                const lastExVol = exHist[exHist.length-1]?.volume||0;
                const prevExVol = exHist[exHist.length-2]?.volume||0;
                const exDelta   = exHist.length>1 ? lastExVol-prevExVol : null;
                return (
                  <div key={ex.id} style={{borderBottom:`1px solid ${T.border}`}}>
                    <div className="an-ex-row" onClick={()=>setAnEx(isOpen?null:ex.id)}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:12,fontWeight:600}}>{ex.name}</div>
                        <div style={{fontSize:9,color:T.muted,fontFamily:"Space Mono",marginTop:1}}>{exHist.length} сессий</div>
                      </div>
                      {exDelta!==null&&(
                        <div style={{fontSize:11,fontFamily:"Space Mono",fontWeight:700,color:exDelta>=0?T.accent:T.red}}>
                          {exDelta>=0?"+":""}{exDelta}кг
                        </div>
                      )}
                      <div style={{fontSize:12,color:T.muted,marginLeft:6}}>{isOpen?"▲":"▼"}</div>
                    </div>
                    {isOpen&&exHist.length>0&&(
                      <div style={{paddingBottom:10}}>
                        <VolumeChart sessions={exHist} color={ex.role==="low"?T.blue:T.accent} T={T}/>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>}

          {/* ── PROFILE ── */}
          {scr==="profile"&&<>
            <div style={{margin:"14px 0 5px",fontSize:10,color:T.muted,letterSpacing:2,fontFamily:"Space Mono"}}>ПРОФИЛЬ</div>
            <div className="p-ava-wrap" style={{display:"flex",flexDirection:"column",alignItems:"center",marginBottom:18}}>
              <div className="ava" style={{width:80,height:80,fontSize:32,marginBottom:10,position:"relative",cursor:"pointer"}} onClick={()=>fRef.current.click()}>
                {ava?<img src={ava} alt="" style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:"50%"}}/>:<Emblem ac={T.accent}/>}
              </div>
              <input ref={fRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];if(f){const r=new FileReader();r.onload=ev=>setAva(ev.target.result);r.readAsDataURL(f);}}}/>
              <input style={{background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:11,padding:"9px 12px",color:T.text,fontSize:17,fontWeight:700,fontFamily:"Manrope",textAlign:"center",outline:"none",width:200,marginBottom:5}} value={userName} onChange={e=>setUserName(e.target.value)} placeholder="Имя"/>
              <input style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:9,padding:"7px 10px",color:T.muted,fontSize:11,fontFamily:"Manrope",textAlign:"center",outline:"none",width:260}} value={userGreet} onChange={e=>setUserGreet(e.target.value)} placeholder="Мотивирующая подпись"/>
            </div>

            <div className="sec">Тема</div>
            <div style={{display:"flex",gap:6,marginBottom:16}}>
              {[{k:"dark",l:"🌑 Тёмная"},{k:"grey",l:"🌓 Серая"},{k:"light",l:"☀️ Светлая"}].map(({k,l})=>(
                <button key={k} onClick={()=>setTheme(k)}
                  style={{flex:1,padding:"9px 4px",borderRadius:10,border:`1.5px solid ${theme===k?T.accent:T.border}`,background:theme===k?`${T.accent}15`:T.surface,color:theme===k?T.accent:T.muted,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"Manrope",transition:"all .2s"}}>
                  {l}
                </button>
              ))}
            </div>

            <div className="sec">Синхронизация</div>
            <div style={{background:T.surface,border:`1px solid ${supabase?T.accent+"30":T.border}`,borderRadius:13,padding:"12px 13px",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:supabase?T.accent:T.muted,boxShadow:supabase?`0 0 6px ${T.accent}`:undefined,flexShrink:0}}/>
                <div style={{fontSize:12,fontWeight:600}}>{supabase?"Supabase подключён":"Supabase не настроен"}</div>
              </div>
              <div style={{fontSize:10,color:T.muted,lineHeight:1.7,marginBottom:supabase?0:8}}>
                {supabase
                  ? <>Данные автоматически синхронизируются. ID устройства: <span style={{fontFamily:"Space Mono",fontSize:9,color:T.blue}}>{UID.slice(0,8)}…</span></>
                  : "Добавь VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в .env файл для включения синхронизации между устройствами."
                }
              </div>
            </div>

            <div className="sec">Резервное копирование</div>
            <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:13,padding:"12px 13px",marginBottom:10}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:4}}>💾 Полный бэкап данных</div>
              <div style={{fontSize:10,color:T.muted,marginBottom:10,lineHeight:1.7}}>
                Сохраняет всё: тренировки, историю, календарь, замеры, таблетки, настройки
              </div>
              <div style={{display:"flex",gap:7}}>
                <button onClick={exportAll}
                  style={{flex:1,padding:"9px",borderRadius:10,border:`1px solid ${T.accent}30`,background:`${T.accent}08`,color:T.accent,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"Manrope"}}>
                  ⬇ Скачать JSON
                </button>
                <button onClick={()=>impRef.current.click()}
                  style={{flex:1,padding:"9px",borderRadius:10,border:`1px solid ${T.blue}30`,background:`${T.blue}08`,color:T.blue,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"Manrope"}}>
                  ⬆ Восстановить
                </button>
                <input ref={impRef} type="file" accept=".json" style={{display:"none"}} onChange={importAll}/>
              </div>
              <div style={{marginTop:8,fontSize:10,color:T.orange}}>⚠ Восстановление перезапишет все текущие данные</div>
            </div>

            <div className="sec">История тренировок</div>
            <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:13,padding:"12px 13px",marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div>
                  <div style={{fontSize:12,fontWeight:600}}>📊 Тренировок записано</div>
                  <div style={{fontSize:11,color:T.muted,marginTop:2}}>{history.length} сессий · {compWk} завершено</div>
                </div>
                <div style={{fontSize:22,fontWeight:800,fontFamily:"Space Mono",color:T.blue}}>{history.length}</div>
              </div>
              <button onClick={()=>{if(window.confirm("Очистить всю историю тренировок?")){ setHistory([]); setCompWk(0); }}}
                style={{width:"100%",padding:"9px",borderRadius:10,border:`1px solid ${T.red}30`,background:`${T.red}08`,color:T.red,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"Manrope"}}>
                🗑 Очистить историю
              </button>
            </div>

            <div className="sec">Данные и хранение</div>
            <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:13,padding:"12px 13px",marginBottom:14,fontSize:11,color:T.muted,lineHeight:1.9}}>
              <div style={{fontWeight:700,color:T.text,marginBottom:4}}>📦 Где хранятся данные?</div>
              <div>✓ <strong style={{color:T.text}}>localStorage</strong> — прямо в браузере на устройстве</div>
              <div>✓ Тренировки, веса, замеры, таблетки, календарь</div>
              <div style={{marginTop:5,color:T.orange,fontSize:10}}>⚠ При очистке браузера удалятся! Делай бэкап.</div>
              <button onClick={()=>{if(window.confirm("Сбросить ВСЕ данные VITAL_OS? Нельзя отменить.")){ALL_KEYS.forEach(k=>localStorage.removeItem(k));window.location.reload();}}}
                style={{marginTop:9,width:"100%",padding:"8px",borderRadius:9,border:`1px solid ${T.red}30`,background:`${T.red}08`,color:T.red,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"Manrope"}}>
                🗑 Сбросить все данные
              </button>
            </div>

            <div className="sec">Уведомления</div>
            <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:13,padding:"12px 13px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:12,fontWeight:600}}>🔔 Push-уведомления</div>
                <div style={{fontSize:10,color:T.muted,marginTop:2}}>
                  {Notification.permission==="granted"?"✅ Включены · 3 звуковых сигнала":Notification.permission==="denied"?"❌ Заблокированы":"⚠ Не настроены"}
                </div>
              </div>
              <button onClick={()=>setShowNP(true)}
                style={{padding:"7px 12px",borderRadius:9,border:`1px solid ${T.blue}30`,background:`${T.blue}12`,color:T.blue,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"Manrope"}}>
                Настроить
              </button>
            </div>

            <div className="sec">Мои препараты</div>
            <div className="pm-list">
              {pills.map(p=>(
                <div key={p.id} className="pm-item">
                  <span style={{fontSize:18}}>{p.icon}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:600}}>{p.name}</div>
                    <div style={{fontSize:9,color:T.muted,fontFamily:"Space Mono"}}>{p.time} · {p.dose}</div>
                  </div>
                  <button className="pm-del" onClick={()=>setPills(ps=>ps.filter(x=>x.id!==p.id))}>✕</button>
                </div>
              ))}
            </div>
            <div className="add-form">
              <div className="add-t">+ ДОБАВИТЬ ПРЕПАРАТ</div>
              <div className="f-row">
                <input className="fi" placeholder="Название препарата" value={np.name} onChange={e=>setNp(p=>({...p,name:e.target.value}))}/>
                <input className="fi-sm" placeholder="🔵" value={np.icon} onChange={e=>setNp(p=>({...p,icon:e.target.value}))}/>
              </div>
              <div className="f-row">
                <input className="fi" placeholder="Время (20:00)" value={np.time} onChange={e=>setNp(p=>({...p,time:e.target.value}))}/>
                <input className="fi" placeholder="Доза (1 капс.)" value={np.dose} onChange={e=>setNp(p=>({...p,dose:e.target.value}))}/>
              </div>
              <button className="save" onClick={()=>{if(!np.name||!np.time)return;setPills(ps=>[...ps,{...np,id:Date.now(),color:T.purple}]);setNp({name:"",time:"",dose:"",icon:"💊"});}}>Добавить</button>
            </div>
            <div className="div"/>
            <div className="sec">Мои данные</div>
            <div className="card" style={{marginBottom:8}}>
              <div style={{fontSize:11,color:T.muted,lineHeight:1.9}}>
                <div>👤 <strong style={{color:T.text}}>{userName}</strong>, 40 лет, 168 см, {lastBody.weight} кг</div>
                <div>🩺 Хр. простатит, гастрит (ремиссия), H. pylori (пролечен)</div>
                <div>💊 Урсофальк, Железо, Цинк, B-комплекс</div>
                <div>🔬 Тест. 14.21 нмоль/л · Ферритин 23 нг/мл · HbA1c 5.5%</div>
                <div>🏋️ Full Body A/B · {currentMacro?.name} · МК {microNum}</div>
                <div>🫀 Давление {sys}/{dia} мм.рт.ст.</div>
              </div>
            </div>
          </>}

        </div>

        {showMM&&<MacroModal macro={editMac} onClose={()=>{setShowMM(false);setEditMac(null);}} onSave={saveMacro} T={T}/>}
        {showNP&&<NotifPanel pills={pills} schedule={schedule} T={T} onClose={()=>setShowNP(false)}/>}

        <div className="nav">
          {NAVS.map(({id,icon,lbl})=>(
            <button key={id} className={`nb ${scr===id?"act":""}`} onClick={()=>setScr(id)}>
              <span className="ni">{icon}</span>
              <span className="nl">{lbl}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
