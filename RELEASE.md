# Release Guide

This repository contains a VS Code extension at the repo root and a separate Cloudflare worker under `cloudflare-worker/`.
Release the extension from the repository root.

## Prerequisites

- Node.js and npm installed
- Access to the `PredictabilityAtScale` VS Code Marketplace publisher
- `vsce` access configured on the machine
- OpenVSX token if publishing to OpenVSX

## Release Checklist

1. Review the pending changes.
2. Update the version in `package.json`.
3. Add release notes to `CHANGELOG.md`.
4. Install dependencies if needed:

```powershell
npm install
```

5. Validate the extension build:

```powershell
npm run compile
npm test
```

6. Build the production package:

```powershell
npm run package
```

7. Optionally create a local VSIX first:

```powershell
npx @vscode/vsce package
```

8. Publish to the VS Code Marketplace:

```powershell
npx @vscode/vsce publish
```

9. Publish to OpenVSX:

```powershell
npx ovsx publish -p <OPENVSX_TOKEN>
```

## First-Time Login

If `vsce` is not already authenticated on the machine:

```powershell
npx @vscode/vsce login PredictabilityAtScale
```

If `ovsx` is not already available on the machine, run it through `npx` as shown above or install it globally:

```powershell
npm install -g ovsx
```

## Notes

- `vscode:prepublish` is wired to `npm run package`, so `vsce package` and `vsce publish` trigger the production build automatically.
- The extension manifest is the root `package.json`, not `cloudflare-worker/package.json`.
- Packaging exclusions are controlled by `.vscodeignore`.
- Publish to both marketplaces from the repository root after the version in `package.json` has been updated.