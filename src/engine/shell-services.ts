import { dhclient, dhcpRelease } from './dhcp.ts';
import type { Command } from './shell.ts';

/** `dnsmasq [OPTIONS]`: starts the DHCP and DNS server in the background. */
export const dnsmasq: Command = (_net, device, args, io) => {
  if (args.includes('--help')) {
    io.out('Usage: dnsmasq [options]');
    io.out('  --dhcp-range=START,END[,LEASE]       hand out addresses from START to END');
    io.out('  --dhcp-option=option:router,IP       default gateway for clients');
    io.out('  --dhcp-option=option:dns-server,IP   name server for clients');
    io.out('  --address=/NAME/IP                   answer DNS queries for NAME with IP');
    io.out('  --host-record=NAME,IP                same as --address');
    io.out('Stop it with: killall dnsmasq');
    return;
  }
  const result = device.startDnsmasq(args);
  if (typeof result === 'string') io.out(result);
  else result.forEach((line) => io.out(line));
};

/** `killall NAME`: only dnsmasq runs in the background in NetForge. */
export const killall: Command = (_net, device, args, io) => {
  const [name] = args;
  if (name === undefined) {
    io.out('Usage: killall NAME');
    return;
  }
  if (name !== 'dnsmasq' || !device.stopDnsmasq()) io.out(`${name}: no process found`);
};

/** `dhclient [-r] [-v] IF`: gets (or releases) an address with DHCP. */
export const dhclientCommand: Command = (_net, device, args, io) => {
  const release = args.includes('-r');
  const names = args.filter((a) => !a.startsWith('-'));
  const name = names[0] ?? device.ip?.ports[0]?.name;
  const port = name === undefined ? undefined : device.port(name);
  if (!device.ip) {
    io.out('dhclient: command not found');
    return;
  }
  if (!port) {
    io.out(`Cannot find device "${name ?? ''}"`);
    return;
  }
  if (release) {
    dhcpRelease(device, port, io);
    return;
  }
  const started = dhclient(device, port, io);
  if (typeof started === 'string') {
    io.out(started);
    return;
  }
  return { interrupt: started };
};
