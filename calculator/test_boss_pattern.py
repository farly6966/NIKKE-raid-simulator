"""보스 패턴 1단계 — 보스를 스칼라 셋이 아니라 시간에 따라 이어지는 스크립트로.

上游 Jgaram/nikke-calc `b67e366`의 이식. 上游는 이 검산들을 모듈의 `__main__` 블록에
두었지만, 이 fork의 하네스는 unittest라 그대로 테스트 파일로 옮긴다.

**합격 기준은 baseline 29/29 무변동이다.** `enemy["patterns"]`가 비면 스케줄러를 아예
만들지 않으므로 그건 구조적으로 보장되고, 여기서는 **스케줄러가 실제로 무엇을 하는가**를
잰다 — 그리고 마지막 클래스가 그 둘을 잇는다: 종전 스칼라를 등가 패턴으로 옮긴 적이
**같은 전투를 내는가**.

포맷·검사 규칙의 정본은 `calculator/boss_pattern.py` 모듈 docstring.

fork 주의: 이 repo에는 이미 `enemy["boss_phases"]`(평평한 시간 창 여섯 종 —
core·parts·immune·element_gate·pierce_gate·optimal_range)가 있고 Boss Maker·연합
다섯 왕이 그걸 쓴다. **두 축은 서로를 모른다.** 통합은 등가 증명을 따로 세운 뒤에 한다.
"""
import unittest

from calculator.boss_pattern import (OVERLAY_FIELDS, BossScript, legacy_to_patterns,
                                     validate)
from calculator.damage import is_element_match
from calculator.sim_result import HitEvent
from calculator.timeline import simulate
from context.spec import build_config, build_squad

DT = 1 / 60
BASE = {"def": 31784, "code": "수냉", "core_px": 0, "has_parts": False,
        "optimal_range_weapons": []}
ROSTER = {"전격캐": "전격", "작열캐": "작열"}
WEAPONS = frozenset({"SG", "SMG", "SR"})


def _superior(caster: str, code: str) -> bool:
    return is_element_match(ROSTER.get(caster, ""), code)


def _run(patterns, until_t, hits=None, base=None):
    """timeline 루프를 흉내 낸다: 프레임 맨 앞 전이 → 히트 흡수. 프레임별 적 상태도 남긴다."""
    enemy = dict(base or BASE)
    boss = BossScript(validate(patterns, weapon_types=WEAPONS), enemy, _superior)
    frames, admitted, fired = [], [], []
    t = 0.0
    while t <= until_t:
        fired += [(t, e) for e in boss.begin_frame(t, enemy)]
        frames.append((t, dict(enemy), boss.vanished))
        for ev in (hits(t) if hits else []):
            if boss.admit(ev, t):
                admitted.append(ev)
        t += DT
    boss.finish(until_t)
    return boss, frames, admitted, fired


def _starts(boss, pid):
    return [e.t for e in boss.log if e.pattern == pid and e.event == "start"]


def _ends(boss, pid):
    return [(e.t, e.outcome) for e in boss.log if e.pattern == pid and e.event == "end"]


def _near(a, b):
    return abs(a - b) < DT / 2


def _state_at(frames, t):
    return next(s for ft, s, _ in frames if _near(ft, t) or ft > t)


def _normal(c, d):
    return HitEvent(t=0, caster=c, damage=d, is_crit=False, hit_tag="normal")


def _skill(c, d):
    return HitEvent(t=0, caster=c, damage=d, is_crit=False, hit_tag="dot_damage",
                    skill_name="지속딜")


def _interrupt_script():
    return [
        {"id": "저지", "kind": "interrupt", "after": [{"node": "대기"}],
         "until": {"time": 15, "targets_cleared": True},
         "emit": ["event:target_spawn"],
         "targets": [{"name": "저지원A", "hp": 1000, "score": 500,
                      "emit_on_destroy": ["enemy_death"]},
                     {"name": "저지원B", "hp": 1000, "share": 0.5},
                     {"name": "본체", "hp": 0}]},
        {"id": "대기", "kind": "idle", "until": {"time": 2}},
        {"id": "성공", "kind": "groggy", "after": [{"node": "저지", "outcome": "cleared"}],
         "until": {"time": 5}},
        {"id": "광역기", "kind": "attack", "after": [{"node": "저지", "outcome": "expired"}],
         "until": {"time": 5}, "spec": {"damage_pct": 300}},
    ]


