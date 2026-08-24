import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

const origin = process.env.SITE_ORIGIN;

export const metadata: Metadata = {
  title: 'LIMKETMON',
  description: '임신규 사진 카드를 모으는 카드깡 도감',
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
  themeColor: '#101014'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
