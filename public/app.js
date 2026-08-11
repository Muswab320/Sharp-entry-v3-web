const $ = id => document.getElementById(id);
let latestChart = [];

const fmt = n => Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—';
const timeFmt = iso => iso ? new Date(iso).toLocaleString() : '—';

function toast(msg, error=false){
  const t=$('toast');t.textContent=msg;t.className='toast show'+(error?' error':'');
  clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.className='toast',3000);
}

function setSignalClass(el, signal){
  el.className='signal-badge '+String(signal||'WAIT').toLowerCase();
}

function drawChart(points){
  const canvas=$('chart');
  const rect=canvas.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  canvas.width=Math.max(1,rect.width*dpr);canvas.height=Math.max(1,120*dpr);
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const w=rect.width,h=120;ctx.clearRect(0,0,w,h);
  if(!points||points.length<2)return;
  const vals=points.map(p=>Number(p.close));
  const min=Math.min(...vals),max=Math.max(...vals),range=max-min||1;
  ctx.beginPath();
  vals.forEach((v,i)=>{const x=i/(vals.length-1)*w;const y=h-10-((v-min)/range)*(h-20);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});
  const grad=ctx.createLinearGradient(0,0,w,0);grad.addColorStop(0,'#44e3a1');grad.addColorStop(1,'#6cd8e8');
  ctx.strokeStyle=grad;ctx.lineWidth=2;ctx.stroke();
}

function renderSignal(s){
  if(!s)return;
  $('signalBadge').textContent=s.signal;setSignalClass($('signalBadge'),s.signal);
  $('price').textContent=fmt(s.entry);$('marketTime').textContent='Last candle: '+(s.candleTime||'—');
  $('trend').textContent=s.trend||'—';$('structure').textContent=s.structure||'—';$('confidence').textContent=(s.confidence??'—')+'%';
  $('entry').textContent=fmt(s.entry);$('sl').textContent=fmt(s.sl);$('tp1').textContent=fmt(s.tp1);$('tp2').textContent=fmt(s.tp2);$('tp3').textContent=fmt(s.tp3);$('rsi').textContent=fmt(s.rsi);
  const reasons=$('reasons');reasons.innerHTML='';
  (s.reasons||[]).forEach(r=>{const d=document.createElement('div');d.className='reason';d.textContent=r;reasons.appendChild(d)});
  if(!(s.reasons||[]).length)reasons.innerHTML='<div class="empty">No strong confirmation yet.</div>';
  latestChart=s.chart||[];drawChart(latestChart);
}

async function refreshStatus(){
  try{
    const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();
    const pill=$('serverPill');pill.className='status-pill good';pill.querySelector('span').textContent=d.scanning?'Scanning':'Scanner Online';
    $('scanStatus').textContent=d.scanning?'Scanning now…':`Every ${d.config.intervalMinutes} min`;
    $('intervalText').textContent=`Every ${d.config.intervalMinutes} minutes`;
    $('apiStatus').textContent=d.config.marketApiConfigured?'Connected':'Needs key';$('apiStatus').className='mini-pill '+(d.config.marketApiConfigured?'good':'bad');
    $('telegramStatus').textContent=d.config.telegramConfigured?'Connected':'Needs setup';$('telegramStatus').className='mini-pill '+(d.config.telegramConfigured?'good':'bad');
    if(d.signal)renderSignal(d.signal); else if(d.market?.price)$('price').textContent=fmt(d.market.price);
    if(d.lastError){pill.className='status-pill bad';pill.querySelector('span').textContent='Needs attention';}
  }catch(e){const pill=$('serverPill');pill.className='status-pill bad';pill.querySelector('span').textContent='Offline';}
}

async function loadHistory(){
  try{
    const r=await fetch('/api/history',{cache:'no-store'});const d=await r.json();const list=$('historyList');list.innerHTML='';
    $('historyCount').textContent=`${d.history.length} saved`;
    if(!d.history.length){list.innerHTML='<div class="empty">No signals recorded yet.</div>';return;}
    d.history.forEach(s=>{
      const el=document.createElement('div');el.className='history-item';
      el.innerHTML=`<div class="history-top"><span class="history-signal ${String(s.signal).toLowerCase()}">${s.signal} · ${s.confidence}%</span><strong>${fmt(s.entry)}</strong></div><div class="history-meta">${s.candleTime||timeFmt(s.scannedAt)} · SL ${fmt(s.sl)} · TP3 ${fmt(s.tp3)}</div>`;
      list.appendChild(el);
    });
  }catch(e){toast('Could not load history',true)}
}

$('scanBtn').addEventListener('click',async()=>{
  const b=$('scanBtn');b.disabled=true;b.textContent='Scanning H1 · M15 · M5…';
  try{const r=await fetch('/api/scan',{method:'POST'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Scan failed');renderSignal(d.result);toast(`${d.result.signal} · ${d.result.confidence}% confidence`);loadHistory();}
  catch(e){toast(e.message,true)}finally{b.disabled=false;b.textContent='Scan Gold Now';refreshStatus();}
});

$('telegramTestBtn').addEventListener('click',async()=>{
  const b=$('telegramTestBtn');b.disabled=true;b.textContent='Sending…';
  try{const r=await fetch('/api/telegram/test',{method:'POST'});const d=await r.json();if(!r.ok)throw new Error(d.error||d.reason||'Telegram test failed');toast('Telegram test sent');}
  catch(e){toast(e.message,true)}finally{b.disabled=false;b.textContent='Send Telegram Test';}
});

document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active');$(btn.dataset.page).classList.add('active');if(btn.dataset.page==='history')loadHistory();
}));

window.addEventListener('resize',()=>drawChart(latestChart));
refreshStatus();loadHistory();setInterval(refreshStatus,15000);
