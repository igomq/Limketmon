# LIMKETMON

임신규 사진 카드를 뽑고 수집해 덱을 짜서 겨루는 카드 게임입니다. OpenAI Sites용 Vinext + React 앱이며,
Sign in with ChatGPT로 사용자를 식별하고 Cloudflare D1에 계정별 뽑기권·도감·덱·전투·쿠폰 기록을 저장합니다.

## 수집 경험

- 로그인 없이 전체 도감과 카드 상세를 미리 볼 수 있습니다.
- 발견 화면에서 추천 카드와 최근 수집한 카드를 확인합니다.
- 도감에서 이름·번호·스킬 검색, 등급·보유 상태 필터, 희귀도·번호·최근 수집순 정렬을 지원합니다.
- 카드를 만지면 위치에 따라 기울기와 빛이 반응합니다. N은 기본 광택, R은 은은한 색 반사, SR은 무지개 홀로그램, SSR은 금빛 반사 띠, UR은 여러 색이 겹치는 오로라 효과를 제공합니다.
- 팩을 연 뒤 카드를 눌러 뒤집고, 좌우로 넘기거나 한 번에 모두 확인할 수 있습니다. 모든 결과는 연출 전에 저장됩니다.
- 모바일은 하단 탐색 메뉴와 끌어서 닫을 수 있는 카드 상세 시트를 제공합니다. 키보드 탐색과 동작·투명도 줄이기 설정도 지원합니다.
- 무료 뽑기는 KST 자정에 갱신됩니다. 웰컴 쿠폰 `LIMKETMON`은 계정당 한 번 SSR 이상 뽑기권 1장, 보통 뽑기권 10장, 하급 뽑기권 50장을 지급합니다.

뽑기권 차감, 카드 지급, 뽑기 이력은 하나의 D1 transaction에서 처리합니다. 저장 실패 시 차감과 무료 횟수도 함께 복구됩니다.

## 게임

수집한 카드로 덱을 짜고 5단계 PvE 상대와 3대3 배틀을 벌입니다. 전투 시작·검증·보상은 모두 서버가 처리하며,
카드에서 스탯과 능력을 어떻게 유도하는지는 [docs/GAME.md](docs/GAME.md)에 정리했습니다.

### 덱

- 덱은 정확히 3장이고 같은 카드를 중복으로 넣을 수 없습니다. 보유한 카드만 사용합니다.
- 계정당 최대 10개까지 만들 수 있고, 이름은 앞뒤 공백을 제거한 뒤 24자로 자릅니다.
- 보유 카드가 3장 이상이면 덱이 하나도 없을 때 보유 카드 중 등급이 높은 순으로 기본 덱을 자동 생성합니다. 기본 덱은 하나만 유지됩니다.

### PvE 5단계

상대는 덱 구성과 AI 성향, 체력 배율로 난이도를 냅니다. 아래 크레딧은 첫 격파에만 지급합니다.

| 상대 | 난이도 | 첫 격파 보상 |
| --- | --- | --- |
| 루키 조교(`rookie`) | beginner | 2 |
| 단골 도전자(`regular`) | normal | 3 |
| 파티 베테랑(`veteran`) | normal | 4 |
| 에이스(`ace`) | hard | 5 |
| 최종 보스(`boss`) | boss | 8 |

### 데일리 챌린지

- KST 날짜를 유일한 입력으로 삼아, 같은 날 모든 사용자가 같은 상대와 같은 규칙으로 겨룹니다.
- 규칙은 등급 제한(`R` 또는 `SR` 이하), 속성 강화(+25%), 12라운드 제한, 제한 없음 중 하나가 날짜에 따라 정해지고, 상대는 5단계를 순환합니다.
- 승리하면 크레딧 3을 하루 한 번만 지급합니다.

### 업적

8종이며 조건을 처음 만족한 시점에 한 번만 보상합니다.