class SchedulingTest(unittest.TestCase):
    """패턴이 서로를 잇는다 — `after` · `delay` · `until` · `repeat`."""

    def test_sequential(self):
        """A(5초) → B(3초) → C가 5.0s·8.0s에 갈린다."""
        b, *_ = _run([{"id": "A", "kind": "idle", "until": {"time": 5}},
                      {"id": "B", "kind": "idle", "after": ["A"], "until": {"time": 3}},
                      {"id": "C", "kind": "idle", "after": ["B"]}], 10)
        self.assertTrue(_near(_starts(b, "B")[0], 5.0), b.log)
        self.assertTrue(_near(_starts(b, "C")[0], 8.0), b.log)
        self.assertEqual(_ends(b, "C"), [(10, "end")],
                         "전투가 끝나 닫힌 패턴의 사유는 end다")

    def test_simultaneous_and_delay(self):
        """같은 `after`를 나눠 가진 둘이 함께 열린다 — 그리고 20초가 20.017로 밀리지 않는다.

        루프가 `t += DT`로 시각을 쌓으면 180초까지 5e-13쯤 어긋난다. 그대로 `>=`로 재면
        「20초 뒤」가 한 프레임 늦게 끝난다 — `_EPS`가 그것을 걷어 낸다.
        """
        b, *_ = _run([{"id": "A", "kind": "idle", "until": {"time": 20}},
                      {"id": "B1", "kind": "idle", "after": ["A"]},
                      {"id": "B2", "kind": "groggy", "after": ["A"], "delay": 1.5}], 25)
        self.assertEqual(_starts(b, "B1"), [_ends(b, "A")[0][0]])
        self.assertTrue(_near(_starts(b, "B1")[0], 20.0), _starts(b, "B1"))
        self.assertTrue(_near(_starts(b, "B2")[0], 21.5), _starts(b, "B2"))

    def test_cycle_and_overlay_follows_the_window(self):
        """`after` 순환 + `repeat: 0` / 오버레이(방어력·적정거리)가 구간을 따라간다."""
        b, frames, _, _ = _run(
            [{"id": "강화", "kind": "buff", "after": ["start", "돌진"], "repeat": 0,
              "until": {"time": 2}, "enemy": {"def_mult": 2, "def_add": 100}},
             {"id": "후퇴", "kind": "move", "after": ["강화"], "repeat": 0,
              "until": {"time": 3}, "weapons": ["SR"]},
             {"id": "돌진", "kind": "move", "after": ["후퇴"], "repeat": 0,
              "until": {"time": 1}, "weapons": ["SG", "SMG"]}], 20)
        st = _starts(b, "강화")
        self.assertEqual(len(st), 4, st)
        for i, x in enumerate(st):
            self.assertTrue(_near(x, 6.0 * i), st)
        self.assertEqual(_state_at(frames, 1.0)["def"], 31784 * 2 + 100)
        self.assertEqual(_state_at(frames, 3.0)["def"], 31784)
        self.assertEqual(_state_at(frames, 3.0)["optimal_range_weapons"], ["SR"])
        self.assertEqual(_state_at(frames, 5.5)["optimal_range_weapons"], ["SG", "SMG"])
        self.assertEqual(_state_at(frames, 6.5)["optimal_range_weapons"], [])


