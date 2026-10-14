# V1 baseline MacBook validation evidence

This directory preserves the sanitized, machine-verifiable output from the final clean
MacBook validation of code commit
`37ce53bce3d523eee560eff242b369f1d1c7a794`.

- `manifest.json` binds the exact commit, Git tree, source archive, package lock,
  toolchain, isolation profile, eight commands, exit codes, summaries, byte counts,
  and log SHA-256 values.
- `mac-validation-logs.tar.gz.b64` is a single-line Base64 encoding of the gzip tar
  containing the eight logs named by the manifest.
- Host identity, private paths, placeholder values, and test credential decoys were
  removed from the retained logs. Tar headers are normalized to UID/GID `0`,
  `root:root`, fixed UTC mtime `2000-01-01T00:00:00Z`, and gzip mtime `0`. The
  validation received no production secrets and did not contact production endpoints.
- This is validation evidence only. It does not authorize production access,
  migration, deployment, workflow enablement, or a V1 GO decision.

Expected evidence hashes:

```text
manifest.json                         c12b3326f36b97f088e6916bd91a2453f3a78007acc5ab797667022238dce47a
mac-validation-logs.tar.gz.b64        adb32fe0f1657a2058d2a42e8738c329c8e732f3464495f290ebbb42b0c3677b
decoded mac-validation-logs.tar.gz    0cf24f95df6a51ace9ef8ac1f3504d80b49b08df3ee8654fef9d6123131abf2d
```

The source Mac produced manifest SHA-256
`28463f1775411e85eec0ba9710dd6305dba7dea17f1a26b2ab4f5c4f4989c916`.
The repository copy was formatting-normalized; both resolve to canonical sorted JSON
SHA-256 `6bf03b19bbf22dee7ed599f2bb57a9e710c8b1b07b8122b54ccb7573fd2d6c3f`.
The hash in `generator.initial_assembly_source_sha256` is provenance for the initial
inline assembly only. That private command was not retained; the manifest marks it
non-retrievable and lists all subsequent post-processing explicitly.

One portable verification path from this directory is:

```sh
shasum -a 256 manifest.json mac-validation-logs.tar.gz.b64
jq -S -c . manifest.json | shasum -a 256
evidence_tar="$(mktemp /private/tmp/arena-v1-mac-validation.XXXXXX)"
openssl base64 -d -A -in mac-validation-logs.tar.gz.b64 -out "$evidence_tar"
shasum -a 256 "$evidence_tar"
tar -tzf "$evidence_tar"
```

After extracting into a private temporary directory, recompute every member hash and
byte count against `commands[].log_sha256` and `commands[].log_bytes` in the manifest.
Also verify the normalized tar metadata against
`evidence_bundle.header_normalization`.
