"""재장전 앞뒤 딜레이는 재장전 «동작»의 일부다 — 속도 버프를 같이 탄다.

`reload_start_delay`(탄 소진 → 장전 시작)와 `post_reload_delay`(장전 완료 → 첫 발)는
60fps 영상에서 **버프 없는 상태로** 잰 값이다(`data/weapon_delays.json`). 그 값을 고정으로
두면 재장전 속도를 크게 받은 캐릭터가 손해를 두 번 본다 — 특히 장탄이 1발까지 줄어
매 발마다 재장전하는 경우 딜이 무너진다.

제보(2026-08-24): 아니스 : 스파클링 서머의 딜이 비정상적으로 낮다. 그는 버스트로
자기 최대 장탄을 73.92% 깎아 «마지막 탄환» 스킬을 자주 터뜨리는 설계라, 1발 상태에서
매 발 재장전한다. 고정 딜레이 0.4초를 매 발 물어 스쿼드 비중이 실측 42.1% → 시뮬
31.9%로 내려앉았다.
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ['목단', '에이드 : 에이전트 바니', '아니스 : 스파클링 서머',
         '메이든 : 아이스 로즈', '프리바티']


def _run():
    squad = build_squad(SQUAD)
    cfg = build_config(squad, {'duration': 180, 'rng_mode': 'expected'})
    return simulate(squad, config=cfg, enemy={'code': '수냉', 'core_px': 52})


class ReloadDelayScalesWithSpeedTest(unittest.TestCase):
    def test_delay_shrinks_when_reload_is_buffed(self):
        """버프가 없으면 실측값 그대로, 버프를 받으면 그만큼 줄어든다."""
        from calculator.buff_manager import BuffManager
        from calculator.timeline import CharState

        squad = build_squad(['드레이크', '크라운', 'test_B3'])
        drake = next(c for c in squad if c['name'] == '드레이크')
        state = CharState(drake, 100000.0, '')
        bm = BuffManager(squad)

        # 버프 없음 → 실측값 그대로 (배수 1)
        self.assertEqual(1.0, state._reload_speed_factor(bm, 0.0))
        self.assertEqual(0.2, state.post_reload_delay)     # SG 실측값

        # 재장전 속도 +75% → 시간이 1/4로 줄고 앞뒤 딜레이도 같이 줄어든다
        bm.get_buffs = lambda *a, **k: {'reload_speed_pct': 75.0}
        self.assertAlmostEqual(0.25, state._reload_speed_factor(bm, 0.0))

    def test_maiden_share_matches_the_report(self):
        """제보 스쿼드에서 **메이든의 비중**이 실측 35.2% 언저리여야 한다.

        종전에는 이 자리가 「아니스 > 메이든」이라는 **순서**를 釘고 있었다. 그 전제는
        메이든이 낮게 잡혀 있을 때만 성립했다 — `max_hp_additive`(원문 `[시전자의 최종
        최대 체력의 10%를 공격력으로 합산한 …]`)를 엔진이 읽지 않아 메이든이 33.3%에
        머물렀기 때문이다. 그걸 이으니 35.6%로 실측 35.2%에 붙었고, 순서가 뒤집혔다.

        **아니스 쪽은 회귀가 아니다**(`git bisect`로 확인했다). 그의 절대 딜은
        `e028cbc` 이래 `2,328,198,978`에서 **한 자리도 움직인 적이 없다**. 비중이 내려온
        것은 분모가 커졌기 때문이다 — `2584f4d`(moris-kr, 2026-08-30)가 목단의 무기 변경
        5타 추가 대미지가 조용히 죽어 있던 것을 고쳐 목단이 +55.7%(919,803,289 →
        1,432,463,148) 커졌다. 그 자체가 정당한 수정이다(유저 제보 기반, 같은 부류의
        「조용히 아무 일도 안 함」).

        그래서 이 테스트는 **아직 못 맞추는 목표**를 釘는 자리로 남긴다 —— 아래
        `test_sparkling_summer_share_matches_the_report` 참조.
        """
        result = _run()
        total = sum(result.char_total.values())
        maiden = result.char_total['메이든 : 아이스 로즈'] / total
        self.assertAlmostEqual(
            maiden, 0.352, delta=0.02,
            msg=f'메이든 비중이 실측 35.2%에서 멀다 ({maiden:.1%}) — '
                '`max_hp_additive`가 대미지에 실리는지 확인하라',
        )

    @unittest.expectedFailure
    def test_sparkling_summer_share_matches_the_report(self):
        """아니스 비중 42.1%(제보) — **아직 못 맞춘다.** 미해결 표식으로 남긴다.

        회귀가 아니다(위 참조). 남은 의문은 **제보 숫자 둘이 서로 안 맞는다**는 것이다.

        `e028cbc`의 제보는 `아니스 42.1% · 메이든 35.2%`이므로 나머지 셋이 22.7%다.
        그런데 `2584f4d`의 제보(목단 5타 추가딜이 인게임에서 작동한다)를 반영한 지금,
        목단 **혼자** 21.4%다. 그러면 에이드 + 프리바티가 합쳐서 1.3%여야 하는데
        시뮬은 7.0%다(3.1 + 3.9). 두 제보가 같은 계정·같은 육성에서 나온 것이 아니면
        한 편성 안에서 동시에 성립할 수 없다 —— 둘 다 **upstream 쪽 제보**다.

        그러므로 42.1%은 이 repo의 명부·육성에 그대로 적용되는 목표가 아닐 수 있다.
        판정하려면 **이 repo 유저가 다섯 명 전원의 비중을 한 번에** 재 주어야 한다.
        고쳐지거나 목표가 바뀌면 이 테스트가 「예상치 못하게 통과」로 뒤집혀 알려 준다.
        """
        result = _run()
        total = sum(result.char_total.values())
        anis = result.char_total['아니스 : 스파클링 서머'] / total
        self.assertAlmostEqual(anis, 0.421, delta=0.02)

    def test_last_bullet_skill_fires_often_at_one_round(self):
        """장탄이 1발로 줄면 «마지막 탄환»이 매 발 터진다 — 그게 이 캐릭터의 설계다."""
        result = _run()
        missiles = [h for h in result.hits
                    if h.caster == '아니스 : 스파클링 서머' and h.skill_name == '스파클링 미사일']
        self.assertGreater(len(missiles), 100, '스파클링 미사일 발동이 너무 적다')


if __name__ == '__main__':
    unittest.main()
