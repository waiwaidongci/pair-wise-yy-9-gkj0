// 页面层：只负责展示与交互。数据来自 /api/state，动作用 fetch 调接口。
export const pageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>古法蓝晒 · 转手链整理室</title>
<style>
  :root{--bg:#f1f3ef;--panel:#fff;--ink:#20241f;--muted:#687066;--line:#d4ddd0;--accent:#526f43;--accent-d:#3f5734;--warn:#9b4937;--warn-bg:#f7e7e2;--ok:#3f6b4a;--ok-bg:#e6f1e8;--gold:#8a6d2f;--gold-bg:#f6eedc;}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif}
  header{padding:18px 24px;background:#fff;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}
  h1{margin:0;font-size:22px}h2{margin:0 0 10px;font-size:16px}h3{margin:0;font-size:15px}
  main{display:grid;grid-template-columns:360px 1fr;gap:18px;padding:18px 24px}
  .panel,.card,.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
  label{display:block;margin:9px 0 4px;color:var(--muted);font-size:12px}input,select{width:100%;border:1px solid var(--line);border-radius:6px;padding:8px;font:inherit;background:#fff}
  button{border:0;border-radius:6px;background:var(--accent);color:#fff;padding:8px 11px;font-weight:700;cursor:pointer;font-size:13px}button:hover{background:var(--accent-d)}
  button.secondary{background:#69736a}button.danger{background:var(--warn)}button:disabled{opacity:.45;cursor:not-allowed}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:9px;margin-bottom:14px}.stat strong{display:block;font-size:22px}.stat span{font-size:12px;color:var(--muted)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
  .card{display:grid;gap:7px;border-left:4px solid var(--line)}.card.invalid{border-left-color:var(--warn);background:var(--warn-bg)}
  .card.done{border-left-color:var(--ok)}.card.requeue{border-left-color:var(--gold)}
  .row{display:flex;justify-content:space-between;gap:8px;align-items:center}.meta{color:var(--muted);font-size:12px}
  .pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:11px;background:#fff}
  .pill.hold{background:var(--ok-bg);border-color:var(--ok);color:var(--ok)}.pill.expired{background:var(--gold-bg);border-color:var(--gold);color:var(--gold)}
  .pill.invalid{background:var(--warn-bg);border-color:var(--warn);color:var(--warn)}
  .holder{font-weight:700}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
  .reason{font-size:12px;color:var(--warn);font-weight:700}.ok-reason{font-size:12px;color:var(--ok);font-weight:700}
  .chain{border-top:1px dashed var(--line);padding-top:7px;margin-top:3px;display:grid;gap:3px;max-height:120px;overflow:auto}
  .chain div{font-size:11px;color:var(--muted)}.chain b{color:var(--ink)}
  .btns{display:flex;gap:6px;flex-wrap:wrap}.btns button{padding:6px 9px;font-size:12px}
  .timeline{display:grid;gap:6px;max-height:340px;overflow:auto}.ev{font-size:12px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff}
  .ev .t{color:var(--muted)}.ev .ty{font-weight:700}
  .twocol{display:grid;grid-template-columns:1fr 1fr;gap:14px}.list{display:grid;gap:6px}
  .flash{animation:flash 1.2s}@keyframes flash{0%{background:#fff8c9}100%{background:transparent}}
  .faultbox{background:var(--gold-bg);border:1px solid var(--gold);border-radius:8px;padding:10px;font-size:12px}
  .retry-ok{color:var(--ok);font-weight:700}.retry-fail{color:var(--warn);font-weight:700}
  @media(max-width:980px){main{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div><h1>古法蓝晒 · 转手链整理室</h1><div class="meta">玻璃板 → 工艺检查点 → 入盒批次：一板一工位，租约持有，过期从最近检查点续做；药液批次更新自动失效重排；写盘失败按检查点重试，不重复消耗、不留下占用无记录。</div></div>
  <div class="btns"><button id="reload" class="secondary">刷新</button></div>
</header>
<main>
  <section>
    <div class="panel" style="margin-bottom:14px">
      <h2>建档 / 操作</h2>
      <form id="createForm">
        <label>玻璃板编号（留空自动）</label><input name="code" placeholder="如 CN-002">
        <label>玻璃板尺寸</label><input name="plateSize" placeholder="如 18x24cm">
        <label>曝光时间</label><input name="exposure" placeholder="如 8分钟">
        <label>冲洗水源</label><input name="waterSource" placeholder="如 井水过滤">
        <label>盒位</label><input name="box" placeholder="如 蓝盒A-03">
        <button style="margin-top:10px">建立玻璃板</button>
      </form>
    </div>

    <div class="panel" style="margin-bottom:14px">
      <h2>药液批次（更新即失效重排）</h2>
      <form id="batchForm">
        <label>新药液批次编号</label><input name="code" placeholder="如 B-0715" required>
        <label>备注</label><input name="note" placeholder="如 夏至新配液">
        <button style="margin-top:10px" class="danger">更新批次并失效旧结论</button>
      </form>
      <div class="list" id="batches" style="margin-top:10px"></div>
    </div>

    <div class="faultbox">
      <h2 style="font-size:13px">写盘故障注入（演示重试）</h2>
      <div class="meta" style="margin-bottom:6px">让存储层接下来 N 次写盘失败，观察按检查点重试。</div>
      <form id="faultForm" style="display:flex;gap:6px;align-items:center">
        <input name="writeFailures" type="number" min="0" value="2" style="width:80px">
        <button>注入 N 次失败</button>
      </form>
      <div class="meta" id="faultNow" style="margin-top:6px"></div>
    </div>
  </section>

  <section>
    <div class="stats" id="stats"></div>
    <div class="twocol" style="margin-bottom:14px">
      <div class="panel"><h2>工位持有</h2><div class="list" id="stations"></div></div>
      <div class="panel"><h2>入盒批次</h2><div class="list" id="boxBatches"></div></div>
    </div>
    <div class="panel" style="margin-bottom:14px">
      <h2>玻璃板（持有人 / 失效原因 / 重试结果）</h2>
      <div class="grid" id="plates"></div>
    </div>
    <div class="panel" style="margin-bottom:14px">
      <h2>重试结果（写盘失败 → 按检查点重试）</h2>
      <div class="timeline" id="telemetry"></div>
    </div>
    <div class="panel">
      <h2>转手链（持有 / 检查点 / 失效 / 重排 / 入盒）</h2>
      <div class="timeline" id="events"></div>
    </div>
  </section>
</main>
<script>
const STEPS = ["涂布","晾干","曝光","冲洗","复晒","入盒"];
let state = null;
const $ = s => document.querySelector(s);

async function api(path, options){
  const res = await fetch(path, options && options.body ? {...options, headers:{'Content-Type':'application/json'}} : options);
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.reason || data.error || ('请求失败 '+res.status));
  return data;
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&','<':'<','>':'>','"':'"'}[c])); }
function wsName(id){ const w = state.workstations.find(x=>x.id===id); return w ? w.name : (id||'—'); }
function leaseLeft(p){ if(!p.holder||!p.leaseExpiresAt) return null; return Math.max(0, Math.round((new Date(p.leaseExpiresAt)-Date.now())/1000)); }
function fmtAt(t){ if(!t) return ''; const d=new Date(t); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0'); }

async function load(){
  try { state = await api('/api/state'); render(); }
  catch(e){ console.error(e); }
}

function render(){
  // 统计
  const plates = state.plates;
  const held = plates.filter(p=>p.holder && leaseLeft(p)>0).length;
  const invalid = plates.filter(p=>p.invalidReason).length;
  const requeue = plates.filter(p=>p.status==='待重洗').length;
  const done = plates.filter(p=>p.status==='已交付').length;
  const consumed = plates.reduce((n,p)=>n+(p.consumptions||[]).length,0);
  $('#stats').innerHTML = [
    ['玻璃板总数', plates.length],['在持工位', held],['待重洗', requeue],['已失效', invalid],['已交付', done],['药液消耗(份)', consumed]
  ].map(([k,v])=>'<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');

  // 工位
  $('#stations').innerHTML = state.workstations.map(w=>{
    const ps = plates.filter(p=>p.holder===w.id && leaseLeft(p)>0);
    return '<div class="ev"><span class="ty">'+esc(w.name)+'</span> <span class="mono">'+w.id+'</span>'+
      (ps.length ? ' → 持有：'+ps.map(p=>esc(p.code)).join('、') : ' <span class="meta">空闲</span>')+'</div>';
  }).join('');

  // 入盒批次
  $('#boxBatches').innerHTML = state.boxBatches.length ? state.boxBatches.map(b=>
    '<div class="ev"><span class="ty">'+esc(b.code)+'</span> <span class="meta">'+b.status+' · '+b.plateIds.length+' 板</span></div>').join('')
    : '<div class="meta">尚无入盒批次（「入盒」检查点会自动建批）</div>';

  // 药液批次
  $('#batches').innerHTML = state.chemicalBatches.map(b=>
    '<div class="ev"><span class="ty">'+esc(b.code)+'</span> <span class="meta">v'+b.version+(b.current?' · 当前':'')+'</span><div class="meta">'+esc(b.note||'')+'</div></div>').join('');

  // 故障状态
  const f = state.fault;
  $('#faultNow').textContent = '当前：接下来 '+f.writeFailures+' 次写盘必失败，随机失败率 '+(Math.round(f.randomRate*100))+'%';

  // 玻璃板卡片
  $('#plates').innerHTML = plates.map(cardHtml).join('') || '<div class="meta">暂无玻璃板</div>';

  // 重试结果
  $('#telemetry').innerHTML = (state.telemetry||[]).slice(0,20).map(t=>{
    const ok = t.ok;
    const attempts = (t.attempts||[]).length;
    return '<div class="ev"><span class="t">'+fmtAt(t.at)+'</span> <span class="ty">'+esc(t.op)+'</span> '+(t.plateId?'<span class="mono">'+esc(t.plateId)+'</span> ':'')+
      (ok ? '<span class="retry-ok">成功</span>' : '<span class="retry-fail">失败</span>')+
      (attempts ? ' · 尝试 '+attempts+' 次' : '')+
      (t.error ? '<div class="reason">'+esc(t.error)+(attempts?'（已按检查点重试）':'')+'</div>' : '')+
      (ok && attempts ? '<div class="ok-reason">写盘曾失败 '+attempts+' 次，均从最近检查点续做，未重复消耗药液、未留占用无记录</div>' : '');
  }).join('') || '<div class="meta">暂无重试记录</div>';

  // 转手链事件
  $('#events').innerHTML = state.events.slice(0,40).map(e=>
    '<div class="ev"><span class="t">'+fmtAt(e.at)+'</span> <span class="ty">'+esc(e.type)+'</span> '+(e.plateId?'<span class="mono">'+esc(e.plateId)+'</span> ':'')+
    (e.workstation?'<span class="meta">'+esc(wsName(e.workstation))+'</span> ':'')+
    '<div>'+esc(e.reason||'')+(e.detail?' <span class="meta">· '+esc(e.detail)+'</span>':'')+'</div></div>').join('') || '<div class="meta">暂无事件</div>';

  bindCards();
}

function cardHtml(p){
  const left = leaseLeft(p);
  const held = p.holder && left>0;
  const expired = p.holder && left!==null && left<=0;
  const nxt = nextStepOf(p);
  const last = lastCp(p);
  const cls = p.invalidReason ? 'invalid' : (p.status==='已交付' ? 'done' : (p.status==='待重洗' ? 'requeue' : ''));
  const cpList = p.checkpoints.filter(c=>c.valid).map(c=>esc(c.step)).join(' → ');
  const invalidList = p.checkpoints.filter(c=>!c.valid).map(c=>esc(c.step)).join('、');
  return '<article class="card '+cls+'">'
    + '<div class="row"><h3>'+esc(p.code)+'</h3><span class="pill">'+esc(p.status)+'</span></div>'
    + '<div class="meta">'+esc(p.plateSize||'')+' · 药液批次 <span class="mono">'+esc(p.chemicalBatch||state.meta.currentChemicalBatch)+'</span>'+(p.box?' · 盒位 '+esc(p.box):'')+'</div>'
    + '<div class="row"><span class="meta">当前持有人</span>'
    + (held ? '<span class="pill hold holder">'+esc(wsName(p.holder))+' · 剩 '+left+'s</span>'
            : expired ? '<span class="pill expired">租约已过期</span>'
                      : '<span class="pill">无</span>')
    + '</div>'
    + '<div class="meta">最近检查点：<b>'+esc(last||'无')+'</b> → 下一站：<b>'+esc(nxt||'已完成')+'</b></div>'
    + (cpList ? '<div class="meta">已完成：'+cpList+'</div>' : '')
    + (invalidList ? '<div class="reason">失效步骤：'+invalidList+'</div>' : '')
    + (p.invalidReason ? '<div class="reason">失效原因：'+esc(p.invalidReason)+'</div>' : '')
    + (p.boxBatchId ? '<div class="meta">入盒批次：<span class="mono">'+esc(p.boxBatchId)+'</span></div>' : '')
    + '<div class="meta">药液消耗：'+(p.consumptions||[]).length+' 份（'+(p.consumptions||[]).map(c=>esc(c.step)+'@'+esc(c.chemicalBatch)).join('，')+'）</div>'
    + '<div class="chain"><b>转手链</b>'+chainOf(p)+'</div>'
    + '<div class="btns">'
    + (held && p.holder==='W1' ? '' : '<button data-act="claim" data-id="'+esc(p.id)+'" data-w="W1">'+(held?'':'东窗认领')+'</button>')
    + (held && p.holder==='W2' ? '' : '<button data-act="claim" data-id="'+esc(p.id)+'" data-w="W2">'+(held?'':'西窗认领')+'</button>')
    + (expired ? '<button data-act="takeover" data-id="'+esc(p.id)+'" data-w="W1" class="secondary">东窗接管续做</button>' : '')
    + (expired ? '<button data-act="takeover" data-id="'+esc(p.id)+'" data-w="W2" class="secondary">西窗接管续做</button>' : '')
    + (held && nxt ? '<button data-act="step" data-id="'+esc(p.id)+'" data-w="'+esc(p.holder)+'" data-step="'+esc(nxt)+'">记录「'+esc(nxt)+'」</button>' : '')
    + '</div>'
    + '</article>';
}

function nextStepOf(p){
  for(const s of STEPS){ if(!p.checkpoints.some(c=>c.step===s && c.valid)) return s; }
  return null;
}
function lastCp(p){
  for(let i=STEPS.length-1;i>=0;i--){ if(p.checkpoints.some(c=>c.step===STEPS[i] && c.valid)) return STEPS[i]; }
  return null;
}
function chainOf(p){
  const evs = state.events.filter(e=>e.plateId===p.id).slice(0,6).reverse();
  if(!evs.length) return '<div>暂无</div>';
  return evs.map(e=>'<div><span class="t">'+fmtAt(e.at)+'</span> <b>'+esc(e.type)+'</b> '+esc(e.reason||'')+'</div>').join('');
}

function bindCards(){
  document.querySelectorAll('[data-act]').forEach(btn=>{
    btn.onclick = async ()=>{
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const w = btn.dataset.w;
      try{
        if(act==='claim' || act==='takeover'){
          await api('/api/plates/'+encodeURIComponent(id)+'/claim', {method:'POST', body:JSON.stringify({workstationId:w})});
        }else if(act==='step'){
          const step = btn.dataset.step;
          const body = {workstationId:w, step, note: step+' 完成'};
          if(step==='冲洗'){ body.developStatus='稳定'; body.defect=null; }
          await api('/api/plates/'+encodeURIComponent(id)+'/checkpoint', {method:'POST', body:JSON.stringify(body)});
        }
        await load();
      }catch(e){ alert(e.message); }
    };
  });
}

$('#createForm').onsubmit = async e=>{ e.preventDefault();
  const f = e.target; const body = Object.fromEntries(new FormData(f).entries());
  try{ await api('/api/plates', {method:'POST', body:JSON.stringify(body)}); f.reset(); await load(); }
  catch(err){ alert(err.message); }
};
$('#batchForm').onsubmit = async e=>{ e.preventDefault();
  const f = e.target; const body = Object.fromEntries(new FormData(f).entries());
  if(!confirm('更新药液批次将使所有旧显影结论失效并重排，确定？')) return;
  try{ await api('/api/chemical-batches', {method:'POST', body:JSON.stringify(body)}); f.reset(); await load(); }
  catch(err){ alert(err.message); }
};
$('#faultForm').onsubmit = async e=>{ e.preventDefault();
  const f = e.target; const body = Object.fromEntries(new FormData(f).entries());
  await api('/api/faults', {method:'POST', body:JSON.stringify({writeFailures:Number(body.writeFailures)})});
  await load();
};
$('#reload').onclick = load;

load();
setInterval(load, 1000);
</script>
</body>
</html>`;
