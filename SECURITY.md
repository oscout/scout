# Security policy

## Supported versions

Security fixes target the package version currently published under the npm
`latest` dist-tag and its corresponding tagged source in this repository.
Older releases may not receive fixes.

Check the installed version with:

```bash
scout --version
npm view @openscout/scout version
```

## Report a vulnerability

Please do not open a public issue, discussion, or pull request for a suspected
vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/oscout/scout/security/advisories/new)
so the report can include reproduction details, affected versions, and impact
without exposing users. If that form is unavailable, use the maintainer contact
routes at [arach.dev](https://arach.dev) and include only enough detail to
establish a private follow-up channel.

Useful reports include:

- the affected command, service, transport, or package;
- the exact Scout version and platform;
- a minimal reproduction or proof of concept;
- the expected security boundary and observed violation;
- whether credentials, message content, local files, or remote nodes are at
  risk.

## Scope and posture

Scout is currently designed for high-trust local developer pilots. It is not a
hardened untrusted multi-tenant runtime, a compliance boundary, or a globally
consistent distributed system. Reports that break the documented local trust
model are still welcome; describe the assumed attacker and boundary clearly.