| 업적 | 조건 | 보상 |
| --- | --- | --- |
| 첫 승리 (`first_win`) | 배틀 첫 승리 | 2 |
| 10승 달성 (`wins_10`) | 누적 10승 | 5 |
| 보스 격파 (`boss_clear`) | 보스 상대 격파 | 5 |
| N등급의 반란 (`n_only_win`) | N 등급 카드만으로 승리 | 4 |
| 역전의 순간 (`clutch_win`) | 체력 10% 이하로 버틴 아군과 승리 | 4 |
| 모든 등급 수집 (`all_rarities`) | N·R·SR·SSR·UR 모두 보유 | 10 |
| 100회 뽑기 (`pulls_100`) | 누적 100회 뽑기 | 5 |
| 데일리 3회 클리어 (`daily_3`) | 데일리 3회 클리어 | 3 |

### 기록과 통계

- 승·패, 승률(소수점 1자리), 보스·데일리 격파 횟수는 전체 이력 카운터에서, 현재·최고 연승과 상위 카드 5장, 등급별 사용 슬롯은 승·패, 승률(소수점 1자리), 현재·최고 연승, 상위 카드 5장, 등급별 사용 슬롯, 보스·데일리 격파 횟수를 보여줍니다.
- 뽑기 누적 횟수와 등급별 뽑기 분포도 함께 표시합니다.

### 배틀 규칙

- 3대3 라운드제입니다. 매 라운드 속도(`spd`) 내림차순으로 행동하고, 같은 속도면 아군(side a)이 먼저, 그다음 슬롯 순서입니다.
- 전투 시작 시 에너지 3으로 시작해 자기 턴마다 1씩 회복하며 최대 10까지 쌓입니다.
- 스킬은 등급별 코스트(N 2 / R 3 / SR 4 / SSR 5 / UR 6)를 쓰고, 쓴 뒤 등급별 쿨다운(N 0 / R 1 / SR 2 / SSR 2 / UR 3)만큼 쉬어야 다시 나갑니다.
- 속성 링은 `물 → 불 → 풀 → 대지 → 암흑 → 물`이며 다음 속성에게 +25%, 이전 속성에게 −20%가 적용됩니다.
- 상태이상은 중독·회복·보호막·기절·공격 강화·공격 약화·방어 강화·방어 약화 8종입니다.
- 치명타 확률은 카드 운(`luck`)에서 유도하고(9~15%), 피해에는 0.9~1.1 배율의 분산이 붙습니다.
- 40라운드를 넘기면 무승부로 끝납니다. 턴 제한 규칙이 걸리면 그 라운드까지 이기지 못할 때 패배합니다.

### 서버 권위

- 전투 시작 시 클라이언트는 덱 id와 상대(또는 데일리)만 보냅니다. 시드·상대·규칙·덱 스냅샷·보상은 서버가 정하고 `battles` 행에 기록합니다.
- 저장된 시드·덱 스냅샷·규칙 버전·결정 로그로 서버가 같은 AI를 다시 돌려 결과를 검증한 뒤에만 보상을 지급합니다.
- 저장된 `ruleset_version`이 현재 규칙 버전과 다르면 재시뮬레이션하지 않고 `invalid`로 확정합니다.
- 로그가 재현되지 않으면 지급 없이 invalid만 돌려주고 그 전투는 pending으로 남깁니다. 올바른 로그로 다시 정산할 수 있어 첫 격파 보상 기회가 사라지지 않습니다.
- 같은 전투를 다시 종료해도 결과는 한 번만 지급됩니다. `settle:<battleId>` 키와 D1 batch 트랜잭션이 중복 지급을 막습니다.
- `replay`는 저장된 시드·덱 스냅샷·결정 로그로 다시 돌려 저장된 결과와 일치하는지(`verified`)를 돌려줍니다.

### 카드 성장·보상·뽑기 확률

