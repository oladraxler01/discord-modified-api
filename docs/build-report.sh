#!/usr/bin/env bash
# Rebuild REPORT.docx from REPORT.md (needs pandoc)
cd "$(dirname "$0")" && pandoc REPORT.md -f markdown-tex_math_dollars -o REPORT.docx --resource-path=. --toc --toc-depth=2 -M toc-title="Contents"
