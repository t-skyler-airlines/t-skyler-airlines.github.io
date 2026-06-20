# T-Skyler 會員卡 → Apple 錢包（Cloudflare Worker）

把會員卡產生成 **Apple Wallet 的 `.pkpass`**（也回傳 Google 錢包連結），
透過 [WalletWallet](https://www.walletwallet.dev/) 簽章，**API key 藏在 Worker，不會外流到前端**。

- 免費額度：WalletWallet 每月 1,000 張（不需信用卡、每月重置）。
- 本 Worker 另外限制 **每天最多 20 張**（`DAILY_LIMIT`，用 KV 計數、台北時區換日）。
  20 × 31 天 ≈ 620 < 1000，確保不會超過月免費額度。

---

## 一次性部署步驟

> 需要：Node.js、一個 Cloudflare 帳號（免費）、一個 WalletWallet 帳號（免費）。

```bash
# 0) 進到這個資料夾
cd wallet-worker

# 1) 安裝並登入 wrangler（Cloudflare CLI）
npm install -g wrangler
wrangler login

# 2) 建立每日計數用的 KV 命名空間
wrangler kv namespace create PASS_KV
#   → 會印出一行 id = "xxxxxxxx..."，把它貼到 wrangler.toml 的 PASS_KV id

# 3) 設定 WalletWallet 金鑰（會安全地存在 Cloudflare，不進 git）
wrangler secret put WALLETWALLET_KEY
#   → 貼上你的 ww_live_... 金鑰

# 4) 部署
wrangler deploy
#   → 部署完成後會給你一個網址，例如：
#     https://tskyler-wallet.<你的子網域>.workers.dev
```

## 接到官網

把上一步拿到的 Worker 網址，貼到 `index.html` 最上面的設定常數：

```js
var WW_WORKER_URL = 'https://tskyler-wallet.<你的子網域>.workers.dev';
```

填好之後，會員計畫頁的「**加入 Apple 錢包**」按鈕就會自動出現並可使用。
（`WW_WORKER_URL` 留空時，按鈕會自動隱藏，網站照常運作。）

---

## 可調整的設定（`src/worker.js` 最上面）

| 常數 | 預設 | 說明 |
|---|---|---|
| `DAILY_LIMIT` | `20` | 每天最多產生幾張卡 |
| `ALLOWED_ORIGINS` | 官網 + localhost | 允許呼叫的來源（CORS 白名單） |
| `TZ_OFFSET_MIN` | `480`（UTC+8） | 用哪個時區決定「今天」 |

## 本機測試

```bash
wrangler dev          # 本機跑 Worker
# 另開官網本機預覽（http://localhost:8765），把 WW_WORKER_URL 指到 http://127.0.0.1:8787
```

## 注意事項

- 每日上限用 KV 計數，KV 是「最終一致」，極端併發下可能誤差個位數張，
  對 20/天的軟性上限完全足夠。若要嚴格不可超過，可改用 Durable Objects 做原子計數。
- `.pkpass` 必須在 **iPhone 的 Safari** 開啟才會跳出「加入 Apple 錢包」；
  桌機瀏覽器則會直接下載 `.pkpass` 檔。
