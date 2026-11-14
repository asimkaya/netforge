import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Device } from '../../engine/device.ts';
import { fetchMail, isEmail, sendMail, type MailMessage } from '../../engine/mail.ts';
import { FIELD, PRIMARY, SECONDARY } from '../styles.ts';

/** Account settings live in the device's files, so they are saved with the lab. */
const SETTINGS = '/root/.mailrc';

function readSettings(device: Device): { address: string; server: string } {
  const text = device.fs?.read(SETTINGS) ?? '';
  const get = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '';
  return { address: get('address'), server: get('server') };
}

type Tab = 'inbox' | 'compose' | 'settings';

/** A mail client: SMTP to send, POP3 to fetch. */
export function Mail({ device }: { device: Device }) {
  const saved = readSettings(device);
  const configured = isEmail(saved.address) && saved.server !== '';
  const [tab, setTab] = useState<Tab>(configured ? 'inbox' : 'settings');
  const [address, setAddress] = useState(saved.address);
  const [server, setServer] = useState(saved.server);
  const [messages, setMessages] = useState<MailMessage[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancel = useRef<() => void>(() => {});
  useEffect(() => () => cancel.current(), []);

  const saveSettings = (e: FormEvent) => {
    e.preventDefault();
    if (!isEmail(address)) {
      setStatus('Enter your address like bob@lab.');
      return;
    }
    if (!server.trim()) {
      setStatus('Enter the mail server’s address or name.');
      return;
    }
    const error = device.fs?.write(SETTINGS, `address=${address}\nserver=${server.trim()}\n`);
    setStatus(error ?? 'Settings saved.');
    if (!error) setTab('inbox');
  };

  const refresh = () => {
    const user = saved.address.split('@')[0] ?? '';
    setBusy(true);
    setStatus('Checking mail…');
    cancel.current = fetchMail(device, saved.server, user, 'password', (r) => {
      setBusy(false);
      if (r.ok) {
        setMessages(r.messages);
        setStatus(`${r.messages.length} message${r.messages.length === 1 ? '' : 's'}.`);
      } else setStatus(r.error);
    });
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!isEmail(to)) {
      setStatus('Enter the recipient like alice@lab.');
      return;
    }
    setBusy(true);
    setStatus('Sending…');
    cancel.current = sendMail(
      device,
      { server: saved.server, from: saved.address, to, subject, body },
      (r) => {
        setBusy(false);
        if (r.ok) {
          setStatus(`Sent to ${to}.`);
          setTo('');
          setSubject('');
          setBody('');
        } else setStatus(r.error);
      },
    );
  };

  const tabs: [Tab, string][] = [
    ['inbox', 'Inbox'],
    ['compose', 'Compose'],
    ['settings', 'Settings'],
  ];
  const shown = open === null ? undefined : messages?.[open];

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex gap-1 border-b border-(--nf-border) px-2 py-1">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            disabled={id !== 'settings' && !configured}
            aria-pressed={tab === id}
            className={`border-b-2 px-2 py-1 ${tab === id ? 'border-(--nf-accent)' : 'border-transparent'} disabled:opacity-40`}
          >
            {label}
          </button>
        ))}
        {configured && (
          <span className="ml-auto self-center text-(--nf-muted)">{saved.address}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'settings' && (
          <form onSubmit={saveSettings} className="space-y-2">
            <label className="flex flex-col gap-1">
              Your email address
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="bob@lab"
                className={`${FIELD} w-56`}
              />
            </label>
            <label className="flex flex-col gap-1">
              Mail server (address or name)
              <input
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="10.0.0.25"
                className={`${FIELD} w-56`}
              />
            </label>
            <button type="submit" className={PRIMARY}>
              Save
            </button>
            <p className="text-(--nf-muted)">
              Sending uses SMTP (port 25), checking mail uses POP3 (port 110). Mail goes to
              /var/mail/USER on the server, where USER is the part before @.
            </p>
          </form>
        )}
        {tab === 'inbox' && (
          <div className="space-y-2">
            <button type="button" onClick={refresh} disabled={busy} className={PRIMARY}>
              Check mail
            </button>
            {messages && messages.length > 0 && (
              <ul
                aria-label="Messages"
                className="divide-y divide-(--nf-border) rounded border border-(--nf-border)"
              >
                {messages.map((m, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => setOpen(i)}
                      className="flex w-full gap-2 px-2 py-1 text-left hover:bg-(--nf-raised)"
                    >
                      <span className="w-32 truncate">{m.from}</span>
                      <span className="truncate font-semibold">{m.subject || '(no subject)'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {shown && (
              <article className="space-y-1 rounded border border-(--nf-border) p-2">
                <h3 className="text-sm font-semibold">{shown.subject || '(no subject)'}</h3>
                <p className="text-(--nf-muted)">
                  From {shown.from} to {shown.to}
                  <span className="ml-3">{shown.date}</span>
                </p>
                <pre className="font-sans whitespace-pre-wrap">{shown.body}</pre>
              </article>
            )}
          </div>
        )}
        {tab === 'compose' && (
          <form onSubmit={send} className="space-y-2">
            <label className="flex flex-col gap-1">
              To
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="alice@lab"
                className={`${FIELD} w-56`}
              />
            </label>
            <label className="flex flex-col gap-1">
              Subject
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className={`${FIELD} w-full`}
              />
            </label>
            <label className="flex flex-col gap-1">
              Message
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                className={`${FIELD} w-full`}
              />
            </label>
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className={PRIMARY}>
                Send
              </button>
              <button type="button" onClick={() => setTab('inbox')} className={SECONDARY}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {status && (
          <p role="status" className="mt-2 text-(--nf-muted)">
            {status}
          </p>
        )}
      </div>
    </div>
  );
}
