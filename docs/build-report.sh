#!/usr/bin/env bash
# Rebuild REPORT.docx from REPORT.md (needs pandoc)
cd "$(dirname "$0")" && pandoc REPORT.md -f markdown-tex_math_dollars -o REPORT.docx --resource-path=. --toc --toc-depth=2 -M toc-title="Contents"
# PDF (needs Node + Playwright/Chromium): HTML with report.css, printed to A4
pandoc REPORT.md -f markdown-tex_math_dollars -t html5 -s --toc --toc-depth=2 --embed-resources --resource-path=. -c report.css -o /tmp/report.html && node -e "
const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage();
 await p.goto('file:///tmp/report.html'); await p.pdf({ path: 'REPORT.pdf', format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
 await b.close(); })();"
