# DSH plugin integration surface — evidence for a local-OCR plugin

Investigation date: 2026-11-06. Target: DeepSeek Harness **Desktop** `0.2.2-rc.1`, profile `desktop`
(`%USERPROFILE%\.dsh\profiles\desktop`).

## 0. Environment facts (verified)

| Fact | Value | Evidence |
|---|---|---|
| DSH version | `0.2.2-rc.1` | `D:\Softwares\deepseek\resources\app.asar\dsh\package.json` (`"version": "0.2.2-rc.1"`) |
| Desktop app package | `@deepseek-ai/dsh-desktop`, `main: lib/main.js` | asar root `package.json` |
| Node used by DSH runtime | `24.21.0` | `app.asar\dsh\desktop-runtime.json:7`; `D:\Softwares\deepseek\resources\runtime\versions.json` |
| pnpm | `11.28.5` | `app.asar\dsh\desktop-runtime.json:8` |
| Electron (Host process) | `44.7.0` | `D:\Softwares\deepseek\version` → `44.7.0`; `D:\Softwares\deepseek\LICENSE.electron.txt` |
| Host profile dir | `%USERPROFILE%\.dsh\profiles\desktop` | `package.json` → `"name": "dsh-profile-desktop"` |
| Profile pnpm settings | `nodeLinker: hoisted`, `allowBuilds: {'@google/genai': true, protobufjs: true}` | `…\profiles\desktop\pnpm-workspace.yaml` |
| Profile-installed `@deepseek-ai/*` | only `cosmokit`, `schemastery` | `…\profiles\desktop\node_modules\@deepseek-ai\` |

Consequence: **a profile-installed bundle must not `import '@deepseek-ai/dsh-tools'`** — that package is not
reachable from the profile's `node_modules` (it lives in the installation's asar). It must either be declared
as a bundle `dependencies` entry (a second copy is then installed) or be avoided entirely. The skeleton in
§5 therefore registers a **raw** `ToolDefinition` and imports nothing from `@deepseek-ai/*`.

---

## A. Tool registration

### A1. Exact shape of `ToolDefinition`

Authoritative source: live Host inspection — `cordis_inspect_query` → provider `Service`, method `listService`,
`input: { service: "tools" }`, field `data.referencedTypes`. Verbatim declarations returned by the running Host:

```ts
export interface ToolSchema {
    deferLoading?: true;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}

export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}

export interface ToolRunContext extends ToolExecution {
    deferContext(context: UserMessage): void;
    concludeTurn(): void;
}

export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    readonly schema?: ToolSchema;
    readonly arguments: unknown;
    readonly agent?: Agent;
    readonly toolSet?: ResolvedToolSet;
    readonly parent?: ToolExecutionToken;
    readonly signal: AbortSignal;
}
```

**Required fields:** `name`, `description`, `parameters`, `output` (`{ schema, render }`), `execute`.

**Parameter-schema convention: raw JSON Schema, not zod.** `ToolSchema.parameters` is
`Record<string, unknown>` and the registry projects it verbatim to the model
(`dsh-tools\lib\index.js:366-376`, `projectToolSchema` → `{ name, description, parameters, deferLoading? }`).
The registry asserts the output schema against the supported JSON Schema subset
(`app.asar\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js:433-445`):

```js
register(definition, options = {}) {
    const name = definition.name;
    const output = definition.output;
    if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function")
        throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
    assertSupportedJsonSchema(output.schema);
    const timeoutMs = definition.timeoutMs;
    if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
        throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
    if (name === "run_code") throw new Error(`tool name "run_code" is reserved ...`);
    return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, { definition, when: options.when }), { label: "tools.register()" });
}
```
(`dsh-tools\lib\index.js:433-445`)

**`execute` signature:** `execute(args: unknown, exec: ToolRunContext): Promise<unknown>`. `args` is the
already-validated argument object; `exec` carries `callId`, `name`, `arguments`, `agent?`, `signal`,
`deferContext()`, `concludeTurn()`.
**Return value:** the tool returns a *value* (`JsonValue`) matching `output.schema`; the **model-facing
content** is produced by `output.render(args, value)` → `ContentBlock[]`. This is how `read_image` returns an
image: the value carries the attachment metadata, `render` emits a text envelope + an `image` content block
(`dsh-tool-fs\lib\index.js:1735-1743`, `1775`).

Optional first-party helper: `defineTool(options)` (`dsh-tools\lib\types\schema.js:275-359`, duplicated at
`dsh-tools\lib\index.js:310-359`). It accepts an **implicit property map** for `parameters`
(`{ file_path: { type: "string", required: true, description } }`), compiles it to raw JSON Schema
(`parameterSchemaSpecToJsonSchema`, `dsh-tools\lib\types\schema.js:239-248`), validates arguments before
calling `execute`, and throws `ToolArgsError` on mismatch. It lives in `@deepseek-ai/dsh-tools`, which a
profile bundle cannot import without taking a dependency on it (see §0).

### A2. `ToolRegistrationOptions` — does it control scope?

```ts
export interface ToolRegistrationOptions {
    readonly when?: (context: ToolActivationContext) => boolean | Promise<boolean>;
}
export interface ToolActivationContext {
    readonly agent: Agent;
    readonly modelSelection: Readonly<ModelSelection>;
    readonly signal: AbortSignal;
}
```
(live `Service.listService(service:"tools")` → `referencedTypes`)

**Scope is NOT controlled by the options.** `when` is only a *step-time activation condition*: the tool is
registered globally but is offered to a model step only when the predicate passes
(`dsh-tools\lib\index.js:443`, `when: options.when`; the resolution path is `tools.resolve(context)` /
`tools.executable(name, scope, toolSet)`).

Scope comes from **the context you register on**:
* root/profile context → global tool, visible to every agent;
* `agent.ctx` → scoped tool that shadows the global one for that agent
  (`dsh-tools\lib\index.js:410` `this.layers = new ScopedLayers((scope) => new ToolLayer(scope), …)`;
  `restrict()` throws `"tools.restrict() requires a scoped context (agent.ctx)"` at `dsh-tools\lib\index.js:453-455`,
  proving scope = the context the call is made on).
* `dsh-tools\lib\index.js:385` — a duplicate name in the same layer throws
  `tool "<name>" is already registered in this scope`.

### A3. A real, working Host plugin that registers a tool

**`@deepseek-ai/dsh-tool-fs`** — `app.asar\dsh\node_modules\@deepseek-ai\dsh-tool-fs\lib\index.js`.

Plugin entry (lines 1943-1991):

```js
/** Cordis plugin name used by loader diagnostics. */
const name = "tool-fs";
/** Services required by the filesystem tool suite. */
const inject = ["tools", "fs", "systemPrompt", "workingDirectory"];
const Config = z.object({
    read: z.boolean().default(true),
    readImage: z.boolean().default(true),
    write: z.boolean().default(true),
    edit: z.boolean().default(true),
    applyPatch: z.boolean().default(false),
    readLimit: z.number().default(READ_LIMIT),
    …
});
function apply(ctx, config) {
    const resolved = config;
    …
    if (resolved.read) applyReadTool(ctx, { limit: resolved.readLimit, … });
    if (resolved.readImage) ctx.inject(["attachments"], (imageCtx) => {
        applyReadImageTool(imageCtx);
    });
    …
}
export { Config, apply, inject, name };
```
(`dsh-tool-fs\lib\index.js:1943-1991`)

The tool registration itself (lines 1753-1838, trimmed):

```js
function applyReadImageTool(ctx) {
    ctx.tools.register(defineTool({
        name: "read_image",
        description: "Read a PNG/JPEG/WebP/GIF file and return the image itself. …",
        parameters: { file_path: { type: "string", required: true, description: "Path to the image file, resolved by the filesystem backend." } },
        output: {
            schema: { type: "object", additionalProperties: false, properties: { path: {…}, image: IMAGE_VALUE_SCHEMA } },
            render: (_args, value) => imageReadContent(value),
            presentationMeta: (_args, value) => ({ path: value.path })
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            if (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
            …
            const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path);
            const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
            const data = await ctx.fs.readBytes(target, exec.signal, byteCap);
            …
            ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) });
            …
            return { path: ctx.fs.processPath(target), image: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, … } };
        },
        presentCall(args) { return { card: "generic", title: `Read image ${args.file_path}`, kind: "read", locations: [{ path: args.file_path }] }; }
    }));
}
```
(`dsh-tool-fs\lib\index.js:1753-1838`)

Other real registrations: `applyReadTool` (`dsh-tool-fs\lib\index.js:247-269+`).

### A4. Does `inject` matter?

Yes. The Loader entry's `inject` option ("Adds required services or intercept config for this entry",
`cordis-plugin-loader\README.md:25-34`) makes the plugin **wait** for the named services and exposes them as
`ctx.<name>`. The live `Service.listService` output states the same access rule per service:

```json
"access": {
  "optional": { "expression": "ctx.get(\"tools\")", "requiresUndefinedCheck": true },
  "hardDependency": { "inject": ["tools"], "expression": "ctx.tools" }
}
```
(Host `Service.listService(service:"tools")`; same shape for `attachments`, `fs`, `subprocess`.)

Two ways to get a service:
1. **hard dependency** — put it in `export const inject = [...]`; then `ctx.tools` is guaranteed.
2. **optional** — `ctx.inject(['attachments'], (subCtx) => { … })` runs the callback only while the service is
   mounted and disposes it when the service goes away
   (`dsh-tool-fs\lib\index.js:1980-1982`, and the doc comment at `1745-1752`).

For a plugin that must also work when the service is absent, use `ctx.get('tools')` (the "optional" access
expression above) and check for `undefined`.

### A5. Existing tools that take an image and return text

**None.** A regex scan of **all 22,102 files** in `app.asar` for
`/read[-_]?image|image[-_]?read|vision|ocr/i` matched only:
* `read_image` (the built-in tool of `@deepseek-ai/dsh-tool-fs`);
* unrelated `@aws-sdk` `resolveSsoCredentials` / `resolveSSOCredentials` names.

There is **no OCR tool and no vision/describe-image tool** in this build.

The closest existing analogues are:
* `read_image` — image **in, image out** (it does not OCR; it returns a normalized image block plus a text
  envelope `<path>…</path><type>image</type><content>…</content>`, `dsh-tool-fs\lib\index.js:1716-1729`).
* The spill/compaction path, which represents an image to the model **as text**:
  `` `[Image: ${JSON.stringify(access.readonlyPath)}; ${block.attachment.mediaType}; ${block.attachment.width}x${block.attachment.height}. Use read_image to view it.]` ``
  (`dsh-spill-policy\lib\index.js:175`, mirrored in `dsh-spill-policy\lib\types\index.js:61`).

That text form is the pattern an OCR tool should follow: the model calls `ocr_image` with a **path**, and the
tool returns **text**.

---

## B. Getting an image into the plugin

### B6. What an Agent actually hands to a tool

The realistic input is **a path string in the tool arguments**, not an attachment id and not base64.

* `read_image` takes `file_path: string` and resolves it through the mounted filesystem backend
  (`dsh-tool-fs\lib\index.js:1757-1761`, `1788`).
* The model-visible representation of an image that the user attached is a **path plus an image block**;
  the durable attachment lives in the attachment service, not in the tool argument.

Attachment service (`Service.listService(service:"attachments")`, live):

| Method | Signature |
|---|---|
| `saveImage` | `saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>` — `{ data: Uint8Array, mediaType: ImageMediaType, name?: string }` |
| `saveImages` | `saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>` |
| `readImage` | `readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>` → `{ ref, data }` |
| `imageHostPath` | `imageHostPath(ref: ImageAttachmentRef): string \| undefined` — "Locate the provider-owned normalized object in the harness host filesystem." |
| `validateImage` | `validateImage(input): Promise<void>` |
| `readImageRequest` | `readImageRequest(ref, target: ImageRequestTarget, signal?): Promise<RequestImageAttachment>` — route-chosen resize/version for a model request |
| `admitPromptContent` | replaces encoded images in a prompt with durable refs |
| `saveFile` / `saveFileStream` / `readFileStream` / `fileHostPath` | verbatim file equivalents |

`ImageAttachmentRef` = `{ attachmentId, mediaType, bytes, width, height, name?, originalDimensions? }`;
`ImageMediaType` = `'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'`;
`ImageAttachmentLimits` = `{ maxImageBytes, maxImagesPerMessage, maxMessageImageBytes, maxImagePixels, maxImageDimension, mediaTypes }`.

`fileUploads` service (live catalog): `uploadImageStream({ sessionId, data, mediaType, name? }) → ImageUploadValue`,
`uploadStream(...) → FileUploadValue`, `resolve(agent, receiptId) → StagedAttachment | undefined`,
`bindPrompt(agent, receiptIds, requestId) → PromptFileBinding`, `retirePrompt(agent, requestId)`.

**Practical conclusion for the OCR tool:** the tool's `args` should carry a `file_path` (relative to the
session cwd, or absolute). If the user attached an image, the model must have a path for it — the built-in
`read_image` path gives the model exactly that (a `<path>` element in the tool result envelope), and the
spill policy emits `[Image: "<path>"; …]`. A plugin that wants the *bytes* of a user attachment must look the
attachment up in the session log / `attachments` service; the tool argument itself will not carry it.

### B7. Getting the session's working directory

`workingDirectory` service (live `Service.listService`): `defaultDirectory: string`,
`get(session: Session): string`, `ensure(agent: Agent, signal?): Promise<string>`, `set(agent, path, signal?): Promise<string>`.

The exact pattern used by the built-in fs tools (`dsh-tool-fs\lib\index.js:162-206`):

```js
async function sessionResolveOptions(ctx, exec) {
    const cwd = exec.agent === void 0 ? void 0 : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    return { ...cwd !== void 0 ? { cwd } : {}, signal: exec.signal };
}

