import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Network } from '../engine/network.ts';
import type { Note, Zone } from './annotations.ts';
import { copyOf, paste } from './clipboard.ts';
import { startHistory, undo } from './history.ts';
import { addDevice, addNote, addZone, getLab, loadLab, removeAnnotation } from './lab.ts';
import { PROJECT_VERSION, emptyProgress, parseProject, serializeProject } from './project.ts';

const note: Note = { id: 'n1', x: 10, y: -20.5, w: 240, text: 'Core switch\nrack 2' };
const zone: Zone = { id: 'z1', x: 0, y: 0, w: 400, h: 250, title: 'Server room', tint: 2 };

const base = () =>
  serializeProject({
    net: new Network(),
    layout: {},
    notes: [note],
    zones: [zone],
    tasks: emptyProgress(),
  });

function mutate(text: string, change: (file: Record<string, unknown>) => void): string {
  const file = JSON.parse(text) as Record<string, unknown>;
  change(file);
  return JSON.stringify(file);
}

describe('notes and zones in the save format', () => {
  it('round-trip', () => {
    const loaded = parseProject(base());
    expect(loaded.notes).toEqual([note]);
    expect(loaded.zones).toEqual([zone]);
  });

  it('loads a version 12 file, which has neither', () => {
    const old = mutate(base(), (f) => {
      f.version = 12;
      delete f.notes;
      delete f.zones;
    });
    const loaded = parseProject(old);
    expect(loaded.notes).toEqual([]);
    expect(loaded.zones).toEqual([]);
    expect(PROJECT_VERSION).toBe(14);
  });

  it('rejects bad notes and zones', () => {
    type Item = Record<string, unknown>;
    const bad = (change: (note: Item, zone: Item, file: Item) => void) =>
      expect(() =>
        parseProject(
          mutate(base(), (f) => {
            const [n, z] = [(f.notes as Item[])[0] ?? {}, (f.zones as Item[])[0] ?? {}];
            change(n, z, f);
          }),
        ),
      ).toThrow(/invalid|twice|too many/);
    bad((n) => (n.text = 'x'.repeat(2001)));
    bad((n) => (n.text = 'ab'));
    bad((n) => (n.w = 5000));
    bad((n) => (n.x = 1e9));
    bad((n) => (n.id = 'd1'));
    bad((n, _z, f) => (f.notes = [n, { ...n }]));
    bad((_n, z) => (z.w = 10));
    bad((_n, z) => (z.h = 99999));
    bad((_n, z) => (z.title = 'x'.repeat(61)));
    bad((_n, z) => (z.tint = 4));
    bad((_n, z) => (z.tint = 1.5));
    bad(
      (_n, _z, f) =>
        (f.zones = Array.from({ length: 101 }, (_, i) => ({ ...zone, id: `z${i + 1}` }))),
    );
  });
});

describe('notes and zones in the lab', () => {
  let stop: () => void;
  beforeAll(() => {
    vi.useFakeTimers();
    stop = startHistory();
  });
  afterAll(() => {
    stop();
    vi.useRealTimers();
  });

  it('are added, selected, removed and undone', () => {
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    addNote({ x: 5, y: 6 });
    addZone({ x: 0, y: 0 });
    expect(getLab().notes[0]).toMatchObject({ id: 'n1', x: 5, y: 6, text: '' });
    expect(getLab().zones[0]).toMatchObject({ id: 'z1', title: 'Zone' });
    expect(getLab().selection).toEqual(['z1']);
    vi.advanceTimersByTime(500);
    removeAnnotation('n1');
    vi.advanceTimersByTime(500);
    expect(getLab().notes).toEqual([]);
    undo();
    expect(getLab().notes).toHaveLength(1);
  });

  it('are copied with the selection and get fresh ids and a new position', () => {
    loadLab({
      net: new Network(),
      layout: {},
      notes: [note],
      zones: [zone],
      tasks: emptyProgress(),
    });
    addDevice('pc', { x: 0, y: 0 });
    const clip = copyOf(getLab(), ['n1', 'z1', 'd1']);
    const { project, ids } = paste(getLab(), clip, 40);
    expect(project.notes?.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(project.zones?.map((z) => z.id)).toEqual(['z1', 'z2']);
    expect(project.notes?.[1]).toMatchObject({ x: 50, y: 19.5, text: note.text });
    expect(ids.sort()).toEqual(['d2', 'n2', 'z2']);
    expect(getLab().notes).toHaveLength(1);
  });
});
