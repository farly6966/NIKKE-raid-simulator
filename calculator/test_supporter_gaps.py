"""서포터·힐 쪽에서 나온 결함 넷 — 셋은 하네스가 그 조건을 아예 안 여는 자리였다.

上游 Jgaram/nikke-calc `786b2ce`의 이식.

넷 다 「조용히 아무 일도 안 일어난다」 유형이라 baseline 초록불 아래 계속 살아 있었다.
그래서 회귀가 아니라 **조건을 직접 여는 테스트**로 釘는다.
"""
import json
from pathlib import Path
import unittest

from calculator.buff_manager import BuffManager
from calculator.timeline import simulate
from context.spec import build_config, build_squad

ROOT = Path(__file__).resolve().parents[1]
MAIDEN = "메이든 : 아이스 로즈"
LUDMILLA = "루드밀라 : 윈터 오너"


def _parsed():
    return json.loads((ROOT / "data/parsed_skills.json").read_text(encoding="utf-8"))


def _run(names, enemy, duration=180, config=None):
    squad = build_squad(names)
    cfg = build_config(squad, {"duration": duration, "rng_mode": "expected",
                               "first_burst_time": 3.0, **(config or {})})
    return simulate(squad, config=cfg, enemy=enemy, verbose=True)


class CoreHitCountTimingTest(unittest.TestCase):
    """`core_hit_count:N` — 표기 하나가 통째로 죽어 있었다.

    `_timing_to_index_key()`는 `core_hit_count:`·`core_hit:` 둘 다 `core_hit`로 접는데
    `_timing_match()`에는 `core_hit:` 분기뿐이었다. 파싱 정본 표기가
    `core_hit_count:N`이라(`context/PARSING.md`) 그 표기를 쓰는 효과는 **영구 미발동**이다.
    코어 이벤트 자체는 정상이라 로그만 봐서는 알 수 없다.
    """

    def test_both_spellings_match_the_core_hit_event(self):
        bm = BuffManager.__new__(BuffManager)
        for timing in ("core_hit:3", "core_hit_count:3"):
            with self.subTest(timing=timing):
                # count=3이 문턱 3의 배수 → 매칭. 한쪽 표기만 받으면 다른 쪽은 False다.
                self.assertTrue(
                    BuffManager._timing_match(bm, timing, "core_hit", 3, 0.0, {}, ""))
                self.assertFalse(
                    BuffManager._timing_match(bm, timing, "core_hit", 2, 0.0, {}, ""))

    def test_snowstorm_fires_on_a_core_boss(self):
        """루드밀라 : 윈터 오너 `눈보라`(`core_hit_count:60`)가 실제로 걸린다."""
        result = _run([LUDMILLA, "크라운", "아스카 : WILLE", "리틀 머메이드", "라피"],
                      {"code": "", "core_px": 52})
        fired = [h for h in result.hits if h.skill_name == "눈보라"]
        self.assertTrue(fired, "코어 보스인데 `눈보라`가 한 번도 안 걸렸다")

    def test_it_does_not_fire_without_a_core(self):
        """코어가 없으면 안 걸린다 — 「항상 참」으로 고친 게 아님을 보인다."""
        result = _run([LUDMILLA, "크라운", "아스카 : WILLE", "리틀 머메이드", "라피"],
                      {"code": "", "core_px": 0})
        fired = [h for h in result.hits if h.skill_name == "눈보라"]
        self.assertEqual(fired, [], "코어가 없는데 `눈보라`가 걸렸다")