카드 분해, 특성 강화, 초월, 합성과 모드별 승리 보상은 [카드 성장 규칙](docs/CARD_GROWTH.md)을 따릅니다.
일반 대련은 매 승리마다 난이도에 맞는 뽑기권을 지급하고 최초 격파 시 같은 보상을 한 번 더 지급합니다.
데일리는 하루 첫 승리, 업적은 최초 달성 시 보상을 지급합니다. 모든 지급은 D1 트랜잭션과 고유한 지급 키로 중복 수령을 방지합니다.

| 등급 | 보통 뽑기 | 하급 뽑기 |
| --- | ---: | ---: |
| N | 60% | 78% |
| R | 28% | 20% |
| SR | 10% | 1.9% |
| SSR | 1.9% | 0.1% |
| UR | 0.1% | 0% |

SR 이상·SSR 이상 뽑기권은 해당 등급 이상의 기본 가중치를 정규화합니다. XR은 초월로만 획득합니다.
뽑기 횟수에 따른 확률 보정과 확정 지급은 적용하지 않습니다.

### 전투 수명 주기

- 클라이언트가 로그를 잃어 정산이 재현되지 않으면 그 전투는 지급 없이 pending 으로 남습니다. 이후 올바른 로그로 다시 정산할 수 있어 첫 격파 보상 기회가 영구히 사라지지 않습니다.
- 정산은 settle:<battleId> 지급 키로 잠그므로 같은 전투를 동시에 여러 번 정산해도 지급은 한 번입니다. 진 쪽 요청은 먼저 정산한 결과를 그대로 돌려받습니다.
- 계정당 열어 둘 수 있는 pending 전투는 40건이고, 넘으면 오래된 것부터 정리합니다.
- 데일리 보상은 전투를 시작한 KST 날짜에 귀속됩니다. 쉬운 날의 전투를 열어 두고 어려운 날에 정산해도 시작한 날의 보상으로만 지급됩니다.
- 덱 상한(10개)과 기본 덱 하나 규칙은 개수 조회가 아니라 단일 INSERT 문 안에서 강제하므로 동시 생성으로도 넘길 수 없습니다.
- 스타터 덱은 카드 3장을 처음 모은 계정에 한 번만 자동 생성되며, 동시 요청이 겹쳐도 하나만 만들어집니다.

### 뽑기 차감의 일관성

뽑기권 차감과 카드 지급은 하나의 트랜잭션으로 처리합니다. 동시 요청에서도 잔액을 초과한 차감은 전체 지급과 함께 취소됩니다.
하급·보통·SR 이상·SSR 이상 뽑기권의 잔액은 각각 분리합니다.

## 구성

- `app/`: React 화면과 API Route
- `lib/`: 게임 규칙과 수동 큐레이션 카드 manifest
- `lib/battle/`: 결정적 배틀 엔진과 카드 스탯·능력 유도
- `db/`: Drizzle 기반 D1 스키마와 바인딩
- `drizzle/`: 로컬과 Sites 배포에 적용되는 SQL migration
- `public/cards/`: 서비스에서 사용하는 카드 이미지
- `.openai/hosting.json`: Sites 프로젝트 ID와 논리적 D1 바인딩 이름
- `wrangler.local.jsonc`: 로컬 D1 CLI 전용 설정

`.openai/hosting.json`과 `wrangler.local.jsonc`에는 비밀값이 없습니다. 운영 D1의 실제 ID와
자격 증명은 Sites가 관리합니다.

## 요구 사항

- Node.js 22.13 이상
- Corepack이 제공하는 pnpm

버전 확인:

```bash
node --version
corepack pnpm --version
```

## 최초 로컬 설정

