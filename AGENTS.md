# NIKKE Damage Calculator

승리의 여신: 니케 5인 스쿼드의 실시간 전투와 DPS를 계산한다.

## 사용자와 일하는 방식

- **사용자에게 하는 말은 번체 중국어(繁體中文)로 쓴다.** 이 저장소의 데이터 키·코드
  주석·commit 메시지는 한국어지만(상류 `Jgaram/nikke-calc`의 언어) **사용자는 한국어를
  읽지 못한다** — 한국어가 섞인 설명은 그에게 빈 칸이나 같다.
- **캐릭터 이름도 사용자에게는 번체 중국어로 말한다.** 표는 `data/locale_text.json`의
  `characters[한국어 이름]["zh-TW"]`. 필요하면 괄호로 한국어 키를 덧붙인다.
  코드·commit·`context/*.md` 안쪽은 한국어 그대로 둔다 — 저장소의 기존 관례다.
- **새로 쓰는 주석은 번체 중국어로 쓴다.** 기존 파일이 한국어인 것은 상류 작성자의
  것이고, 이 포크가 그 파일에 새로 넣는 줄도 번체 중국어다.
- **게임 메커니즘은 사용자가 정본이다.** 그는 실제로 플레이하고 유니온을 운영한다.
  저장소 안에서 서로를 증명하던 값 세 곳이 **함께 틀린 적이 있다**(유니온 레이드 전투
  시간을 90초로 적어 뒀지만 실제는 180초, 테스트 한 조까지 같이 틀렸다). 게임 수치가
  걸리면 기존 값을 믿지 말고 먼저 묻는다.
- **그는 commit을 저장점으로 쓴다.** 단계가 끝날 때마다 전체 검증을 돌리고 commit한다.
- **`master`로 합치면 배포가 돈다**(`.github/workflows/pages.yml`). 합치기 전에 묻고,
  **초록불을 배포 완료로 읽지 않는다.** 자산 지문은 `__BUILD_ID__`가 `Date.now()`라
  내용이 그대로여도 매번 바뀌므로 「새 판이 올라갔다」까지만 증명한다 — **내 변경이
  들어갔다는 증명은 온라인 파일을 받아 표식을 찾는 것**이다. 요령은
  `docs/上游移植-交接筆記.md` §5.
- **내 브라우저는 그의 브라우저가 아니다.** 그의 화면·그의 저장된 판은 보이지 않는다.
  그의 로컬 데이터(`localStorage`의 유니온 판 등)는 확인용이라도 지우지 않는다.

## Repository contracts

- `scraper/nikke_scraped.json`은 수집 원시 데이터의 유일한 정본이다. `data/`에 사본을 만들지 않는다.
- 출시 전 카드 이미지에서 옮겨 적은 스킬 원문은 `scraper/preview_skills.json`에만 둔다.
  스키마는 `nikke_scraped.json` 항목과 동일하되 `values`는 레벨 10만 갖는다.
  출시되면 스크랩 원문과 대조해 정식 등록하고 이 파일에서 제거한다 — `doclint.py`가 강제한다.
- 시뮬레이션용 character dict는 `context/spec.py`에서만 만든다. `calculator/`는 이를 import하지 않는다.
- `profiles/`는 **개인 계정 육성 데이터**다. 통째로 gitignore이며 `scraper/.session_cookie`(계정
  접근권)와 함께 어떤 경우에도 커밋 대상에 올리지 않는다. 만드는 것은 둘뿐이다 —
  내 계정은 `profile-sync` skill, 남이 건네준 파일은 `scraper/profile_import.py`.
  후자가 읽는 내보내기(`exports/`)와 거기서 나온 보고서(`out/`)도 같은 이유로 gitignore다:
  남의 계정 자료이고, 도구에 따라 **로그인 쿠키까지 딸려 온다**(변환기는 그것을 읽지 않는다).
- `context/baseline/`의 golden snapshot은 손으로 편집하지 않는다.
- 공용 skill의 정본은 `.agent/skills/`다. `.claude/skills/`는 호환 진입점일 뿐이다.

## Context routing

필요한 문서와 절만 읽고, 현재 작업과 무관한 context는 다시 읽지 않는다.

