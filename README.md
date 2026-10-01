# KooyaHQ Console CLI releases

This public repository hosts release assets for the KooyaHQ Console CLI and local MCP server. It contains no application source code or credentials; the CLI source repository is private.

## Requirements

Node.js 22 or newer.

## Install

```sh
npm install -g https://github.com/KooyaPH/kooyahq-console-cli/releases/latest/download/kooya-cli.tgz
```

## Update

Check for an update:

```sh
kooyahq update --check
```

Install the latest release:

```sh
kooyahq update
```

## Release contents

Each versioned GitHub Release contains `kooya-cli.tgz` and its `kooya-cli.tgz.sha256` checksum. The tag workflow validates the package name, version, privacy setting, archive contents, and checksum before publishing these two assets. It does not publish to npm.

Release tags matching `v*` cannot be updated or deleted after creation.

The release package is built from the private source repository. Only the packaged archive and checksum are published here; private source, tests, design files, and credentials must not be included in the package.