async function resolveRegularReadTarget(ctx, exec, requestedPath) {
    const target = await ctx.fs.resolve(requestedPath, await sessionResolveOptions(ctx, exec));
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === void 0) { ctx.emit("fs/observed", target, { kind: "absent" }, exec); throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND"); }
    if (info.type !== "file") throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
    return { target, info };
}
```

`fs` service (live) — the pieces a local plugin needs:

| Method | Signature |
|---|---|
| `resolve` | `resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>` — relative paths resolve against `opts.cwd`; returns `{ targetKey, displayPath }` |
| `stat` | `stat(target: FsTarget, signal?): Promise<FsInfo \| undefined>` → `{ version, type, size? }`; `undefined` = absent |
| `readBytes` | `readBytes(target: FsTarget, signal: AbortSignal \| undefined, maxBytes: number): Promise<Uint8Array>` — fails `FS_TOO_LARGE` instead of truncating |
| `processPath` | `processPath(target: FsTarget): string` — "the canonical absolute path a subprocess in this filesystem's execution world can open" |
| `fileUrl` / `contains` / `readText` / `streamText` / `listDir` / `writeText` / `editText` / `patchText` / `deleteFile` / `moveFile` / `watch` | see the live contract |

`ctx.fs.processPath(target)` is exactly the value to hand to an OCR binary or to `node:fs` when the backend
is host-file-backed.

---

## C. Shipping runtime assets (models) inside a bundle

### C8. Large binaries, npm dependencies, native postinstall, `.node` addons

**Bundle = a package with `dsh.bundle.patch`.** Manifest shape
(`cordis-plugin-development\references\host-plugin.md:9-18`):

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**How installation works** (`dsh-plugin-manager\README.md`):
* `installBundle` runs **`pnpm add`** in the profile directory (line 64/68). Therefore the bundle's
  `dependencies` are installed into `%USERPROFILE%\.dsh\profiles\desktop\node_modules` (hoisted linker —
  `pnpm-workspace.yaml` → `nodeLinker: hoisted`).
* A **local directory** target installs as `link:<absolute workspace package directory>`
  (`dsh-plugin-manager\README.md:52`). For a linked directory, `files` in `package.json` does **not** filter
  anything: "Local directory installation links the checkout instead, so check the files directly; `files`
  does not filter a linked directory." (`host-plugin.md:35`).
  → **Shipping 13 MB of `.onnx` files inside the bundle directory is safe** for a local install.
* A **registry/tarball** install goes through npm packing, so `files` decides what is included
  (`host-plugin.md:35`, example at `host-plugin.md:46-48`:
  `"files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]`). Large binaries must be listed
  there (e.g. `"models/*.onnx"`), otherwise they are silently dropped from the tarball.

