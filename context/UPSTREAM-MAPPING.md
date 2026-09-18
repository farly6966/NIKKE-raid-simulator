# 상류 이식 대조표

`Jgaram/nikke-calc`의 엔진 수정이 이 fork에 있는가를 **커밋 단위로** 판정한 기록이다.
「보기에 같다」로 넘기지 않기 위해 판정마다 근거를 적는다.

## 두 상류

이 fork는 `Jgaram/nikke-calc`의 fork가 **아니다.**

```
git merge-base ce75361 Jgaram/master    → 공통 조상 없음
git merge-base ce75361 Moris-kr/master  → f56124d
```

이 저장소의 역사는 `Moris-kr/nikke-calc`에서 왔고, `Jgaram/nikke-calc`는 같은 프로젝트를
새 역사로 다시 발행한 쪽이다(첫 커밋이 2026-08-23 배포 스냅샷). 둘은 서로의 수정을
옮겨 가며 발전해 왔으므로 **같은 결함이 서로 다른 구현으로 이미 고쳐져 있는 경우가 많다.**
그래서 줄 단위 대조는 분류(triage)에만 쓰고, 판정은 언제나 의미로 한다.

## 판정 기준

| 판정 | 뜻 |
|---|---|
| 이미 있음 | 같은 결함이 이 fork에서 이미 고쳐져 있다. 구현이 달라도 된다 |
| 부분 | 본체는 있고 후속 보강만 빠졌다 |
| 필요 | 이 fork에 그 결함이 살아 있다 |
| 불필요 | 이 fork의 구조에서는 성립하지 않는다 |

## C 구간 — 근래 엔진 수정

| 커밋 | 내용 | 판정 | 근거 |
|---|---|---|---|
| `b97936b` | 차지 배율을 가산으로 | 이미 있음 | `calculator/damage.py`가 상류 master와 **바이트 동일**이다. damage.py에만 손대는 커밋은 정의상 전부 들어와 있다 |
| `9c0d673` | 「차지 대미지 배율 ▲」은 무기 기본 배율에만 | 이미 있음 | 위와 같음 + `data/base_stat_tables/collection.json`의 SR·RL이 이미 `charge_dmg_mag_pct` |
| `3b2de88` | 일반 공격 한정 크리 버프를 스킬 딜에서 뺀다 | 이미 있음 | `crit_rate_skill`·`crit_dmg_skill` 두 쌍이 `calculator/buff_manager.py`에 있다 |
| `022de31` | 마지막 프레임 스킬 딜 유실 | 이미 있음 | 루프 종료 뒤 `_dot_events`를 다시 수거한다. fork 판본이 더 정교하다 — 속성 게이트와 누적까지 태운다 |
| `11d6f97` | `ally_hp_below`가 시전자가 아닌 수령자를 본다 | 이미 있음 | `_runtime_condition_ok(conditions, ab.caster, caster, actual_recipient, t)` |
| `721f82e` | 나유타 변신 사격을 스킬 대미지로 | 이미 있음 | `calculator/sim_result.py` `_is_normal()`의 이름 붙은 히트 분기 |
| `e38b663` | 무기 변경 중에도 무기 타입은 기본 무기로 | 이미 있음 | `CharState.base_weapon_type` |
| `775a9f4` | 레이븐 쇼크웨이브 중첩만큼 지속 대미지 | 이미 있음 | 레이븐 `dot_damage`에 `scaling: stack_count` |
| `b8d77bf` | 신데렐라 : 크리스탈 웨이브 저격 모드 장탄 | 이미 있음 | 해당 `weapon_change`에 `max_ammo_buff_applies` |
| `524e64a` | 차지 속도 면역 + 레이븐 파츠 | 이미 있음 | **이 fork master의 조상 커밋이다.** 회귀는 `calculator/test_charge_speed_immune.py`·`test_raven_parts.py` |
| `23f5bff` | 차지형 무기 변경 첫 버스트 탄창 | 이미 있음 | 같음. 회귀는 `calculator/test_weapon_change_repeat.py` |
| `4a1f4a9` | 차지 속도 면역은 스킬 버프만 막는다 | 이미 있음 | `524e64a`가 같은 결론을 이미 구현했다. 표현만 다르다 — 상류는 면제 목록을 `{equipment, cube}`로 **열거**하고 fork는 「스킬 소스만 제거」로 **여집합**을 쓴다. 차이가 드러나는 자리는 `collection`뿐이고, `collection.json`에 `charge_speed_pct`가 없어 **현재 도달 불가**다. 실측이 생기면 그때 가른다 |
| `8fd9963` | 차지 여부를 무기 유형에서 분리 | 부분 | 파스칼(비차지 RL)은 fork가 `parsed_nikke.json`의 수동 `fire_mode: "auto"` 오버라이드로 이미 해결했다. **다만 무기 변경 모드 쪽이 비었다** — 드레이크 : 그레이트 빌런 `오버 오버 드라이브`가 상류에는 `charge: true`가 붙어 있는데 fork에는 없어, SG 기본값을 따라 **연사로 돈다** |
| `d5ab3d0` | 무기 변경 최대 장탄 버프 | 부분 | `max_ammo_buff_applies` 본체는 `_full_ammo()`에 있다. 빠진 것은 `_wc_ammo_full` **래치** — 상류는 장탄을 채우는 사건(모드 진입·재장전 완료)에만 다시 재서, 모드 도중 장탄 버프가 붙었다 끊길 때 종료 조건이 흔들리는 것을 막는다 |
| `4f144d7` | 모드 종료 시 만탄 복귀 | **필요** | fork는 `_wc_ammo_borrowed`(= 연사 모드)일 때만 채운다. **차지 모드는 잔탄을 그대로 들고 나온다.** 모드 안에서 잡힌 재장전을 취소하는 처리도, 종료 경로가 둘인 것을 가리는 `_wc_ammo_restored` 플래그도 없다 |
| `63a784e` | 실행 순서·모드 복귀·공짜 풀차지·MG 예열 | **필요** | 발수 소진 종료 경로에는 차지 초기화가 있으나 **지속시간 만료·토글 해제 경로에는 없다.** 모드 진입 전 `_charge_start_t`가 얼어 있다가 복귀 프레임에 공짜 풀차지 한 발이 된다. 영향: 벨벳 `깔끔한 마무리` · 타키나 `제압 개시` · 라플라스 `라플라스 버스터` |
| `927a613` | 「N발 유지」 버프가 자기 조건을 스스로 깬다 | **필요** | `_has_runtime_cond()`에 `duration_bullets` 인자가 없다. 발수 만료 버프는 `expires_at`이 `inf`로 남아 런타임 재평가 게이트를 통과하고, `not_self_state:`로 재부여를 막는 버프가 스스로를 끈다. 영향: 베스티 : 택티컬 업 `미사일 가이드` |
| `b3ec538` | 그레이브 과열 30·60회 카운터 | **필요** | fork의 `parsed_skills.json`에 `과열 명중` 게이지가 없다 |

