# 上游移植對照表

判定 `Jgaram/nikke-calc` 的引擎修正在這個 fork 裡有沒有，**以 commit 為單位**。
為了不要用「看起來一樣」帶過，每個判定都附根據。

**涵蓋率**：upstream 全歷史 86 筆（`ea82f76` 當時），本表目前判定 **35 筆**。
其餘**還沒逐筆判定過** —— 沒進表不等於不適用，只等於沒看過。未判定的清單與分區
待辦在 `docs/上游移植-交接筆記.md` §4。

## 兩個上游

這個 fork **不是** `Jgaram/nikke-calc` 的 fork。

```
git merge-base ce75361 Jgaram/master    → 沒有共同祖先
git merge-base ce75361 Moris-kr/master  → f56124d
```

這個 repo 的歷史來自 `Moris-kr/nikke-calc`，而 `Jgaram/nikke-calc` 是同一個專案
用新歷史重新發佈的那一邊（第一個 commit 是 2026-08-23 的部署快照）。兩邊會互相
搬對方的修正，所以**同一個缺陷常常已經用不同的實作在各自那邊修好了**。
因此逐行對照只用來做分類（triage），判定一律看語意。

## 判定基準

| 判定 | 意思 |
|---|---|
| 已存在 | 同一個缺陷在這個 fork 已經修好了。實作不同也算 |
| 部分 | 本體有，只缺後續補強 |
| 需移植 | 這個缺陷在這個 fork 還活著 |
| 不適用 | 在這個 fork 的結構下不成立 |
| 已移植 | 這次做掉了，附 commit |

## C 區 —— 近期引擎修正

