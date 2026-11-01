# Publication note — base/ comment normalization

This repository is the public export of the RiderTap base application plus
the Copilot layer built for the Meta Global AI Developer Hackathon.

For publication, comments and documentation strings in `base/` (and one line
in `BEFORE.md`) that named the original hosted build platform were reworded
to neutral descriptions ("the hosted artifact", "the platform SDK", "the
hosted runtime"). Only comments and prose changed — no code was added,
removed, or altered in behavior.

- The base application code in this export is behavior-identical to the
  live production application.
- `BASELINE-MANIFEST.sha256` in this export has been regenerated for the
  files whose comments were normalized, so the manifest matches this
  export exactly for every file present in it. (Build-output files listed
  in the manifest are not included in this export.)
- The canonical, unmodified baseline — against which the live production
  deployment is verified — is maintained separately by the entrant and is
  not part of this export. That maintained separation is the one deliberate
  divergence between this export's manifest and the canonical baseline.
- Functional identifiers were intentionally retained: the client framework
  SDK's package name in dependency entries, lockfiles, and import
  specifiers, its DOM hook identifiers in the client entry, and local
  tool paths inside the deploy scripts. Removing them would break the
  export's build and deploy tooling; they are part of the application's
  real dependency surface.
