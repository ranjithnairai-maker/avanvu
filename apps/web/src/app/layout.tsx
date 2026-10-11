import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { brand, site } from '@/lib/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(site.origin),
  title: {
    default: `${brand.productName}: ${brand.appStoreSubtitle}`,
    template: `%s | ${brand.productName}`,
  },
  description: `${brand.tagline} ${brand.supportingLine} Mental rehearsal sessions built around your event, voiced and ready to play offline.`,
  openGraph: { siteName: brand.productName, type: 'website' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F8FB' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0F1A' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <div className="wrap">
            <Link href="/" className="wordmark" aria-label={`${brand.productName} home`}>
              {brand.wordmark}
            </Link>
            <nav aria-label="Primary">
              <Link href="/support">Support</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
            </nav>
          </div>
        </header>
        <main>
          <div className="wrap">{children}</div>
        </main>
        <footer className="site">
          <div className="wrap">
            <span>
              {brand.productName} is mental rehearsal for performance preparation. It is not therapy or
              medical care.
            </span>
            <span>
              <Link href="/delete-account">Delete your account</Link>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
