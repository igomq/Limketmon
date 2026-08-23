# LIMKETMON

임신규 사진 카드를 수집하는 병맛 TCG 카드깡 웹앱. SvelteKit(Svelte 5) + TypeScript + pnpm.
현재는 in-memory mock backend로 동작하며, ChatGPT Sites 배포 시 repository adapter만 교체하면 된다 (`docs/SITES_HANDOFF.md` 참고).

## 실행

```bash
pnpm install
pnpm cards:sync   # images/ → 카드 manifest + static/cards 복사 (최초 1회 필수)
pnpm dev          # http://localhost:5173
```

## 명령

| 명령 | 설명 |
| --- | --- |
| `pnpm cards:sync` | `images/`의 새 사진을 카드로 등록 (기존 metadata 불변, deterministic) |
| `pnpm dev` | 개발 서버 |
| `pnpm check` | svelte-check 타입 검사 |
| `pnpm test` | Vitest 단위 테스트 |
| `pnpm test:e2e` | Playwright 사용자 흐름·모바일·시각 회귀 테스트 |
| `pnpm build` | 프로덕션 빌드 |
| `pnpm preview` | 빌드 결과 미리보기 |

## 이미지 추가법

1. `images/`에 `.jpg .jpeg .png .webp .avif` 파일을 넣는다 (원본은 수정/덮어쓰지 않음).
2. `pnpm cards:sync` 실행 → 새 카드가 `imsingyu-vNNN`으로 append되고 manifest에 기록된다.
3. 기존 카드의 rarity/스탯/스킬은 절대 바뀌지 않는다 (파일명 시드 deterministic 생성).

## 게임 규칙

- **매일 1회 무료 뽑기** — KST(Asia/Seoul) calendar date 기준. 00:00 KST에 리셋.
- 무료 뽑기 사용 후에는 **뽑기권(pullCredits) 1개**를 소비. 둘 다 없으면 거부.
- 확률: N 50% / R 27% / SR 14% / SSR 7% / UR 2% (부족한 rarity는 fallback).
- **쿠폰** `LIMKETMON` → 뽑기권 +100, 계정당 1회.
- 중복 카드는 quantity 누적 (향후 합성/분해 대비).

## Mock backend

`BACKEND_MODE=mock` (기본). in-memory DB는 `globalThis`에 저장되어 dev hot-reload에는 유지되지만
서버 재시작 시 초기화된다 (의도된 동작). 구조:

```
route (+page.server / +server)
  ↓ service (src/lib/server/services/*)  ← 비즈니스 로직, 서버 사이드에서만 판정
  ↓ repository interface (src/lib/server/repositories/types.ts)
  ↓ mock adapter (src/lib/server/repositories/mock/*)
```

## 테스트

```bash
pnpm test
```

auth(가입/로그인/세션), KST 무료 뽑기 리셋, 뽑기권 소비/중복 quantity, 쿠폰 중복/계정 격리,
카드 manifest determinism 을 커버한다. 시간은 injectable `Clock`, 랜덤은 injectable `Rand`로 주입된다.
Playwright는 `E2E=true`인 로컬 테스트 서버에서만 고정 랜덤을 사용하며 production 랜덤 경로는 유지한다.

## 배포 (ChatGPT Sites)

`docs/SITES_HANDOFF.md` 참고 — adapter 계층과 배포 설정만 수정하면 된다.
