# TS 引擎遷移 — 2026-09-26 交接

## 2026-09-26 最新狀態

- 分支 `codex/ts-engine-union-parity`；正式網站仍用 Python/Pyodide，TS 核心尚未接到畫面或部署。`master` 保持原狀。
- 29 組 Python golden（固定亂數）：22 組總傷完全相同、29 組都在 ±1% 內，最大差約 −0.10%；29 組 Full Burst 次數相同。`parity:engine` 仍刻意失敗，不能切換正式引擎。
- 新增 `parity:expected`，在 Python／TS 都用預期值模式重算 29 組，隔離暴擊亂數呼叫順序：22 組完全相同、29 組都在 ±0.1% 內，最大差 +0.059366%。固定亂數差距有同時刻兩段傷害的暴擊分配順序；預期值仍有少量差距，不能說公式完全一致。
- 31 組本機帳號的標準化 180 秒試跑：11 組完全相同，全部在 ±0.1% 內。這不是 9/20 當期 Boss 的逐盤重播。
- `parity:boss-phases`：六類 Boss 區間與重疊規則，13 組 Python 固定數字的總傷、命中數、逐角色傷害完全相同。`strictNoBurst` 已接入 TS 爆裂控制。這不涵蓋上游完整 Boss 行動排程。
- 新修正 CDN 開火後延遲、`DOWN_Charge` 最短開火週期、武器變更後的蓄力階段與原武器滿彈復歸、CDN 分段裝填比例與 `reload_ratio_pct` 技能、扣彈後最低零發、CDN 回掩體自動裝填、同一發先處理攻擊次數再處理命中。渡鴉、絲絨、「小隊 2」、翠娜／紅蓮隊及兩組葛雷夫隊固定基準已完全相同。先前約 −50% 的透芙霰彈隊已完全相同、露姬隊約 +0.01%。
- 舊 9/20 結果有 470 筆候選，但缺完整 Boss／角色計算請求，不能宣稱 470 筆已校正。完整新版請求可用聯盟畫面「匯出引擎驗證資料」產生，再用 `parity:evidence` 重播；匯出含角色育成資訊，應妥善保管。
- 最新事件順序修正後的完整前端回歸為 44 檔／742 項通過；正式建置、Python 原引擎 snapshot 29/29、doclint 及 Boss 區間 13/13 也已通過。
- 下一步：追預期值模式剩餘最大 +0.059366% 的明日香／露德米拉隊；取得實際 Boss 完整請求後重播候選及 HiGHS 排刀；29 組 golden、真實聯盟請求、排刀與瀏覽器 worker 驗證完成後才接正式路徑。合併 `master` 會觸發部署，須先依 `AGENTS.md` 請使用者確認。

以下 2026-09-25 段落為當時的歷史紀錄，數值與待辦以本節為準。

## 狀態

- 工作分支：`codex/ts-engine-union-parity`，從 `d0f37a0` 的 `master` 分出。
- 原 Python/Pyodide worker 仍是網站正式計算路徑。TS 核心已放在 `site/src/engine/`，但尚未接到畫面或部署計算。
- TS 原始碼取自 `Moris-kr/nikke-calc` 2026-09-25 `master`；fork 相容調整在 `data.ts`、`bridge.ts`、`timeline.ts`、`engine.worker.ts`。
- 不可切換正式引擎：`npm run parity:engine` 目前 29 組只有 0 組總傷完全相等。此指令回傳失敗是刻意的阻擋訊號。

## 本階段已做

