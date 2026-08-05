# Root application vendor packages

This directory contains compatibility packages owned exclusively by the root
web application. Each package must keep its package metadata and applicable
third-party notices beside its source.

Worker runtime dependencies belong in `worker/package.json` and
`worker/package-lock.json`; root vendor packages must not be placed under
`worker/**` or become Worker release inputs.
