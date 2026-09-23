# Apiweld GitHub Action

Runs `apiweld check`. When selected operations drift, it regenerates the client with `apiweld heal --apply`, pushes `apiweld/heal-<date>`, and opens a pull request whose body is the heal plan.

The workflow needs `contents: write` and `pull-requests: write`.

```yaml
name: apiweld
on:
  schedule:
    - cron: "0 8 * * 1"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: ./action
        with:
          fail-on: breaking
```

`command` overrides the executable. Use `bun run apiweld` when the tool is installed in the repo instead of from npm.
