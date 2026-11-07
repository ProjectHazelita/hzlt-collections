import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
export function EntryIdentity({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  const url = new URL(`/entries/${id}`, location.origin).href;
  async function copy() {
    let success = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        success = true;
      }
    } catch {
      /* HTTP and denied permission use the actual legacy copy operation. */
    }
    if (!success) {
      const field = document.createElement('textarea');
      field.value = url;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      try {
        success = document.execCommand('copy');
      } finally {
        field.remove();
      }
    }
    setFallback(!success);
    setCopied(success);
    if (success) window.setTimeout(() => setCopied(false), 2000);
  }
  return (
    <span className="entry-identity">
      <span>#{id}</span>
      <button
        type="button"
        className="icon-button"
        aria-label={copied ? '链接已复制' : '复制条目链接'}
        title="复制条目链接"
        onClick={() => void copy()}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
      {copied && <span role="status">链接已复制</span>}
      {fallback && (
        <input
          aria-label="条目链接，复制失败请手动复制"
          readOnly
          value={url}
          onFocus={(event) => event.target.select()}
        />
      )}
    </span>
  );
}
