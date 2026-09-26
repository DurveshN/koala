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

## docx

Koala's document-runtime bundles `docx` version `9.7.1` under the MIT License to
generate `.docx` files.

- Source: https://github.com/dolanmiu/docx
- License: MIT
- A copy of the dependency's `LICENSE` file is shipped in the document-runtime
  artifact at `licenses/docx-LICENSE`.

## mammoth

Koala's document-runtime bundles `mammoth` version `1.9.0` under the BSD-2-Clause
License to extract raw text from `.docx` files.

- Source: https://github.com/mwilliamson/mammoth.js
- License: package license is included in the document-runtime artifact at
  `licenses/mammoth-LICENSE`.

```text
Copyright (c) 2013, Michael Williamson
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## xlsx

Koala's document-runtime bundles `xlsx` version `0.18.5` under the Apache
License 2.0 to read `.xlsx` spreadsheets.

- Source: https://git.sheetjs.com/sheetjs/sheetjs
- License: https://www.apache.org/licenses/LICENSE-2.0
- A copy of the dependency's `LICENSE` file is shipped in the document-runtime
  artifact at `licenses/xlsx-LICENSE`.

## jszip

Koala's document-runtime bundles `jszip` version `3.10.1` to read the OPC
package structure of `.docx` and `.pptx` files. jszip is dual-licensed under
the MIT License or GPLv3; the runtime distributes a copy of its license text.

- Source: https://github.com/Stuk/jszip
- License: package license is included in the document-runtime artifact at
  `licenses/jszip-LICENSE.markdown`.

## fast-xml-parser

Koala's document-runtime bundles `fast-xml-parser` version `4.4.0` under the
MIT License to parse presentation and wordprocessing XML from `.pptx` files.

- Source: https://github.com/NaturalIntelligence/fast-xml-parser
- License: package license is included in the document-runtime artifact at
  `licenses/fast-xml-parser-LICENSE`.

```text
MIT License

Copyright (c) 2017 Amit Kumar Gupta

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

## Document Runtime Licensing Status

The Koala document-runtime code does not claim the OpenCode root `LICENSE` as
its own license. Koala's license remains pending the owner's decision. The
development runtime carries this third-party notice file for provenance, but
its Koala component has no declared license and remains `releaseReady: false`.

Release staging also requires complete, target-specific notices for Tesseract,
Leptonica, tessdata, native canvas, and every linked native dependency. Those
notices are not present in the current development artifact.

The release workflow does not synthesize or download those notices. Its native
document gate requires an externally prepared release runtime, then includes the
runtime's exact license files in the hashed inventory and dependency report
submitted to the independent confinement-evidence issuer. The resulting
Ed25519 envelope, its SPKI DER verification key, and the strict reports are
packaged with those inventoried files. Until those inputs exist and pass
verification, no document-runtime target is release-enabled.

The current repository therefore does not claim to distribute Tesseract,
Leptonica, tessdata, or a release-ready native canvas closure. Their complete
target-specific copyright and license texts must be supplied with the authentic
six-target runtime artifacts before this section can be expanded into final
distribution notices.
