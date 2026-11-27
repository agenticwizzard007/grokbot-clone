import { useState } from 'react';
import { REGISTRY, type UiConfig } from '@shared/ui-config/index';
import { ButtonGroup, Row } from '../../layout';
import { AppearanceSection } from './Controls';
import { recordedShortcut, setValue } from './patches';
import type { Patch } from './LayoutControls';
export function Shortcuts({ doc, patch }: { doc: UiConfig; patch: Patch }) {
  const [recording, setRecording] = useState<string | null>(null);
  return <AppearanceSection title="Shortcuts">
    {REGISTRY.shortcuts.map(shortcut => <Row key={shortcut.id} title={shortcut.label} subtitle={<kbd>{Object.hasOwn(doc.keybindings, shortcut.id) ? doc.keybindings[shortcut.id] ?? 'None' : shortcut.default ?? 'None'}</kbd>} trailing={<ButtonGroup>
      <button type="button" className="cfg-btn cfg-btn--secondary" aria-label={`Change ${shortcut.label} shortcut`} aria-pressed={recording === shortcut.id} onClick={() => setRecording(recording === shortcut.id ? null : shortcut.id)} onBlur={() => setRecording(null)} onKeyDown={e => {
        if (recording !== shortcut.id) return;
        if (e.key === 'Tab') { setRecording(null); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRecording(null); return; }
        e.preventDefault(); e.stopPropagation();
        const combo = recordedShortcut(e.nativeEvent);
        if (combo) void patch(setValue(`/keybindings/${shortcut.id}`, combo)).then(ok => { if (ok) setRecording(null); });
      }}>{recording === shortcut.id ? 'Press keys' : 'Change'}</button>
      <button type="button" className="cfg-btn cfg-btn--secondary" aria-label={`Clear ${shortcut.label} shortcut`} disabled={shortcut.required} onClick={() => void patch(setValue(`/keybindings/${shortcut.id}`, null))}>Clear</button>
    </ButtonGroup>} />)}
  </AppearanceSection>;
}