| commit | 內容 | 判定 | 根據 |
|---|---|---|---|
| `b97936b` | 蓄力倍率改為加算 | 已存在 | `calculator/damage.py` 與上游 master **位元組完全相同**。只動 damage.py 的 commit 依定義全部都在 |
| `9c0d673` | 「蓄力傷害倍率 ▲」只吃武器基本倍率 | 已存在 | 同上 + `data/base_stat_tables/collection.json` 的 SR·RL 已經是 `charge_dmg_mag_pct` |
| `3b2de88` | 只對普攻生效的爆擊增益要從技能傷害扣掉 | 已存在 | `crit_rate_skill`·`crit_dmg_skill` 兩組都在 `calculator/buff_manager.py` |
| `022de31` | 最後一格的技能傷害遺失 | 已存在 | 迴圈結束後會再收一次 `_dot_events`。fork 的版本更細 —— 連屬性閘門和累積都算進去 |
| `11d6f97` | `ally_hp_below` 看錯對象（看接收者而非施放者） | 已存在 | `_runtime_condition_ok(conditions, ab.caster, caster, actual_recipient, t)` |
| `721f82e` | 娜由塔變身射擊要算技能傷害 | 已存在 | `calculator/sim_result.py` `_is_normal()` 的具名命中分支 |
| `e38b663` | 武器變更期間武器類型仍看基本武器 | 已存在 | `CharState.base_weapon_type` |
| `775a9f4` | 蕾雯衝擊波依疊層數給持續傷害 | 已存在 | 蕾雯的 `dot_damage` 有 `scaling: stack_count` |
| `b8d77bf` | 灰姑娘：琉璃波光狙擊模式的彈藥 | 已存在 | 該 `weapon_change` 有 `max_ammo_buff_applies` |
| `524e64a` | 蓄力速度免疫 + 蕾雯部位 | 已存在 | **這是本 fork master 的祖先 commit。** 回歸測試在 `calculator/test_charge_speed_immune.py`·`test_raven_parts.py` |
| `23f5bff` | 蓄力型武器變更的第一次爆裂彈匣 | 已存在 | 同上。回歸測試在 `calculator/test_weapon_change_repeat.py` |
| `4a1f4a9` | 蓄力速度免疫只擋技能增益 | 已存在 | `524e64a` 已經實作了同樣的結論，只是寫法不同 —— 上游把豁免清單**列舉**成 `{equipment, cube}`，fork 用「只移除技能來源」取**補集**。唯一會分出差別的位置是 `collection`，而 `collection.json` 裡沒有 `charge_speed_pct`，所以**目前到不了**。有實測再來分 |
| `8fd9963` | 把「是否蓄力」從武器類型分離 | **已移植**（本 commit） | **先前這一列的判定是錯的，這次重驗改寫。** 帕斯卡 fork 本來就用 `parse_nikke.py` 的 `_MANUAL_OVERRIDES` 解決（不是手改產生檔，重新產生不會掉）。德雷克：終極反派「超超速運作」**也本來就在蓄力** —— fork 把那個模式登記成 `weapon_type: RL`（註解記載 2026-09-02 使用者影片確認那是發射器），RL 預設就是蓄力。真正缺的是**原則**：CDN `조작 타입` 這 200 人全都有，但 fork 沒有讀它。這次補上 `is_charge` 推導、`CharState` 以它為正本、以及武器變更效果的 `charge` 欄位。全量比對顯示兩種推導只在帕斯卡一人分開，所以**行為零改變**（snapshot 29/29 無變動），換來的是手寫例外退休、以及日後原文把兩軸拆開時資料可以直接說 |
| `d5ab3d0` | 武器變更的最大彈藥增益 | **已移植** `db3614c` | `max_ammo_buff_applies` 本體本來就在 `_full_ammo()`。這次補的是 `_wc_ammo_full` **鎖存** —— 只在填彈事件（進入模式·裝填完成）重新量測，避免模式進行中彈藥增益開關導致結束條件晃動。順帶把 fork 專屬的量表連動動態彈藥（E.H.）也收進同一個窗口 |
| `4f144d7` | 模式結束時滿彈復歸 | **已移植**（本 commit） | fork 原本只在 `_wc_ammo_borrowed`（= 連射模式）時填，**蓄力模式把剩餘彈藥原封不動帶出來**。而且 `orig_ammo` 在「有發射的 tick」抓到的是模式的剩餘彈藥 → 츠바이 每循環多打一發空彈匣的幽靈射擊。兩條結束路徑用 `_wc_ammo_restored` 保證只填一次 |
| `63a784e` | 執行順序·模式復歸·免費滿蓄力·MG 預熱 | **已移植** `2287c10` | 發數耗盡的結束路徑有蓄力重置，**持續時間到期·切換解除的路徑沒有**。進入模式前的 `_charge_start_t` 凍著，回到原武器就變成一發免費滿蓄力。影響薇爾維特「俐落收尾」· 瀧奈「壓制開始」· 拉普拉斯「拉普拉斯炸彈」 |
| `927a613` | 「N 發維持」的增益自己破壞自己的條件 | **已移植** `5c2cf49` | `_has_runtime_cond()` 沒有 `duration_bullets` 參數。發數到期的增益 `expires_at` 留在 `inf`，通過了 runtime 重新評估的閘門，於是用 `not_self_state:` 擋重複施加的增益把自己關掉。影響貝斯蒂：戰術升級「飛彈導引」。連帶修正了 `parsed_skills.json` 的效果排列 |
| `b3ec538` | 格拉維過熱 30·60 次計數器 | **已移植** `e2a2a21` | fork 的 `parsed_skills.json` 裡沒有「過熱命中」量表，`과열 II·III` 和「未來預知」同一瞬間一起開，30·60 次完全是裝飾。改用虛擬量表（累積 + 每次未來預知歸零）+ `passive` 登錄 + `gauge_above` 執行期判定。純資料，引擎不用動 |
| `ace1a61` | 「武器變更狀態」總稱判定 | 不適用 | 上游的 parser 會吐出泛稱 `self_state:무기 변경`，所以引擎需要一個總稱分支（`_has_self_state` 的 `WEAPON_CHANGE_STATE`）。**fork 的 parser 解析成實際模式名** —— 목단「다 덤벼! 2」的條件是 `self_state:정정당당 승부다!`，而牠 `weapon_change` 項目的 `name` 正是同一個字串，字面比對就成立。`data/parsed_skills.json` 全檔 `self_state:무기 변경` 出現 **0 次**，泛稱這條路在 fork 到不了。日後若 parser 改成吐泛稱，這一列要重驗 |
| `35d8c20` | 格拉維放熱：無限彈藥 + 掩體中斷裝填 | 部分移植 | 三件事。**`infinite_ammo` 已存在** —— fork 叫 `max_ammo_infinite`，`test_roster_batch06` 有釘。**掩體那半已移植** `7cf88f8`：有限掩體到期時收掉進行中的裝填（還有彈就當場切，0 發等下一個彈夾），`_finish_reload` 的 docstring 本來就記著這個缺口。⚠️ 判定要放在 `tick()` 的裝填完成檢查**之前** —— 那個檢查在裝填進行中就 `return`，加在 `_tick_cover` 裡是死碼。**還剩** `reload_ratio_pct`，見 A 區 `93ec10a` |

