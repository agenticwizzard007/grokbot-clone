import { BookOpen, Brain, Clock, File, Globe, Monitor, Search, Shield, SquareCheck } from 'lucide-react';
import { builtinToolIcon } from '../../lib/builtinToolIcon';

const icons = { skill: BookOpen, memory: Brain, task: SquareCheck, routine: Clock, file: File, search: Search, browser: Globe, computer: Monitor, generic: Shield };

export function BuiltinToolIcon({ tool }: { tool: string }) {
  const Glyph = icons[builtinToolIcon(tool)];
  return <span className="toolkit-logo builtin-tool-icon" style={{ width: 44, height: 44, borderRadius: 44 / 5 }} aria-hidden="true"><Glyph size={22} aria-hidden="true" /></span>;
}
