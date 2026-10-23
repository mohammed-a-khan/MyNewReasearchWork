# Third-party notices (EZTest Azure DevOps extension)

The extension is EZTest's own code. It includes or is packaged with:

| File | From | License |
|---|---|---|
| `schemas/tasks.schema.json` | [microsoft/azure-pipelines-task-lib](https://github.com/microsoft/azure-pipelines-task-lib) (used only to validate `task.json`; not in the `.vsix`) | MIT |
| `web/lib/SDK.min.js` (copied in by `npm run package`) | [azure-devops-extension-sdk](https://www.npmjs.com/package/azure-devops-extension-sdk) 4.0.2; its licence is copied next to it as `web/lib/LICENSE-azure-devops-extension-sdk.txt` | MIT |

`tfx-cli` (MIT) packages the extension; it is a development tool and is not
included in the `.vsix`.

## MIT License (Microsoft Corporation)

Copyright (c) Microsoft Corporation. All rights reserved.

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
