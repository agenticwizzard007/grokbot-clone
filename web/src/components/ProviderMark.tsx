/** Provider artwork is bundled locally; its text label supplies the accessible name. */
export function ProviderMark({ provider }: { provider: 'claude' | 'codex' }) {
  return provider === 'claude' ? (
    <img className="subscription-provider-mark subscription-provider-mark--claude" src="/assets/providers/claude-code.svg" width={24} height={20} alt="" aria-hidden="true" draggable={false} />
  ) : (
    <svg className="subscription-provider-mark" width={20} height={20} viewBox="20 20 88 88" aria-hidden="true" focusable="false">
      <use href="/assets/providers/openai.svg#mark" />
    </svg>
  );
}
