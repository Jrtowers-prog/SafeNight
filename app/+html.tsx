/**
 * Custom HTML shell for Expo Router web builds.
 *
 * This file is the single source of truth for the <head> on every page.
 * It injects global meta tags, Open Graph defaults, Twitter Card tags,
 * structured data (JSON-LD), manifest link, and performance hints.
 *
 * Per-page overrides are handled by the <Head> component in each route.
 */
import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';
import { SEO } from '../src/config/seo';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />

        {/* ── Primary Meta Tags ────────────────────────── */}
        <title>{SEO.title}</title>
        <meta name="title" content={SEO.title} />
        <meta name="description" content={SEO.description} />
        <meta name="keywords" content={SEO.keywords} />
        <meta name="author" content={SEO.siteName} />
        <meta name="robots" content="index, follow" />
        <meta name="googlebot" content="index, follow, max-video-preview:-1, max-image-preview:large, max-snippet:-1" />

        {/* ── Canonical ────────────────────────────────── */}
        <link rel="canonical" href={SEO.siteUrl} />

        {/* ── Open Graph / Facebook ────────────────────── */}
        <meta property="og:type" content="website" />
        <meta property="og:url" content={SEO.siteUrl} />
        <meta property="og:title" content={SEO.title} />
        <meta property="og:description" content={SEO.description} />
        <meta property="og:image" content={`${SEO.siteUrl}${SEO.ogImage}`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="SafeNight walking safety navigation app" />
        <meta property="og:site_name" content={SEO.siteName} />
        <meta property="og:locale" content={SEO.locale} />

        {/* ── Twitter Card ─────────────────────────────── */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:url" content={SEO.siteUrl} />
        <meta name="twitter:title" content={SEO.title} />
        <meta name="twitter:description" content={SEO.description} />
        <meta name="twitter:image" content={`${SEO.siteUrl}${SEO.ogImage}`} />
        <meta name="twitter:image:alt" content="SafeNight walking safety navigation app" />
        {/* <meta name="twitter:site" content={`@${SEO.twitterHandle}`} /> */}

        {/* ── Theme & PWA ──────────────────────────────── */}
        <meta name="theme-color" content={SEO.themeColor} />
        <meta name="msapplication-TileColor" content={SEO.themeColor} />
        <meta name="application-name" content={SEO.siteName} />
        <meta name="apple-mobile-web-app-title" content={SEO.siteName} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="format-detection" content="telephone=no" />

        {/* ── Favicons ─────────────────────────────────── */}
        <link rel="icon" type="image/png" href="/favicon.png" />
        <link rel="apple-touch-icon" href="/favicon.png" />

        {/* ── Web App Manifest ─────────────────────────── */}
        <link rel="manifest" href="/manifest.json" />

        {/* ── Structured Data (JSON-LD) ────────────────── */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'WebApplication',
              name: 'SafeNight',
              url: SEO.siteUrl,
              description: SEO.description,
              applicationCategory: 'UtilitiesApplication',
              operatingSystem: 'Android, iOS, Web',
              author: {
                '@type': 'Organization',
                name: 'SafeNight',
                url: SEO.siteUrl,
              },
              screenshot: `${SEO.siteUrl}${SEO.ogImage}`,
              featureList:
                'Route safety scores, Real-time navigation, Live location sharing, Safety Circle, Street lighting analysis, Crime data integration',
            }),
          }}
        />

        {/* ── Organization JSON-LD ─────────────────────── */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: 'SafeNight',
              url: SEO.siteUrl,
              logo: `${SEO.siteUrl}/favicon.png`,
              sameAs: [
                SEO.appStore.android,
              ],
            }),
          }}
        />

        {/* ── Performance Hints ────────────────────────── */}
        <link rel="dns-prefetch" href="https://plymhack2026-fork-1.onrender.com" />
        <link rel="preconnect" href="https://plymhack2026-fork-1.onrender.com" crossOrigin="anonymous" />

        {/* Expo Router scroll-reset styles */}
        <ScrollViewStyleReset />

        {/* ── Global Styles ────────────────────────────── */}
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body { height: 100%; margin: 0; padding: 0; }
              body {
                overflow: hidden;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
              }
              #root { display: flex; flex: 1; height: 100%; }
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
