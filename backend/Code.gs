/**
 * UG 門市修繕進度系統 — 後端 (Google Apps Script Web App)
 * 架構沿用「文宣申請系統」：純 JSON API、token/admin 驗證、
 * 附件分頁存 base64、LINE Messaging API 群組推播、Script Properties 存敏感設定。
 *
 * ⚠ 資安：所有 token / 密碼 一律存 Script Properties，禁止寫進前端。
 *   前端用 text/plain POST（避免 CORS preflight），token 放 body。
 */

// ── 預設設定（實際值請存 Script Properties，這裡只是 fallback / 種子資料）──
var CONFIG = {
  SHEET_NAME: '門市修繕進度系統',
  API_TOKEN: 'rp_8sK2mVq7Xz4Pd',      // 門市端共用 token（存 Script Properties: API_TOKEN）
  ADMIN_KEY: 'UGfix-7Q2x9',           // 管理端通行金鑰（＝前端連結 ?m= 的值；無密碼登入，有連結即可進）
  // 門市／督導主檔＝Google 試算表「門店資料表_UG」（三套系統共用，Script Properties 可覆寫）
  MASTER_SHEET_ID: '1MMsKbGNR1gEnI04TLBpv3SR47bqh5CYrd1RSVwohdT4',
  MASTER_SHEET_GID: 1076844819,
};

// 同步後一併通知的另外兩套系統（帶 noFanout 避免互相呼叫成無限迴圈）
var PEER_SYSTEMS = [
  { name: '文宣申請系統',
    url:  'https://script.google.com/macros/s/AKfycbwn-hiS6mPpxw3BmZCqTmH211g0AwI7KW7xiBMzWyYXdymk5eBYCeL3eRZq6kz1u9yrRw/exec',
    auth: { token: 'pr_kQ7mZ2xV9tLpA4nBwR8sYcEf' } },
  { name: '門市物料異常回報系統',
    url:  'https://script.google.com/macros/s/AKfycbzyZqkKtYuSuMUv31cAaHC3JZU33Gk8ETYvjWtowQ2pn6EfVMv771_biO2V6kH0lgGf/exec',
    auth: { token: 'gkt00TlVXvaARtTtBthQ9MUechEw' } }
];

// 狀態定義（順序＝流程）
var STATUS = ['待處理', '處理中', '更換負責單位', '待討論', '已結案'];
//            0          1         2(改相關單位自動帶入)  3(無法修繕需討論)  4
var STATUS_DISCUSS = '待討論';
var STATUS_CLOSED  = '已結案';
var STATUS_UNIT    = '更換負責單位';

// 報修項目（依分區）種子；每筆 [報修項目, 報修單位, 需設備編號(1/0)]
// 可由管理端覆寫，存 Script Properties: ZONES_CONFIG。zones 順序＝物件鍵順序。
var DEFAULT_ZONES = {
  '備料區':[['地板','工務',0],['電燈','工務',0],['牆壁','工務',0],['天花板','工務',0],['冷氣','工務',0],['濾心','採購',0],['生飲/自來水','工務',0],['水槽/水管','工務',0],['冷凍冰箱','採購',0],['冷藏冰箱','採購',0],['電磁爐','採購',1],['電子秤','採購',0],['製冰機','採購',1],['煮茶壺','採購',0],['煮茶機','採購',1]],
  '製作區':[['地板','工務',0],['電燈','工務',0],['牆壁','工務',0],['天花板','工務',0],['工作台','採購',0],['儲冰槽','採購',0],['生飲/自來水','工務',0],['水槽/水管','工務',0],['洗杯器','工務',0],['封口機','採購',1],['蒸汽機','採購',1],['均質機','採購',1],['智能茶飲機','採購',1]],
  '櫃台區':[['地板','工務',0],['電燈','工務',0],['牆壁','工務',0],['天花板','工務',0],['文字架','工務',0],['杯貼標籤機','資訊',0],['發票出單機','資訊',0],['桌上掃碼器','資訊',0],['叫號器','資訊',0],['悠遊卡機','資訊',0],['電視機','資訊',0],['UE平台','資訊',0],['FP平台','資訊',0],['餐飲王系統','資訊',0]],
  '客席區':[['地板','工務',0],['電燈','工務',0],['冷氣','工務',0],['打卡牆','工務',0],['天花板','工務',0]],
  '其他':[['門相關','工務',0],['監視器','資訊',0],['香氛機','採購',0],['水塔','工務',0],['網路','資訊',0],['廁所','工務',0],['招牌','工務',0],['其他','工務',0]]
};

// 報修單位（自動由項目帶入，admin 可再改派）
var DEFAULT_UNITS = ['工務','採購','資訊'];

