# 上游移植對照表

判定 `Jgaram/nikke-calc` 的引擎修正在這個 fork 裡有沒有，**以 commit 為單位**。
為了不要用「看起來一樣」帶過，每個判定都附根據。

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
| `b3ec538` | 格拉維過熱 30·60 次計數器 | **需移植** | fork 的 `parsed_skills.json` 裡沒有「過熱命中」的量表 |

## A 區 —— 累積式爆裂量表（完成）

| commit | 判定 | 備註 |
|---|---|---|
| `3935b6b` | 已移植 | `00c48ac` |
| `f12fc35` | 已移植 | `9ef6b7d` —— `context/mechanics/버스트 게이지.md` |
| `1246e2e` | 已移植 | `9ef6b7d` |
| `93ec10a` | 部分移植 | `tap_fire.window` 在 `9ef6b7d`，裝填控制政策 C 在 `008da4b`。**還剩**：`clip_count`（CDN `reload_bullet`）· `reload_ratio_pct`（格拉維「放熱」）·「武器變更狀態」的總稱判定 · `ammo_charge_pct` 負值下限 |
| `cf0ef28` | 不適用 | 這個 commit 是上游把**自己測試用的 3 個編成**的裝填控制從常數（政策 A）換成政策 C。這個 fork 的 29 個 baseline 編成**一個控制設定都沒有**，沒有常數可以換。在 baseline 上新加操作屬於測試台設計決策，不是移植；而且預設模式還是 `fixed` 的期間，控制只會算成損失 |
| `1300089` | 跳過 | `3b63720` 整個退掉了。中間型的校正常數（`ally_flat`）是上游自己註明「原因不明·離散 ±30%」，9 天後就移除了 |
| `3b63720` | 已移植 | `a0fa513` |

## 怎麼重新確認

逐行分類的做法是數 `git show --format= <commit> -- calculator/` 的 `+` 行有幾行原封不動
出現在 fork 原始碼裡。**那個數字只是分類，不是判定** —— `63a784e` 新增的 5 行程式碼
fork 裡全部都有，但在**別的路徑**上，真正該修的那條路徑是空的。