저장소를 clone한 뒤 다음 순서로 실행합니다.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm db:local:migrate
pnpm dev
```

`pnpm db:local:migrate`는 `drizzle/`의 migration을 로컬 D1에 적용합니다. 같은 migration은
다시 실행해도 건너뜁니다. 개발 서버는 터미널에 표시된 로컬 URL에서 열고, 첫 화면의
`ChatGPT로 시작하기`를 누르면 로컬 전용 테스트 사용자로 로그인됩니다.

| 항목 | 로컬 값 |
| --- | --- |
| 사용자 ID | `local_seedy` |
| 이메일 | `seedy@sites.test` |
| 표시 이름 | `Seedy` |
| 로그인 URL | `/signin-with-chatgpt?return_to=/` |
| 로그아웃 URL | `/signout-with-chatgpt?return_to=/` |

로컬 로그인은 `localhost`, `127.0.0.1`, `::1`에서만 동작하며 운영 빌드에는 포함되지 않습니다.

## 로컬 D1

개발 서버는 `vite.config.ts`의 `DB` 바인딩으로 로컬 D1을 사용합니다. Wrangler CLI도 같은
database ID와 `.wrangler/state` 저장소를 사용하도록 `wrangler.local.jsonc`에 맞춰져 있습니다.
로컬 데이터는 운영 D1과 완전히 분리되며 Git에도 올라가지 않습니다.

현재 테이블:

- `users`: ChatGPT 사용자 ID와 이메일
- `user_game_state`: 뽑기권별 잔액, 마지막 무료 뽑기 KST 날짜, 성장 재료 잔액
- `inventory`: 사용자별 카드 수량
- `coupon_redemptions`: 계정별 쿠폰 사용 기록
- `pull_history`: 뽑기 이력
- `decks`: 사용자별 덱과 기본 덱 플래그
- `deck_cards`: 덱 슬롯(0~2)별 카드
- `battles`: 시드·덱 스냅샷·결정 로그와 검증된 전투 결과
- `user_achievements`: 업적 달성 기록
- `reward_claims`: 첫 격파·데일리·업적·전투 정산의 1회성 지급 키

migration 상태 확인:

```bash
pnpm exec wrangler d1 migrations list DB --local --config wrangler.local.jsonc
```

테이블 확인:

```bash
pnpm exec wrangler d1 execute DB --local --config wrangler.local.jsonc \
  --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