// 門市 → 負責督導（種子；可由管理端覆寫，存 Script Properties: STORE_DIRECTORY）
var DEFAULT_DIRECTORY = {
  '忠孝敦化店':'劉邦鑫 Benson','信義虎林店':'劉邦鑫 Benson','信義永吉店':'劉邦鑫 Benson','站前南陽店':'劉邦鑫 Benson','士林捷運店':'劉邦鑫 Benson','林口長庚店':'劉邦鑫 Benson','中山南西店':'劉邦鑫 Benson',
  '羅東民權店':'林雨慈 Ivory','台北大巨蛋店':'林雨慈 Ivory','宜蘭礁溪店':'林雨慈 Ivory',
  '新店民權店':'呂韋興 Robert','台北西湖店':'呂韋興 Robert','蘆洲光華店':'呂韋興 Robert','中和南勢角店':'呂韋興 Robert','信義通化店':'呂韋興 Robert','新莊幸福店':'呂韋興 Robert','板橋中正店':'呂韋興 Robert','土城學府店':'呂韋興 Robert','汐止中興店':'呂韋興 Robert','台北大安店':'呂韋興 Robert','台北萬芳店':'呂韋興 Robert','三重正義店':'呂韋興 Robert','中山大直店':'呂韋興 Robert','永和永安市場店':'呂韋興 Robert','台北石牌店':'呂韋興 Robert','北投光明店':'呂韋興 Robert','基隆廟口店':'呂韋興 Robert','樹林中山店':'呂韋興 Robert','花蓮中山店':'呂韋興 Robert',
  '嘉義文化店':'許瑛琪 Lydia','高雄巨蛋店':'許瑛琪 Lydia','台南民生店':'許瑛琪 Lydia','斗六中山店':'許瑛琪 Lydia','高雄美麗島店':'許瑛琪 Lydia','彰化員林店':'許瑛琪 Lydia','高雄瑞隆店':'許瑛琪 Lydia','台南永康店':'許瑛琪 Lydia','台南東寧店':'許瑛琪 Lydia','虎尾林森店':'許瑛琪 Lydia','高雄鳳山店':'許瑛琪 Lydia','屏東民生店':'許瑛琪 Lydia',
  '台中逢甲店':'林凱琳 Liisa','台中勤美店':'林凱琳 Liisa','台中大里店':'林凱琳 Liisa','台中東山店':'林凱琳 Liisa','台中北平店':'林凱琳 Liisa','彰化彰基店':'林凱琳 Liisa','台中東海店':'林凱琳 Liisa','南投復興店':'林凱琳 Liisa','台中黎明店':'林凱琳 Liisa','台中豐原店':'林凱琳 Liisa','台中中科店':'林凱琳 Liisa','台中太平店':'林凱琳 Liisa','台中大甲店':'林凱琳 Liisa','台中沙鹿店':'林凱琳 Liisa',
  '中壢新生店':'劉靜蓮 Jill','新竹清大店':'劉靜蓮 Jill','中壢中原店':'劉靜蓮 Jill','新竹民生店':'劉靜蓮 Jill','桃園南崁店':'劉靜蓮 Jill','桃園中正店':'劉靜蓮 Jill','竹北博愛店':'劉靜蓮 Jill','苗栗頭份店':'劉靜蓮 Jill','桃園藝文店':'劉靜蓮 Jill','新竹金山店':'劉靜蓮 Jill','楊梅大成店':'劉靜蓮 Jill','竹北勝利店':'劉靜蓮 Jill','內壢忠孝店':'劉靜蓮 Jill','新竹新豐店':'劉靜蓮 Jill','桃園龍潭店':'劉靜蓮 Jill',
  '泰山明志店':'','平鎮中豐店':'','苗栗府前店':''
};

var REPAIR_HEADERS = ['id','createdAt','store','supervisor','occurDate','equipment','description','status','handleUnit','progressNote','repairConfirm','closeDate','supervisorConfirm','robertNote','statusHistory','updatedAt','zone','equipNo','contact','phone'];
var ATT_HEADERS = ['id','repairId','kind','mime','dataUrl','createdAt'];

// ─────────────────────── 入口 ───────────────────────
function doGet(e) {
  // 供其他系統唯讀取用門市／督導對照（內容同 doPost 的 meta，本來就免 token）
  if (e && e.parameter && e.parameter.action === 'meta') return ok_(meta_());
  // LINE webhook 走 doPost；其餘 doGet 只回健康檢查
  return json_({ ok: true, service: 'UG repair backend', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
    }
    // LINE webhook（擷取 groupId / userId）
    if (body && body.events) { return handleWebhook_(body); }

    var action = body.action || '';
    switch (action) {
      case 'meta':           return ok_(meta_());
      case 'create':         requireToken_(body); return ok_(createRepair_(body));
      case 'listMine':       requireToken_(body); return ok_({ list: listMine_(body.store) });
      case 'getAttachments': requireToken_(body); return ok_({ attachments: getAttachments_(body.repairId) });
      // 管理 / 督導端
      case 'adminList':      requireAdmin_(body); return ok_({ list: adminList_() });
      case 'update':         requireAdmin_(body); return ok_(updateRepair_(body));
      case 'delete':         requireAdmin_(body); return ok_(deleteRepair_(body.id));
      case 'repush':         requireAdmin_(body); return ok_(repush_(body));
      case 'saveConfig':     requireAdmin_(body); return ok_(saveConfig_(body));
      case 'syncStores':     requireSync_(body);  return ok_(syncStoresFromMaster_(body));  // 從門店資料表同步門市／督導
      case 'getEmails':      requireAdmin_(body); return ok_({ emails: supervisorEmails_() });
      case 'saveEmails':     requireAdmin_(body); return ok_(saveEmails_(body));
      case 'getUnitEmails':  requireAdmin_(body); return ok_({ emails: unitEmails_() });
      case 'saveUnitEmails': requireAdmin_(body); return ok_(saveUnitEmails_(body));
      case 'saveLine':       requireAdmin_(body); return ok_(saveLine_(body));
      case 'getLine':        requireAdmin_(body); return ok_(getLine_());
      case 'pushTest':       requireAdmin_(body); return ok_(pushTest_(body));
      case 'capturedIds':    requireAdmin_(body); return ok_({ ids: capturedIds_() });
      default: return err_('unknown action: ' + action);
    }
  } catch (ex) {
    return err_(ex && ex.message ? ex.message : String(ex));
  }
}

// ─────────────────────── 驗證 ───────────────────────
function requireToken_(body) {
  var t = prop_('API_TOKEN') || CONFIG.API_TOKEN;
  if (!body || body.token !== t) throw new Error('unauthorized');
}
// syncStores 專用：管理金鑰或門市端 token 皆可（另外兩套系統連動時用 token）
function requireSync_(body) {
  var key = prop_('ADMIN_KEY') || CONFIG.ADMIN_KEY;
  var t = prop_('API_TOKEN') || CONFIG.API_TOKEN;
  if (body && (String(body.adminKey || '') === String(key) || body.token === t)) return;
  throw new Error('unauthorized');
}
function requireAdmin_(body) {
  // 無密碼登入：以連結金鑰(adminKey) 當管理通行碼（前端從 ?m= 自動帶上）
  var key = prop_('ADMIN_KEY') || CONFIG.ADMIN_KEY;
  if (!body || String(body.adminKey || '') !== String(key)) throw new Error('admin auth failed');
}

