import { writeFileSync } from 'node:fs';
import path from 'node:path';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Write an executable sh wrapper around Chrome that removes Remotion's "no proxy" flags and forces
 * all traffic (loopback included) through our filtering proxy, with a fixed DevTools port.
 */
export function writeChromeWrapper({ realChrome, proxyPort, debugPort, dir }) {
  const file = path.join(dir, 'chrome-wrapper.sh');
  const script = `#!/bin/sh
for a in "$@"; do
  shift
  case "$a" in
    --no-proxy-server|--proxy-server=*|--proxy-bypass-list=*|--proxy-pac-url=*|--remote-debugging-port=*|--remote-debugging-address=*|--remote-allow-origins*|--no-sandbox|--disable-web-security|--allow-file-access-from-files) ;;
    *) set -- "$@" "$a" ;;
  esac
done
exec ${shq(realChrome)} "$@" \\
  --proxy-server=http://127.0.0.1:${Number(proxyPort)} \\
  --proxy-bypass-list='<-loopback>' \\
  --remote-debugging-port=${Number(debugPort)} \\
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \\
  --webrtc-ip-handling-policy=disable_non_proxied_udp
`;
  writeFileSync(file, script, { mode: 0o700 });
  return file;
}