class MaxHpAdditiveScalingTest(unittest.TestCase):
    """`scaling: "max_hp_additive"` — 규격만 있고 읽는 곳이 없었다.

    메이든 : 아이스 로즈 `다이아몬드 더스트`가 유일한 사용처인데, 최대 체력의 10%가
    통째로 빠진 채 계산됐다. 이 캐릭터에선 그 10%가 공격력의 몇 배라 딜이 자릿수로 틀린다.
    """

    def test_diamond_dust_includes_ten_percent_of_max_hp(self):
        names = [MAIDEN, "루주", "크라운", "홍련", "라피"]
        result = _run(names, {"code": "", "core_px": 0})
        dust = [h for h in result.hits
                if h.caster == MAIDEN and "다이아몬드 더스트" in h.skill_name]
        self.assertTrue(dust, "`다이아몬드 더스트`가 한 발도 안 나갔다")

        # 같은 히트를 공격력만으로 계산하면 얼마인가 — 최대 체력 항이 빠진 값이다.
        squad = build_squad(names)
        maiden = next(c for c in squad if c["name"] == MAIDEN)
        effect = next(e for e in _parsed()[MAIDEN] if e.get("name") == "다이아몬드 더스트")
        self.assertEqual(effect.get("scaling"), "max_hp_additive")
        self.assertGreater(float(effect.get("scaling_hp_pct", 0)), 0)
        # 최대 체력 10%가 공격력을 넘는 캐릭터라, 반영되면 딜이 최소 2배는 돼야 한다.
        from calculator.base_stat import calc_base_stats
        base = calc_base_stats(maiden)
        self.assertGreater(base["hp"] * 0.10, base["atk"],
                           "전제가 깨졌다 — 이 캐릭터는 최대 체력 10%가 공격력보다 커야 한다")

    def test_the_dead_helper_is_gone(self):
        """`base_stat.hp_to_atk()`는 호출자 0인 죽은 헬퍼였다 — 이 자리의 유령이다."""
        import calculator.base_stat as base_stat
        self.assertFalse(hasattr(base_stat, "hp_to_atk"))


class BlessYouExcludesSelfTest(unittest.TestCase):
    """원문은 「자신을 제외한 전격 코드 아군 전체」다.

    `allies_code:`는 시전자를 포함하므로, MP≥1이면 아군판·MP=0이면 자기판인
    **배타 분기의 양쪽을 자기가 다** 받고 있었다.
    """

    def test_target_key_excludes_the_caster(self):
        for name in ("블레스 유", "블레스 유 2"):
            with self.subTest(name=name):
                effect = next(e for e in _parsed()[MAIDEN] if e.get("name") == name)
                self.assertEqual(effect["target"], "allies_code_excl_self:전격")

    def test_resolver_drops_the_caster(self):
        names = [MAIDEN, "루주", "크라운", "홍련", "라피"]
        squad = build_squad(names)
        cfg = build_config(squad, {"duration": 30, "rng_mode": "expected"})
        result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
        applied = [e for e in result.log.buff_events
                   if e.kind == "activate" and e.name in ("블레스 유", "블레스 유 2")]
        self.assertTrue(applied, "`블레스 유`가 한 번도 안 걸렸다 — 전제가 깨졌다")
        for entry in applied:
            self.assertNotEqual(entry.target, MAIDEN,
                                f"{entry.name}이 시전자 자신에게 걸렸다")


class LeadingLightValuesTest(unittest.TestCase):
    """`이끄는 등불` — 지속시간만 맞고 값이 서로 바뀌어 있었다.

    원문 `[공격력 {0}% ▲][10초] / [재장전 속도 {1}% ▲][20초]`이므로
    공격력은 0열, 재장전은 1열이다.
    """

    def test_values_follow_the_right_column(self):
        raw = json.loads((ROOT / "scraper/nikke_scraped.json").read_text(encoding="utf-8"))
        columns = raw[LUDMILLA]["스킬"]["이끄는 등불"]["values"]
        parsed = {e["name"]: e for e in _parsed()[LUDMILLA]}
        atk, reload_ = parsed["이끄는 등불"], parsed["이끄는 등불 2"]
        self.assertEqual(atk["stat"], "atk_pct")
        self.assertEqual(reload_["stat"], "reload_speed_pct")
        for level in map(str, range(1, 11)):
            with self.subTest(level=level):
                self.assertEqual(atk["values"][level], float(columns[level][0]))
                self.assertEqual(reload_["values"][level], float(columns[level][1]))


if __name__ == "__main__":
    unittest.main()