// ─────────────────────── meta（前端下拉資料）───────────────────────
function meta_() {
  var z = zonesConfig_();
  var zones = Object.keys(z).map(function (zone) {
    return { zone: zone, items: z[zone].map(function (t) { return t[0]; }) };
  });
  return {
    stores: Object.keys(directory_()).sort(),
    directory: directory_(),
    supervisors: uniq_(Object.keys(directory_()).map(function (s) { return directory_()[s]; })),
    equipment: equipmentList_(),     // 扁平去重（直接選項目／設備篩選）
    zones: zones,                    // [{zone, items:[...]}]（先選分區再選項目）
    itemMeta: itemMeta_(),           // {項目:{unit, need}}（自動帶單位 + 是否強制設備編號）
    units: DEFAULT_UNITS,
    statuses: STATUS,
    regions: storeRegions_(),          // {門市:區域}（來源＝門店資料表，設定頁可手動改）
    regionOrder: regionOrder_(),       // 區域顯示順序（門市下拉分組用）
    syncAt: prop_('STORE_SYNC_AT') || ''
  };
}
function directory_() {
  var raw = prop_('STORE_DIRECTORY');
  if (raw) { try { var o = JSON.parse(raw); if (o && Object.keys(o).length) return o; } catch (e) {} }
  return DEFAULT_DIRECTORY;
}
// 門市 → 區域（Script Properties: STORE_REGIONS；來源＝門店資料表，設定頁可手動調整）
function storeRegions_() {
  var raw = prop_('STORE_REGIONS');
  if (raw) { try { var o = JSON.parse(raw); if (o && typeof o === 'object') return o; } catch (e) {} }
  return {};
}
// 區域顯示順序（存 REGION_ORDER；沒有就依門市對照出現順序推）
function regionOrder_() {
  var raw = prop_('REGION_ORDER');
  if (raw) { try { var a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a; } catch (e) {} }
  var reg = storeRegions_(), seen = {}, out = [];
  Object.keys(directory_()).forEach(function (k) {
    var r = reg[k] || '';
    if (r && !seen[r]) { seen[r] = 1; out.push(r); }
  });
  return out;
}
function zonesConfig_() {
  var raw = prop_('ZONES_CONFIG');
  if (raw) { try { var o = JSON.parse(raw); if (o && Object.keys(o).length) return o; } catch (e) {} }
  return DEFAULT_ZONES;
}
function itemMeta_() {
  var z = zonesConfig_(), m = {};
  Object.keys(z).forEach(function (zone) {
    z[zone].forEach(function (t) { if (!m[t[0]]) m[t[0]] = { unit: t[1] || '', need: !!t[2] }; });
  });
  return m;
}
function equipmentList_() {
  var z = zonesConfig_(), seen = {}, out = [];
  Object.keys(z).forEach(function (zone) {
    z[zone].forEach(function (t) { if (!seen[t[0]]) { seen[t[0]] = 1; out.push(t[0]); } });
  });
  return out;
}

// ─────────────────────── 門市登記 ───────────────────────
function createRepair_(body) {
  var store = String(body.store || '').trim();
  if (!store) throw new Error('門市必填');
  var item = String(body.equipment || '').trim();
  if (!item) throw new Error('報修項目必填');
  var contact = String(body.contact || '').trim();
  var phone = String(body.phone || '').trim();
  if (!contact) throw new Error('門市聯絡人必填');
  if (!phone) throw new Error('聯絡電話必填');
  if (!body.description) throw new Error('問題描述必填');

  var im = itemMeta_()[item];
  var equipNo = String(body.equipNo || '').trim();
  if (im && im.need && !equipNo) throw new Error('「' + item + '」需填寫設備編號');
  // 報修單位：由項目自動帶入（找不到才用前端傳的）
  var unit = (im && im.unit) || body.handleUnit || '';

  var sh = repairSheet_();
  var supervisor = directory_()[store] || body.supervisor || '';
  var now = new Date();
  var id = genId_(store, now);
  var hist = [{ at: now.toISOString(), by: '門市', from: '', to: STATUS[0], note: '門市登記' }];

  var row = {
    id: id, createdAt: now.toISOString(), store: store, supervisor: supervisor,
    occurDate: body.occurDate || ymd_(now), equipment: item,
    description: body.description, status: STATUS[0],
    handleUnit: unit, progressNote: '', repairConfirm: '',
    closeDate: '', supervisorConfirm: '', robertNote: '',
    statusHistory: JSON.stringify(hist), updatedAt: now.toISOString(),
    zone: String(body.zone || '').trim(), equipNo: equipNo,
    contact: contact, phone: phone
  };
  sh.appendRow(REPAIR_HEADERS.map(function (h) { return row[h]; }));

  // 附件（照片/影片）→ 上傳 Drive，分照片網址與影片連結
  var media = saveAttachments_(id, body.attachments);

  // 新案 → 推播群組（照片進圖片訊息、影片以連結附在文字）
  var pushCode = pushLineForStore_(supervisor, lineText_('new', row, '', STATUS[0]), media.photoUrls, media.videoLinks);

  // 新案 → Email 通知相關單位（依 handleUnit 找部門信箱）
  var unitRes = { unitEmailed: false };
  try { unitRes = unitEmailNotify_(row, '新修繕案件'); } catch (e) { unitRes = { unitEmailed: false, unitReason: String(e) }; }

  return { id: id, supervisor: supervisor, pushCode: pushCode, unitEmailed: unitRes.unitEmailed, unitTo: unitRes.unitTo || '' };
}

