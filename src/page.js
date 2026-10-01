// 页面层：只负责渲染与调用 /api，不内置业务规则。
// 重点展示：当前持有人（含租约倒计时）、失效原因（待重排）、每次写盘的重试结果。
export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>古法蓝晒底片整理室 · 可恢复转手链</title>
<style>
  :root { --bg:#eef1ea; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#4f6f3f; --warn:#9b4937; --hold:#8a6a2c; --ok:#3f6f55; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { padding:18px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:flex-end; flex-wrap:wrap; }
  h1 { margin:0 0 4px; font-size:23px; } h2 { margin:0 0 10px; font-size:16px; } h3 { margin:0; font-size:17px; }
  .meta { color:var(--muted); font-size:13px; }
  main { display:grid; grid-template-columns:340px 1fr; gap:18px; padding:18px 26px; align-items:start; }
  .panel, form, .card, .stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
  label { display:block; margin:9px 0 4px; color:var(--muted); font-size:12px; }
  input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 11px; font-weight:700; cursor:pointer; font-size:13px; }
  button.secondary { background:#69736a; } button.warn { background:var(--warn); } button.gold { background:var(--hold); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-bottom:12px; }
  .stat strong { display:block; font-size:22px; } .stat span { font-size:12px; color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; }
  .card { display:grid; gap:7px; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
  .pill.hold { background:#f6edd8; border-color:#d8c08a; color:var(--hold); }
  .pill.queue { background:#eef1ea; } .pill.requeue { background:#f8e6e0; border-color:#dca48f; color:var(--warn); }
  .pill.done { background:#e2efe8; border-color:#9cc5ae; color:var(--ok); } .pill.start{ background:#f0f0ee; }
  .holder { font-size:13px; padding:7px 9px; border-radius:6px; background:#f6edd8; border:1px dashed #d8c08a; }
  .requeue-box { font-size:13px; padding:8px 9px; border-radius:6px; background:#f8e6e0; border:1px solid #dca48f; color:#7a3527; }
  .retry-ok { font-size:12px; padding:6px 8px; border-radius:6px; background:#e2efe8; border:1px solid #9cc5ae; color:var(--ok); }
  .retry-bad { font-size:12px; padding:6px 8px; border-radius:6px; background:#f8e6e0; border:1px solid #dca48f; color:var(--warn); }
  .cps { display:flex; gap:4px; flex-wrap:wrap; margin:2px 0; }
  .cp { font-size:11px; border-radius:4px; padding:2px 6px; background:#e7ede1; border:1px solid #c6d6b8; }
  .cp.invalid { background:#eee; color:#999; border-color:#ddd; text-decoration:line-through; }
  .kv { display:grid; grid-template-columns:84px 1fr; gap:2px 8px; font-size:13px; }
  .kv b { color:var(--muted); font-weight:400; }
  .logs { border-top:1px solid var(--line); padding-top:7px; max-height:118px; overflow:auto; font-size:12px; color:var(--muted); display:grid; gap:2px; }
  .toast { position:fixed; right:18px; bottom:18px; max-width:420px; display:grid; gap:8px; z-index:10; }
  .toast div { background:#222; color:#fff; padding:10px 13px; border-radius:8px; font-size:13px; box-shadow:0 4px 14px rgba(0,0,0,.25); white-space:pre-wrap; }
  .toast .err { background:var(--warn); } .toast .ok { background:var(--ok); }
  .ledger { max-height:220px; overflow:auto; font-size:12px; display:grid; gap:4px; }
  .tag-voided { color:var(--warn); font-weight:700; }
  details summary { cursor:pointer; font-weight:700; font-size:14px; margin-bottom:8px; }
  .small { font-size:12px; color:var(--muted); }
  @media (max-width:980px){ main{grid-template-columns:1fr;} .stats{grid-template-columns:repeat(3,1fr);} }
</style>
</head>
<body>
<header>
  <div>
    <h1>古法蓝晒底片整理室</h1>
    <div class="meta">玻璃板 · 工艺检查点 · 入盒批次的可恢复转手链：一块板同时只由一个工位持有，租约过期从最近检查点续做，药液轮换自动失效重排，写盘按检查点幂等重试。</div>
  </div>
  <div class="row">
    <div><label class="meta" for="stationSel">我的工位</label><select id="stationSel" style="width:130px"></select></div>
    <div><label class="meta" for="failIn">模拟写盘失败次数（故障注入）</label><input id="failIn" type="number" min="0" max="9" value="0" style="width:200px" title="让下次提交的前 N 次落盘失败，验证自动重试；≥3 次则请求整体失败、占用不落盘"></div>
    <button id="reload">刷新</button>
  </div>
</header>
<main>
  <section style="display:grid;gap:14px">
    <form id="createForm"><h2>新增玻璃板</h2>
      <label>编号（留空自动生成）</label><input name="code" placeholder="CN-005">
      <label>玻璃板尺寸</label><input name="plateSize" placeholder="18x24cm">
      <label>曝光时间</label><input name="exposure" placeholder="8分钟">
      <label>冲洗水源</label><input name="waterSource" placeholder="井水过滤">
      <button>建档入队</button>
    </form>

    <div class="panel"><h2>药液批次</h2>
      <div id="chemInfo" class="small" style="margin-bottom:8px"></div>
      <div class="row">
        <input id="newBatch" placeholder="新批次号，如 B-1025">
        <button id="rotateBtn" class="gold">登记并轮换</button>
      </div>
      <div class="small" style="margin-top:6px">轮换后：已显影未入盒的板旧结论作废、回到「曝光」检查点重排；未冲洗的板直接改用新液；已入盒的不动。</div>
      <div class="row" style="margin-top:8px"><button class="secondary" id="reapBtn">回收全部过期租约</button></div>
    </div>

    <details class="panel" open>
      <summary>药液消耗台账（按幂等键去重）</summary>
      <div class="ledger" id="consumptions"></div>
    </details>
    <details class="panel">
      <summary>入盒批次与盒位占用</summary>
      <div class="ledger" id="boxes"></div>
      <div class="row" style="margin-top:8px"><button class="secondary" id="sealBtn">封存当前开放批次</button></div>
    </details>
  </section>

  <section>
    <div class="stats" id="stats"></div>
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">工位队列与板卡</h2>
        <div class="small">排队顺序（先到先做，重排板到队尾）：<span id="queueLine"></span></div>
      </div>
      <div class="grid" id="cards" style="margin-top:10px"></div>
    </div>
    <details class="panel" style="margin-top:14px">
      <summary>转手链事件（租约 / 检查点 / 失效 / 重试）</summary>
      <div class="ledger" id="events" style="max-height:260px"></div>
    </details>
  </section>
</main>
<div class="toast" id="toast"></div>

<script>
const PILL = {"待开始":"start","排队中":"queue","处理中":"hold","待重排":"requeue","已交付":"done"};
let view = null;
const $ = (s) => document.querySelector(s);
const stationSel = $("#stationSel");
const tokens = {}; // plateId -> 当前工位持有的租约令牌
const getStation = () => stationSel.value;
const failCredits = () => Number($("#failIn").value) || 0;

function toast(msg, kind) {
  const box = $("#toast"); const d = document.createElement("div");
  if (kind) d.className = kind;
  d.textContent = msg; box.appendChild(d);
  setTimeout(() => d.remove(), 6000);
}

async function api(path, options = {}) {
  const opts = { method: options.method || "GET", headers: { "Content-Type": "application/json" } };
  if (options.body) opts.body = JSON.stringify(options.body);
  const f = failCredits();
  if (f > 0 && opts.method !== "GET") opts.headers["X-Fail-Writes"] = String(f);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || data.error || "请求失败");
    e.data = data;
    throw e;
  }
  if (data.writeAttempts > 1) toast("写盘第 " + data.writeAttempts + " 次尝试才成功，已按检查点重试，未重复消耗药液/盒位", "ok");
  return data;
}

async function load() {
  view = await api("/api/state");
  render();
}

function render() {
  if (!stationSel.value) stationSel.innerHTML = view.stations.map(s => '<option value="'+s.id+'">'+s.name+'</option>').join("");
  $("#stats").innerHTML = Object.entries(view.stats).map(([k,v]) =>
    '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join("");
  const codeName = (id) => (view.plates.find(p => p.id === id) || {}).code || id;
  $("#queueLine").textContent = view.queue.map(codeName).join(" → ") || "（空）";

  $("#chemInfo").innerHTML = "当前在用批次：<b>"+view.activeBatchId+"</b><br>已知批次：" +
    view.chemicalBatches.map(b => b.id + "（"+({active:"在用",retired:"停用",unknown:"未知"})[b.status]+ "）").join("、");

  $("#consumptions").innerHTML = view.consumptions.length ? view.consumptions.slice().reverse().map(c =>
    '<div>● '+c.code+' · '+c.batchId+' · '+(c.amountMl==null?"量未记":c.amountMl+"ml")+' · '+fmt(c.at)+
    (c.voided ? ' <span class="tag-voided">已作废（'+(c.voidReason||"显影失效")+'）</span>' : " <b>有效</b>")+
    '<br><span class="small">幂等键 '+c.requestId+' / 台账 '+c.id+'</span></div>').join("")
    : '<div class="small">暂无消耗</div>';

  $("#boxes").innerHTML = view.boxBatches.length ? view.boxBatches.slice().reverse().map(b =>
    '<div><b>'+b.id+'</b>（'+(b.status==="open"?"开放中":"已于 "+fmt(b.sealedAt)+" 封存")+'）占用 '+b.slots.length+'/'+b.capacity+
    '<br><span class="small">'+b.slots.map(s => s.slot+":"+s.code).join("，")+'</span></div>').join("")
    : '<div class="small">尚无入盒批次，第一块板入盒时自动开批次</div>';

  $("#events").innerHTML = view.events.slice().reverse().map(e =>
    '<div>['+fmt(e.at)+'] '+(e.plateId?codeName(e.plateId)+" · ":"")+e.message+'</div>').join("") ||
    '<div class="small">暂无事件</div>';

  $("#cards").innerHTML = view.plates.map(cardHtml).join("");
  bindCardButtons();
}

function cardHtml(p) {
  const mine = p.lease && p.lease.station === getStation();
  const cps = p.checkpoints.map(c =>
    '<span class="cp'+(c.valid===false?" invalid":"")+'" title="'+fmt(c.at)+' '+(c.station||"")+' '+(c.conclusion||"")+'">'+c.stage+'</span>').join("");
  const holder = p.lease
    ? '<div class="holder">当前持有人：<b>'+p.lease.holderName+'</b> · 剩余 <b data-expires="'+p.lease.expiresAt+'">'+left(p.lease.expiresAt)+'</b>'+
      (mine ? '（我持有，令牌 '+p.lease.token.slice(-6)+'）' : "")+'</div>'
    : '<div class="meta">无人持有'+(p.queuePosition?' · 队列第 '+p.queuePosition+' 位':'')+'</div>';
  const invalid = p.invalidated
    ? '<div class="requeue-box"><b>待重排 · 失效原因：</b>'+p.invalidated.reason+'<br>续做检查点：<b>'+
      (p.invalidated.resumeFrom||"无")+'</b> → 重做「'+p.nextStage+'」'+
      (p.invalidated.fromBatchId?'<br>旧批次 '+p.invalidated.fromBatchId+' → 新批次 '+p.invalidated.toBatchId:"")+'</div>' : "";
  const retryTime = p.lastRetry && p.lastRetry.at ? new Date(p.lastRetry.at).toLocaleTimeString("zh-CN") : "";
  const retry = p.lastRetry
    ? '<div class="'+(p.lastRetry.ok?"retry-ok":"retry-bad")+'">最近重试结果：'+p.lastRetry.message+'（'+retryTime+'）</div>' : "";
  const dev = p.develop
    ? '<div class="small">显影结论：'+p.dev.conclusion+'（药液 '+p.dev.batchId+'，'+fmt(p.dev.at)+'）</div>'
    : '<div class="small">显影结论：尚未做出</div>';
  const kv = '<div class="kv"><b>尺寸</b><span>'+p.plateSize+'</span><b>曝光</b><span>'+p.exposure+'</span><b>水源</b><span>'+p.waterSource+'</span><b>药液</b><span>'+p.batchId+'</span>'+
    (p.boxSlot?'<b>盒位</b><span>'+p.boxBatchId+' '+p.boxSlot+'</span>':"")+'</div>';

  // 操作按钮按状态与持有关系决定
  let actions = "";
  if (p.status === "已交付") {
    actions = '<div class="small">已入盒 '+p.boxBatchId+' '+p.boxSlot+'，转手链闭环。</div>';
  } else if (p.lease && !mine) {
    actions = '<button data-act="recover" class="warn" title="租约未过期时会被拒绝；过期后可接管从最近检查点续做">租约已过期？接管续做</button>';
  } else if (!p.lease) {
    actions = '<button data-act="acquire" class="gold">领取租约（从「'+p.nextStage+'」开始）</button>';
  } else if (mine) {
    const stage = p.nextStage;
    const extra = stage === "冲洗"
      ? '<input name="conclusion" placeholder="显影结论，如 显影合格"><input name="amountMl" type="number" placeholder="药液 ml，默认300"><input name="defect" placeholder="缺陷（无则留空）">'
      : stage === "曝光" ? '<input name="metric" placeholder="曝光计量，默认档案值">'
      : '<input name="note" placeholder="本步备注（可选）">';
    actions =
      '<div class="small">我持有 · 下一步：<b>'+stage+'</b>'+
      (p.invalidated ? '（失效重跑，重做冲洗将按 '+p.batchId+' 重新扣药液）' : '')+'</div>'+
      '<label>请求幂等键 requestId（留空=租约令牌+步骤，重试安全）</label><input name="requestId" placeholder="留空即可">'+extra+
      '<div class="row"><button data-act="advance">完成「'+stage+'」检查点</button>'+
      '<button data-act="heartbeat" class="secondary">续租</button>'+
      (stage==="入盒"?"":'<button data-act="handoff" class="secondary">交接回队列</button>')+
      '</div>'+
      '<div class="row" style="margin-top:6px"><button data-act="assign" class="gold" title="把这块板改用另一批次；若已显影则旧结论失效重排">改用药液…</button></div>';
  }

  return '<article class="card"><div class="row" style="justify-content:space-between"><h3>'+p.code+'</h3>'+
    '<span class="pill '+(PILL[p.status]||"")+'">'+p.status+'</span></div>'+
    holder+invalid+retry+
    '<div class="cps">'+(cps||'<span class="small">尚无检查点</span>')+'</div>'+
    dev+kv+
    (p.defect?'<div class="small">缺陷：'+p.defect+(p.repair?" / 修补："+p.repair:"")+'</div>':"")+
    (p.note?'<div class="small">备注：'+p.note+'</div>':"")+
    '<div>'+actions+'</div>'+
    '<div class="logs">'+(p.events||[]).slice(-6).map(e=>'<div>['+fmt(e.at)+'] '+e.message+'</div>').join("")+'</div>'+
    '</article>';
}

function bindCardButtons() {
  document.querySelectorAll("[data-act]").forEach(btn => {
    btn.onclick = async () => {
      const card = btn.closest(".card");
      const p = view.plates.find(x => card.querySelector("h3").textContent === x.code);
      const body = (names) => Object.fromEntries(names.map(n => [n, card.querySelector('[name="'+n+'"]')?.value || ""]).filter(([,v]) => v !== ""));
      try {
        if (btn.dataset.act === "acquire") {
          const r = await api("/api/plates/"+p.id+"/acquire", { method:"POST", body:{ station:getStation() } });
          if (r.token) tokens[p.id] = r.token;
          toast(r.acquired ? "领取成功，从「"+r.resumeStage+"」续做" : "同工位重复领取，已按续租处理", "ok");
        } else if (btn.dataset.act === "heartbeat") {
          await api("/api/plates/"+p.id+"/heartbeat", { method:"POST", body:{ token:tokens[p.id] } });
          toast("续租成功", "ok");
        } else if (btn.dataset.act === "handoff") {
          await api("/api/plates/"+p.id+"/handoff", { method:"POST", body:{ token:tokens[p.id] } });
          delete tokens[p.id]; toast("已交接回队列，占用释放，停在最近检查点", "ok");
        } else if (btn.dataset.act === "recover") {
          const r = await api("/api/plates/"+p.id+"/recover", { method:"POST", body:{} });
          toast("过期租约已回收，续做点「"+(r.resumeFrom||"无")+"」，下一步「"+(r.nextStage||"—")+"」", "ok");
        } else if (btn.dataset.act === "advance") {
          const input = body(["requestId","conclusion","amountMl","defect","metric","note"]);
          input.token = tokens[p.id]; input.station = getStation();
          const r = await api("/api/plates/"+p.id+"/advance", { method:"POST", body:input });
          if (r.replayed) toast("重复提交被幂等拦截：直接回放检查点，药液/盒位均未重复占用\\n"+(r.consumption?"台账 "+r.consumption.id:""), "ok");
          else if (r.stage === "冲洗") toast("冲洗完成，消耗药液 "+r.consumption.amountMl+"ml（台账 "+r.consumption.id+"）", "ok");
          else if (r.stage === "入盒") toast("入盒完成："+r.boxBatchId+" "+r.slot+"，占用与完成记录同一次落盘", "ok");
          else toast("检查点「"+r.stage+"」已落盘", "ok");
        } else if (btn.dataset.act === "assign") {
          const bid = prompt("把 "+p.code+" 改用药液批次：", view.activeBatchId);
          if (!bid) return;
          const r = await api("/api/plates/"+p.id+"/chemical", { method:"PUT", body:{ batchId:bid } });
          toast(r.invalidated ? "批次已更新：旧显影结论失效，已回到曝光检查点重排" : "批次已指定（尚未冲洗，直接生效）", r.invalidated?"":"ok");
        }
      } catch (e) {
        toast("失败：" + e.message + (e.data?.holderName ? "（持有人："+e.data.holderName+"）" : "") + (e.data?.retryable ? "\\n请用同一令牌与 requestId 重试" : ""), "err");
      }
      await load();
    };
  });
}

$("#createForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(ev.target).entries());
  try { await api("/api/plates", { method:"POST", body:data }); toast("新板已建档入队", "ok"); ev.target.reset(); }
  catch (e) { toast("建档失败：" + e.message, "err"); }
  await load();
};
$("#rotateBtn").onclick = async () => {
  const bid = $("#newBatch").value.trim();
  if (!bid) return toast("请填写新批次号", "err");
  try {
    const r = await api("/api/chemicals/rotate", { method:"POST", body:{ batchId:bid, note:"页面登记轮换" } });
    toast("已轮换为 "+r.toBatchId+"："+r.invalidatedCount+" 块板旧显影结论失效并重排", "ok");
    $("#newBatch").value = "";
  } catch (e) { toast("轮换失败：" + e.message, "err"); }
  await load();
};
$("#reapBtn").onclick = async () => {
  try { const r = await api("/api/leases/reap-expired", { method:"POST", body:{} });
    toast("回收过期租约 "+r.count+" 个", "ok"); }
  catch (e) { toast("回收失败：" + e.message, "err"); }
  await load();
};
$("#sealBtn").onclick = async () => {
  try { const r = await api("/api/box-batches/seal", { method:"POST", body:{} });
    toast("入盒批次 "+r.boxBatch.id+" 已封存", "ok"); }
  catch (e) { toast("封存失败：" + e.message, "err"); }
  await load();
};
stationSel.onchange = render;
$("#reload").onclick = load;

function fmt(t) { return t ? new Date(t).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}) : ""; }
function left(exp) { const s = Math.max(0, Math.round((new Date(exp) - Date.now())/1000)); return s>0 ? Math.floor(s/60)+"分"+s%60+"秒" : "已过期"; }
setInterval(() => document.querySelectorAll("[data-expires]").forEach(el => el.textContent = left(el.dataset.expires)), 1000);
load().catch(e => toast("加载失败：" + e.message, "err"));
</script>
</body>
</html>`;
}
