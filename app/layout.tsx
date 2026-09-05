import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

const origin = process.env.SITE_ORIGIN;

export const metadata: Metadata = {
  title: 'LIMKETMON — 평범한 순간, 범상치 않은 카드',
  description: '세상에 하나뿐인 임신규 컬렉션. 매일 한 장 무료로 발견하고, 46개의 특별한 순간을 모아보세요.',
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
