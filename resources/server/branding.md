<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->

# Vibe browser branding

The approved white and blue logo is defined in [vibeBranding.ts](../../src/vs/server/node/vibeBranding.ts). Its central white triangle has its centroid at the center of the rounded square.

The authentication page, startup overlay and SVG favicon embed the same data URI. They can display the logo before authentication or cached workbench resources finish loading. Authentication permits only `data:` images through its existing restrictive Content Security Policy.

Using the Node version in `.nvmrc`, regenerate the 192/512 PNGs, the 16/32/48 ICO and the manifest icon revisions from that artwork:

```bash
npm exec playwright install chromium
node scripts/update-vibe-icons.mts
```

An existing browser can be selected with `node scripts/update-vibe-icons.mts --browser-executable <browser-executable>`. The command resolves all repository files relative to itself.

The artwork hash versions the ICO, Apple touch icon and manifest URLs, including the PNG URLs inside the manifest, so a logo update invalidates previously cached browser icons. Keep the generated files with the source change. The existing web and server packaging steps already include these filenames.