1. 原 fork Python golden snapshot：`python -m context.snapshot` 29/29 通過。
2. 新增 `npm run parity:engine`，從現有 `context.snapshot.SQUADS` 和 baseline 直接對比 TS 引擎；可用 `--case=名稱 --json` 追逐角色、逐技能、命中數、增益目標與 Full Burst。最新 TS 29 組中 23 組總傷在 ±1% 內、10 組完全相同，Full Burst 次數已全部相同。此處百分比按總傷計算；即使總傷相同，逐技能仍須核對。
3. TS 橋接預設改為 fork 的固定回充與首爆 3 秒；在記憶體補上等級表稀有度鍵，不改 JSON 正本。單人 10 秒的 Python／TS 結果均為 3,427,327、240 hits。
4. 發現 TS 漏發 `full_charge_fire`，導致某角色持續傷害 173 次完全消失。補上觸發後，本機 31 組帳號的**標準化、非當期 Boss** 180 秒試跑，最新為 10 組完全相同、中位差 0%，只有 1 組超過 ±1%，最差 −6.13%。資料僅在操作者本機，未提交。
   另補上 fork 的 `full_charge_fire_count:N`、`full_charge_hit_count:N` 及舊稱 `full_charge_count:N` 索引與門檻。這修復冷卻縮短效果原本永不觸發的問題；四組原本 14→9 的 Full Burst 差異消失。其中一組總傷差從 −49.81% 改善為 −8.92%。
   `on_attack_count:{0}` 需要按技能等級代入門檻。原先透芙愛藏品的「急造彈丸」完全未觸發，使其彈藥與霰彈攻速增益整條失效；修正後固定基準「第三隊」由 −49.21% 到約 0%，命中數與該技能觸發次數相同。
   同一角色的兩個 `fullburst_duration` 效果必須分別累計。另撤除上游 TS 的角色名稱排序，保留 fork 原編隊順序；攻擊力並列時，米蘭達的增益因此回到 Python 選擇的海倫，該基準由 +12.55% 到 −0.51%。
5. 新增聯盟畫面的「匯出引擎驗證資料」：每盤完整 `SimulationRequest` 與精簡結果，以匿名流水號連結同一成員；不含姓名、openid 或 cookie。原「匯出試算結果」格式不變。驗證檔仍含角色育成資料，僅本機或可信任對象使用。
6. 新增 `npm run parity:evidence -- <檔案>`，讓 TS 用完整請求重跑並以盤號輸出差值；一筆合成樣本完全相符。
7. 本階段驗證：Python snapshot 29/29、doclint OK；前端完整測試 44 檔／735 項通過，正式建置通過。TS/Python parity gate 仍刻意失敗（10/29 完全相同），不應把此 gate 視為已放行。

## 使用者提供資料與限制

- 舊結果檔有 470 筆候選，31 份本機 JSON 成功匯入 profile；455 筆候選對得上這批 profile。原始 JSON 中有帳號 cookie，未讀取值、未複製到 repo、未提交。
- 舊結果檔只存 `phases` 與候選的隊伍／總傷，**不含當時完整的 Boss、爆裂與角色請求**，不能作為精確數值對照。實際帳號的 31 組試跑固定使用 180 秒、預期值模式、敵防 31,784，僅診斷引擎；不能宣稱重現 9/20 的 470 筆結果。
- 真實 profile 位於被 Git 忽略的 `profiles/`；任何提交都只明確加入程式及文件路徑，不執行 `git add .`。

## 下一步

1. 追仍未對齊的技能效果，優先是渡鴉隊伍的蓄力與「衝擊波」持續傷害：29 組固定基準中最大差 −6.83%，其普通攻擊 Python 83／TS 122 次，衝擊波 Python 170／TS 128 次。每修一類就重跑 29 組閘門。
2. 移植 fork 專用 `bossPhases`（六種區間）和 `strictNoBurst`。目前 TS 橋接會明確拒絕這兩種輸入，防止忽略條件後輸出錯誤傷害。
3. 取得新版完整驗證匯出後，重跑當期 Boss 與聯盟排刀；比較傷害、可選候選、每人成員三刀與 HiGHS 排刀結果。
4. 在 29 組 golden 完全通過、聯盟真實請求通過前，不把 TS worker 設為預設。合併 `master` 會觸發 Pages 部署，合併前依 `AGENTS.md` 徵求確認。