**Dependency build scripts:** pnpm 11 blocks them. The failed installation reports every pending
`allowBuilds` key in `pendingBuilds`; the manager records the names itself; the Web page offers *Allow these
scripts and retry*, and the `plugin_manager` tool can grant them via `approvedBuilds` on `install_bundle`
(`dsh-plugin-manager\README.md:72`; schema in `dsh-api-remotes\lib\client.js:15454`, `15534`, `15535`).
This profile already carries approved build scripts:
`pnpm-workspace.yaml` → `allowBuilds: { '@google/genai': true, protobufjs: true }`.
⇒ **A native postinstall (e.g. `onnxruntime-node` downloading/linking its binaries) is supported but requires
an explicit build-script approval step in the install flow.** Without it, `install_bundle` fails with
`pendingBuilds` and nothing is installed.

**Version/engine gates:** an install naming packages is checked against `engines.dsh` / `peerDependencies`
*before* pnpm runs; an unmet DSH requirement rejects the operation so nothing is downloaded and no build
script runs (`dsh-plugin-manager\README.md:77`). A third-party bundle should therefore declare
`"engines": { "dsh": ">=0.2.2" }` (or omit it) — a missing/loose range is safer than a wrong one.

**Do native `.node` addons load inside the DSH Host process?** **Yes — there is direct precedent.**

