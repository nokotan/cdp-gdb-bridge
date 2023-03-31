set NODE_OPTIONS=--openssl-legacy-provider
call vsce package

set NODE_OPTIONS=
code --install-extension cdp-gdb-bridge-1.2.3.vsix