| 상황 | 정본 |
|---|---|
| 캐릭터 이름 해석 | `context/ALIASES.md` |
| 스킬 파싱 규칙·현황·예외 | `context/PARSING.md`, `context/PARSING-CHARS.md` |
| stat/trigger/target 로스터와 구현 상태 | `context/IMPL-STATUS.md` |
| 컨트롤 메커니즘 | `context/CONTROL.md` |
| 인게임 검증값·추정값 | `context/DATA_VERIFY.md` |
| 기본 스펙·회귀 운영 | `context/HARNESS.md` |
| 게임 메커니즘 | `context/GAMEPLAY.md`의 관련 절만 |
| 캐릭터별 사이클·검증 또는 메커니즘 조사 | 해당 `context/scenarios/*.md`가 있을 때만 |
| **지금까지 뭘 했고 다음이 뭔가**(상류 이식) | `docs/上游移植-交接筆記.md` — 진행은 §0, 남은 일은 §4 |
| 상류 commit별 이식 판정 | `context/UPSTREAM-MAPPING.md`(이식 장부 정본) |
| 유니온 레이드 기능 전체 | `docs/聯盟突襲-交接筆記.md` |
| 회차 보스 카드·전투 조건·기본 편성 | `docs/union-boss-catalog.md` |

`GAMEPLAY.md`는 전체 통독하지 않는다. 편성은 `§스쿼드 구성`, 사이클은
`§버스트 쿨타임 감소`·`§풀버스트 사이클`, 파싱은 `§트리거 발동 의미`,
컨트롤은 요약만 읽고 상세는 `CONTROL.md`를 쓴다.

## Character names

캐릭터 이름이 나오면 작업 종류와 관계없이 먼저 `context/ALIASES.md`로 정식 명칭을 확인한다.
표에 없는 축약어는 추측하지 말고 묻는다. 코드·데이터·답변에는 정식 명칭만 쓴다.
신규 캐릭터 등록 중 아직 별칭이 없다면 입력된 정식 명칭을 그대로 쓴다.

## Simulation invariants

- 공통 기본 스펙과 캐릭터별 상시 차이는 `context/spec.py`·`data/char_defaults.json`에 두고, 특정 스쿼드만의 차이는 호출부에 둔다.
- 기본 layer에서 벗어난 설정으로 실행했다면 결과와 함께 이탈 목록을 그대로 보고한다.
- `preview_skills.json`에 있는 캐릭터가 낀 시뮬·리포트 결과는 `[프리뷰 · 미검증]`을 함께 보고한다.
  스킬 레벨 10 외의 설정으로는 실행할 수 없다(값이 없어 조용히 0이 되는 대신 즉시 실패한다).
- 계산기 코드를 수정하면 `python -m context.snapshot`과 `python -m context.doclint`를 실행한다.

## Skills

| 요청 | skill |
|---|---|
| 신규 캐릭터 추가 또는 기존 캐릭터 재구현 | `char-add` — 수집부터 시나리오·파싱·구현·검증까지 전부 담당 |
| 출시 전 카드 이미지로 선행 등록 | `char-add` — 단계 0P로 진입 |
| 등록과 무관한 raw 게임 데이터 갱신만 | `char-scrape` |
| 조합·운용 비교, enikk 대조, 중복 없는 솔로레이드 N덱 최적화·지정 편성 계산 | `report-squad` |
| 한 캐릭터의 육성 효율 (덱 고정, 변수 한 축씩) | `report-growth` |
| **내 계정의 실제 육성 데이터를 받아오기** | `profile-sync` — 로그인 세션 필요, 산출물은 로컬 전용 |
| **유니온원이 건네준 내보내기를 프로필로** | skill이 아니라 스크립트다: `python scraper/profile_import.py exports/` |
| **여러 사람을 같은 덱으로 견주기** | skill이 아니라 러너다: `python -m context.union_compare --squad "..."` |
| **내 실제 스펙으로 계산** | skill이 아니라 러너 옵션이다: `sim.py --profile <이름>` · 보고서 스펙의 `"profile"` 키 |
| 변경사항 커밋 | `commit` |

각 skill의 세부 절차와 gate는 해당 `SKILL.md`에서만 관리한다.

## Documentation

- 게임 명세·인게임 검증·시나리오는 문서가 정본이고, 구현 상태처럼 코드에서 판정 가능한 사실은 코드·데이터가 정본이다.
- 코드·데이터의 재서술은 가능한 한 쓰지 않는다. 불가피한 사본은 정본을 선언하고 `context/doclint.py`의 `MIRRORS`에 등록한다.
- 사용자 요청과 관련 context가 충돌하면 양쪽을 인용하고 어느 쪽을 따를지 묻는다.
- `context/*.md`를 바꾸기 전에는 해당 파일을 읽고 변경안을 제시해 확인받는다.
