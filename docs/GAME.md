# LIMKETMON 게임 시스템

이 문서는 카드 도감과 배틀을 잇는 수치와 규칙의 근거를 정리합니다. 모든 값은 `lib/` 소스에서만
유도되고, 화면은 규칙을 다시 계산하지 않습니다. 카드를 추가하는 일반 절차는 [README](../README.md)의
"카드 추가" 절차를 따릅니다.

## 카드에서 스탯 유도

`lib/battle/stats.ts`(`STAT_RULESET` 3)가 큐레이션 카드 하나를 전투 스탯으로 바꿉니다. 같은 카드는
언제나 같은 스탯을 냅니다.

| 스탯 | 식 | 현재 매니페스트 범위 |
| --- | --- | --- |
| `atk` | `round(card.attack × 0.7 × rarityScale)` | 13~152 |
| `def` | `round(card.defense × 0.7 × rarityScale)` | 등급별 정규화 |
| `maxHp` | `round((40 + round(defense × 0.62)) × rarityScale)` | 69~204 |
| `spd` | `10 + floor(luck ÷ 4)` | 20~35 |
| `crit` | `5 + floor(luck ÷ 10)` (퍼센트) | 9~15 |
| `cost` | 등급별 코스트 표 | 2~6 |

`rarityScale`은 등급의 평균 전투력(HP + 2×ATK + DEF)을 정규화 밴드 `180 × POWER_CURVE(rarity, 0)`에
맞추는 배수입니다(N 1.0, R 1.25, SR 1.55, SSR 2.4, UR 3.55). 카드 개별 역할은 그대로 두고 등급 간
평균만 약속된 밴드에 맞춥니다. 스킬 코스트:

| 등급 | 정규화 배수 | 스킬 코스트 |
| --- | --- | --- |
| N | 1.0 | 2 |
| R | 1.25 | 3 |
| SR | 1.55 | 4 |
| SSR | 2.4 | 5 |
| UR | 3.55 | 6 |

같은 카드 중복은 강화에 소모합니다. `lib/enhance.ts`의 `MAX_ENHANCE`는 15이고 `enhanceCost(level)`은
레벨이 오를수록 1장씩 더 듭니다(0→1은 1장, 1→2는 2장, …). 기본 카드 1장은 항상 남겨 두고 나머지만
재료가 되므로 화면에 보이는 재료 수는 `enhanceMaterials(quantity) = max(0, quantity - 1)`이고, 저장되는
`inventory.quantity`는 기본 카드를 포함한 전체 합계입니다. 강화 배수는 등급별 `enhancePower(rarity, level)`
곡선의 비율이며, 이 곡선은 N5≈R3≈SR0, N10≈R5≈SR2≈SSR0, N15≈R10≈SR6≈SSR3≈UR0 지점을 근사합니다
(±15%). 모든 호출자는 `applyEnhance(stats, level, rarity)`를 등급과 함께 씁니다. 전투 시작 때 강화
단계를 덱 스냅샷에 고정합니다.

속성은 `visualTags`를 아래 표 순서(light → shadow → iron → nature → spark)로 훑어 처음 맞는
키워드로 정하고, 아무것도 맞지 않으면 `ELEMENTS[version % 5]`로 떨어집니다.

| 속성 | 키워드 |
| --- | --- |
| light | snow, glare, christmas-tree, thumb-up, peace-sign, bouquet, formalwear |
| shadow | dark-background, eyes-closed, back-view, side-profile, low-quality, low-resolution, mask, negative-space, motion-blur, soft-focus |
| iron | glasses, goggles, helmet, winter-gear, winter-jacket, uniform, striped-suit, vehicle, subway, transit, sign, billboard, backpack, papers |
| nature | waterpark, wet-hair, waterline, food, spoon, chopsticks, restaurant, crowd, street, rain-overlay |
| spark | distorted-filter, screenshot, screenshot-overlay, animated, gif, mirror-selfie, phone, phone-foreground, cat-filter, filter, recursive-face, circular-crop, collage, layered-composition, countdown-overlay, chat-overlay, low-angle |

