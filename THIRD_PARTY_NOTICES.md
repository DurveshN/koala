# Third-Party Notices

## OpenCode

Koala includes source derived from OpenCode.

- Source: https://github.com/anomalyco/opencode
- Imported release: `v1.18.31`
- Imported commit: `014614d35b397775e5d397a490fc72368c894ec2`

```text
MIT License

Copyright (c) 2025 opencode

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
```

Additional dependency notices will be maintained here as Koala's retained and
new dependency set is finalized. Koala's root license is pending the owner's
selected license text.

## Anthropic Sandbox Runtime

Koala uses `@anthropic-ai/sandbox-runtime` version `0.0.76` under the Apache
License 2.0.

- Source: https://github.com/anthropics/sandbox-runtime
- License: https://www.apache.org/licenses/LICENSE-2.0
- A copy of the dependency's `LICENSE` file is shipped beside the packaged
  sandbox worker and native helper assets.

## ipaddr.js

Koala uses `ipaddr.js` for local/private IP address and CIDR classification.

```text
Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## PDF.js

Koala's document-runtime foundation uses `pdfjs-dist` version `6.3.289` under
the Apache License 2.0.

- Source: https://github.com/mozilla/pdf.js
- License: https://www.apache.org/licenses/LICENSE-2.0
- The pinned package license and required PDF.js runtime assets are included in
  each staged document-runtime artifact.

## @napi-rs/canvas

Koala's document-runtime foundation uses `@napi-rs/canvas` version `1.0.9` under
the MIT License, with one target-specific native package per runtime artifact.

- Source: https://github.com/Brooooooklyn/canvas
- License: https://github.com/Brooooooklyn/canvas/blob/main/LICENSE
- The staged development manifest remains `releaseReady: false` until the exact
  Skia/native dependency inventory and all required notices are included.

## Document Runtime Licensing Status

The Koala document-runtime code does not claim the OpenCode root `LICENSE` as
its own license. Koala's license remains pending the owner's decision. The
development runtime carries this third-party notice file for provenance, but
its Koala component has no declared license and remains `releaseReady: false`.

Release staging also requires complete, target-specific notices for Tesseract,
Leptonica, tessdata, native canvas, and every linked native dependency. Those
notices are not present in the current development artifact.