## A 구간 — 누적식 버스트 게이지 (완료)

| 커밋 | 판정 | 비고 |
|---|---|---|
| `3935b6b` | 이식 완료 | `0adfb79` |
| `f12fc35` | 이식 완료 | `fd674fd` — `context/mechanics/버스트 게이지.md` |
| `1246e2e` | 이식 완료 | `fd674fd` |
| `93ec10a` | 부분 이식 | `tap_fire.window`는 `fd674fd`, 장전컨 정책 C는 `11b1e63`. **남은 것**: `clip_count`(CDN `reload_bullet`) · `reload_ratio_pct`(그레이브 `방열`) · 「무기 변경 상태」 총칭 판정 · `ammo_charge_pct` 음수 하한 |
| `cf0ef28` | 불필요 | 상류가 **자기 하네스 3조합**의 장전컨을 상수(정책 A)에서 정책 C로 옮긴 커밋이다. 이 fork의 29개 baseline 조합에는 컨트롤 설정이 **하나도 없어** 옮길 상수가 없다. baseline에 조작을 새로 얹는 것은 이식이 아니라 하네스 설계 결정이고, 기본 모드가 `fixed`인 동안에는 컨트롤이 손해로만 잡힌다 |
| `1300089` | 건너뜀 | `3b63720`이 통째로 되돌렸다. 중간형의 캘리브 상수(`ally_flat`)는 상류 자신이 「원인 미상·산포 ±30%」로 적어 두고 9일 뒤 제거했다 |
| `3b63720` | 이식 완료 | `15f0268` |

## 다시 확인하는 법

줄 단위 분류는 `git show --format= <커밋> -- calculator/`의 `+` 줄이 fork 소스에 그대로
있는지를 세면 나온다. **그 수치는 분류일 뿐 판정이 아니다** — `63a784e`는 추가된 코드
5줄이 전부 fork에 있었지만 **다른 경로**에 있었고, 정작 고쳐야 할 경로는 비어 있었다.