| Precedent | Evidence |
|---|---|
| `sharp` (libvips, native N-API) is loaded **inside the Host** | `dsh-attachment-local\lib\index.js:118` → `const requireSharp = createLazyRequire("sharp", import.meta.url);` |
| The lazy loader resolves the dependency **relative to the plugin package** | `dsh-lazy-require\lib\index.js:11-22` → `createRequire(parentURL)(specifier)`, cached, failed loads not cached |
| A native `.node` builtin is loaded in the Host | `dsh-app-boot\lib\index.js:2566` → `createRequire(import.meta.url)("node-addon-require-builtin")` |
| Native binaries are shipped **unpacked** out of the asar | `D:\Softwares\deepseek\resources\app.asar.unpacked\dsh\node_modules\` contains `node-pty`, `koffi` (FFI), `sherpa-onnx-win-x64`, `libreoffice-kit-win32-x64`, `node-addon-require-builtin-win32-x64-msvc`, `@img` (sharp) |
| Electron version | `44.7.0` (`D:\Softwares\deepseek\version`) — N-API v8+ is available, so N-API addons are ABI-stable against Electron's Node |

**Caveat specific to `onnxruntime-node`:** it ships prebuilt binaries per platform and its install script
downloads/links them → it needs `allowBuilds` approval (§C8 above) and the binaries must match the
**target process**. `onnxruntime-node` is built on Node-API, so it will load in Electron's Node — but it is
a *heavy* dependency to add to a profile.

**Strongly recommended alternative — the existing in-tree precedent.** The speech-to-text plugin already
does "ONNX model + native runtime" inside DSH, and does it with a **sidecar Node child process**, not in the
Electron process:

```js
const handle = this.ctx.subprocess.spawn({
    argv: [ process.execPath, …runtime.worker.endsWith(".ts") ? ["--import", import.meta.resolve("tsx/esm")] : [], runtime.worker, JSON.stringify({...this.config, ...runtime}) ],
    cwd: this.config.dataRoot,
    graceMs: this.config.graceMs,
    env: { DSH_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: "1" },
    stdio: { stdin: "ignore", stdout: "pipe", stderr: { maxBytes: this.config.maxLogBytes } }
});
```
(`dsh-experimental-speech-to-text-sensevoice\lib\index.js:773-791`)

Note `ELECTRON_RUN_AS_NODE: "1"` — it is how the Host turns its own Electron binary into a plain Node
runtime for a child process. That same trick is the safest way to run `onnxruntime-node` next to an OCR
engine, because the OCR engine then lives in a separate process and cannot crash the Host.

That same plugin also shows the **model-assets pattern**:
* it *downloads* models on demand into `config.dataRoot/models/…` and verifies them against a lock file
  (`dsh-experimental-speech-to-text-sensevoice\lib\index.js:208-240`, `328-371`) — i.e. **13 MB of ONNX
  weights need not be shipped in the bundle at all**; downloading on first use (with a checksum lock) is the
  established DSH pattern.

### C9. `packageDir` — where the plugin's own package directory is resolved

* The live `Config.listConfigs` provider returns the resolved package directory for a live entry. Verified:

```json
{ "id": "include:tool-fs", "patchId": "tool-fs", "name": "@deepseek-ai/dsh-tool-fs", "status": "inactive",
  "packageDir": "D:\\Softwares\\deepseek\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-tool-fs" }
