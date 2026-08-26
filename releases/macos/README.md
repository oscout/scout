# OpenScout for macOS

This public directory is the trust and update surface for the signed OpenScout
macOS app. The native product extends Scout's public core; its source and
product release are owned by the private OpenScout repository, while its
notarized installer and Sparkle feed must remain anonymously reachable.

## Current release

| Artifact | Version |
| --- | --- |
| OpenScout product | `0.2.92` |
| Scout public core | `0.2.91` |
| Public release tag | `app-v0.2.92` |

- Versioned installer: `OpenScout-0.2.92.dmg`
- Stable installer alias: `OpenScout.dmg`
- Sparkle feed: [`appcast.xml`](./appcast.xml)

Product and public-package versions are intentionally independent. A native
app release never republishes Scout's npm packages from the private product
repository.

## Verify a download

macOS verifies the Developer ID signature and Apple's notarization ticket:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/OpenScout.app
spctl --assess --type execute --verbose=2 /Applications/OpenScout.app
xcrun stapler validate /Applications/OpenScout.app
```

Release notes publish the installer SHA-256. Compare it locally with:

```bash
shasum -a 256 OpenScout-0.2.92.dmg
```

## Publication contract

The release owner publishes in this order:

1. merge and tag the exact private product source;
2. build, sign, notarize, staple, and verify a fresh installer from pinned
   Hudson and Termini revisions;
3. upload the immutable versioned installer and verify it anonymously;
4. upload the stable alias;
5. publish the signed Sparkle appcast last.

This ordering prevents the updater from advertising an installer that does not
exist yet. The private GitHub release is a provenance receipt, not the public
download origin.

## Upgrading from 0.2.87 or earlier

Older builds point at the former private-repository feed and cannot discover
this migration automatically. Install `0.2.92` manually once from the public
release. Later versions use this public feed normally.

For help, open an issue in the public
[Scout issue tracker](https://github.com/oscout/scout/issues).