## A 區 —— 累積式爆裂量表（完成）

| commit | 判定 | 備註 |
|---|---|---|
| `3935b6b` | 已移植 | `00c48ac` |
| `f12fc35` | 已移植 | `9ef6b7d` —— `context/mechanics/버스트 게이지.md` |
| `1246e2e` | 已移植 | `9ef6b7d` |
| `93ec10a` | 部分移植 | `tap_fire.window` 在 `9ef6b7d`，裝填控制政策 C 在 `008da4b`，`ammo_charge_pct` 負值下限在 `d85ac2f`。「武器變更狀態」總稱判定移到下面 `ace1a61` 那一列判定（不適用）。**還剩**：`clip_count`（CDN `reload_bullet`）· `reload_ratio_pct`（格拉維「放熱」）—— 兩項同源，都要先把 `reload_bullet` 收進 `scraper/nikke_scraped.json`（**需使用者點頭重抓 CDN**，那是原始資料唯一正本） |
| `cf0ef28` | 不適用 | 這個 commit 是上游把**自己測試用的 3 個編成**的裝填控制從常數（政策 A）換成政策 C。這個 fork 的 29 個 baseline 編成**一個控制設定都沒有**，沒有常數可以換。在 baseline 上新加操作屬於測試台設計決策，不是移植；而且預設模式還是 `fixed` 的期間，控制只會算成損失 |
| `1300089` | 跳過 | `3b63720` 整個退掉了。中間型的校正常數（`ally_flat`）是上游自己註明「原因不明·離散 ±30%」，9 天後就移除了 |
| `3b63720` | 已移植 | `a0fa513` |

## B 區 —— 操作與鏡頭仲裁

| commit | 內容 | 判定 | 根據 |
|---|---|---|---|
| `c751e2a` · `54e30af` | 首循環 Full Burst 預測 | **已移植** `997170e` | 政策 B·`if_dry` 原本只有「前一循環週期」觀測，第一循環沒值就不作用（CONTROL.md §미구현 記著）。補上冷卻鏈 fallback。**觀測仍優先** —— 鏈條看不到還沒撒下的 `burst_cooldown_reduce`。值只在 Full Burst 結束取一次，否則「每循環一次」守衛失效。fork 調整兩處：階段延遲是 `burst_switch_delay + burst_reaction`（上游只有前者）、`_burst_delay` 項拿掉（`544adeb` 未移植）。實測誤差 +0.020 秒 |
| `8d16ea5`（클릭 스케줄） | `control.click` 統一 톡톡이／홀드 | **已移植** `8ae5faf` | 四窗 × 三模式，先匹配者勝，按下／放開分開詢問。舊鍵 desugar，**baseline 29/29 一格未動**。順帶拿掉 `_tick_charge` 重複的 `_hold_release_t < 0` 守衛 —— 留著排程順序沒有意義 |
| `8d16ea5`（조작 모드） | `control_mode` solo／warn／strict | 需移植 | ↓ 與下列同批 |
| `c961351` | 카메라 경합依等級仲裁 | 需移植 | fork 的 `camera`／`camera_mode` 是 **config 層靜態指定**；仲裁是**執行期會變的歸屬**，不是同一個東西。動它會改到 `컨트롤_*` 兩條 baseline |
| `ac8fe2a` | anchor 語法·window enum·裝填控制 3 政策 | 需移植 | anchor／gate 是為了餵 `c961351` 而存在 |
| `544adeb` | 爆裂納入 control·第五按鈕·delayed burst | 需移植 | priority 同上。`_burst_delay` 也在這裡 |
| `29c7ce1` | attachment schema 統一 | 需移植 | — |
| `cf8c9ec` | runtime control condition 擴充 | 需移植 | — |
| `ec774c7` | 武器變更中控制排程不能停住 | 需移植 | — |

**剩下七筆咬在一起**，拆開做沒有意義：`ac8fe2a` 的 anchor／gate 與 `544adeb` 的
priority 都是 `c961351` 相機仲裁的輸入。

## 怎麼重新確認

逐行分類的做法是數 `git show --format= <commit> -- calculator/` 的 `+` 行有幾行原封不動
出現在 fork 原始碼裡。**那個數字只是分類，不是判定** —— `63a784e` 新增的 5 行程式碼
fork 裡全部都有，但在**別的路徑**上，真正該修的那條路徑是空的。
