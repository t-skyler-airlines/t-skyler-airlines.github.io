// ============================================================================
// T-Skyler 會員卡 → Apple / Google 錢包 產生器（Cloudflare Worker）
// ----------------------------------------------------------------------------
// 作用：
//   1. 把 WalletWallet 的 API key 藏在 Worker secret 裡（不會外流到前端）
//   2. 限制只有官網來源可以呼叫（CORS 白名單）
//   3. 每天最多只能產生 DAILY_LIMIT 張卡（用 KV 計數，台北時區換日）
//   4. 呼叫 WalletWallet 產生簽章過的 .pkpass，回傳給瀏覽器
//      → iPhone Safari 會跳出「加入 Apple 錢包」；桌機則下載 .pkpass
//
// 需要的繫結（在 wrangler.toml / dashboard 設定）：
//   - KV 命名空間  PASS_KV
//   - Secret      WALLETWALLET_KEY   (ww_live_...)
// ============================================================================

const ALLOWED_ORIGINS = [
  'https://t-skyler-airlines.github.io',
  'http://localhost:8765',   // 本機預覽（可自行移除）
  'http://127.0.0.1:8765',
];

const DAILY_LIMIT = 20;        // 每天最多產生幾張會員卡
const TZ_OFFSET_MIN = 8 * 60;  // 台北 UTC+8，用來決定「今天」

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405, cors);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'forbidden_origin' }, 403, cors);
    if (!env.WALLETWALLET_KEY)        return json({ error: 'server_not_configured' }, 500, cors);

    // ---- 每日上限（KV 計數，以台北日期為界）----
    const day = localDayKey();
    const key = `count:${day}`;
    const count = parseInt((await env.PASS_KV.get(key)) || '0', 10) || 0;
    if (count >= DAILY_LIMIT) {
      return json({ error: 'daily_limit', limit: DAILY_LIMIT, used: count }, 429, cors);
    }

    // ---- 讀取前端送來的會員資料並清洗 ----
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const name     = sanitize(body.name, 40)      || 'T-Skyler Member';
    const memberNo = sanitize(body.memberNo, 24)  || 'TS 000 000 000';
    const tierCode = sanitize(body.tier, 16).toUpperCase() || 'EXPLORER';
    const tierName = sanitize(body.tierName, 24)  || titleCase(tierCode);
    const miles    = sanitize(String(body.miles == null ? '0' : body.miles), 16) || '0';
    const since    = sanitize(String(body.since == null ? '' : body.since), 8);
    const barcode  = sanitize(body.barcodeValue, 256) || memberNo;

    const PRESET = { EXPLORER: 'dark', SILVER: 'dark', GOLD: 'orange', PLATINUM: 'purple' };
    const colorPreset = PRESET[tierCode] || 'dark';

    const payload = {
      organizationName: 'T-Skyler Airlines',
      logoText: 'T-SKYLER CLUB',
      description: 'T-Skyler Club Membership Card',
      colorPreset,
      barcodeValue: barcode,
      barcodeFormat: 'QR',
      headerFields:    [{ label: 'MILES', value: miles }],
      primaryFields:   [{ label: 'MEMBER', value: name }],
      secondaryFields: [{ label: 'TIER', value: tierName }, { label: 'SINCE', value: since }],
      auxiliaryFields: [{ label: 'CARD NO.', value: memberNo }],
      backFields: [
        { label: 'About', value: 'Tschool Aviation Research Club — virtual membership card.' },
        { label: 'Website', value: 'https://t-skyler-airlines.github.io' },
      ],
    };

    // ---- 呼叫 WalletWallet ----
    let ww;
    try {
      ww = await fetch('https://api.walletwallet.dev/api/passes', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WALLETWALLET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ error: 'upstream_unreachable', detail: String(e).slice(0, 200) }, 502, cors);
    }

    if (!ww.ok) {
      const detail = (await ww.text().catch(() => '')).slice(0, 500);
      return json({ error: 'walletwallet_error', status: ww.status, detail }, 502, cors);
    }

    // ---- 成功：先加計數（只算成功的），再回傳 .pkpass ----
    ctx.waitUntil(env.PASS_KV.put(key, String(count + 1), { expirationTtl: 60 * 60 * 48 }));

    const ct = (ww.headers.get('Content-Type') || '').toLowerCase();

    // 直接是 .pkpass 二進位 → 原樣轉送
    if (ct.includes('application/vnd.apple.pkpass') || ct.includes('octet-stream')) {
      const buf = await ww.arrayBuffer();
      return pkpassResponse(buf, cors);
    }

    // JSON 回應 → 找出 pass（base64 或下載網址）
    const data = await ww.json().catch(() => ({}));
    const b64 = data.pkpass || data.applePass || data.pkpassBase64 || data.applePassBase64;
    if (b64) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return pkpassResponse(bytes, cors);
    }
    const applePassUrl = data.applePassUrl || data.passUrl || data.url || data.downloadUrl || null;
    const googlePayUrl = data.googlePayUrl || data.googleWalletUrl || data.saveUrl || null;
    return json({ applePassUrl, googlePayUrl, serialNumber: data.serialNumber || null }, 200, cors);
  },
};

// ---------- helpers ----------
function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function pkpassResponse(buf, cors) {
  return new Response(buf, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="tskyler-member.pkpass"',
      'Cache-Control': 'no-store',
    },
  });
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) },
  });
}
function sanitize(v, max) {
  if (v == null) return '';
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // 去除控制字元 (<32) 與角括號 '<'(60) '>'(62)，其餘保留
    if (c >= 32 && c !== 60 && c !== 62) out += s[i];
  }
  return out.trim().slice(0, max || 64);
}
function titleCase(s) { return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; }
function localDayKey() {
  // 以台北時間決定「今天」（UTC+8）
  const d = new Date(Date.now() + TZ_OFFSET_MIN * 60 * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
