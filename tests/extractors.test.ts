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

  it('handles an empty script tag', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json"></script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc)).toEqual({});
  });

  it('keeps scanning after a malformed block and finds the good one', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">{ nope }</script>
        <script type="application/ld+json">
          {"@type":"JobPosting","title":"QA Engineer","hiringOrganization":{"name":"TestCo"}}
        </script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc)).toMatchObject({ position: 'QA Engineer', company: 'TestCo' });
  });

  it('reads a JobPosting out of a top-level array', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">
          [{"@type":"BreadcrumbList"},
           {"@type":"JobPosting","title":"Data Analyst","hiringOrganization":{"name":"ArrayCo"}}]
        </script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc)).toMatchObject({ position: 'Data Analyst', company: 'ArrayCo' });
  });

  it('accepts @type declared as an array', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">
          {"@type":["Thing","JobPosting"],"title":"Designer","hiringOrganization":{"name":"MultiCo"}}
        </script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc)).toMatchObject({ position: 'Designer', company: 'MultiCo' });
  });

  // ── @graph traversal — the Yoast / Schema-plugin layout ──
  it('walks @graph to find the JobPosting', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@graph":[
            {"@type":"WebSite","name":"Board"},
            {"@type":"Organization","name":"Not the employer"},
            {"@type":"JobPosting","title":"DevOps Engineer","hiringOrganization":{"name":"GraphCo"}}
          ]}
        </script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc)).toMatchObject({ position: 'DevOps Engineer', company: 'GraphCo' });
  });

  it('walks a nested @graph', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">
          {"@graph":[{"@graph":[
            {"@type":"JobPosting","title":"Deep Role","hiringOrganization":{"name":"DeepCo"}}
          ]}]}
        </script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc)).toMatchObject({ position: 'Deep Role', company: 'DeepCo' });
  });

  it('returns nothing when @graph holds no JobPosting', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">
          {"@graph":[{"@type":"WebSite","name":"Board"},{"@type":"Person","name":"Ada"}]}
        </script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc)).toEqual({});
  });

  it('survives null and primitive members inside @graph', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">
          {"@graph":[null,"text",42,
            {"@type":"JobPosting","title":"Survivor","hiringOrganization":{"name":"NullCo"}}]}
        </script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc)).toMatchObject({ position: 'Survivor', company: 'NullCo' });
  });

  it('survives a JSON-LD document that is just a string', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">"just a string"</script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc)).toEqual({});
  });

  it('leaves company and position undefined when the JobPosting omits them', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">{"@type":"JobPosting"}</script>
      </head><body></body></html>`);
    const info = extractFromJsonLd(doc);
    expect(info.company).toBeUndefined();
    expect(info.position).toBeUndefined();
    expect(info.description).toBe('');
  });

  it('strips HTML and collapses whitespace in the description', () => {
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">
          {"@type":"JobPosting","title":"X","description":"<p>Build   <b>things</b></p>\\n<ul><li>Ship</li></ul>"}
        </script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc).description).toBe('Build things Ship');
  });

  it('clips a very long description to 2000 characters', () => {
    const long = 'a'.repeat(5000);
    const doc = htmlToDoc(`<html><head>
        <script type="application/ld+json">
          {"@type":"JobPosting","title":"X","description":"${long}"}
        </script>
      </head><body></body></html>`);
    expect(extractFromJsonLd(doc).description).toHaveLength(2000);
  });
});

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