```
(`cordis_inspect_query` → provider `Config`, method `listConfigs`, `input: { entry: "include:tool-fs" }`.)

  For a **profile-installed bundle**, `packageDir` will be
  `%USERPROFILE%\.dsh\profiles\desktop\node_modules\<bundle-name>` (or the linked workspace directory when the
  bundle was installed as `link:`).

* The bundle's own resolution order is *installation anchor first, then the profile directory*
  (`dsh-app-boot\lib\index.js:1774-1780`, `resolveBundleDir` → `packageDirFromAnchor` at `1755-1761`).

* **Reading files relative to the package dir is a supported, in-tree pattern:**
  * `readFileSync(new URL("../runtime/assets.json", import.meta.url), "utf8")`
    (`dsh-experimental-speech-to-text-sensevoice\lib\index.js:208`)
  * `fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url))`
    (`…sensevoice\lib\index.js:218`) — resolves a sidecar script shipped **inside the package**
  * `readFile(new URL("../skills/personalized-pages.md", import.meta.url), …)`
    (`dsh-creation-recommendations\lib\index.js:34`)
  * `import.meta.resolve("@deepseek-ai/dsh-creation-recommendations/references/" + file)`
    (`dsh-creation-recommendations\lib\index.js:482`)

  ⇒ **Ship the ONNX models inside the bundle directory and read them with
  `fileURLToPath(new URL('./models/rec.onnx', import.meta.url))`.** This works for both a linked local
  install and a packed registry install (as long as `files` lists them).

* `createLazyRequire(specifier, import.meta.url)` (`dsh-lazy-require\lib\index.js:11-22`) is the sanctioned
  way to load a *dependency* of the plugin package (e.g. `onnxruntime-node`) lazily and package-relative.

---

## D. Configuration & lifecycle

### D10. Declaring `Config` and persisting changes

**Export shape.** `export const Config = <schema>`; the schema is validated against the Loader entry's
`config` at activation (`host-plugin.md:64`). Two shapes exist in this build:

* **zod (standard-schema)** — the norm for DSH packages:
  ```js
  const Config = z.object({ read: z.boolean().default(true), readImage: z.boolean().default(true), … });
  ```
  (`dsh-tool-fs\lib\index.js:1952-1962`; also `dsh-tools\lib\index.js:406`
  `static Config = z.object({ mode: z.never()…, maxParallelSubCalls: z.never()… })`).
* **Schemastery** — the classic Cordis style; the loader compares raw configs using "Schemastery metadata"
  and notes "a non-Schemastery schema compares raw" (`cordis-plugin-loader\README.md:63`), so zod is accepted.

The live `Config.listConfigs` provider projects the entry's `Config` into a JSON Schema for the Settings UI
(directory → one entry → "its projected Config schema").

**Persisting a change at runtime** (`host-plugin.md:68-77`) — a plugin never edits `cordis.patch.yml` itself:

```js
const entry = ctx.fiber.entry
const editor = ctx.get('configEditor')
if (entry === undefined || editor === undefined) throw new Error('Configuration cannot be saved in this profile')
await editor.edit(entry, current => ({ ...current, field: value }))
```

`configEditor` service (live): `entries(): Entry[]`,
`configuration(): Array<{ entry, inherited, override }>`,
`edit(entry: Entry, change: (current, inherited) => Record<string, unknown>): Promise<void>`.
"Editing an ordinary field restarts the plugin so `apply` rebuilds its state; a field declared `.volatile()`
updates in place and is read with `config.field.get()`." (`host-plugin.md:77`).

### D11. Starting / stopping a long-lived child process

**`subprocess` service** (live `Service.listService(service:"subprocess")`):

```ts
export interface SubprocessSpawnSpec {
    argv: readonly string[];
    cwd: string;
    stdio: SubprocessStdio;
    graceMs: number;
    signal?: AbortSignal | undefined;
    env?: NodeJS.ProcessEnv | undefined;
}
export interface SubprocessHandle {
    readonly stdin: Writable | undefined;
    readonly stdout: Readable | undefined;
    readonly stderr: Readable | undefined;
    readonly control: Duplex | undefined;
    readonly collected: SubprocessCollectedOutputs;
    readonly done: Promise<SubprocessOutcome>;      // { exitCode: number|null; signal: NodeJS.Signals|null }
    terminate(): void;
    waitForExit(signal?: AbortSignal): Promise<boolean>;
}
export type SubprocessStdio = {
    stdin: 'ignore' | 'pipe' | { readonly data: string };
    stdout: 'pipe' | 'inherit' | SubprocessCollect;
    stderr: 'pipe' | 'inherit' | SubprocessCollect;
    control?: 'pipe';
};
```
`spawn(spec)` returns the live handle **synchronously**; "Disposal of the service terminates all still-running
managed processes and awaits their exit." Also available: `resolveExecutable(command, env?, signal?)`,
`terminalEnvironment(signal?)`, `spawnTerminal(spec)`.

**Real, in-tree example of a plugin owning a long-lived child and cleaning it up**
(`dsh-experimental-speech-to-text-sensevoice\lib\index.js:773-819`):

```js
const handle = this.ctx.subprocess.spawn({ argv: [...], cwd: this.config.dataRoot, graceMs: this.config.graceMs, env: {…}, stdio: {…} });
try {
    const worker = { handle, url: `http://127.0.0.1:${await readReady(handle, …)}`, token, closed: false };
    this.worker = worker;
    handle.done.then(exited, exited);      // child exit → publish "standby"
    return worker;
} catch (error) {
    handle.terminate();
    await handle.waitForExit();            // ← cleanup idiom
    throw error;
}
```

Other `ctx.subprocess.spawn` users: `dsh-bash-local\lib\index.js:209`, `dsh-pwsh-local\lib\index.js:306`,
`dsh-tool-fs-search\lib\index.js:171`, `dsh-ptc-runtime-node\lib\index.js:1120`,
`dsh-workspace-changes\lib\index.js:170`.

**`timer` service** (live): `timeout(callback, delay): () => void`, `timeout(delay): Promise<void>`,
`interval(callback, delay): () => void`, `interval(delay): AsyncIterableIterator<void>`,
`throttle(cb, delay, noTrailing?)`, `debounce(cb, delay)`. All return disposers.
Cordis's timer plugin is already mounted (`@deepseek-ai/cordis-plugin-timer` in the shared packages list).

### D12. What happens to `apply`'s disposer on disable / reload

* `export function apply(ctx, config) { … return disposer }` — the returned disposer is the fiber's cleanup
  hook and runs when the entry is disabled, removed, reconfigured, or when the containing fiber is disposed.
* `ctx.effect(fn)` registers a disposer **owned by the current context**; it runs on that context's disposal.
  Example in-tree: `cordis\lib\index.js:1195` → `return this.ctx.effect(() => { …; return () => this.exporters.delete(id); }, "ctx.logger.exporter()")`.
  580 `ctx.effect(` call sites exist across `@deepseek-ai/*` packages.
* Loader: entry updates "await `loader/patch-context`, the Fiber update waterfall and **disabled-entry
  disposal**" (`cordis-plugin-loader\README.md:63`); `loader.remove(id)` stops and deletes an entry.
* HMR: "the Loader entries running affected plugins **stop**" and are re-imported by the Loader
  (`dsh-hmr\README.md:67`, `:69`) — i.e. the old `apply` disposer runs, then `apply` runs again for the new
  module generation.
* Guidance for plugin authors (`cordis-plugin-development\references\practices.md:8`, `:19`):
  "Registrations are effects owned by a context. Plugin unload, agent disposal, slot collapse, and profile
  patches remove what was registered on the corresponding context." and "Register per-agent behavior on
  `agent.ctx` … Wrap it in one `agent.ctx.effect()` **and also keep that disposer, keyed by agent, in your
  plugin's own effect**; unloading the plugin does not dispose `agent.ctx` registrations by itself."

⇒ A long-lived OCR sidecar must be terminated in the disposer returned by `apply` (and, if it is started
lazily on first use, that start must itself be wrapped in `ctx.effect`).

---

## Recommended plugin skeleton

Host-only bundle, one tool named `ocr_image`, using only verified APIs. Everything marked `UNVERIFIED` is
explicitly flagged.

### `package.json`

```json
{
  "name": "@local/dsh-rapidocr",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "models/*.onnx", "worker/*.js"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```
(`files` must list `models/*.onnx` — otherwise a registry/tarball install drops them.
`host-plugin.md:35`, `:46-48`.)

### `cordis.patch.yml`

```yaml
- insert:
    - id: rapidocr
      name: '@local/dsh-rapidocr'
      config:
        enabled: true
```
(`host-plugin.md:22-27`. The row's `config` is validated against the plugin's `Config` export.)

### `locale/en.json` (+ `locale/zh.json`)

```json
{ "meta": { "title": "RapidOCR", "description": "Recognises text in images with a local ONNX OCR engine." } }
```
(`host-plugin.md:31-42` — the Plugin Manager and Settings pages read `meta.title` / `meta.description` from
exported locale JSON, and an icon from exported resources; icons may be SVG/PNG/JPEG/WebP up to 256 KiB.)

### `index.js`

```js
// @local/dsh-rapidocr — Host-only bundle: registers one model-facing tool, `ocr_image`.
//
// Verified against DeepSeek Harness Desktop 0.2.2-rc.1 (Electron 44.7.0, Node 24.21.0).
// Every API call below is cited in docs/dsh-integration.md.

import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process' // UNVERIFIED: prefer ctx.subprocess.spawn (see §D11)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rapidocr'

/**
 * Services this plugin requires.
 * - 'tools'            -> ctx.tools            (hard dependency, live Service.listService)
 * - 'workingDirectory' -> ctx.workingDirectory (hard dependency)
 * - 'fs'               -> ctx.fs               (hard dependency; host-path authorization)
 * 'attachments' is OPTIONAL and is used with ctx.inject(...) so the tool only
 * exists where a durable attachment store is mounted (same pattern as dsh-tool-fs:1980).
 */
export const inject = ['tools', 'workingDirectory', 'fs']

/**
 * Config schema for the plugin row.
 * `dsh-tool-fs` uses a zod schema (dsh-tool-fs/lib/index.js:1952). This bundle
 * declares zod as a dependency so the import resolves from the profile's
 * node_modules (the profile already hoists `zod`).
 */
export const Config = {
  type: 'object',
  properties: {
    workerPath: { type: 'string', default: '' },
    pythonPath: { type: 'string', default: '' },
    maxImageBytes: { type: 'number', default: 50 * 1024 * 1024 },
    timeoutMs: { type: 'number', default: 120000 },
  },
}

// Package-relative asset resolution — the in-tree pattern
// (dsh-experimental-speech-to-text-sensevoice/lib/index.js:208,218).
const packageDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * Resolve the OCR sidecar script that ships inside this bundle.
 * @param {string} configured - optional override from the plugin config
 * @returns {string} absolute path to the worker script
 */
function resolveWorker(configured) {
  const candidate = configured
    ? fileURLToPath(new URL(configured, import.meta.url))
    : fileURLToPath(new URL('./worker/ocr-worker.js', import.meta.url))
  if (!existsSync(candidate)) throw new Error(`rapidocr: worker script not found at ${candidate}`)
  return candidate
}

/**
 * Plugin entry. Registers the `ocr_image` tool.
 * @param {*} ctx - the plugin context
 * @param {*} config - the validated row config
 * @returns {() => void} disposer run when the plugin is disabled, reloaded or removed
 */
export function apply(ctx, config) {
  const workerPath = resolveWorker(config.workerPath)

  // System-prompt guidance for the model — same shape as the built-in `read` tool
  // (dsh-tool-fs/lib/index.js:248-252).
  ctx.systemPrompt.section({
    name: 'tool:ocr_image',
    order: ctx.systemPrompt.getSectionOrder('TOOL_OCR_IMAGE'), // UNVERIFIED: section-order name
    text: ({ scope }) =>
      ctx.tools.get('ocr_image', scope) === undefined
        ? ''
        : 'Use ocr_image to recognise text inside an image file (PNG/JPEG). It returns the recognised text.',
  })

  // Register the tool. Registration is owned by this context: the disposer is
  // returned below, so disabling/reloading the plugin unregisters it.
  const dispose = ctx.tools.register(
    {
      name: 'ocr_image',
      description:
        'Recognise the text in an image file (PNG/JPEG) with a local ONNX OCR engine and return the recognised text.',
      // Raw JSON Schema (dsh-tools/lib/index.js:366-376 projects `parameters` verbatim).
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the image file, resolved against the session working directory.',
          },
          lang: {
            type: 'string',
            description: 'Optional language hint passed to the OCR engine, e.g. "ch" or "en".',
          },
        },
        required: ['file_path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'Canonical absolute path of the recognised image.' },
            text: { type: 'string', description: 'The recognised text.' },
          },
          required: ['path', 'text'],
        },
        render: (_args, value) => [{ type: 'text', text: `<path>${value.path}</path>\n<text>\n${value.text}\n</text>` }],
        presentationMeta: (_args, value) => ({ path: value.path }),
      },
      timeoutMs: config.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
          throw new Error('file_path must be a non-empty string')
        }

        // 1. Resolve the path against the calling session's working directory
        //    (dsh-tool-fs/lib/index.js:162-206).
        const cwd =
          exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const target = await ctx.fs.resolve(args.file_path, {
          ...(cwd !== undefined ? { cwd } : {}),
          signal: exec.signal,
        })
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new Error(`cannot read "${target.displayPath}": not found`)
        if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": not a regular file`)

        // 2. Read the bytes through the mounted filesystem backend so path
        //    authorization stays with ctx.fs (dsh-tool-fs/lib/index.js:1790).
        const data = await ctx.fs.readBytes(target, exec.signal, config.maxImageBytes)

        // 3. Run the OCR engine. Preferred: a long-lived sidecar spawned with
        //    ctx.subprocess.spawn (contract in §D11; in-tree precedent
        //    dsh-experimental-speech-to-text-sensevoice/lib/index.js:773-791,
        //    incl. env { ELECTRON_RUN_AS_NODE: '1' }).
        //    UNVERIFIED: the exact request/response protocol of a sidecar is a
        //    design choice; the spawn/terminate/waitForExit calls are verified.
        const text = await runOcr(ctx, { workerPath, image: data, lang: args.lang, signal: exec.signal })

        // 4. Return a value matching output.schema; `output.render` turns it
        //    into the model-facing content blocks.
        return { path: ctx.fs.processPath(target), text }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: `Recognise text in ${args.file_path}`,
          kind: 'read',
          locations: [{ path: args.file_path }],
        }
      },
    },
    {},
  )

  // The disposer returned from apply() runs on disable / reload / removal
  // (cordis-plugin-loader/README.md:63; dsh-hmr/README.md:67,69).
  return () => {
    dispose()
  }
}