// ─────────────────────── 更新（狀態/進度）───────────────────────
function updateRepair_(body) {
  var id = body.id;
  if (!id) throw new Error('缺少 id');
  var sh = repairSheet_();
  var data = sh.getDataRange().getValues();
  var hidx = data[0];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]) === String(id)) {
      var obj = rowToObj_(hidx, data[r]);
      var oldStatus = obj.status;
      var oldUnit = String(obj.handleUnit || '');
      var oldProgress = String(obj.progressNote || '');
      var oldRepair = String(obj.repairConfirm || '');
      var newStatus = body.status != null ? String(body.status) : oldStatus;

      // 手動調整「相關單位」（且有變動）→ 自動把狀態帶成「更換負責單位」→ 觸發群組通知
      var unitChanged = (body.handleUnit != null && String(body.handleUnit) !== oldUnit && String(body.handleUnit) !== '');
      if (unitChanged) newStatus = STATUS_UNIT;

      // 套用可編輯欄位
      if (body.status != null || unitChanged) setCell_(sh, r, 'status', newStatus);
      if (body.handleUnit != null)        setCell_(sh, r, 'handleUnit', body.handleUnit);
      if (body.progressNote != null)      setCell_(sh, r, 'progressNote', body.progressNote);
      if (body.repairConfirm != null)     setCell_(sh, r, 'repairConfirm', body.repairConfirm);
      if (body.supervisorConfirm != null) setCell_(sh, r, 'supervisorConfirm', body.supervisorConfirm);
      if (body.robertNote != null)        setCell_(sh, r, 'robertNote', body.robertNote);

      var now = new Date();
      // 結案自動補結案日
      if (newStatus === STATUS_CLOSED && !obj.closeDate) setCell_(sh, r, 'closeDate', ymd_(now));
      setCell_(sh, r, 'updatedAt', now.toISOString());

      // 狀態歷程
      var statusChanged = (newStatus !== oldStatus);
      if (statusChanged) {
        var hist = [];
        try { hist = JSON.parse(obj.statusHistory || '[]'); } catch (e) { hist = []; }
        hist.push({ at: now.toISOString(), by: body.actor || '管理', from: oldStatus, to: newStatus, note: body.progressNote || '' });
        setCell_(sh, r, 'statusHistory', JSON.stringify(hist));
      }

      // 推播：每次狀態改變都通知群組
      if (statusChanged) {
        obj.status = newStatus;
        obj.handleUnit = body.handleUnit != null ? body.handleUnit : obj.handleUnit;
        obj.progressNote = body.progressNote != null ? body.progressNote : obj.progressNote;
        var kind = newStatus === STATUS_DISCUSS ? 'discuss'
                 : newStatus === STATUS_CLOSED ? 'closed'
                 : newStatus === STATUS_UNIT ? 'unit' : 'status';
        pushLineForStore_(obj.supervisor, lineText_(kind, obj, oldStatus, newStatus));
      }

      // Email 通知：處理進度 / 修繕部門處理確認 有新增或變更 → 寄信給該案件督導
      var changes = [];
      if (body.progressNote != null && String(body.progressNote) !== oldProgress && String(body.progressNote).trim())
        changes.push(['處理進度 / 說明', String(body.progressNote)]);
      if (body.repairConfirm != null && String(body.repairConfirm) !== oldRepair && String(body.repairConfirm).trim())
        changes.push(['修繕部門處理確認', String(body.repairConfirm)]);
      var emailRes = { emailed: false };
      if (changes.length) {
        obj.status = newStatus;
        obj.handleUnit = body.handleUnit != null ? body.handleUnit : obj.handleUnit;
        obj.progressNote = body.progressNote != null ? body.progressNote : obj.progressNote;
        obj.repairConfirm = body.repairConfirm != null ? body.repairConfirm : obj.repairConfirm;
        try { emailRes = emailNotify_(obj, changes); } catch (e) { emailRes = { emailed: false, reason: String(e) }; }
      }

      // 更換負責單位 → Email 通知新接手的部門
      var unitRes = { unitEmailed: false };
      if (unitChanged) {
        obj.handleUnit = body.handleUnit;
        obj.status = newStatus;
        try { unitRes = unitEmailNotify_(obj, '更換負責單位'); } catch (e) { unitRes = { unitEmailed: false, unitReason: String(e) }; }
      }
      return { id: id, status: newStatus, notified: statusChanged, emailed: emailRes.emailed, emailTo: emailRes.to || '', emailReason: emailRes.reason || '', unitEmailed: unitRes.unitEmailed, unitTo: unitRes.unitTo || '' };
    }
  }
  throw new Error('找不到案件 ' + id);
}

// ─────────────────────── 重新推播 ───────────────────────
// 不改狀態、不寫歷程，把該案件依目前內容重發一次群組通知（含照片/影片）
function repush_(body) {
  var id = body.id;
  if (!id) throw new Error('缺少 id');
  var sh = repairSheet_();
  var data = sh.getDataRange().getValues();
  var h = data[0];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]) === String(id)) {
      var obj = rowToObj_(h, data[r]);
      var photoUrls = [], videoLinks = [];
      getAttachments_(id).forEach(function (a) {
        var u = String(a.dataUrl || '');
        if (u.indexOf('http') !== 0) return; // base64 備援存檔無法用於推播
        if (a.kind === 'video') videoLinks.push(u); else photoUrls.push(u);
      });
      var code = pushLineForStore_(obj.supervisor, '🔔 重新推播\n' + lineText_('new', obj, '', obj.status), photoUrls, videoLinks);
      if (code === 0)   throw new Error('尚未設定 LINE_TOKEN，無法推播');
      if (code !== 200) throw new Error('LINE 回應 HTTP ' + code + '（401=token失效、400=群組ID錯誤或機器人不在群組、429=當月訊息額度用完）');
      return { id: id, code: code };
    }
  }
  throw new Error('找不到案件 ' + id);
}

// ─────────────────────── 讀取 ───────────────────────
function adminList_() {
  var sh = repairSheet_();
  var data = sh.getDataRange().getValues();
  var h = data[0]; var out = [];
  for (var r = 1; r < data.length; r++) out.push(rowToObj_(h, data[r]));
  var pc = attachmentCount_();
  out.forEach(function (c) { c.photoCount = pc[c.id] || 0; });
  return out.reverse();
}
// repairId → 照片張數（清單只回張數，圖片本體點進去才用 getAttachments 載，清單才不會慢）
function attachmentCount_() {
  var sh = attSheet_();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return {};
  var h = data[0], ri = h.indexOf('repairId');
  var m = {};
  for (var r = 1; r < data.length; r++) {
    var id = String(data[r][ri]); if (!id) continue;
    m[id] = (m[id] || 0) + 1;
  }
  return m;
}
// 刪除案件（含附件列與 Drive 圖檔）
function deleteRepair_(id) {
  if (!id) throw new Error('缺少 id');
  var sh = repairSheet_();
  var data = sh.getDataRange().getValues();
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][0]) === String(id)) { sh.deleteRow(r + 1); break; }
  }
  var ash = attSheet_();
  var ad = ash.getDataRange().getValues();
  if (ad.length >= 2) {
    var h = ad[0], ri = h.indexOf('repairId'), ui = h.indexOf('dataUrl');
    for (var k = ad.length - 1; k >= 1; k--) {
      if (String(ad[k][ri]) === String(id)) {
        try { var fid = driveId_(ad[k][ui]); if (fid) DriveApp.getFileById(fid).setTrashed(true); } catch (e) {}
        ash.deleteRow(k + 1);
      }
    }
  }
  return { deleted: id };
}
function driveId_(url) { var m = /[?&]id=([^&]+)/.exec(String(url || '')); return m ? m[1] : ''; }
function listMine_(store) {
  return adminList_().filter(function (x) { return x.store === store; });
}

