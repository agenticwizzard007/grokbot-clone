import { FlockMark } from './FlockMark';
import { Icon } from './Icon';

export function SetupPaperHeader({ backLabel, title, onBack, onClose, closeLabel = 'Close', disabled = false }: {
  backLabel: string; title?: string; onBack: () => void; onClose: () => void; closeLabel?: string; disabled?: boolean;
}) {
  return <header className="setup-paper__bar setup-paper__bar--responsive">
    <button type="button" className="setup-paper__back" aria-label={backLabel} onClick={onBack} disabled={disabled}>
      <Icon name="chev_left" size={14} /><span className="setup-paper__back-label">{backLabel}</span>
    </button>
    <span className="setup-paper__bar-title"><span className="setup-paper__flock"><FlockMark size={24} /></span>{title}</span>
    <button type="button" className="setup-paper__close" onClick={onClose} disabled={disabled} aria-label={closeLabel}><Icon name="close" size={16} /></button>
  </header>;
}
