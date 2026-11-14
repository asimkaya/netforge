import { describe, expect, it } from 'vitest';
import { Network } from '../engine/network.ts';
import { focusOf } from './focus.ts';

describe('task step focus', () => {
  it('points at the palette for steps that add devices', () => {
    const net = new Network();
    net.addDevice('pc');
    expect(
      focusOf({ title: 'Add two PCs', detail: 'Drag a PC from the left panel.' }, net),
    ).toEqual({ palette: ['pc'], devices: [] });
  });

  it('points at devices on the canvas, or at the palette when there are none yet', () => {
    const net = new Network();
    const pc = net.addDevice('pc');
    const step = { title: 'Give the first PC an address', detail: 'Then open the router.' };
    expect(focusOf(step, net)).toEqual({ palette: ['router'], devices: [pc.id] });
    const router = net.addDevice('router');
    expect(focusOf(step, net)).toEqual({ palette: [], devices: [pc.id, router.id] });
  });

  it('tells a home router from a router and finds devices by name', () => {
    const net = new Network();
    const router = net.addDevice('router');
    const home = net.addDevice('homerouter');
    expect(focusOf({ title: 'Open the Home Router', detail: '' }, net).devices).toEqual([home.id]);
    expect(focusOf({ title: 'Check', detail: 'Run `ip route` on r1.' }, net).devices).toEqual([
      router.id,
    ]);
  });
});