class InterruptTest(unittest.TestCase):
    """저지 — 성공·실패로 뒤가 갈린다."""

    def test_cleared(self):
        # 2초부터 프레임당 10딜 → A는 1000에서 약 3.67초, B(share 0.5)는 약 5.33초에 깨진다
        b, _, _, fired = _run(_interrupt_script(), 30, hits=lambda t: [_normal("전격캐", 10)])
        (t_end, oc), = _ends(b, "저지")
        destroys = [e for e in b.log if e.event == "destroy"]
        self.assertEqual(oc, "cleared")
        self.assertTrue(_near(t_end, destroys[-1].t + DT), (t_end, destroys))
        self.assertEqual(_starts(b, "성공"), [t_end])
        self.assertFalse(_starts(b, "광역기"), "실패 분기가 열렸다")
        self.assertEqual(b.score, 500)
        self.assertFalse(b.unmodeled)
        self.assertIn((2.0, "event:target_spawn"),
                      [(round(ft, 6), e) for ft, e in fired])
        t_death = next(ft for ft, e in fired if e == "enemy_death")
        self.assertTrue(_near(t_death, destroys[0].t + DT),
                        "파괴 이벤트는 다음 프레임 맨 앞에서 나간다")

    def test_expired_opens_the_reserved_branch(self):
        """예약 종류(attack)는 **구간만 차지한다** — 효과가 없다고 구간까지 없애면
        저지 실패 뒤가 통째로 당겨진다."""
        b, *_ = _run(_interrupt_script(), 30)
        (t_end, oc), = _ends(b, "저지")
        self.assertEqual(oc, "expired")
        self.assertTrue(_near(t_end, 17.0), t_end)
        self.assertFalse(_starts(b, "성공"))
        self.assertTrue(_near(_starts(b, "광역기")[0], 17.0))
        self.assertEqual(b.unmodeled, ["광역기"])

    def test_cleared_beats_expired_in_the_same_frame(self):
        """제한시간이 끝나는 **바로 그 프레임**에 마지막 저지원이 깨졌다면 인게임은 성공이다."""
        lim = 1.0
        b, *_ = _run(
            [{"id": "저지", "kind": "interrupt",
              "until": {"time": lim, "targets_cleared": True},
              "targets": [{"name": "X", "hp": 100}]}], 3,
            hits=lambda t: ([_normal("전격캐", 100)]
                            if lim - DT - DT / 2 < t < lim - DT / 2 else []))
        self.assertEqual(_ends(b, "저지")[0][1], "cleared", _ends(b, "저지"))


class DamageGateTest(unittest.TestCase):
    """딜 게이트 — 속성보호막과 사라짐. **거른 뒤에 표적에 흡수한다.**"""

    def test_shield_blocks_and_blocked_damage_does_not_chip_targets(self):
        b, frames, admitted, _ = _run(
            [{"id": "보호막", "kind": "shield", "code": "수냉", "until": {"time": 5}},
             {"id": "파츠", "kind": "parts", "targets": [{"name": "팔", "hp": 10 ** 9}]}],
            10, hits=lambda t: [_normal("전격캐", 10), _skill("작열캐", 30)])
        n_fire = sum(1 for e in admitted if e.caster == "작열캐")
        n_elec = sum(1 for e in admitted if e.caster == "전격캐")
        self.assertEqual(n_elec, len(frames), "우월 코드가 막혔다")
        self.assertEqual(n_fire, len(frames) - 300, "보호막 5초(300프레임)가 안 막혔다")
        arm = b._runs[1].targets[0]
        self.assertEqual(arm.dealt, 10 * n_elec + 30 * n_fire,
                         "막힌 딜이 표적을 깎았다")
        end = next(e for e in b.log if e.pattern == "보호막" and e.event == "end")
        self.assertEqual(end.detail, "막은 딜 9,000", end)

    def test_vanish_drops_only_normal_attacks(self):
        """사라짐은 **평타만** 뺀다 — 발사로 파생된 스킬과 이미 걸린 지속 대미지는
        보스가 화면에 없어도 들어간다(트리거는 이미 처리된 뒤다)."""
        b, frames, admitted, _ = _run(
            [{"id": "출현", "kind": "idle", "until": {"time": 1}},
             {"id": "사라짐", "kind": "vanish", "after": ["출현"], "until": {"time": 2}}],
            4, hits=lambda t: [_normal("전격캐", 1), _skill("전격캐", 1)])
        n_normal = sum(1 for e in admitted if e.hit_tag == "normal")
        n_skill = sum(1 for e in admitted if e.hit_tag == "dot_damage")
        gone = [ft for ft, _, v in frames if v]
        self.assertEqual(n_skill, len(frames), "스킬이 사라짐에 막혔다")
        self.assertEqual(n_normal, len(frames) - 120, "평타 2초(120프레임)가 안 빠졌다")
        self.assertEqual(len(gone), 120)
        self.assertTrue(_near(gone[0], 1.0) and _near(gone[-1], 3.0 - DT), (gone[0], gone[-1]))

    def test_core_part_closes_with_its_target(self):
        """표적이 깨지면 코어·파츠도 함께 닫힌다. 코어 합성은 **살아 있는 것 중 큰 값**."""
        b, frames, _, _ = _run(
            [{"id": "코어", "kind": "core", "core_px": 30},
             {"id": "약점", "kind": "parts",
              "targets": [{"name": "코어 파츠", "hp": 600, "core_px": 45}]}],
            3, hits=lambda t: [_skill("전격캐", 10)] if t >= 1 - DT / 2 else [])
        dt_ = next(e.t for e in b.log if e.event == "destroy")
        before, after = _state_at(frames, dt_), _state_at(frames, dt_ + DT)
        self.assertEqual((before["core_px"], before["has_parts"]), (45, True), before)
        self.assertEqual((after["core_px"], after["has_parts"]), (30, False), after)
        self.assertTrue(_near(dt_, 2.0 - DT), dt_)