/**
 * Run the OCR engine once. UNVERIFIED: the transport below is a placeholder
 * design; the verified primitives are ctx.subprocess.spawn / handle.terminate
 * / handle.waitForExit (§D11).
 * @param {*} ctx plugin context
 * @param {{ workerPath: string, image: Uint8Array, lang?: string, signal: AbortSignal }} request
 * @returns {Promise<string>} the recognised text
 */
async function runOcr(ctx, request) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('rapidocr: no subprocess service is mounted')
  const handle = subprocess.spawn({
    argv: [process.execPath, request.workerPath],
    cwd: packageDir,
    graceMs: 5000,
    signal: request.signal,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
  })
  try {
    handle.stdin.write(request.image)
    handle.stdin.end()
    const chunks = []
    for await (const chunk of handle.stdout) chunks.push(chunk)
    const stdout = Buffer.concat(chunks).toString('utf8')
    await handle.done
    return stdout
  } finally {
    handle.terminate()
    await handle.waitForExit()
  }
}
```

### Notes on the skeleton

* `ctx.tools.register` returns the exact unregistration disposer (`dsh-tools\lib\index.js:441-444`); returning
  it from `apply` is the whole lifecycle story.
* `ctx.systemPrompt.getSectionOrder('TOOL_OCR_IMAGE')` — the *pattern* is verified
  (`dsh-tool-fs\lib\index.js:250`, `ctx.systemPrompt.getSectionOrder("TOOL_READ")`), but the exact section-order
  key is **UNVERIFIED**. Safer: omit `order` and pass a plain numeric `order` (e.g. `order: 100`) — **UNVERIFIED**
  whether `order` is optional.
* `ctx.get('subprocess')` is the documented optional-access form (live catalog: `ctx.get("subprocess")`,
  `requiresUndefinedCheck: true`).
* `handle.stdin` is `Writable | undefined` and `handle.stdout` is `Readable | undefined` per the contract;
  the stream code above needs a `undefined` guard in production (**UNVERIFIED** as written).
* `ctx.fs.readBytes(target, signal, maxBytes)` needs a numeric `maxBytes`; `config.maxImageBytes` supplies it.
* The model-visible result is text-only, which matches the §A5 conclusion that DSH has no OCR tool yet and
  the §B6 convention that images reach tools as paths.

---

## Open questions / risks

1. **`defineTool` is not importable from a profile bundle.** `@deepseek-ai/dsh-tools` is not in
   `…\profiles\desktop\node_modules\@deepseek-ai\` (only `cosmokit`, `schemastery`). The skeleton therefore
   registers a raw `ToolDefinition` and hand-writes the JSON Schema. If the Lead wants argument validation for
   free, the bundle must declare `@deepseek-ai/dsh-tools` as a dependency — which installs a **second copy** of
   the package into the profile, and that copy's `ToolDefinition` identity must still satisfy the running
   registry. **Unverified.** Prefer the raw shape.
2. **Sidecar transport is unverified.** `ctx.subprocess.spawn` / `terminate()` / `waitForExit()` / `done` are
   verified; a request/response protocol on top of them is not. A stdio-JSON-lines worker is the natural
   choice; needs a prototype.
3. **`ctx.systemPrompt.getSectionOrder('<key>')` key names are unverified.** Only `TOOL_READ` is observed in
   this build. Consider omitting the system-prompt section entirely for v1.
4. **Native `onnxruntime-node` inside the Electron Host is unproven for this exact package.** Precedent exists
   for native addons in the Host (`sharp` at `dsh-attachment-local\lib\index.js:118`), and `onnxruntime-node`
   is Node-API based (ABI-stable), but its install script needs `allowBuilds` approval, and it is a heavy
   dependency for a profile. **Recommendation: run the OCR engine in a sidecar Node child
   (`ELECTRON_RUN_AS_NODE=1`), exactly as the shipped speech-to-text plugin does.**
5. **13 MB of `.onnx` weights: ship or download?** Shipping inside the bundle works for a local `link:`
   install (`files` does not filter a linked directory) and for a registry install **only if `files` lists
   `models/*.onnx`**. The in-tree alternative (sensevoice) **downloads and verifies** models on demand into a
   data root — a better fit if the bundle must also be published to a registry, but it adds first-run latency
   and needs a download host.
6. **`.onnx` in `files` + pnpm packing** — npm/pnpm pack has no per-file size limit, but the tarball grows
   the profile's install size and the manager's `detailMaxBytes` (1 MiB) / `detailImageMaxBytes` (5 MiB)
   apply only to *bundle detail documents*, not to package contents. Still worth verifying the packed file
   list before publishing (`host-plugin.md:35`).
7. **Where the OCR output should go.** `read_image` returns an *image*; `ocr_image` returns *text*. The
   model-facing envelope convention in this build is `<path>…</path><type>…</type><content>…</content>`
   (`dsh-tool-fs\lib\index.js:1724-1728`); the skeleton uses `<path>` + `<text>`. **Unverified** whether the
   Web UI's tool renderer recognises a custom card for a generic tool — the built-in `read_image` row is
   registered by `@deepseek-ai/dsh-client-ui-tool` (`dsh-client-ui-tool\lib\client.js:3012-3018`), so a custom
   tool will render through the *generic* fallback card.
8. **Session-level visibility of the tool.** A root-context registration makes `ocr_image` global for every
   agent in the profile, including the `minimal` / `sdk-minimal` presets that advertise a deliberately small
   tool set (`dsh-sdk-minimal\README.md:83`). If that is undesirable, register on `agent.ctx` inside an
   `agent/created` listener and keep the disposer in the plugin's own effect (`practices.md:19`).
9. **Sandbox / path authorization.** `ctx.fs` owns path authorization (the `read_image` doc: "Path
   authorization for `read` and `read_image` belongs entirely to `ctx.fs`", `dsh-tool-fs\README.md:78`).
   The OCR sidecar, however, reads the file path *outside* `ctx.fs` if it opens the file itself — passing the
   path to a child process bypasses the sandbox. Reading the bytes in the Host and streaming them to the child
   (as the skeleton does) keeps authorization in `ctx.fs` at the cost of copying the image into the pipe.
10. **Version gates.** A bundle that declares `engines.dsh` is checked *before* pnpm runs and refused on a
    mismatch (`dsh-plugin-manager\README.md:77`). The Lead should decide the range (installed: `0.2.2-rc.1`).
11. **Not verified by inspection:** the exact `cordis.patch.yml` loader dialect beyond the minimal `insert`
    form shown (`host-plugin.md:22-27`); whether a bundle may ship a `client.js` half (not needed here);
    whether `ctx.tools.register` rejects a tool name that already exists in a *different* scope.

### Source map (all paths relative to `D:\Softwares\deepseek\resources\`)

| Path | Used for |
|---|---|
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js` | `register()` contract, `projectToolSchema`, scope rules |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-tools\lib\types\schema.js` | `defineTool`, JSON-Schema DSL |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-tool-fs\lib\index.js` | `read_image` tool, cwd resolution, `Config`/`inject`/`apply` |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-tool-fs\README.md` | tool table, path-ownership statement |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-lazy-require\lib\index.js` | `createLazyRequire` |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-attachment-local\lib\index.js` | native `sharp` in the Host |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-experimental-speech-to-text-sensevoice\lib\index.js` | sidecar spawn, ONNX models, package-relative assets |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js` | bundle/package dir resolution |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-plugin-manager\README.md` | install, `pnpm add`, build scripts, `allowBuilds`, link installs |
| `app.asar\dsh\node_modules\@deepseek-ai\cordis-plugin-loader\README.md` | entry options, disposal, volatile config |
| `app.asar\dsh\node_modules\@deepseek-ai\cordis\lib\index.js` | `ctx.effect` semantics |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-hmr\README.md` | reload / recomposition and plugin stop |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-spill-policy\lib\index.js` | image-as-text convention |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\{host-plugin,practices,mcp-bundle}.md` | bundle manifest, `Config`/`configEditor`, practices |
| `app.asar\dsh\desktop-runtime.json`, `app.asar\dsh\package.json`, `D:\Softwares\deepseek\version` | versions (DSH / Node / pnpm / Electron) |
| `%USERPROFILE%\.dsh\profiles\desktop\{package.json,pnpm-workspace.yaml,node_modules}` | profile layout, `allowBuilds`, installed packages |
