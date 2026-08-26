# OpenScout for macOS

This public directory is the trust and update surface for the signed OpenScout
macOS app. The native product extends Scout's public core; its source and
product release are owned by the private OpenScout repository, while its
notarized installer and Sparkle feed must remain anonymously reachable.

## Next promotion

| Artifact | Version |
| --- | --- |
| OpenScout product | `0.2.92` (preparing) |
| Scout public core | `0.2.92` |
| Public release tag | `app-v0.2.92` (not promoted yet) |

- Planned versioned installer: `OpenScout-0.2.92.dmg`
- Sparkle feed: [`appcast.xml`](./appcast.xml)
- Compatibility: macOS 26 or later on Apple silicon

The checked-in feed is intentionally empty until the notarized installer has
been published and anonymously verified. An appcast item is the promotion
signal; source preparation alone never advertises a download.

Product and public-package versions are intentionally independent. A native
app release never republishes Scout's npm packages from the private product
repository.

## Verify a promoted download

macOS verifies the Developer ID signature and Apple's notarization ticket:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/OpenScout.app
spctl --assess --type execute --verbose=2 /Applications/OpenScout.app
xcrun stapler validate /Applications/OpenScout.app
```

After promotion, release notes publish the installer SHA-256. Compare it locally with:

```bash
shasum -a 256 OpenScout-0.2.92.dmg
```

## Publication contract

The release owner publishes in this order:

1. merge and tag the exact private product source;
2. build, sign, notarize, staple, and verify a fresh installer from pinned
   Hudson and Termini revisions;
3. upload the immutable versioned installer and verify it anonymously;
4. publish the signed Sparkle appcast last.

This ordering prevents the updater from advertising an installer that does not
exist yet. The private GitHub release is a provenance receipt, not the public
download origin. There is deliberately no mutable `OpenScout.dmg` release
asset; download links name the promoted version explicitly.

## Upgrading from 0.2.87 or earlier

Older builds point at the former private-repository feed and cannot discover
this migration automatically. After `0.2.92` is promoted, install it manually
once from the public release. Later versions use this public feed normally.

For help, open an issue in the public
[Scout issue tracker](https://github.com/oscout/scout/issues).