class ScriptIsRejectedWhenWrongTest(unittest.TestCase):
    """**칸 이름을 잘못 적어 영영 무발동이 되는 쪽이, 시뮬이 안 도는 것보다 늦게 발견된다.**

    그래서 조용히 무시될 수 있는 입력 — 모르는 칸·없는 참조·영영 안 열리는 분기 — 을
    남기지 않는다.
    """

    IDLE = {"id": "A", "kind": "idle"}
    TG = [{"name": "X", "hp": 10}]

    CASES = {
        "모르는 kind":            [{"kind": "roar"}],
        "모르는 칸":              [{"kind": "idle", "untill": {"time": 1}}],
        "kind에 없는 칸":         [{"kind": "core", "core_px": 10, "targets": TG}],
        "id 중복":               [IDLE, dict(IDLE)],
        "자동 id 충돌":           [{"kind": "idle"}, {"id": "idle1", "kind": "idle"}],
        "예약어 id":             [{"id": "start", "kind": "idle"}],
        "없는 패턴 참조":          [{"kind": "idle", "after": ["B"]}],
        "until.after 자기 자신":   [{"id": "A", "kind": "idle",
                                  "until": {"after": [{"node": "A"}]}}],
        "until.after 없는 패턴":   [{"kind": "idle", "until": {"after": [{"node": "Z"}]}}],
        "until.time 0":          [{"kind": "idle", "until": {"time": 0}}],
        "until.time 음수":        [{"kind": "idle", "until": {"time": -1}}],
        "없는 속성 코드":          [{"kind": "shield", "code": "빛"}],
        "core_px 0":             [{"kind": "core", "core_px": 0}],
        "표적 없는 parts":         [{"kind": "parts", "targets": []}],
        "표적 없는 interrupt":     [{"kind": "interrupt"}],
        "표적 이름 중복":          [{"kind": "parts", "targets": TG + TG}],
        "음수 hp":               [{"kind": "parts", "targets": [{"name": "X", "hp": -1}]}],
        "음수 share":            [{"kind": "parts",
                                  "targets": [{"name": "X", "hp": 1, "share": -0.1}]}],
        "hp 없는 표적":           [{"kind": "parts", "targets": [{"name": "X"}]}],
        "표적의 모르는 칸":        [{"kind": "parts",
                                  "targets": [{"name": "X", "hp": 1, "hpp": 2}]}],
        "깰 표적 없이 cleared":    [{"kind": "interrupt", "until": {"targets_cleared": True},
                                  "targets": [{"name": "X", "hp": 0}]}],
        "표적 kind 아닌 cleared":  [{"kind": "idle", "until": {"targets_cleared": True}}],
        "빈 after":              [{"kind": "idle", "after": []}],
        "outcome end":           [IDLE, {"kind": "idle",
                                         "after": [{"node": "A", "outcome": "end"}]}],
        "불가능한 outcome":        [IDLE, {"kind": "idle",
                                         "after": [{"node": "A", "outcome": "expired"}]}],
        "start에 outcome":        [{"kind": "idle",
                                   "after": [{"node": "start", "outcome": "expired"}]}],
        "시작에서 끊긴 패턴":       [{"id": "P", "kind": "idle", "after": ["Q"],
                                   "until": {"time": 1}},
                                  {"id": "Q", "kind": "idle", "after": ["P"],
                                   "until": {"time": 1}}],
        "모르는 이벤트":           [{"kind": "idle", "emit": ["event:part_destory"]}],
        "모르는 무기군":           [{"kind": "move", "weapons": ["LMG"]}],
        "예약 아닌 kind의 spec":   [{"kind": "idle", "spec": {}}],
        "없앤 칸(게이지 토글)":     [{"kind": "vanish", "blocks_burst_gauge": False}],
        "모르는 buff 칸":          [{"kind": "buff", "enemy": {"atk_mult": 2}}],
        "repeat 음수":            [{"kind": "idle", "repeat": -1}],
        "list 아님":             {"kind": "idle"},
    }

    def test_every_wrong_script_is_rejected(self):
        for label, pats in self.CASES.items():
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    validate(pats, weapon_types=WEAPONS)

    def test_the_case_list_is_not_silently_shrinking(self):
        """上游가 세어 둔 종수와 맞춘다 — 목록이 줄면 검사망이 좁아진 것이다."""
        self.assertGreaterEqual(len(self.CASES), 34)