```

로컬 DB를 완전히 초기화하려면 개발 서버를 종료하고 `.wrangler/state`를 삭제한 다음
`pnpm db:local:migrate`를 다시 실행합니다. 이 작업은 로컬 계정의 카드와 뽑기권도 모두 지웁니다.

### 스키마 변경

1. `db/schema.ts`를 수정합니다.
2. `pnpm db:generate`로 새 migration을 만듭니다.
3. 생성된 `drizzle/*.sql`을 검토합니다.
4. `pnpm db:local:migrate`로 로컬 D1에 적용합니다.
5. `pnpm test && pnpm build`로 검증합니다.

운영 D1에 `wrangler --remote`를 직접 실행하지 않습니다. Sites 배포 시 `drizzle/` migration이
빌드 산출물에 포함되고 Sites가 운영 데이터베이스에 적용합니다.

## 개발

```bash
pnpm dev
```

`next dev`가 아니라 위 명령을 사용해야 합니다. Vinext, Sites 로컬 로그인, Workers 런타임,
D1 바인딩을 함께 실행하기 때문입니다. `.env`는 현재 필요하지 않으며, 추가할 경우 `.env*`는
Git에서 제외됩니다.

## 테스트

```bash
pnpm test
pnpm check
pnpm build
```

- `pnpm test`: KST 날짜·희귀도 확률과 뽑기권, 이미지·metadata, 도감 검색·필터·정렬, 제스처 도착 위치 계산, SQLite 기반 뽑기 차감·지급의 원자성을 검사합니다.
- `tests/battle-engine.test.ts`: 속도 순서·속성 링·상태이상·쿨다운·에너지와 같은 시드·같은 결정의 재현성을 검사합니다.
- `tests/battle-data.test.ts`: 카드 스탯 유도 밴드, 능력 DSL 유효성, 5개 상대 구성을 검사합니다.
- `tests/battle-server.test.ts`: 덱 소유 검증, 서버 재시뮬레이션, 1회성 보상과 동시 종료, 데일리, 잔액 부족 롤백을 실제 migration 위에서 검사합니다.
- `tests/progression.test.ts`: 덱 규칙, 데일리 규칙 회전, 업적 8종, 보상 계획, 통계 집계를 검사합니다.
- tests/battle-races.test.ts: 병렬 뽑기의 초과 차감 방지, 스타터 덱 경쟁, 덱 상한, 데일리 뱅킹, pending 상한, 로그 없는 정산의 재시도 가능성을 검사합니다.
- tests/api-e2e.test.ts: 실제 라우트 핸들러로 무료 뽑기 → 쿠폰 → 5연차 → 덱 → 전투 → 보상 → replay → 데일리까지 한 흐름을 검사합니다.
- tests/migration.test.ts: drizzle migration 을 순서대로 적용해 스키마 생성, 기존 데이터 보존, 파괴적 변경 없음, schema.ts 와의 일치를 검사합니다.
- `pnpm check`: TypeScript 타입을 검사합니다.
- `pnpm build`: React/Vinext 타입과 번들, Workers 호환성, Sites 메타데이터와 migration 포함을
  검사합니다. 운영 D1에는 연결하지 않습니다.

수동 통합 확인은 다음 순서가 가장 짧습니다.

1. `pnpm db:local:migrate` 후 `pnpm dev`를 실행합니다.
2. 로컬 로그인 후 무료 1회 뽑기를 확인합니다.
3. 쿠폰 `LIMKETMON`을 적용해 뽑기권 100개가 추가되는지 확인합니다.
4. 5연속 뽑기로 뽑기권이 정확히 5개 차감되는지 확인합니다.
5. 도감이 `UR → SSR → SR → R → N` 순서인지 확인합니다.

## 카드 추가

1. `images/`에 `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, `.gif` 파일을 넣습니다.
2. `pnpm cards:sync`를 실행해 다음 `limsingyu-vNNN.ext` 번호 제안을 확인합니다.
3. 이미지를 직접 확인한 뒤 제안된 이름으로 rename하고 `lib/data/cards.curated.json`에 metadata를 추가합니다.
4. 다시 sync해 검증하고 `public/cards/`에 원본 바이트 그대로 복사합니다. 기존 큐레이션 metadata는 변경되지 않습니다.

## 명령 요약

| 명령 | 설명 |
| --- | --- |
| `pnpm dev` | Sites 로그인과 로컬 D1을 포함한 개발 서버 |
| `pnpm test` | DB가 필요 없는 Node 단위 테스트 |
| `pnpm check` | TypeScript 타입 검사 |
| `pnpm build` | Sites 배포용 production build |
| `pnpm db:local:migrate` | 로컬 D1 migration 적용 |
| `pnpm db:generate` | `db/schema.ts` 변경으로 migration 생성 |
| `pnpm cards:sync` | 새 사진을 카드 manifest와 정적 이미지에 등록 |

## 자주 발생하는 문제

- `no such table` 오류: `pnpm db:local:migrate`를 먼저 실행합니다.
- migration 중 `table ... already exists` 오류: 이전 개발 환경이 migration 이력 없이 만든 로컬
  DB입니다. 보존할 로컬 데이터가 없다면 개발 서버를 종료하고 `.wrangler/state`를 삭제한 뒤
  `pnpm db:local:migrate`를 다시 실행합니다.
- `Cloudflare D1 binding DB is unavailable`: `pnpm dev`로 실행했는지 확인합니다.
- 로그인 후에도 로그인 화면이 보임: `localhost` 또는 `127.0.0.1`로 접속하고 쿠키를 허용합니다.
- Node가 `.ts` 파일을 실행하지 못함: Node 22.13 이상으로 올립니다.
- 운영 반영이 안 됨: Git push만으로 Sites가 자동 배포되지는 않으므로 새 Sites 버전을 배포해야 합니다.
