
const R=window.RUN, END=R.frames[R.frames.length-1][0]+1.5;
const PH=[[0,'Glance','One number that matters: distance to liquidation, with side, leverage, PnL.'],
 [14,'Price shock','A labelled SIM shock of −7% over 10 s, applied to live testnet prices.'],
 [29,'Alert','Under 10% away, the alert takes over. Highlighted fix: add 720 margin, solved from Binance’s isolated-margin formula.'],
 [34.6,'Confirm','The card shows the exact effect: liq 54,280 → 50,665, 3.7% → 10.1% away. Valid 30 s. Press = yes, swipe = no.'],
 [38.7,'Done','ADDED 720 USDT margin (simulated). Liquidation is 10.1% away again.'],
 [44.3,'Alert set','Back to the glance; one press set a price alert at 53,500.'],
 [47.3,'Voice','Hold to speak. This simulator had no microphone, so the run continued on the press path.'],
 [66,'Reduce half','The reduce card is honest: halves the loss at liquidation, hardly moves the liquidation price. The recording ends on this card’s countdown; it was not confirmed.']];
const $=s=>document.getElementById(s), fmt=n=>Math.round(n).toLocaleString('en-US');
let t=0, playing=false, speed=1.5, last=0;
const imgs=R.frames.map(([,f])=>{const i=new Image();i.src='frames/'+f;return i});
function at(x){const S=R.states;let i=0;while(i<S.length-2&&S[i+1][0]<x)i++;const a=S[i],b=S[i+1],q=Math.min(1,Math.max(0,(x-a[0])/(b[0]-a[0]||1)));return a.map((v,k)=>k===0?x:k===2?(q<1?v:b[k]):v+(b[k]-v)*q)}
function draw(){
  let fi=0;R.frames.forEach(([ft],i)=>{if(ft<=t)fi=i});
  const src='frames/'+R.frames[fi][1];if(!$('gimg').src.endsWith(src))$('gimg').src=src;
  $('rt').textContent=t.toFixed(1);
  const [,mark,liq,dist,pnl]=at(t);
  const P0=49000,P1=63000,X=v=>Math.min(100,Math.max(0,(v-P0)/(P1-P0)*100))+'%';
  $('liq').style.left=X(liq);$('liqL').style.left=X(liq);$('liqL').textContent='liq '+fmt(liq);
  $('zone').style.left=X(liq);$('zone').style.width=`calc(${X(liq/0.9)} - ${X(liq)})`;
  $('entry').style.left=X(61786);$('entryL').style.left=X(61786);$('mark').style.left=X(mark);
  const col=dist<.05?'var(--bad)':dist<.1?'var(--warn)':'var(--g)';
  $('mark').style.background=col;$('dist').style.color=col;$('dist').textContent=(dist*100).toFixed(1)+'% '+(dist<.05?'· under 5%':dist<.1?'· under 10%':'· safe');
  $('ml').textContent=fmt(mark)+' · '+fmt(liq);$('pnl').textContent=(pnl<0?'−$':'+$')+fmt(Math.abs(pnl));
  let p=PH[0];for(const x of PH)if(t>=x[0])p=x;$('ph').textContent=p[1];$('phs').textContent=p[2];
  [...$('chaps').children].forEach((b,i)=>b.setAttribute('aria-pressed',PH[i]===p));
  const ev=R.events.find(([et])=>t>=et&&t<et+1.2);$('press').classList.toggle('on',!!ev);$('press').textContent=ev?ev[1].replace('_',' '):'press';
  $('scrub').value=Math.round(t/END*1000);
  const m=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');$('tc').textContent=m(t/speed)+' / '+m(END/speed);
}
function loop(now){if(!playing)return;t+=(now-last)/1000*speed;last=now;if(t>=END){t=END;setPlay(false)}draw();requestAnimationFrame(loop)}
function setPlay(on){playing=on;$('play').textContent=on?'❚❚ Pause':'▶ Play';$('play').setAttribute('aria-label',on?'Pause':'Play');if(on){if(t>=END)t=0;last=performance.now();requestAnimationFrame(loop)}}
$('play').onclick=()=>setPlay(!playing);
$('scrub').oninput=e=>{t=e.target.value/1000*END;draw()};
$('spd').onclick=()=>{speed=speed===1.5?1:speed===1?2:1.5;$('spd').textContent=speed+'×';draw()};
PH.forEach(([pt,name])=>{const b=document.createElement('button');b.textContent=name;b.onclick=()=>{t=pt;draw()};$('chaps').appendChild(b)});
addEventListener('keydown',e=>{if(e.code==='Space'&&e.target.tagName!=='BUTTON'){e.preventDefault();setPlay(!playing)}});
draw();