class LegacyScalarsConvertToTheSameBattleTest(unittest.TestCase):
    """**등가 변환이 오버레이 배선의 증인이다.**

    종전 스칼라(`def`·`core_px`·`has_parts`·`optimal_range_weapons`)를 「전투 시작에 열려
    끝까지 가는 패턴」으로 옮긴 적이 같은 전투를 내면, 오버레이가 기본 경로와 어긋나지
    않았다는 뜻이다. `legacy_to_patterns()`는 **검산 전용이고 엔진은 쓰지 않는다** —
    스칼라를 그대로 두는 편이 회귀에 안전하다.
    """

    # **버스트가 직접 딜을 내는 캐릭터가 있어야 한다.** `BurstController.enemy_def`를
    # 조회 시점이 아니라 `__init__`에서 붙들면 버스트 딜만 옛 방어력으로 계산되는데,
    # 버프형 버스트만 있는 편성으로는 그 어긋남이 결과에 드러나지 않는다 —— 라피 :
    # 레드 후드를 넣고 캐시로 되돌려 실제로 갈리는 것을 확인했다(1,603,915,561 vs
    # 1,610,739,121).
    SQUAD = ["리타", "그레이브", "라피 : 레드 후드", "앨리스", "모더니아"]

    def test_the_overlay_reproduces_the_four_scalars(self):
        for legacy in ({"def": 31784, "code": "수냉"},
                       {"def": 50000, "code": "작열", "core_px": 52, "has_parts": True,
                        "optimal_range_weapons": ["SG", "SMG"]}):
            with self.subTest(legacy=legacy):
                full = {**BASE, **legacy}
                conv = legacy_to_patterns(full)
                enemy = {**BASE, **{k: v for k, v in conv.items() if k != "patterns"}}
                boss = BossScript(validate(conv["patterns"]), enemy, _superior)
                boss.begin_frame(0.0, enemy)
                for k in OVERLAY_FIELDS:
                    self.assertEqual(enemy[k], full[k], k)

    def test_a_whole_battle_is_identical(self):
        """스칼라 적과 등가 패턴 적이 **총딜·캐릭터별 딜 모두** 같다.

        `def`를 기본값과 다르게 둔 것이 `BurstController.enemy_def` 캐시를 잡는다 —
        `__init__`에서 값을 붙들면 버스트 딜만 옛 방어력으로 계산된다.
        """
        for enemy in ({"code": "풍압", "core_px": 0},
                      {"code": "풍압", "def": 55555, "core_px": 52, "has_parts": True}):
            with self.subTest(enemy=enemy):
                squad = build_squad(self.SQUAD)
                cfg = build_config(squad, {"duration": 60, "rng_mode": "expected",
                                           "first_burst_time": 3.0})
                plain = simulate(squad, config=cfg, enemy=dict(enemy))
                conv = legacy_to_patterns({**BASE, **enemy})
                squad2 = build_squad(self.SQUAD)
                cfg2 = build_config(squad2, {"duration": 60, "rng_mode": "expected",
                                             "first_burst_time": 3.0})
                patterned = simulate(squad2, config=cfg2, enemy=conv)
                self.assertEqual(plain.squad_total, patterned.squad_total,
                                 "등가 패턴이 다른 총딜을 냈다")
                self.assertEqual(dict(plain.char_total), dict(patterned.char_total))
                self.assertTrue(patterned.boss_log, "패턴이 하나도 안 돌았다")

    def test_an_enemy_that_already_has_patterns_is_not_convertible(self):
        with self.assertRaises(ValueError):
            legacy_to_patterns({**BASE, "patterns": [{"kind": "idle"}]})