// ─────────────────────── 附件（存 Drive 公開圖）───────────────────────
function saveAttachments_(repairId, atts) {
  var out = { photoUrls: [], videoLinks: [] };
  if (!atts || !atts.length) return out;
  var sh = attSheet_();
  var now = new Date().toISOString();
  atts.slice(0, 5).forEach(function (a, i) {
    var up = null;
    try { up = uploadToDrive_(a.dataUrl, repairId + '-' + (i + 1)); } catch (e) { up = null; }
    var isVideo = (a.kind === 'video') || (String(a.mime || '').indexOf('video') === 0) || (up && up.isVideo);
    var kind = isVideo ? 'video' : 'photo';
    var stored;
    if (up) {
      if (isVideo) {
        stored = 'https://drive.google.com/file/d/' + up.id + '/view'; // 影片：Drive 觀看連結（可播放）
        out.videoLinks.push(stored);
      } else {
        stored = 'https://drive.google.com/thumbnail?id=' + up.id + '&sz=w2048'; // 照片：縮圖網址（img / LINE 圖片訊息）
        out.photoUrls.push(stored);
      }
    } else {
      stored = a.dataUrl || ''; // 上傳失敗退回存 base64
    }
    sh.appendRow([Utilities.getUuid(), repairId, kind, a.mime || '', stored, now]);
  });
  return out;
}
function uploadToDrive_(dataUrl, name) {
  var m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl || '');
  if (!m) return null;
  var mime = m[1] || 'application/octet-stream';
  var f = photoFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), mime, name));
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { id: f.getId(), mime: mime, isVideo: mime.indexOf('video') === 0 };
}
function photoFolder_() {
  var id = prop_('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var fo = DriveApp.createFolder('UG修繕照片');
  setProp_('PHOTO_FOLDER_ID', fo.getId());
  return fo;
}
function getAttachments_(repairId) {
  var sh = attSheet_();
  var data = sh.getDataRange().getValues();
  var h = data[0]; var out = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][1]) === String(repairId)) out.push(rowToObj_(h, data[r]));
  }
  return out;
}

// ─────────────────────── LINE 推播 ───────────────────────
function lineCfg_() {
  return {
    token: prop_('LINE_TOKEN') || '',
    groups: safeJson_(prop_('LINE_GROUPS'), {}),    // { 督導:'groupId', ... }（單一群組模式下為空物件）
    fallback: prop_('LINE_DEFAULT_TO') || '',
    link: prop_('LINE_LINK') || ''
  };
}
// 回傳 LINE API 的 HTTP 狀態碼（0=token 未設定），並把每次結果記到 LAST_PUSH 方便除錯
function pushLineForStore_(supervisor, text, imageUrls, videoLinks) {
  var cfg = lineCfg_();
  var to = (cfg.groups && cfg.groups[supervisor]) || cfg.fallback || '';
  if (!cfg.token) { recordPush_(0, to, 'LINE_TOKEN 未設定'); return 0; }
  // 影片以連結附在文字訊息（LINE 直接播 Drive 影片不穩，改給可點擊觀看連結）
  if (videoLinks && videoLinks.length) {
    text += '\n' + videoLinks.map(function (u) { return '🎥 影片：' + u; }).join('\n');
  }
  var messages = [{ type: 'text', text: text }];
  // LINE 單次最多 5 則訊息：1 文字 + 最多 4 張圖
  (imageUrls || []).slice(0, 4).forEach(function (u) {
    messages.push({ type: 'image', originalContentUrl: u, previewImageUrl: u });
  });
  var code = pushMessages_(cfg.token, to, messages);
  recordPush_(code, to, '');
  return code;
}
function recordPush_(code, to, note) {
  try {
    setProp_('LAST_PUSH', JSON.stringify({ at: new Date().toISOString(), code: code, to: to || '(broadcast)', note: note || '' }));
  } catch (e) {}
}
function pushLine_(token, to, text) {
  return pushMessages_(token, to, [{ type: 'text', text: text }]);
}
function pushMessages_(token, to, messages) {
  if (!token) return 0;
  var url = to ? 'https://api.line.me/v2/bot/message/push'
               : 'https://api.line.me/v2/bot/message/broadcast';
  var payload = to ? { to: to, messages: messages } : { messages: messages };
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  return res.getResponseCode();
}
function lineText_(kind, o, from, to) {
  var cfg = lineCfg_();
  var head = kind === 'new'     ? '🆕 新修繕登記'
           : kind === 'discuss' ? '⚠️ 待討論／無法修繕'
           : kind === 'closed'  ? '✅ 已結案'
           : kind === 'unit'    ? '🔁 更換負責單位'
           : '🔧 進度更新';
  var lines = [
    head,
    '門市：' + o.store + '（督導：' + (o.supervisor || '-') + '）',
    '設備：' + o.equipment,
    '問題：' + truncate_(o.description, 60)
  ];
  if (o.contact || o.phone) lines.push('聯絡：' + (o.contact || '') + (o.phone ? ' / ' + o.phone : ''));
  if (kind !== 'new' && from) lines.push('狀態：' + from + ' → ' + to);
  else lines.push('狀態：' + (o.status || to));
  if (o.handleUnit) lines.push('相關單位：' + o.handleUnit);
  if (o.progressNote) lines.push('說明：' + truncate_(o.progressNote, 80));
  if (cfg.link) lines.push('查看：' + cfg.link);
  return lines.join('\n');
}

// ─────────────────────── LINE 設定 / webhook ───────────────────────
function saveLine_(body) {
  if (body.lineToken != null)   setProp_('LINE_TOKEN', body.lineToken);
  if (body.groups != null)      setProp_('LINE_GROUPS', JSON.stringify(body.groups));
  if (body.fallback != null)    setProp_('LINE_DEFAULT_TO', body.fallback);
  if (body.link != null)        setProp_('LINE_LINK', body.link);
  return { saved: true };
}
function getLine_() {
  var cfg = lineCfg_();
  return { tokenSet: !!cfg.token, groups: cfg.groups, fallback: cfg.fallback, link: cfg.link, lastPush: safeJson_(prop_('LAST_PUSH'), null) };
}
function pushTest_(body) {
  var cfg = lineCfg_();
  if (!cfg.token) throw new Error('尚未設定 LINE_TOKEN');
  var to = body.to || cfg.fallback || '';
  var code = pushLine_(cfg.token, to, body.text || '【測試】UG 修繕進度系統 LINE 推播測試');
  recordPush_(code, to, 'pushTest');
  return { ok: code === 200, code: code, to: to || '(broadcast)' };
}
function handleWebhook_(body) {
  // 擷取群組/個人 ID，方便管理端設定推播對象
  try {
    var caps = safeJson_(prop_('CAPTURED_IDS'), []);
    (body.events || []).forEach(function (ev) {
      var src = ev.source || {};
      var rec = { type: src.type, groupId: src.groupId || '', roomId: src.roomId || '', userId: src.userId || '', at: new Date().toISOString() };
      caps.unshift(rec);
    });
    setProp_('CAPTURED_IDS', JSON.stringify(caps.slice(0, 30)));
  } catch (e) {}
  return json_({ ok: true });
}
function capturedIds_() { return safeJson_(prop_('CAPTURED_IDS'), []); }

