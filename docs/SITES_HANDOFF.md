# SITES_HANDOFF — ChatGPT Sites 배포 마이그레이션 가이드

> 2026-08-24 마이그레이션 완료 전의 설계 기록이다. 현재 구현은 루트 `app/`, `lib/`, `db/`,
> `.openai/hosting.json`과 README를 기준으로 한다.

> 이 문서는 나중에 Codex에게 "이 프로젝트를 ChatGPT Sites에 배포 가능하게 만들어라"라고
> 지시할 때 그대로 보여주는 문서다. 목표: **repository adapter + 배포 설정만 바꿔서 전체 앱을 재작성 없이 배포.**

## 1. 현재 architecture

```
UI (SvelteKit routes/components)          ← mock 구현을 전혀 모름
  ↓
+page.server.ts / +server.ts (routes)     ← 세션/파라미터 처리만
  ↓
services (src/lib/server/services/)       ← 모든 비즈니스 로직 (무료 뽑기 KST 판정,
  ↓                                          뽑기권 소비, 쿠폰 검증 — 반드시 서버 사이드 유지)
repository interfaces (repositories/types.ts)
  ↓
createRepositories() factory (src/lib/server/repo.ts)
  ↓
BACKEND_MODE=mock → mock adapter (in-memory)
```

핵심 파일:

| 파일 | 역할 |
| --- | --- |
| `src/lib/server/repo.ts` | adapter 선택 factory. `BACKEND_MODE` 환경 변수로 분기 |
| `src/lib/server/repositories/types.ts` | `AuthRepository`, `GameRepository` 인터페이스 |
| `src/lib/server/repositories/mock/` | 현지 로컬 mock 구현 (배포 시 유지/삭제 선택) |
| `src/lib/server/repositories/sites/` | **Sites adapter를 구현할 위치** (지금은 stub README) |
| `src/lib/server/services/` | auth / pulls / coupons / collection 비즈니스 로직 |
| `src/lib/server/kst.ts` | KST calendar date (Clock 주입 가능) |
| `src/lib/server/crypto.ts` | Web Crypto PBKDF2 password hashing (edge 호환) |
| `src/hooks.server.ts` | 세션 조회 + 보호 route 가드 (`/pull`, `/collection`, `/coupon`, `/api/*`) |

## 2. Sites adapter가 구현해야 할 인터페이스

`src/lib/server/repositories/types.ts` 전체를 그대로 구현하면 된다:

- `AuthRepository`: `createUser`, `findUserByEmail`, `getUser`, `createSession`, `getSession`, `deleteSession`
- `GameRepository`: `getGameState`, `addPullCredits`, `consumePullCredit`(원자적 감소 필요),
  `setLastFreePullDate`, `getInventory`, `addCardToInventory`(중복 시 quantity 증가),
  `hasRedeemedCoupon`, `redeemCoupon`, `recordPull`

## 3. 필요한 DB tables (production schema)

mock이 그대로 따르고 있는 도메인 모델:

```sql
users            (id, email, password_hash, password_salt, created_at)
sessions         (token, user_id, expires_at)
cards            (id, version, name, rarity, image_key, skill_name, skill_description,
                  flavor_text, attack, defense, luck)  -- = cards.generated.json 내용
inventory        (user_id, card_id, quantity, first_obtained_at)
user_game_state  (user_id, pull_credits, last_free_pull_date)  -- KST 'YYYY-MM-DD'
coupon_redemptions (user_id, coupon_code, redeemed_at)         -- PK(user_id, coupon_code)
pull_history     (id, user_id, card_id, rarity, pulled_at)
```

`cards` 테이블은 배포 시 `src/lib/data/cards.generated.json`을 seed 하면 된다.

## 4. migration 순서

1. `src/lib/server/repositories/sites/`에 `SitesAuthRepository`, `SitesGameRepository` 구현
   (Sites의 실제 DB API만 사용 — 추측해서 fake API 만들지 말 것).
2. `src/lib/server/repo.ts`의 `case 'sites'`에서 반환하도록 연결.
3. 배포 환경에 `BACKEND_MODE=sites` 설정.
4. `cards.generated.json` → cards 테이블 seed.
5. SvelteKit adapter를 Sites scaffold가 요구하는 것으로 교체 (`svelte.config.js` 한 곳).
6. `services/auth.ts`의 `sessionCookieOptions().secure = true`로 전환 (HTTPS).
7. 아래 테스트 목록 실행.

## 5. 환경 변수

| 변수 | 값 | 설명 |
| --- | --- | --- |
| `BACKEND_MODE` | `mock` (기본) / `sites` | adapter 선택 |

## 6. session 처리

- 쿠키 이름: `limketmon_session` (HttpOnly, SameSite=Lax, 30일).
- token은 64 hex 랜덤. `getSession`에서 만료 검사 후 만료 시 삭제.
- Sites DB 세션 테이블에 그대로 매핑하면 됨.

## 7. image 처리

- 카드 이미지는 정적 asset: `public/cards/vNNN.ext` (`/cards/vNNN.ext`로 서빙).
- DB/manifest는 **absolute URL이 아니라 image key**(`v023.jpg`)만 저장하고
  UI는 `resolveCardImage()` (`src/lib/cards.ts`)로 URL을 해석한다.
  → object storage 이전 시 이 함수(또는 서버 사이드 resolver)만 수정하면 됨.

## 8. 수정해야 할 파일 / 건드릴 필요 없는 파일

**수 필요:**
- `src/lib/server/repositories/sites/*` (신규 구현)
- `src/lib/server/repo.ts` (factory에 sites case 연결)
- `svelte.config.js` (Sites용 adapter)
- `src/lib/server/services/auth.ts` (secure cookie 플래그)
- 배포/환경 설정

**건드릴 필요 없음:**
- `src/routes/**` 전부 (UI + form actions)
- `src/lib/components/**` 전부
- `src/lib/server/services/{pulls,coupons,collection}.ts`
- `src/lib/server/{kst,crypto,errors}.ts`
- `scripts/cards-sync.mjs`, `src/lib/card-gen.ts`, `tests/**` (단, sites adapter 단위 테스트 추가는 권장)

## 9. 배포 전 테스트 목록

1. `pnpm check` / `pnpm test` / `pnpm build` 통과
2. 회원가입 → 로그인 → 대시보드
3. 무료 뽑기 1회 → 같은 날 두 번째 뽑기에서 뽑기권 소비 확인
4. KST 00:00 직후 무료 뽑기 리셋 확인
5. 쿠폰 `LIMKETMON` → +100, 동일 계정 재사용 거부, 타 계정 사용 가능
6. 컬렉션 completion%, 중복 ×N badge, 카드 상세 modal (ESC/백드롭 닫기)
7. 공유 버튼 → PNG 생성 (Web Share 미지원 브라우저에서 다운로드 fallback)
8. 미로그인 상태에서 `/pull` `/collection` `/coupon` 접근 → `/login` 리다이렉트
9. 서버 재시작 후(= DB 초기화 후) 세션 무효화 정상 동작