class NoPatternsMeansNoScheduler(unittest.TestCase):
    """패턴이 비면 스케줄러를 **아예 만들지 않는다** — baseline 29/29가 그 기준이다."""

    def test_empty_patterns_leave_the_result_untouched(self):
        squad = build_squad(["리타", "그레이브", "레이", "앨리스", "모더니아"])
        cfg = build_config(squad, {"duration": 30, "rng_mode": "expected",
                                   "first_burst_time": 3.0})
        r = simulate(squad, config=cfg, enemy={"code": "풍압", "core_px": 0})
        self.assertEqual(r.boss_log, [])
        self.assertEqual(r.boss_score, 0)
        self.assertEqual(r.boss_unmodeled, [])
        self.assertEqual(r.boss_summary(), "[보스 패턴] 없음")

    def test_a_bad_script_fails_before_the_heavy_setup(self):
        squad = build_squad(["리타", "그레이브", "레이", "앨리스", "모더니아"])
        cfg = build_config(squad, {"duration": 5, "rng_mode": "expected"})
        with self.assertRaises(ValueError):
            simulate(squad, config=cfg,
                     enemy={"code": "풍압", "patterns": [{"kind": "roar"}]})


class PatternsChangeARealBattleTest(unittest.TestCase):
    """모듈 단위 검산만으로는 **timeline 배선**을 못 잰다 — 실제 `simulate()`로 확인한다."""

    SQUAD = ["리타", "그레이브", "라피 : 레드 후드", "앨리스", "모더니아"]

    def _run(self, pats, duration=60.0):
        squad = build_squad(self.SQUAD)
        cfg = build_config(squad, {"duration": duration, "rng_mode": "expected",
                                   "first_burst_time": 3.0})
        return simulate(squad, config=cfg,
                        enemy={"code": "풍압", "core_px": 0, "patterns": pats}, verbose=True)

    def test_vanish_blocks_exactly_what_it_says_it_blocked(self):
        """`막은 딜` 로그가 **총딜 차이와 한 자리도 안 다르다.**

        딜 게이트가 결과 자리 한 곳(`_land()`)에 있다는 증거다 — 여러 자리에 흩어져
        있으면 어느 한 경로가 새도 로그만 보고는 알 수 없다.
        """
        base = self._run([])
        van = self._run([{"id": "사라짐", "kind": "vanish", "until": {"time": 20}}])
        end = next(e for e in van.boss_log if e.event == "end")
        blocked = int(end.detail.replace("막은 딜 ", "").replace(",", ""))
        self.assertEqual(base.squad_total - van.squad_total, blocked,
                         f"총딜 차이와 막은 딜이 다르다: {end.detail}")

    def test_vanish_drops_weapon_gauge_but_not_skill_gauge(self):
        """사라진 동안 **평타 몫의 게이지만** 빠진다(상류 유저 확인 2026-09-13).

        충전 창 전체를 닫지 않고 무기 사격의 가산 자리에서만 거르는 근거 ——
        `CharState._weapon_gauge_lands()`.
        """
        base = self._run([])
        van = self._run([{"id": "사라짐", "kind": "vanish", "until": {"time": 20}}])
        wg = lambda r: [e for e in r.log.gauge_log if e.source.startswith("weapon")]
        sg = lambda r: [e for e in r.log.gauge_log if e.source.startswith("skill")]
        self.assertLess(len(wg(van)), len(wg(base)), "평타 게이지가 안 빠졌다")
        self.assertTrue(sg(van), "스킬 게이지가 통째로 사라졌다")

    def test_a_defense_buff_pattern_moves_the_damage(self):
        """방어력 오버레이가 실제 딜에 닿는다 — 버스트 딜까지 포함해서."""
        soft = self._run([{"id": "약화", "kind": "buff",
                           "enemy": {"def_mult": 0, "def_add": 1000}}])
        hard = self._run([{"id": "강화", "kind": "buff",
                           "enemy": {"def_mult": 0, "def_add": 90000}}])
        self.assertGreater(soft.squad_total, hard.squad_total,
                           "방어력을 90배로 올렸는데 딜이 안 줄었다")

    def test_reserved_kinds_are_reported_not_silently_ignored(self):
        r = self._run([{"id": "광역기", "kind": "attack", "until": {"time": 5},
                        "spec": {"damage_pct": 300}}], duration=10.0)
        self.assertEqual(r.boss_unmodeled, ["광역기"])
        self.assertIn("효과 모델 없음", r.boss_summary())


if __name__ == "__main__":
    unittest.main()