## 능력 DSL

`lib/battle/abilities.ts`(`ABILITY_RULESET` 1)가 카드에서 서명 스킬 하나를 만듭니다. 능력은
JavaScript 콜백이 아니라 데이터입니다: `{ id, name, description, cost, cooldown, ops }`.

- `id`는 `ability:<cardId>@<ABILITY_RULESET>`이고 `name`·`description`은 카드의 `skillName`·`skillDescription`을 그대로 씁니다.
- `cost`는 등급별 코스트 표가 항상 우선입니다.
- `cooldown`은 아래 등급 기본값을 쓰되 `CURATED_ABILITIES`가 있으면 그 값이 이깁니다(N 0 / R 1 / SR 2 / SSR 2 / UR 3).

op 종류:

| op | 필드 | 의미 |
| --- | --- | --- |
| `damage` | `power`, `hits?`, `target?` | `power`만큼 때립니다. `hits`는 1~8 허용, 실행 시 최대 4. |
| `heal` | `amount`, `target?` | 최대 HP까지 회복합니다. |
| `shield` | `amount`, `target?` | `amount`만큼 흡수 풀을 겁니다(지속 2). |
| `apply_status` | `status`, `turns`, `value?`, `chance?`, `target?` | 상태이상을 겁니다. `chance`가 있을 때만 난수를 씁니다. |
| `modify_stat` | `status`, `turns`, `value`, `target?` | `atk_up`·`atk_down`·`def_up`·`def_down`만 허용합니다. |
| `conditional` | `when`, `then` | 조건이 맞으면 `then`을 실행합니다. |

target 종류: `enemy_active`, `enemy_lowest_hp`, `enemy_all`, `self`, `ally_lowest_hp`, `ally_all`.
조건(`when`) 키: `selfHpBelow`, `targetHpBelow`, `turnAtLeast`, `targetHasStatus`. HP 임계값은 최대 HP
대비 퍼센트이고, 모든 절이 참일 때만 `then`이 실행됩니다.

검증 한계(`validateAbility`): `cost` 0~10, `cooldown` 0~5, `ops` 1~8개, `conditional` 중첩 1단계,
`apply_status.turns` 0~10, `chance` 0~100, `damage.hits` 정수 1~8. 엔진은 못 믿는 입력을 만나면
경고를 남기고 기본 공격으로 떨어집니다.

등급별 기본 템플릿(속성 rider가 붙습니다 — light는 아군 공격 강화, shadow는 공격 약화, iron은 방어
약화, nature는 중독, spark는 35% 기절):

| 등급 | 기본 구성 |
| --- | --- |
| N | 1.0배 단타, 방어가 공격보다 높고 HP가 40% 미만이면 자기 회복(4 + round(방어 / 20)) 추가 |
| R | 0.8배 단타 + 속성 rider |
| SR | `luck ≥ 85`면 자기 공격 강화(20%, 3턴) + 0.6배 단타, 아니면 0.5배 3연타 |
| SSR | 방어가 80 이상이면 아군 전체 보호막 + 0.5배 단타, 아니면 0.7배 전체 공격 + 속성 rider |
| UR | HP 60% 미만이면 1.2배 단타 + 자기 회복 20, 이어서 0.6배 전체 공격 + 속성 rider |

`CURATED_ABILITIES`는 소수 카드의 `ops`와 `cooldown`만 덮어씁니다. 이름·설명·코스트는 카드와 등급
표가 계속 우선이라 한국어 카피가 흔들리지 않습니다.

## 상태이상

상태이상은 `{ id, turns, value }`로 다룹니다. 의미는 id마다 다릅니다.

