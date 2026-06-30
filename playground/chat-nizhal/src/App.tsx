import type { NizhalCollection } from "@nizhal/db-collection";
import { useEffect, useMemo, useRef, useState } from "react";
import { type MessageRow, channelTimeline } from "./domain.js";
import { createWebChatClient } from "./web-store.js";

function useCollection<T extends object>(collection: NizhalCollection<T>): T[] {
  const [rows, setRows] = useState<T[]>(() => [...collection.toArray]);
  useEffect(() => {
    const read = () => setRows([...collection.toArray]);
    read();
    const sub = collection.subscribeChanges(read);
    return () => sub.unsubscribe();
  }, [collection]);
  return rows;
}

// RFC-011 F-B: a parked write must be visible + retryable, never silently lost.
function useDeadLetterCount(client: Client): number {
  const [count, setCount] = useState(() => client.deadLetter.length);
  useEffect(() => {
    const update = () => setCount(client.deadLetter.length);
    update();
    return client.onDeadLetterChange(update);
  }, [client]);
  return count;
}

type Client = Awaited<ReturnType<typeof createWebChatClient>>;

export function App() {
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    createWebChatClient()
      .then(setClient)
      .catch((e) => setError(String(e)));
  }, []);
  if (error) return <div className="center err">{error}</div>;
  if (!client) return <div className="center">Connecting…</div>;
  return <Chat client={client} />;
}

function Chat({ client }: { client: Client }) {
  const messages = useCollection(client.messages) as MessageRow[];
  const failed = useDeadLetterCount(client);
  const [text, setText] = useState("");
  const [offline, setOffline] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  function toggleNet() {
    const goOffline = !offline;
    client.onlineDetector.setOnline(!goOffline); // false = hold outbox; true = flush
    setOffline(goOffline);
  }
  const timeline = useMemo(
    () => channelTimeline(messages, client.channelId),
    [messages, client.channelId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to bottom on new message
  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [timeline.length]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    client.mutate.sendMessage({ id: crypto.randomUUID(), channelId: client.channelId, body });
    setText("");
  }

  return (
    <div className="app">
      <header>
        <div className="title">
          # {client.channelId} <span className="dot" /> <small>nizhal · channel = DO</small>
        </div>
        <div className="headerRight">
          <button
            type="button"
            className={`netToggle ${offline ? "netOffline" : "netOnline"}`}
            onClick={toggleNet}
          >
            {offline ? "● Offline" : "● Online"}
          </button>
          <span className="who">{client.user}</span>
        </div>
      </header>
      <div className="list" ref={listRef}>
        {timeline.length === 0 && <div className="empty">No messages yet — say hello.</div>}
        {timeline.map((m) => (
          <div key={m.id} className={`msg${m.author_id === client.user ? " mine" : ""}`}>
            <div className="author">{m.author_id}</div>
            <div className="bubble">{m.body}</div>
          </div>
        ))}
      </div>
      {failed > 0 && (
        <div className="dlBanner">
          <span>
            {failed} message{failed > 1 ? "s" : ""} failed to send
          </span>
          <button type="button" onClick={() => void client.retryDeadLetter()}>
            Retry
          </button>
        </div>
      )}
      <form className="composer" onSubmit={send}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Message #${client.channelId}`}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
