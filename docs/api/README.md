# API contract

The canonical, version-controlled Arena API contract is
[`../openapi.yaml`](../openapi.yaml).

The former `openapi.json` snapshot described the retired
`ranking-arena.vercel.app` deployment and must not be used for integration or
release verification. Generate import-specific JSON from the canonical YAML at
release time instead of maintaining a second hand-edited contract.