// ─────────────────────── 設定 / 密碼 ───────────────────────
function saveConfig_(body) {
  if (body.directory != null) setProp_('STORE_DIRECTORY', JSON.stringify(body.directory));
  if (body.regions != null) {                       // {門市:區域}（設定頁第三欄）
    var reg = {}, order = [], seen = {};
    Object.keys(body.regions).forEach(function (k) {
      var v = String(body.regions[k] == null ? '' : body.regions[k]).replace(/\s+/g, ' ').trim();
      reg[String(k).trim()] = v;
      if (v && !seen[v]) { seen[v] = 1; order.push(v); }
    });
    setProp_('STORE_REGIONS', JSON.stringify(reg));
    setProp_('REGION_ORDER', JSON.stringify(order));
  }
  if (body.zones != null) setProp_('ZONES_CONFIG', JSON.stringify(body.zones));
  return { saved: true };
}

// ─────────────── 門市／督導主檔（Google 試算表「門店資料表_UG」）───────────────
// 三套系統（修繕進度／文宣申請／門市物料異常回報）都同步自這份試算表；
// 本系統仍可在「設定→門市對照」手動增修，同步時**只新增與更新，永不刪除**手動加的門市。
function masterSheet_() {
  var id  = prop_('MASTER_SHEET_ID')  || CONFIG.MASTER_SHEET_ID;
  var gid = Number(prop_('MASTER_SHEET_GID') || CONFIG.MASTER_SHEET_GID);
  var ss = SpreadsheetApp.openById(id);
  var hit = ss.getSheets().filter(function (sh) { return sh.getSheetId() === gid; })[0];
  return hit || ss.getSheets()[0];
}
// 讀主檔門市清單 → [{name, sup, region}]（同門市直營／加盟兩列只取一筆；標題列自動偵測）
function masterStores_() {
  var values = masterSheet_().getDataRange().getValues();
  var hr = -1, cStore = -1, cSup = -1, cRegion = -1;
  for (var i = 0; i < Math.min(values.length, 12); i++) {
    var row = values[i].map(function (x) { return String(x == null ? '' : x).replace(/\s/g, ''); });
    var si = row.indexOf('門市');
    var pi = row.map(function (x) { return x.indexOf('督導') >= 0; }).indexOf(true);
    if (si >= 0 && pi >= 0) { hr = i; cStore = si; cSup = pi; cRegion = row.indexOf('區域'); break; }
  }
  if (hr < 0) throw new Error('門店資料表找不到「門市」與「督導」欄位（請確認分頁 gid）');
  var out = [], idx = {};
  for (var r = hr + 1; r < values.length; r++) {
    var name = String(values[r][cStore] == null ? '' : values[r][cStore]).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    var sup = String(values[r][cSup] == null ? '' : values[r][cSup]).replace(/\s+/g, ' ').trim();
    var region = cRegion >= 0 ? String(values[r][cRegion] == null ? '' : values[r][cRegion]).replace(/\s+/g, ' ').trim() : '';
    var key = normStore_(name);
    if (idx[key]) { if (sup && !idx[key].sup) idx[key].sup = sup; continue; }
    var rec = { name: name, sup: sup, region: region };
    idx[key] = rec; out.push(rec);
  }
  if (!out.length) throw new Error('門店資料表沒有讀到任何門市');
  return out;
}
// 門市名稱正規化（各系統有的帶「店」字尾、有的沒有，比對時一律去掉）
function normStore_(s) { return String(s == null ? '' : s).trim().replace(/店$/, ''); }
// 從主檔同步門市／督導到 STORE_DIRECTORY（只新增與更新）
function syncStoresFromMaster_(body) {
  var master = masterStores_();
  var dir = directory_(), out = {};
  Object.keys(dir).forEach(function (k) { out[k] = dir[k]; });
  var reg = storeRegions_(), regOut = {}, order = [], seenReg = {};
  Object.keys(reg).forEach(function (k) { regOut[k] = reg[k]; });
  var idx = {};
  Object.keys(out).forEach(function (k) { idx[normStore_(k)] = k; });
  var added = [], changed = [], moved = [], seen = {};
  master.forEach(function (rec) {
    var key = normStore_(rec.name);
    if (!key) return;
    seen[key] = 1;
    var name = idx[key];
    if (!name) { name = rec.name; idx[key] = name; out[name] = ''; added.push(name); }
    if (rec.sup && out[name] !== rec.sup) { out[name] = rec.sup; changed.push(name + '→' + rec.sup); }
    if (rec.region) {
      if (regOut[name] && regOut[name] !== rec.region) moved.push(name + '：' + regOut[name] + '→' + rec.region);
      regOut[name] = rec.region;
      if (!seenReg[rec.region]) { seenReg[rec.region] = 1; order.push(rec.region); }
    }
  });
  setProp_('STORE_REGIONS', JSON.stringify(regOut));
  if (order.length) setProp_('REGION_ORDER', JSON.stringify(order));
  var onlyHere = Object.keys(idx).filter(function (k) { return !seen[k]; }).map(function (k) { return idx[k]; });
  setProp_('STORE_DIRECTORY', JSON.stringify(out));
  setProp_('STORE_SYNC_AT', new Date().toISOString());
  var res = {
    stores: Object.keys(out).length, added: added, supervisorChanged: changed, regionMoved: moved,
    onlyInRepair: onlyHere, at: prop_('STORE_SYNC_AT')
  };
  if (!(body && body.noFanout)) res.peers = fanoutSync_();
  return res;
}
// 同步後通知另外兩套系統也各自去主檔同步一次（失敗不影響本系統）
function fanoutSync_() {
  return PEER_SYSTEMS.map(function (p) {
    try {
      var payload = { action: 'syncStores', noFanout: true };
      Object.keys(p.auth).forEach(function (k) { payload[k] = p.auth[k]; });
      var res = UrlFetchApp.fetch(p.url, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      var j = JSON.parse(res.getContentText());
      var d = j.data || j;
      return { system: p.name, ok: !!j.ok, stores: d.stores || 0,
               added: (d.added || []).length, changed: (d.supervisorChanged || []).length, error: j.error || '' };
    } catch (e) { return { system: p.name, ok: false, error: String((e && e.message) || e) }; }
  });
}
// 編輯器工具：確認主檔讀得到
function checkMasterSheet() {
  var list = masterStores_();
  Logger.log('主檔門市數：' + list.length);
  Logger.log(JSON.stringify(list.slice(0, 3)));
  return list.length;
}
// 每日自動同步：編輯器左側「觸發條件」新增 → 函式 dailySyncStores、時間驅動、每日
function dailySyncStores() {
  try { Logger.log('門市同步完成：' + JSON.stringify(syncStoresFromMaster_({ noFanout: true }))); }
  catch (e) { Logger.log('門市同步失敗：' + e); }
}

// ─────────────────────── 督導 Email 通知 ───────────────────────
// 內建預設 Email（可由網頁「督導 Email 通知」覆寫，覆寫值存 SUPERVISOR_EMAILS）
var DEFAULT_EMAILS = {
  '林雨慈 Ivory':  'ivorylin@1992sharetea.com',
  '呂韋興 Robert': 'Robertlu@1992sharetea.com',
  '許瑛琪 Lydia':  'lydiahsu@1992sharetea.com',
  '劉靜蓮 Jill':   'jillianliu@1992sharetea.com',
  '劉邦鑫 Benson': 'bensonliu@1992sharetea.com',
  '林凱琳 Liisa':  'liisalin@1992sharetea.com'
};
// 預設值為底，網頁儲存的值覆寫其上
function supervisorEmails_() {
  var out = {}, stored = safeJson_(prop_('SUPERVISOR_EMAILS'), {});
  Object.keys(DEFAULT_EMAILS).forEach(function (k) { out[k] = DEFAULT_EMAILS[k]; });
  Object.keys(stored).forEach(function (k) { if (stored[k]) out[k] = stored[k]; });
  return out;
}
function saveEmails_(body) {
  if (body.emails != null) setProp_('SUPERVISOR_EMAILS', JSON.stringify(body.emails));
  return { saved: true };
}
// 依督導名找 Email（容錯：完整比對不到時，比對中文姓名／英文名）
function emailFor_(supervisor) {
  var map = supervisorEmails_(), s = String(supervisor || '').trim();
  if (map[s]) return map[s];
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i]; if (!map[k]) continue;
    if (k.indexOf(s) >= 0 || (s && s.indexOf(k) >= 0)) return map[k];
    if (k.split(/\s+/)[0] === s.split(/\s+/)[0] && s) return map[k];  // 中文姓名相同
  }
  return '';
}
// 寄 Email 給該案件督導（處理進度／修繕確認有更新時）
function emailNotify_(o, changes) {
  var email = String(emailFor_(o.supervisor) || '').trim();
  if (!email) return { emailed: false, reason: '督導「' + (o.supervisor || '未指派') + '」未設定 Email' };
  var subject = '【UG修繕｜進度更新】' + o.store + '｜' + o.equipment + '（' + o.status + '）';
  MailApp.sendEmail({ to: email, subject: subject, body: emailBody_(o, changes), htmlBody: emailBodyHtml_(o, changes) });
  return { emailed: true, to: email };
}
// ── 相關單位（部門）Email ──
// 內建預設（可由網頁「單位 Email 通知」覆寫，覆寫值存 UNIT_EMAILS）。多位收件人用逗號分隔。
var DEFAULT_UNIT_EMAILS = {
  '工務': 'raychien@1992sharetea.com, chrislien@1992sharetea.com',
  '採購': 'elenasee@1992sharetea.com',
  '資訊': ''
};
function unitEmails_() {
  var out = {}, stored = safeJson_(prop_('UNIT_EMAILS'), {});
  Object.keys(DEFAULT_UNIT_EMAILS).forEach(function (k) { out[k] = DEFAULT_UNIT_EMAILS[k]; });
  Object.keys(stored).forEach(function (k) { if (stored[k]) out[k] = stored[k]; });
  return out;
}
function saveUnitEmails_(body) {
  if (body.emails != null) setProp_('UNIT_EMAILS', JSON.stringify(body.emails));
  return { saved: true };
}
// 依單位名找 Email（容錯：「工務部」也能對到「工務」）
function unitEmailFor_(unit) {
  var map = unitEmails_(), u = String(unit || '').trim();
  if (map[u]) return map[u];
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i]; if (!map[k]) continue;
    if (k.indexOf(u) >= 0 || (u && u.indexOf(k) >= 0)) return map[k];
  }
  return '';
}
// 寄 Email 給相關單位（新案件、更換負責單位時）
function unitEmailNotify_(o, headline) {
  var to = String(unitEmailFor_(o.handleUnit) || '').trim();
  if (!to) return { unitEmailed: false, unitReason: '單位「' + (o.handleUnit || '未指定') + '」未設定 Email' };
  var subject = '【UG修繕｜' + headline + '】' + o.store + '｜' + o.equipment + '（' + o.handleUnit + '）';
  var chg = [['通知事由', headline]];
  MailApp.sendEmail({ to: to, subject: subject, body: emailBody_(o, chg), htmlBody: emailBodyHtml_(o, chg) });
  return { unitEmailed: true, unitTo: to };
}
// 該案件在「案件管理」的深連結（點了會自動打開該案件）
function caseLink_(o) {
  var base = prop_('LINE_LINK') || '';
  if (!base) return '';
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'case=' + encodeURIComponent(o.id);
}
// 純文字版（HTML 不支援時的後備）
function emailBody_(o, changes) {
  var L = [
    '修繕案件有進度更新，內容如下：', '',
    '案號：' + o.id,
    '門市：' + o.store,
    '督導：' + (o.supervisor || '-'),
    '報修項目：' + o.equipment,
    '設備編號：' + (o.equipNo || '-'),
    '相關單位：' + (o.handleUnit || '-'),
    '聯絡人：' + (o.contact || '-') + '　電話：' + (o.phone || '-'),
    '目前狀態：' + o.status,
    '問題描述：' + (o.description || '-'), ''
  ];
  L.push('── 本次更新 ──');
  changes.forEach(function (c) { L.push('【' + c[0] + '】' + c[1]); });
  var link = caseLink_(o);
  if (link) { L.push(''); L.push('開啟此案件：' + link); }
  L.push(''); L.push('（本信由 UG 門市修繕進度系統自動發送）');
  return L.join('\n');
}
// HTML 版（網址／按鈕可直接點）
function emailBodyHtml_(o, changes) {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  var rows = [
    ['案號', o.id], ['門市', o.store], ['督導', o.supervisor || '-'],
    ['報修項目', o.equipment], ['設備編號', o.equipNo || '-'], ['相關單位', o.handleUnit || '-'],
    ['聯絡', (o.contact || '-') + (o.phone ? '　' + o.phone : '')], ['目前狀態', o.status], ['問題描述', o.description || '-']
  ];
  var h = '<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#2c2c2c">';
  h += '<p>修繕案件有更新，內容如下：</p><table style="border-collapse:collapse">';
  rows.forEach(function (r) { h += '<tr><td style="padding:2px 12px 2px 0;color:#6b6b6b;white-space:nowrap;vertical-align:top">' + esc(r[0]) + '</td><td style="padding:2px 0">' + esc(r[1]) + '</td></tr>'; });
  h += '</table>';
  if (changes && changes.length) {
    h += '<p style="margin:12px 0 4px"><b>── 本次更新 ──</b></p><ul style="margin:0;padding-left:18px">';
    changes.forEach(function (c) { h += '<li><b>' + esc(c[0]) + '</b>：' + esc(c[1]) + '</li>'; });
    h += '</ul>';
  }
  var link = caseLink_(o);
  if (link) h += '<p style="margin-top:18px"><a href="' + link + '" style="display:inline-block;background:#2e7d5b;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">👉 開啟此案件</a></p>';
  h += '<p style="color:#999;font-size:12px;margin-top:16px">（本信由 UG 門市修繕進度系統自動發送）</p></div>';
  return h;
}
// ─────────────────────── 試算表 / 工具 ───────────────────────
function ss_() {
  var id = prop_('SPREADSHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var s = SpreadsheetApp.create(CONFIG.SHEET_NAME);
  setProp_('SPREADSHEET_ID', s.getId());
  return s;
}
function repairSheet_() { return sheetWith_('repairs', REPAIR_HEADERS); }
function attSheet_()    { return sheetWith_('attachments', ATT_HEADERS); }
function sheetWith_(name, headers) {
  var s = ss_(); var sh = s.getSheetByName(name);
  if (!sh) { sh = s.insertSheet(name); sh.appendRow(headers); return sh; }
  if (sh.getLastRow() === 0) { sh.appendRow(headers); return sh; }
  // schema 演進：把缺少的欄位標題補在最後（與 headers 末端新增順序一致，appendRow 才不會錯位）
  var cur = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var missing = headers.filter(function (h) { return cur.indexOf(h) < 0; });
  if (missing.length) sh.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]);
  return sh;
}
function rowToObj_(headers, row) {
  var o = {};
  for (var i = 0; i < headers.length; i++) {
    var v = row[i];
    if (v instanceof Date) v = v.toISOString();
    o[headers[i]] = v;
  }
  return o;
}
function setCell_(sh, rowIdx, header, val) {
  var c = REPAIR_HEADERS.indexOf(header); if (c < 0) return;
  sh.getRange(rowIdx + 1, c + 1).setValue(val);
}
function genId_(store, d) {
  var base = 'R' + ymd_(d).replace(/-/g, '') + '-' + Math.floor(Math.random() * 9000 + 1000);
  return base;
}
function ymd_(d) {
  return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
}
function truncate_(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function uniq_(a) { return a.filter(function (v, i) { return v && a.indexOf(v) === i; }); }
function safeJson_(s, d) { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }

function ok_(obj) { obj = obj || {}; obj.ok = true; return json_(obj); }
function err_(msg) { return json_({ ok: false, error: msg }); }
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────── 編輯器專用：首次授權 ───────────────────────
function setup() {
  // 在編輯器執行一次，建立試算表 + 種子設定 + 觸發授權
  ss_(); repairSheet_(); attSheet_();
  if (!prop_('API_TOKEN')) setProp_('API_TOKEN', CONFIG.API_TOKEN);
  setProp_('ADMIN_KEY', CONFIG.ADMIN_KEY);
  PropertiesService.getScriptProperties().deleteProperty('ADMIN_PASSWORDS'); // 清除舊密碼
  if (!prop_('STORE_DIRECTORY')) setProp_('STORE_DIRECTORY', JSON.stringify(DEFAULT_DIRECTORY));
  PropertiesService.getScriptProperties().deleteProperty('EQUIPMENT_LIST'); // 舊扁平設備清單已改為分區設定 ZONES_CONFIG
  photoFolder_(); // 裸呼叫 DriveApp，逼出 Drive 權限同意畫面（照片上傳用）
  Logger.log('setup done. spreadsheet=' + prop_('SPREADSHEET_ID') + ' photoFolder=' + prop_('PHOTO_FOLDER_ID'));
}
// 若 Drive 權限沒被逼出來，在編輯器執行這個（裸呼叫，勿包 try/catch）
function forceAuthDrive() {
  var fo = photoFolder_();
  var f = fo.createFile(Utilities.newBlob('ok', 'text/plain', 'auth_probe.txt'));
  Logger.log('drive ok, folder=' + fo.getId() + ' probe=' + f.getId());
  f.setTrashed(true);
}
// 強制逼出寄信授權（裸呼叫，勿包 try/catch）→ 在編輯器執行一次
// 會把測試信寄到你在網頁「督導 Email 通知」設定的第一個信箱（先設定再執行本函式）
function forceAuthMail() {
  var emails = supervisorEmails_(), to = '';
  Object.keys(emails).forEach(function (k) { if (!to && emails[k]) to = emails[k]; });
  if (!to) throw new Error('請先到網頁「設定 → 督導 Email 通知」填一個信箱並儲存，再執行本函式');
  MailApp.sendEmail(to, 'UG修繕 Email 授權測試', '收到這封信代表 Email 通知功能已授權完成，可正常使用。');
  Logger.log('test mail sent to ' + to);
}
// 強制逼出對外連線授權（裸呼叫，勿包 try/catch）→ 在編輯器執行
function forceAuthLine() {
  var token = prop_('LINE_TOKEN') || '';
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  Logger.log('HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
}