| id | 라벨 | value 의미 | 처리 |
| --- | --- | --- | --- |
| `poison` | 중독 | 턴당 피해 | 보유자 턴 시작 시 `value`만큼 피해. 보호막을 무시합니다. |
| `regen` | 회복 | 턴당 회복 | 보유자 턴 시작 시 `value`만큼 회복(최대 HP까지). |
| `shield` | 보호막 | 남은 흡수량 | 피해를 가장 먼저 흡수합니다. 0이 되면 사라지고, 부여 시 지속은 2입니다. |
| `stun` | 기절 | — | 보유자의 다음 턴을 건너뜁니다. |
| `atk_up` | 공격 강화 | 공격 증가 퍼센트 | 유효 공격력에 `+value%`. |
| `atk_down` | 공격 약화 | 공격 감소 퍼센트 | 유효 공격력에 `−value%`. |
| `def_up` | 방어 강화 | 방어 증가 퍼센트 | 유효 방어력에 `+value%`. |
| `def_down` | 방어 약화 | 방어 감소 퍼센트 | 유효 방어력에 `−value%`. |

지속 턴은 보유자 자신의 턴이 끝날 때 1씩 줄고, 0이 되면 제거됩니다. 중독과 회복은 턴 시작에
처리되고, 기절은 행동 직전에 확인합니다.

## 데미지 계산

피해 한 방은 `lib/battle/engine.ts`에서 아래 순서로 계산합니다.

```text
attackValue = 기본 공격이면 effectiveStat(attacker, 'atk'), 스킬이면 op.power
boost       = element_boost 규칙이 공격자 속성과 맞으면 1 + bonus, 아니면 1
base        = max(1, attackValue × boost − effectiveStat(defender, 'def') × 0.45)
variance    = 0.9 + draw1 × 0.2          (첫 번째 난수)
element     = 링 상대가 다음 속성이면 1.25, 이전 속성이면 0.8, 그 외 1.0
crit        = draw2 × 100 < attacker.crit ? 1.6 : 1.0   (두 번째 난수)
final       = max(1, round(base × variance × element × crit))
```

난수는 피해 한 방마다 "분산 → 치명타" 순서로만 뽑고, `apply_status`는 `chance`가 있을 때만 뽑습니다.
난수는 모두 `state.rng`(mulberry32)에서 나오므로 같은 시드·같은 결정이면 순서가 어긋나지 않습니다.
보호막이 있으면 먼저 흡수하고, 중독·회복은 방어·보호막과 무관한 고정값입니다.

## AI 휴리스틱 우선순위

상대는 순수 함수 `aiDecision(state, profile)`로만 결정합니다(자체 난수 없음). 그래서 클라이언트
미리보기와 서버 재시뮬레이션이 같은 수를 냅니다. 우선순위는 다음과 같습니다.

1. 결정타 — `lethalFirst`이고 기본 공격 추정 피해가 가장 약한 적의 남은 HP 이상이면 기본 공격.
2. 구출 — 스킬에 `heal`이나 `shield`가 있고 아군 중 `healBelow` 비율 이하로 떨어진 유닛이 있으면 스킬.
3. 광역 절제 — 스킬이 `enemy_all`을 노리는데 살아 있는 적 비율이 `skillMinTargets`보다 낮으면 기본 공격.
4. 절제 — 남은 스킬은 `skillAppetite`로 문턱을 정합니다. 에너지가 `cost + round((1 − skillAppetite) × 4)` 이상일 때만 스킬.

상대별 프로필 값(`healBelow`, `lethalFirst`, `skillMinTargets`, `skillAppetite`)은
`lib/battle/opponents.ts`에 있고, 같은 id의 전투를 다시 돌릴 때 그대로 조회됩니다.

## 강화 해금 기술

46장 각각은 중복 강화 +5 / +10 / +15에서 카드 전용 기술을 하나씩 얻습니다(총 138개). 이름·설명·계열은
`lib/data/enhance-skills.json`에 정적으로 저장되고, 실제 op는 `lib/battle/enhance-skills.ts`가 그 카드의
*강화된* 전투 스탯에서 결정적으로 만들어냅니다. 같은 카드에 같은 강화 단계면 언제나 같은 기술입니다.

