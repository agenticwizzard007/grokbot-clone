import { useEffect, useRef } from 'react';
import type { Bot } from '@shared/types';
import { openConversation } from '../../configStore';
import { useStore } from '../../store';

export function useWorkLifetime() {
  const lifetime = useRef(false);
  useEffect(() => {
    lifetime.current = true;
    return () => { lifetime.current = false; };
  }, []);
  return lifetime;
}

export function workBotKey(bot: Bot | undefined) {
  return bot ? `${bot.id}:${bot.generation}` : '';
}

export function openWorkChat(botId: string) {
  const store = useStore.getState();
  if (!store.bots.some(bot => bot.id === botId)) return;
  openConversation(botId);
}
