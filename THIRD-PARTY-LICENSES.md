# Third-party code and licenses

Dependencies installed through npm retain their upstream licenses. The following code is included directly in this repository.

| Component | Version / source | Local files | License |
| --- | --- | --- | --- |
| Markdown-it | 15.0.3, [upstream](https://github.com/markdown-it/markdown-it) | `public/vendor/markdown-it.min.js` | [MIT](public/vendor/markdown-it.LICENSE) |
| Markdown-it-footnote | 4.0.0, [upstream](https://github.com/markdown-it/markdown-it-footnote) | `public/vendor/markdown-it-footnote.min.js` | [MIT](public/vendor/markdown-it-footnote.LICENSE) |
| KaTeX | 0.16.38, [upstream](https://github.com/KaTeX/KaTeX) | `public/vendor/katex/` | [MIT](public/vendor/katex/LICENSE) |
| Highlight.js | See the bundled release header, [upstream](https://github.com/highlightjs/highlight.js) | `public/vendor/hljs/` | [BSD 3-Clause](public/vendor/hljs/LICENSE) |
| T3 Code | [upstream](https://github.com/pingdotgg/t3code) | `lib/search-ranking.js`, `public/image-compression.js` | MIT, reproduced below |

The T3 Code search-ranking and image-compression algorithms were ported with type erasure and adaptation to this application's runtime. Other architectural comparisons were design references rather than copied source. Markdown application renderers are maintained separately in `public/markdown.js`.

## T3 Code MIT license

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
