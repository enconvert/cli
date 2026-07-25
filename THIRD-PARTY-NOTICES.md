# Third-party notices

The `enconvert` CLI is distributed as a single bundled artifact (an ESM file on
npm; standalone executables on GitHub Releases). The following open-source
packages are **bundled into** that artifact. Copyright lines are taken from
each package's LICENSE file as shipped on npm.

Development and test tooling (`undici`, `tsx`, `tsdown`, `typescript`,
`publint`, `@types/node`) is used at build/test time only and is **not
distributed** with the CLI, so it is not listed here.

## Bundled packages

| Package | License | Copyright |
|---|---|---|
| commander | MIT | Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca> |
| @commander-js/extra-typings | MIT | Copyright (c) 2022 commander-js |
| @bomb.sh/tab | MIT | Copyright (c) Bombshell Authors (per package metadata; no LICENSE file is shipped in the npm package) |
| picocolors | ISC | Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov |
| yocto-spinner | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| @inquirer/prompts (and bundled @inquirer/ansi, checkbox, confirm, core, editor, expand, external-editor, figures, input, number, password, rawlist, search, select, type) | MIT | Copyright (c) 2025 Simon Boudrias |
| cli-width | ISC | Copyright (c) 2015, Ilya Radchenko <knownasilya@gmail.com> |
| fast-wrap-ansi | MIT | Copyright (c) 2025 James Garbutt |
| mute-stream | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| signal-exit | ISC | Copyright (c) 2015-2023 Benjamin Coe, Isaac Z. Schlueter, and Contributors |
| chardet | MIT | Copyright (C) 2024 Dmitry Shirokov |
| iconv-lite | MIT | Copyright (c) 2011 Alexander Shtuchkin |
| zod | MIT | Copyright (c) 2025 Colin McDonnell <zod@colinhacks.com> |
| smol-toml | BSD-3-Clause | Copyright (c) Squirrel Chat et al., All rights reserved. |

## License texts

### MIT License

Applies to: commander, @commander-js/extra-typings, @bomb.sh/tab,
yocto-spinner, the @inquirer packages, fast-wrap-ansi, chardet, iconv-lite,
zod — each with its copyright line from the table above.

```
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

### ISC License

Applies to: picocolors, cli-width, mute-stream, signal-exit — each with its
copyright line from the table above.

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### BSD 3-Clause License (smol-toml)

```
Copyright (c) Squirrel Chat et al., All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

---

The standalone executables additionally embed the [Bun](https://bun.sh)
runtime (MIT License, Copyright (c) Oven, Inc.), which itself incorporates
components such as JavaScriptCore (LGPL-2.1) and Zig standard library code
(MIT); see https://bun.sh/docs/project/licensing for Bun's complete
third-party attribution. The npm package does not include Bun.
