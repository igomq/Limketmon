# LIMKETMON

임신규 사진 카드를 뽑고 수집하는 카드 도감입니다. OpenAI Sites용 Vinext + React 앱이며,
Sign in with ChatGPT로 사용자를 식별하고 Cloudflare D1에 계정별 뽑기권·도감·쿠폰 기록을 저장합니다.

## 수집 경험

- 로그인 없이 전체 도감과 카드 상세를 미리 볼 수 있습니다.
- 발견 화면에서 추천 카드와 최근 수집한 카드를 확인합니다.
- 도감에서 이름·번호·스킬 검색, 등급·보유 상태 필터, 희귀도·번호·최근 수집순 정렬을 지원합니다.
- 카드를 만지면 위치에 따라 기울기, 무지개 포일, 글리터가 반응합니다. N은 광택, R은 홀로그램, SR 이상은 글리터가 더해집니다.
- 팩을 연 뒤 카드를 눌러 뒤집고, 좌우로 넘기거나 한 번에 모두 확인할 수 있습니다. 모든 결과는 연출 전에 저장됩니다.
- 모바일은 하단 탐색 메뉴와 끌어서 닫을 수 있는 카드 상세 시트를 제공합니다. 키보드 탐색과 동작·투명도 줄이기 설정도 지원합니다.
- 무료 뽑기는 KST 자정에 갱신됩니다. 웰컴 쿠폰 `LIMKETMON`은 계정당 한 번 뽑기권 100장을 지급합니다.

뽑기권 차감, 카드 지급, 뽑기 이력은 하나의 D1 transaction에서 처리합니다. 저장 실패 시 차감과 무료 횟수도 함께 복구됩니다.

## 구성

- `app/`: React 화면과 API Route
- `lib/`: 게임 규칙과 수동 큐레이션 카드 manifest
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
- `user_game_state`: 뽑기권과 마지막 무료 뽑기 KST 날짜
- `inventory`: 사용자별 카드 수량
- `coupon_redemptions`: 계정별 쿠폰 사용 기록
- `pull_history`: 뽑기 이력

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

- `pnpm test`: KST 날짜·희귀도 확률, 이미지·metadata, 도감 검색·필터·정렬, 제스처 도착 위치 계산, SQLite 기반 뽑기 차감·지급의 원자성을 검사합니다.
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
