# TS 引擎遷移 — 2026-09-25 交接

## 狀態

- 工作分支：`codex/ts-engine-union-parity`，從 `d0f37a0` 的 `master` 分出。
- 原 Python/Pyodide worker 仍是網站正式計算路徑。TS 核心已放在 `site/src/engine/`，但尚未接到畫面或部署計算。
- TS 原始碼取自 `Moris-kr/nikke-calc` 2026-09-25 `master`；fork 相容調整在 `data.ts`、`bridge.ts`、`timeline.ts`、`engine.worker.ts`。
- 不可切換正式引擎：`npm run parity:engine` 目前 29 組只有 0 組總傷完全相等。此指令回傳失敗是刻意的阻擋訊號。

## 本階段已做

1. 原 fork Python golden snapshot：`python -m context.snapshot` 29/29 通過。
2. 新增 `npm run parity:engine`，從現有 `context.snapshot.SQUADS` 和 baseline 直接對比 TS 引擎；輸出總傷、逐角色及 Full Burst 次數。TS 29 組中 6 組總傷在 ±1% 內、0 組完全相同，4 組 Full Burst 次數不同（14→9）。
3. TS 橋接預設改為 fork 的固定回充與首爆 3 秒；在記憶體補上等級表稀有度鍵，不改 JSON 正本。單人 10 秒的 Python／TS 結果均為 3,427,327、240 hits。
4. 發現 TS 漏發 `full_charge_fire`，導致某角色持續傷害 173 次完全消失。補上觸發後，本機 31 組帳號的**標準化、非當期 Boss** 180 秒試跑改善為 5 組完全相同，中位差 0%，最差 −6.13%。資料僅在操作者本機，未提交。
5. 新增聯盟畫面的「匯出引擎驗證資料」：每盤完整 `SimulationRequest` 與精簡結果，以匿名流水號連結同一成員；不含姓名、openid 或 cookie。原「匯出試算結果」格式不變。驗證檔仍含角色育成資料，僅本機或可信任對象使用。
6. 新增 `npm run parity:evidence -- <檔案>`，讓 TS 用完整請求重跑並以盤號輸出差值；一筆合成樣本完全相符。

## 使用者提供資料與限制

- 舊結果檔有 470 筆候選，31 份本機 JSON 成功匯入 profile；455 筆候選對得上這批 profile。原始 JSON 中有帳號 cookie，未讀取值、未複製到 repo、未提交。
- 舊結果檔只存 `phases` 與候選的隊伍／總傷，**不含當時完整的 Boss、爆裂與角色請求**，不能作為精確數值對照。實際帳號的 31 組試跑固定使用 180 秒、預期值模式、敵防 31,784，僅診斷引擎；不能宣稱重現 9/20 的 470 筆結果。
- 真實 profile 位於被 Git 忽略的 `profiles/`；任何提交都只明確加入程式及文件路徑，不執行 `git add .`。

## 下一步

1. 分別追 4 組 Full Burst 14→9，以及爆裂次數相同卻差數十％的技能效果。優先比較事件時間軸與逐角色命中；每修一類就重跑 29 組閘門。
2. 移植 fork 專用 `bossPhases`（六種區間）和 `strictNoBurst`。目前 TS 橋接會明確拒絕這兩種輸入，防止忽略條件後輸出錯誤傷害。
3. 取得新版完整驗證匯出後，重跑當期 Boss 與聯盟排刀；比較傷害、可選候選、每人成員三刀與 HiGHS 排刀結果。
4. 在 29 組 golden 完全通過、聯盟真實請求通過前，不把 TS worker 設為預設。合併 `master` 會觸發 Pages 部署，合併前依 `AGENTS.md` 徵求確認。
