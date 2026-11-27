import { parseNote, type InlineNode } from '../note-parser';
import { Empty, type WidgetProps } from './shared';
function Inline({ nodes }: { nodes: InlineNode[] }) { return <>{nodes.map((node, index) => node.kind === 'bold' ? <strong key={index}>{node.text}</strong> : node.kind === 'italic' ? <em key={index}>{node.text}</em>
  : node.kind === 'link' ? <span key={index}><a href={node.href} {...node.domain ? { target: '_blank', rel: 'noopener noreferrer' } : {}}>{node.text}</a>{node.domain && <span className="dashboard-link-domain"> ({node.domain})</span>}</span> : <span key={index}>{node.text}</span>)}</>; }
export default function Note({ widget }: WidgetProps) {
  const nodes = parseNote(typeof widget.options.text === 'string' ? widget.options.text : '');
  if (!nodes.length) return <Empty widget={widget} text="Add a note." />;
  return <div className="dashboard-note">{nodes.map((node, index) => {
    if (node.kind === 'list') { const Tag = node.ordered ? 'ol' : 'ul'; return <Tag key={index}>{node.items.map((item, n) => <li key={n}><Inline nodes={item} /></li>)}</Tag>; }
    const Tag = node.kind === 'heading' ? node.level === 3 ? 'h3' : 'h2' : 'p'; return <Tag key={index}><Inline nodes={node.content} /></Tag>;
  })}</div>;
}
