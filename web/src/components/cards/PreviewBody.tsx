import * as React from 'react';

export const plainBodyText = (text: string) => text.replace(/\\r\\n|\\n/g, '\n');

/** Slack's small inline format, rendered as React text nodes and safe links only. */
function slackText(text: string) {
  return text.split(/(```[\s\S]*?```|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|<(?:https?:\/\/|mailto:)[^>\n]+>)/g).map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) return <code key={i}>{part.slice(3, -3)}</code>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <strong key={i}>{part.slice(1, -1)}</strong>;
    if (part.startsWith('_') && part.endsWith('_')) return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith('~') && part.endsWith('~')) return <s key={i}>{part.slice(1, -1)}</s>;
    if (/^<(https?:\/\/|mailto:)/.test(part)) {
      const [href, ...label] = part.slice(1, -1).split('|');
      return <a key={i} href={href} target="_blank" rel="noopener noreferrer">{label.join('|') || href}</a>;
    }
    return part;
  });
}

export function PreviewBody({ text, className = '', slack = false }: { text: string; className?: string; slack?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const long = text.length > 700 || text.split('\n').length > 10;
  return <div className="tool-preview__body">
    <div className={`tool-preview__text ${className}${long && !expanded ? ' is-collapsed' : ''}`}>{slack ? slackText(text) : text}</div>
    {long && <button type="button" className="tool-preview__expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show full'}</button>}
  </div>;
}