- `+5`는 서명을 잇는 실전용 기술, `+10`은 아군 전체나 유틸리티, `+15`는 강한 피니셔입니다.
- op는 기존 능력 DSL만 씁니다. 새 op도, 더 깊은 조건부도 없습니다.
- 기존 서명 능력은 그대로 유지됩니다. `abilityFor(card)`는 손대지 않고, 전투에 들어갈 때
  `scaleAbility`가 `rarityScale(rarity) × enhancePower(rarity, level) / enhancePower(rarity, 0)`만큼
  **고정 수치**(피해·회복·보호막·중독/회복 틱)만 키웁니다. 확률·턴 수·에너지·공격/방어 퍼센트는
  그대로라서 고등급·고강화에서도 서명이 쓸모를 유지합니다.
- 모든 기술은 기운과 재사용 대기를 **공유**합니다. 새 쿨다운 맵은 없습니다. 코스트는 등급 기본
  코스트에서 단계마다 1씩 오르고, 재사용 대기는 +5가 0, +10이 1, +15가 2이며, 마지막으로 쓴 기술이
  공용 카운터를 덮어씁니다. 선택한 기술의 코스트·재사용 값으로 판정합니다.
- `CombatantSeed.skills`(그리고 `Combatant.skills`)에는 해금된 추가 기술만 담깁니다. 상대는 강화가
  없으므로 항상 비어 있고, 그래서 AI는 기본 서명만 씁니다(클라이언트 미리보기와 서버 재현이
  갈라지지 않습니다).
- `Decision`은 `{ uid, action, skillId? }`입니다. `skillId`가 없으면 예전처럼 기본 서명을 씁니다.
  명시된 id가 그 전투원의 `skills`에 없거나, 문자열이 아니거나, 비었거나, 64자를 넘으면 상태를
  건드리기 전에 거부합니다(오류 `'skill'`). `attack`에 id가 붙으면 `'action'` 오류입니다. 실제 기술
  이름은 `action` 이벤트의 `abilityName`으로 기록되므로 로그와 replay가 선택을 그대로 재현합니다.
- `finishBattle`은 `skillId`를 문자열·길이(1~64)로만 검사하고, 어느 기술인지와 합법성은 재시뮬레이션이
  판정합니다. 어긴 기록은 보상을 주지 않고 `invalid`로 남습니다.

## 서버 재시뮬레이션과 replay 재현 절차

전투는 서버가 시드·상대·규칙·덱 스냅샷을 정해 `battles` 행에 남기고, 클라이언트는 덱 id와 행동
로그만 보냅니다. 같은 전투를 재현하는 절차는 다음과 같습니다.

1. `battles` 행에서 `kind`, `opponent_id`, `ruleset_version`, `seed`, `deck_cards`, `modifier`, `decisions`를 읽습니다.
2. `deck_cards` 슬롯 순서와 `opponent_id`로 `buildSetup(...)`을 만들어 `BattleSetup`을 복원합니다(상대 팀은 `opponents.ts` 정의에서 나옵니다).
3. 저장된 `decisions`를 순서대로 대고, 상대 턴은 `aiDecision(state, opponent.profile)`로 결정해 `runBattle(setup, decisions, decide)`을 돌립니다.
4. 나온 `state.status`를 저장된 `result`와 비교합니다. `replay`는 이 일치 여부를 `verified`로 돌려줍니다.
5. 저장된 `ruleset_version`이 현재 `BATTLE_RULESET_VERSION`과 다르면 재판정하지 않고 `invalid`로 확정합니다.

`Decision`은 `{ uid, action: 'attack' | 'skill', skillId? }`이고 `uid`는 `state.activeUid`와 같아야
합니다. `skillId`는 강화로 해금한 기술을 고를 때만 붙습니다. 그래서 재현에는 시드와 결정 목록만
있으면 충분합니다. 스탯·능력·엔진 규칙이 결과를 바꿀 수 있게 바뀌면 `BATTLE_RULESET_VERSION`을
올리고, 이전 버전의 전투는 다시 심사하지 않습니다.

