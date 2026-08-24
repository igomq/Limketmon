# LIMKETMON

임신규 사진 카드를 뽑고 수집하는 카드 도감. ChatGPT Sites용 Vinext + React 앱이며,
ChatGPT 로그인과 Cloudflare D1에 사용자별 뽑기권·도감·쿠폰 기록을 저장한다.

## 실행

```bash
pnpm install
pnpm dev
```

로컬 Sites 로그인 계정과 D1은 개발 서버가 제공한다. 최초 로컬 D1에는 `drizzle/`의
마이그레이션을 적용해야 한다.

## 명령

| 명령 | 설명 |
| --- | --- |
| `pnpm dev` | Sites 로컬 개발 서버 |
| `pnpm test` | KST 리셋·희귀도 경계 검사 |
| `pnpm build` | Sites 배포 빌드 |
| `pnpm db:generate` | `db/schema.ts`에서 D1 마이그레이션 생성 |
| `pnpm cards:sync` | `images/`의 새 사진을 카드 manifest와 `public/cards/`에 등록 |

## 데이터

- 로그인은 Sites가 전달하는 안정적인 ChatGPT 사용자 ID를 신뢰 경계로 사용한다.
- D1에는 비밀번호나 세션 토큰을 저장하지 않는다.
- `users`, `user_game_state`, `inventory`, `coupon_redemptions`, `pull_history`를 사용한다.
- 무료 뽑기는 KST 날짜 기준 하루 1회이며, 이후에는 뽑기권을 원자적으로 차감한다.
- 쿠폰 `LIMKETMON`은 계정당 한 번, 뽑기권 100개를 지급한다.

## 카드 추가

1. `images/`에 `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif` 파일을 넣는다.
2. `pnpm cards:sync`를 실행한다.
3. 기존 카드의 메타데이터는 유지되고 새 카드만 순서대로 추가된다.
