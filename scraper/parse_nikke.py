#!/usr/bin/env python3
"""
parse_nikke.py
nikke_scraped.json → data/parsed_nikke.json

캐릭터별 속성/클래스/기업/버스트단계 + 무기상세 파싱.

Run: python scraper/parse_nikke.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC  = ROOT / "scraper" / "nikke_scraped.json"
PREVIEW = ROOT / "scraper" / "preview_skills.json"   # 출시 전 카드 전사본(수동)
OUT  = ROOT / "data" / "parsed_nikke.json"


def load_preview() -> dict:
    """preview_skills.json의 캐릭터 항목. 없으면 빈 dict.

    스키마가 nikke_scraped.json과 같으므로 그대로 같은 파서에 태운다.
    `_`로 시작하는 키(`_comment`)는 주석이라 제외한다.
    """
    if not PREVIEW.exists():
        return {}
    with open(PREVIEW, encoding="utf-8") as f:
        data = json.load(f)
    return {k: v for k, v in data.items() if not k.startswith("_")}


def parse_weapon_skill(text: str, is_charge: bool) -> dict:
    result = {}

    m = re.search(r'\[공격력 ([\d.]+)% 대미지\]', text)
    if m:
        result["damage_coeff"] = float(m.group(1))
    else:
        print(f"  [WARN] damage_coeff 파싱 실패: {text!r}", file=sys.stderr)

    m = re.search(r'\[코어 대미지 ([\d.]+)%\]', text)
    if m:
        result["core_dmg_mult"] = float(m.group(1))
    else:
        print(f"  [WARN] core_dmg_mult 파싱 실패: {text!r}", file=sys.stderr)

    if is_charge:
        m = re.search(r'차지 시간:\s*([\d.]+)초', text)
        if m:
            result["charge_time"] = float(m.group(1))
        else:
            print(f"  [WARN] charge_time 파싱 실패: {text!r}", file=sys.stderr)

        m = re.search(r'풀 차지 대미지:\s*([\d.]+)% 대미지', text)
        if m:
            result["full_charge_mult"] = float(m.group(1))
        else:
            print(f"  [WARN] full_charge_mult 파싱 실패: {text!r}", file=sys.stderr)

    return result


# CDN이 말해 주지 않는 수동 확정값. 재생성해도 사라지면 안 되는 값은 전부 여기 둔다 —
# 생성 파일(parsed_nikke.json)을 손으로 고치면 다음 재생성이 조용히 되돌린다(파스칼의
# fire_mode가 실제로 그렇게 유실됐다). 근거는 PARSING-CHARS.md §캐릭터별 예외.
_MANUAL_OVERRIDES: dict[str, dict] = {
    # 파스칼의 `fire_mode: auto`는 CDN `조작 타입`을 읽게 되면서 필요 없어졌다
    # (아래 `is_charge`). 200명 전수 대조에서 무기군 추론과 CDN이 어긋나는 것은
    # 파스칼 하나뿐이고, 이제 그 하나도 데이터가 직접 말해 준다.
}


def parse_fire_mechanics(weapon: dict) -> dict:
    """무기상세의 CDN 원값 → 발사 메카닉 필드.

    `연사(rpm)`은 분당 발수다(AR 720 → 12/s, SG 90 → 1.5/s로 기존 값과 일치).
    `연사최대`·`연사증가`는 예열이 있는 MG에서만 시작값과 달라지므로 그때만 기록한다.
    """
    result = {}

    rpm = weapon.get("연사(rpm)") or 0
    if rpm:
        result["fire_rate"] = round(rpm / 60, 4)

        rpm_max = weapon.get("연사최대(rpm)") or 0
        rpm_step = weapon.get("연사증가(rpm/발)") or 0
        if rpm_max and rpm_max != rpm and rpm_step:
            result["fire_rate_max"] = round(rpm_max / 60, 4)
            result["fire_rate_change_pershot"] = round(rpm_step / 60, 4)

    # 값이 없으면 키를 만들지 않는다. 여기서 1로 채우면 그 1이 3계층 해석의 ②층에
    # 실값으로 앉아 ③층(weapon_mechanics 무기군 기본값, 예: SG 펠릿 10)을 덮어버린다
    # — 정보가 없을 때 가야 할 곳은 무기군 기본값이지 1이 아니다.
    # CDN 수집분은 전원 펠릿·총구가 있으므로 이 분기는 프리뷰(출시 전) 캐릭터에만 걸린다.
    if weapon.get("펠릿"):
        result["pellets"] = int(weapon["펠릿"])
    if weapon.get("총구"):
        result["muzzles"] = int(weapon["총구"])

    # 蓄力武器與否。**這是和武器類型獨立的一個軸** —— 不是 SR/RL 就一定蓄力，反過來
    # 也一樣。CDN `조작 타입`（武器說明文裡有沒有 `{charge_time}` 的位置）才是正本：
    # RL 的 파스칼 是 `일반형`（武器技能原文寫著「無法蓄力攻擊的武器」）。
    # 沒有 `조작 타입` 的預覽角色不建這個鍵，維持退回武器類型預設（`type`）的舊行為。
    if weapon.get("조작 타입"):
        result["is_charge"] = weapon["조작 타입"] == "차지형"

    # ── 여기서부터 CDN 유도. 손으로 찍어 둔 예외를 데이터가 대신한다 ─────────
    #
    # 세 필드(`입력 타입`·`사격 자세 유지`·`재장전 탄수`)가 그동안 사람이 영상으로
    # 재어 적어 둔 규칙과 **그대로 겹친다**. 대조 근거는 `context/DATA_VERIFY.md`.

    input_type = weapon.get("입력 타입") or ""
    stance = weapon.get("사격 자세 유지") or 0
    if input_type:
        result["input_type"] = input_type
        # 발사 후 딜레이는 **떼서 쏘는(UP) 무기에만** 있다. `DOWN`(AR·SMG·SG·MG)은
        # 연사라 이 항이 없고, `DOWN_Charge`는 0이다.
        # 자세가 0인 UP 무기가 전부 0.38로 떨어지는데, 이것이 곧 사람이 RL/SR
        # 무기군 기본값으로 재어 둔 값이다(`weapon_delays.json
        # _defaults_by_weapon_type`) —— 손으로 찾은 규칙이 데이터에 이미 있었다.
        if input_type == "DOWN_Charge":
            result["post_fire_delay"] = 0.0
        elif input_type == "UP":
            result["post_fire_delay"] = round(0.22 + max(0.16, stance / 100), 4)
        # 발사 후 엄폐 자세로 돌아가는가. 떼서 쏘고(UP) 자세를 안 붙드는(0) 경우만.
        result["cover_during_delay"] = bool(input_type == "UP" and stance == 0)
        # 떼는 순간이 아니라 정해진 시점에 나가면 «짧게 끊어치기»가 성립하지 않는다.
        uptype = weapon.get("떼기 발사 시점") or 0
        if uptype:
            result["uptype_fire_timing"] = uptype
        # 톡톡이·홀드 가능 여부. 조립 시점에 막기 위한 것이라 파생값으로 미리 적는다.
        #   톡톡이 불가 = 풀차지 전용(`DOWN_Charge`) + 떼기 시점이 고정된 셋
        #   홀드 불가  = `DOWN_Charge`만 (홍련 : 흑영·레이븐은 풀차지 전용이어도 홀드는 된다)
        result["can_tap"] = not (input_type == "DOWN_Charge" or bool(uptype))
        result["can_hold"] = input_type != "DOWN_Charge"

    # 한 번의 재장전이 채우는 발수. `재장전 탄수`는 최대 장탄 대비 비율 ×10000이다
    # (10000 = 탄창 전체). 10000이 아닌 15명이 곧 클립 무기다 —— 손으로 적어 둔
    # `weapon_mechanics.json clip_characters` 14명과 **한 명도 어긋나지 않고**,
    # 거기에 AR이라 아무도 눈치채지 못한 그레이브(60발을 30발씩)가 하나 더 붙는다.
    reload_bullet = weapon.get("재장전 탄수") or 0
    max_ammo_raw = weapon.get("최대 장탄 수") or 0
    try:
        _max_ammo = int(str(max_ammo_raw).strip() or 0)
    except ValueError:
        _max_ammo = 0
    if reload_bullet and _max_ammo and reload_bullet != 10000:
        result["clip_count"] = max(1, round(_max_ammo * reload_bullet / 10000))
        result["clip_ratio_pct"] = reload_bullet / 100.0

    # 히트당 버스트 게이지(%). CDN은 1/10000 % 단위다.
    # 실제 공격 게이지에는 `(대상)`을 쓴다. 이름만 보면 반대로 고르기 쉬운데, 유저
    # 인게임 실측이 전부 2배 쪽이다 — 크라운(MG) 1000발·목단(AR) 200발·루주(SR) 카메라
    # 없이 18발이 `(대상)/10000`으로만 맞는다. 전수 199명에서 `(대상)`이 정확히
    # `(발당)`의 2배라, 대보스 배수를 미리 곱해 둔 필드로 읽는다.
    # 풀차지 배율은 여기서 새 필드를 만들지 않는다 — `버스트게이지(풀차지)/100`이
    # `full_charge_mult`와 전수 일치하므로 그 값을 그대로 쓴다(검산은 run()에서).
    # **0도 유효값**이라 `if weapon.get(...)`으로 거르지 않는다. 대신 키 자체가 없는
    # 프리뷰 캐릭터는 키를 안 만들어 ③층(무기군 기본값)으로 떨어뜨린다.
    # `(발당)`도 보존한다. 「버스트 충전 속도」는 시전자가 일반 공격을 한 번도
    # 명중시키지 않았을 때 이 값을 참조하고, 명중 뒤에는 `(대상)`을 참조한다.
    if "버스트게이지(발당)" in weapon:
        result["burst_energy_raw"] = weapon["버스트게이지(발당)"] / 10000
    if "버스트게이지(대상)" in weapon:
        result["burst_energy"] = weapon["버스트게이지(대상)"] / 10000
    return result


def parse_favorite(char: dict) -> dict:
    """애장품 보유 캐릭터의 단계↔교체슬롯 매핑.

    `favorite_slots[i]` = **애장품 (i+1)단계가 교체하는 스킬 슬롯 번호**다. 교체 순서는
    캐릭터마다 다르다(드레이크 1·2·3, 미란다 3·2·1). 계산기가 단계별로 어느 슬롯을
    애장품 판본으로 갈아끼울지 정하는 유일한 근거이므로 스크랩 원문에서 그대로 옮긴다.
    애장품이 없으면 빈 dict — 키 자체가 "애장품 보유" 판정이다.
    """
    fav = char.get("애장품")
    if not fav:
        return {}
    slots = [int(st["교체슬롯"]) for st in fav.get("단계별", [])]
    if sorted(slots) != [1, 2, 3]:
        print(f"  [WARN] 애장품 교체슬롯이 1·2·3 한 번씩이 아니다: {slots}", file=sys.stderr)
        return {}
    return {"favorite_item": fav.get("아이템명", ""), "favorite_slots": slots}


def run(skills_data: dict | None = None) -> None:
    """nikke_scraped.json 파싱 실행. skills_data를 넘기면 파일 재로드 없이 사용."""
    if skills_data is None:
        with open(SRC, encoding="utf-8") as f:
            skills_data = json.load(f)

    # 프리뷰(출시 전 카드 전사본)를 같이 태운다. 같은 이름이 양쪽에 있으면 **스크랩이 이긴다** —
    # 출시되는 순간 정본으로 자동 전환된다(프리뷰 항목 제거는 char-add 단계 R의 몫).
    preview = load_preview()
    preview_only = {k: v for k, v in preview.items() if k not in skills_data}
    if preview_only:
        print(f"[parse_nikke] 프리뷰 {len(preview_only)}명 포함: {', '.join(preview_only)}")
    skills_data = {**preview_only, **skills_data}

    parsed: dict = {}
    warn_count = 0

    for name, char in skills_data.items():
        weapon = char.get("무기상세", {})
        weapon_type = weapon.get("무기유형", "")
        is_charge = weapon.get("조작 타입") == "차지형"
        weapon_skill_text = weapon.get("무기스킬", "")

        max_ammo_raw = weapon.get("최대 장탄 수", "0")
        reload_raw   = weapon.get("재장전 시간", "0s")

        try:
            max_ammo = int(max_ammo_raw)
        except ValueError:
            max_ammo = 0

        try:
            reload_time = float(re.sub(r'[^\d.]', '', reload_raw))
        except ValueError:
            reload_time = 0.0

        skill_fields = parse_weapon_skill(weapon_skill_text, is_charge)
        if any(k not in skill_fields for k in ("damage_coeff", "core_dmg_mult")):
            warn_count += 1

        # 풀차지는 대미지 배율과 **같은 배율로** 버스트 게이지도 준다 —
        # `버스트게이지(풀차지)/100 == full_charge_mult`가 전수 일치한다.
        # 그래서 게이지용 필드를 따로 내리지 않고 full_charge_mult를 재사용하는데,
        # 게임이 언젠가 둘을 갈라놓으면 조용히 틀리게 된다. 그때 여기서 걸린다.
        fc_gauge = weapon.get("버스트게이지(풀차지)", 0)
        fc_dmg = skill_fields.get("full_charge_mult")
        if fc_dmg is not None and abs(fc_gauge / 100 - fc_dmg) > 1e-9:
            print(f"  [WARN] 풀차지 게이지 배율이 대미지 배율과 다르다: {name} "
                  f"게이지 {fc_gauge / 100} vs 대미지 {fc_dmg} "
                  f"— timeline.py가 full_charge_mult를 게이지에도 쓴다", file=sys.stderr)
            warn_count += 1

        skills = char.get("스킬", {})
        skill3 = list(skills.values())[2] if len(skills) >= 3 else {}
        burst_cool_raw = skill3.get("쿨타임")
        try:
            burst_cooldown = float(str(burst_cool_raw).replace("s", "").strip())
        except (ValueError, TypeError):
            burst_cooldown = 40.0
            print(f"  [WARN] burst_cooldown 파싱 실패: {name} {burst_cool_raw!r}", file=sys.stderr)

        # 스쿼드는 코드가 정본. 표시명이 없는 스쿼드(`-`)는 코드로 대체한다.
        squad = char.get("스쿼드", "")
        squad_name = char.get("스쿼드명", "")
        if squad_name in ("", "-"):
            squad_name = squad

        entry = {
            "rarity":       char.get("레어도", ""),
            "element_code":  char.get("속성", ""),
            "class":         char.get("클래스", ""),
            "manufacturer":  char.get("기업", ""),
            "squad":         squad,
            "squad_name":    squad_name,
            "burst_stage":   char.get("버스트 단계", ""),
            "burst_cooldown": burst_cooldown,
            "weapon_type":   weapon_type,
            "max_ammo":      max_ammo,
            "reload_time":   reload_time,
            **parse_fire_mechanics(weapon),
            **skill_fields,
            **parse_favorite(char),
        }
        if name in preview_only:
            entry["preview"] = True   # 출시 전 카드 기준. context/spec.py가 레벨 10 외 실행을 막는다
            # 카드조차 없어 스킬을 창작한 항목은 경고문이 달라야 한다 — «카드 기준»이라고
            # 말하면 실물 근거가 있는 것처럼 읽힌다 (preview_skills.json `_preview.창작`).
            if (preview.get(name, {}).get("_preview") or {}).get("창작"):
                entry["fabricated"] = True
        entry.update(_MANUAL_OVERRIDES.get(name, {}))
        parsed[name] = entry

    _dummy_base = {
        "rarity": "SSR",
        "element_code": "철갑",
        "class": "화력형",
        "manufacturer": "어브노말",
        "weapon_type": "AR",
        "max_ammo": 60,
        "reload_time": 1.0,
        "damage_coeff": 13.65,
        "core_dmg_mult": 200.0,
    }
    parsed["test_B1"] = {**_dummy_base, "burst_stage": "1", "burst_cooldown": 20.0}
    parsed["test_B2"] = {**_dummy_base, "burst_stage": "2", "burst_cooldown": 20.0}
    parsed["test_B3"] = {**_dummy_base, "burst_stage": "3", "burst_cooldown": 40.0}

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(parsed, f, ensure_ascii=False, indent=2)

    print(f"[parse_nikke] {len(parsed)}명 (더미 B1/B2/B3 포함) → {OUT}")
    if warn_count:
        print(f"[parse_nikke] 경고: {warn_count}건 파싱 실패")


if __name__ == "__main__":
    run()
