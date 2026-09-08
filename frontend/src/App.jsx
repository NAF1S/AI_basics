import { useEffect, useRef, useState } from 'react';

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to the newest message as the conversation grows.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;

    setError(null);
    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ]);
    setIsStreaming(true);

    try {
      // Stream tokens and append them to the last assistant message.
      await streamAssistantMessage(text, (token) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, content: last.content + token };
          return next;
        });
      });
    } catch (err) {
      setError(err.message || 'Request failed.');
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div className="brand">
          <span className="logo">◆</span>
          <h1>DeepSeek Chat</h1>
        </div>
        <span className="hint">Powered by deepseek-chat</span>
      </header>

      <main className="chat-messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>Send a message to start chatting with DeepSeek.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <div className="bubble">
              {msg.content}
              {msg.role === 'assistant' && isStreaming && i === messages.length - 1 ? (
                <span className="cursor">▍</span>
              ) : null}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </main>

      {error && <div className="error">{error}</div>}

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type a message… (Shift+Enter for a new line)"
          rows={1}
        />
        <button type="submit" disabled={isStreaming || !input.trim()}>
          {isStreaming ? 'Streaming…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

/**
 * Calls the POST /deepseek/query/stream endpoint and feeds each
 * streamed token to the onToken callback.
 *
 * The backend uses SSE (Server-Sent Events). Since this is a POST endpoint,
 * the browser-native EventSource API (GET only) can't be used, so we read the
 * response body as a stream and parse `data: ...` lines manually.
 */
async function streamAssistantMessage(message, onToken) {
  const res = await fetch('/deepseek/query/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Request failed (${res.status}). ${detail}`.trim());
  }
  if (!res.body) {
    throw new Error('Streaming is not supported by this browser.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep the possibly-incomplete last line for next chunk

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data:')) continue;
      // Strip the single optional space after "data:" and preserve the rest
      // verbatim (so whitespace-only tokens are kept intact).
      let data = line.slice(5);
      if (data.startsWith(' ')) data = data.slice(1);
      if (data === '[DONE]') continue;
      onToken(data);
    }
  }

  // Flush any trailing partial data line left in the buffer.
  const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
  if (line.startsWith('data:')) {
    let data = line.slice(5);
    if (data.startsWith(' ')) data = data.slice(1);
    if (data !== '[DONE]') onToken(data);
  }
}