## 새 카드 추가 시 자동 유도

카드를 추가할 때 스탯표나 능력표를 손으로 만들지 않습니다.

1. README의 카드 추가 절차대로 이미지와 `lib/data/cards.curated.json` metadata(`rarity`, `attack`, `defense`, `luck`, `visualTags`, `skillName`, `skillDescription`)를 채웁니다.
2. `pnpm cards:sync`로 이미지와 manifest 정합성을 확인합니다.
3. `node --import ./tests/helpers/register.mjs --test tests/battle-data.test.ts`로 스탯 밴드와 능력 DSL 유효성, 능력 id 중복 여부를 확인합니다. 능력은 등급 템플릿에서 자동 생성되므로 카드별 작업이 필요 없습니다.
4. 특정 카드의 서명만 조정하고 싶으면 `CURATED_ABILITIES`에 `ops`/`cooldown`만 추가합니다. 이름·설명·코스트는 건드리지 않습니다.
5. `lib/data/enhance-skills.json`에 그 카드의 +5/+10/+15 기술 이름·설명·계열을 넣습니다. `tests/enhance-skills.test.ts`가 카드마다 세 개가 있는지, 이름·id가 겹치지 않는지, DSL이 유효한지 확인합니다.

스탯과 능력을 계산하는 규칙 자체를 바꾸면 `STAT_RULESET` 또는 `ABILITY_RULESET`을 올립니다.

## 난이도 모드와 뽑기권

`lib/battle/opponents.ts`가 모드를 정의합니다: `normal`(일반), `hard`(하드), `chaos`(카오스). 일반 상대
5개를 모두 첫 격파하면 하드가, 하드 5개를 모두 첫 격파하면 카오스가 열립니다. 잠금은 서버가
`reward_claims`의 claim key(`pve_first:<상대>`, `pve_first:hard:<상대>`, …)로 강제하며, 클라이언트의
모드 선택은 힌트일 뿐입니다. 모드별 첫 격파 보상은 1x/2x/4x이고, 일반 모드부터 기본 스탯과 AI가 상향되어
단순 저등급 덱의 무조건 승리가 방지되며, 하드·카오스는 체력(HP)뿐만 아니라 공격력·방어력(ATK/DEF)과 AI 성향이
점진적으로 강화되어 실질적인 위협을 형성합니다. 데일리 챌린지는 별도의 일반 모드입니다. `BATTLE_RULESET_VERSION`이 4로 올라가
이전 버전의 미정산 전투는 `invalid`로 확정됩니다.

뽑기는 `normal`(뽑기권)·`sr`(SR 이상 뽑기권)·`ssr`(SSR 이상 뽑기권) 세 종류이며 잔액이 분리됩니다.
1/5/10 연속을 지원하고, 하루 한 번의 무료 뽑기는 일반 단일 뽑기에만 적용됩니다. 보장 뽑기권은 최소
등급을 보장하며 일반 천장(pity) 카운터를 건드리지 않습니다. 일반 천장은 30회부터 SSR+ 확률이 점점
오르고 60회째 뽑기를 UR 22%·SSR 78%로 확정하며, 화면 확률표도 이 확정 수치를 그대로 보여줍니다.
승리하면 모드별 확률로 뽑기권이
떨어지고(일반 SR 10%·SSR 2%, 하드 20%·5%, 카오스 30%·10%), 이 드랍은 정산 시 서버 암호학적 난수로 추첨 및 단일 트랜잭션으로 확정 지급·영구 캐시되어 시드 쇼핑이 불가능합니다. 데일리는 하루 한 번의 첫 정산에서만 드랍합니다. 쿠폰은
`LIMKETMON`(뽑기권 100), `LIMKETMON_SR_100P`(SR 이상 20), `LIMKETMON_SSR_100P`(SSR 이상 20)이며
대소문자를 가리지 않고 1인 1회입니다.
