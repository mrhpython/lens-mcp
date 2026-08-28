#!/usr/bin/env bash
# Build the MCPB bundle Smithery accepts for a stdio server.
#
# Smithery hosts and proxies servers, so it takes either a public Streamable
# HTTP endpoint or an MCPB bundle. This server is stdio over npm, and its only
# HTTP endpoint is access-controlled by an unguessable path that must not be
# published — so the bundle is the path.
#
# The bundle must carry its production dependencies, so it is staged outside
# the repo and node_modules never lands here. The artifact is a build output
# and is gitignored; rebuild it rather than committing it.
#
#   ./build-mcpb.sh            -> ./dist/lens-mcp-<version>.mcpb
#
# Then, once signed in (smithery auth login):
#   npx @smithery/cli mcp publish ./dist/lens-mcp-<version>.mcpb -n <org>/lens-mcp

set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(node -p "require('./package.json').version")"
MANIFEST_VERSION="$(node -p "require('./manifest.json').version")"

if [ "$VERSION" != "$MANIFEST_VERSION" ]; then
  echo "version drift: package.json is $VERSION, manifest.json is $MANIFEST_VERSION" >&2
  echo "bring them into line before building — the bundle advertises the manifest's" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "staging $VERSION in $STAGE"
cp mcp-server.cjs package.json package-lock.json manifest.json README.md LICENSE "$STAGE/"
( cd "$STAGE" && npm ci --omit=dev --silent )

mkdir -p dist
OUT="dist/lens-mcp-$VERSION.mcpb"
npx -y @anthropic-ai/mcpb@latest pack "$STAGE" "$OUT"

echo
echo "verifying the packed bundle answers introspection"
VERIFY="$(mktemp -d)"
trap 'rm -rf "$STAGE" "$VERIFY"' EXIT
npx -y @anthropic-ai/mcpb@latest unpack "$OUT" "$VERIFY" >/dev/null

printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"build-check","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node "$VERIFY/mcp-server.cjs" 2>/dev/null \
  | node -e '
let out = "";
process.stdin.on("data", d => out += d);
process.stdin.on("end", () => {
  let init = null, tools = null;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) init = m.result?.serverInfo;
    if (m.id === 2) tools = m.result?.tools;
  }
  if (!init || !tools?.length) {
    console.error("bundle did not answer introspection");
    process.exit(1);
  }
  console.log(`  initialize -> ${init.name} ${init.version}`);
  console.log(`  tools/list -> ${tools.length} tools`);
});'

echo
echo "built $OUT"
