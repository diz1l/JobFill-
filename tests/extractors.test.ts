import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractFromJsonLd } from '../shared/extractors/jsonLd';
import { extractFromOpenGraph } from '../shared/extractors/openGraph';
import { extractFromHeadings } from '../shared/extractors/headingHeuristics';
import { extractJobInfo } from '../shared/extractors/index';

function loadFixture(name: string): Document {
  const html = readFileSync(resolve(__dirname, `fixtures/${name}.html`), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

function htmlToDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

// ─── JSON-LD extractor ────────────────────────────────────────────────────────

describe('extractFromJsonLd', () => {
  it('extracts company and position from LinkedIn fixture', () => {
    const doc = loadFixture('linkedin');
    const info = extractFromJsonLd(doc);
    expect(info.company).toBe('Acme Corp');
    expect(info.position).toBe('Frontend Engineer');
  });

  it('extracts company and position from StartupJobs fixture', () => {
    const doc = loadFixture('startupjobs');
    const info = extractFromJsonLd(doc);
    expect(info.company).toBe('StartupCo s.r.o.');
    expect(info.position).toBe('React Developer');
  });

  it('returns empty object when no JSON-LD present', () => {
    const doc = loadFixture('jobs-cz');
    const info = extractFromJsonLd(doc);
    expect(info.company).toBeUndefined();
    expect(info.position).toBeUndefined();
  });

  it('handles malformed JSON-LD gracefully', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">{ invalid json }</script>
      </head><body></body></html>`);
    expect(() => extractFromJsonLd(doc)).not.toThrow();
    expect(extractFromJsonLd(doc).company).toBeUndefined();
  });
});

// ─── Open Graph extractor ─────────────────────────────────────────────────────

describe('extractFromOpenGraph', () => {
  it('extracts company and position from og:title with "at" separator', () => {
    const doc = htmlToDoc(`<html><head>
        <meta property="og:title" content="Frontend Engineer at Acme Corp" />
      </head><body></body></html>`);
    const info = extractFromOpenGraph(doc);
    expect(info.position).toBe('Frontend Engineer');
    expect(info.company).toBe('Acme Corp');
  });

  it('falls back to og:site_name for company', () => {
    const doc = htmlToDoc(`<html><head>
        <meta property="og:title" content="Senior Developer" />
        <meta property="og:site_name" content="LinkedIn" />
      </head><body></body></html>`);
    const info = extractFromOpenGraph(doc);
    expect(info.position).toBe('Senior Developer');
    expect(info.company).toBe('LinkedIn');
  });

  it('returns empty when no OG tags present', () => {
    const doc = htmlToDoc(`<html><head></head><body></body></html>`);
    const info = extractFromOpenGraph(doc);
    expect(info.company).toBeUndefined();
    expect(info.position).toBeUndefined();
  });
});

// ─── Heading heuristics ───────────────────────────────────────────────────────

describe('extractFromHeadings', () => {
  it('extracts position from h1', () => {
    const doc = loadFixture('greenhouse');
    const info = extractFromHeadings(doc);
    expect(info.position).toBe('Software Engineer');
  });

  it('extracts company from title separator', () => {
    const doc = htmlToDoc(`<html>
        <head><title>Product Designer - DesignCo</title></head>
        <body><h1>Product Designer</h1></body>
      </html>`);
    const info = extractFromHeadings(doc);
    expect(info.company).toBe('DesignCo');
  });
});

// ─── Combined extractor (fallback chain) ──────────────────────────────────────

describe('extractJobInfo', () => {
  it('JSON-LD takes priority over OG', () => {
    const doc = htmlToDoc(`<html>
        <head>
          <meta property="og:title" content="OG Position at OG Company" />
          <script type="application/ld+json">
          {
            "@type": "JobPosting",
            "title": "LD Position",
            "hiringOrganization": { "name": "LD Company" }
          }
          </script>
        </head>
        <body><h1>H1 Position</h1></body>
      </html>`);
    const info = extractJobInfo(doc);
    expect(info.position).toBe('LD Position');
    expect(info.company).toBe('LD Company');
  });

  it('falls back to OG when no JSON-LD', () => {
    const doc = htmlToDoc(`<html>
        <head>
          <meta property="og:title" content="OG Position at OG Company" />
        </head>
        <body><h1>H1 Position</h1></body>
      </html>`);
    const info = extractJobInfo(doc);
    expect(info.position).toBe('OG Position');
    expect(info.company).toBe('OG Company');
  });

  it('falls back to heading heuristics as last resort', () => {
    const doc = htmlToDoc(`<html>
        <head><title>Backend Developer | SomeCorp</title></head>
        <body><h1>Backend Developer</h1></body>
      </html>`);
    const info = extractJobInfo(doc);
    expect(info.position).toBe('Backend Developer');
    expect(info.company).toBe('SomeCorp');
  });

  it('returns empty JobInfo when nothing is detectable', () => {
    const doc = htmlToDoc(`<html><head><title></title></head><body></body></html>`);
    const info = extractJobInfo(doc);
    expect(info.company).toBeUndefined();
    expect(info.position).toBeUndefined();
  });
});
