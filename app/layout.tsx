import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

const origin = process.env.SITE_ORIGIN;

export const metadata: Metadata = {
  title: 'LIMKETMON — 임신규 카드 도감',
  description: '사진첩에만 두기 아까운 임신규의 표정들. 매일 한 장 무료로 뽑고, 46종의 신규를 모아보세요.',
  openGraph: {
    title: 'LIMKETMON',
    description: '임신규 카드 도감',
    images: origin ? [`${origin}/og.png`] : []
  },
  twitter: {
    card: 'summary_large_image',
    title: 'LIMKETMON',
    description: '임신규 카드 도감',
    images: origin ? [`${origin}/og.png`] : []
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f8f9fb'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
